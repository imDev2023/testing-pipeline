//! Taking a snapshot: each market state, with everything its trades touch, cloned as
//! pipeline-check clones a market (the router and its config, the Market, the strategy's
//! registration, program and ProgramData, the mints, vaults, fee accounts, transfer hooks
//! and every account `pipeline_resolve_accounts` lists), plus the token accounts the payouts
//! pay into; then what the deployed build does on that state (`check::record_baseline`).
//!
//! A market state the router has no Market for (a wallet may call `pipeline_seed_liquidity`
//! itself and never register the market) is cloned the same way, as if the router had
//! recorded what `pipeline_market_info` would give it, and saved without that Market: the
//! replay registers it, as anyone could (`check.rs`).

use borsh::BorshSerialize;
use buy_wall_amm::config::{DESIGNER_RECIPIENT, MARKET_STATE_SIZE, SUITE_TREASURY};
use buy_wall_amm::state::{MarketState, MARKET_STATE_DISCRIMINATOR};
use pipeline_check::{clone_market, AccountSource, CheckOptions, ClusterInfo};
use pipeline_client::{self as client, pda, Pubkey};
use solana_account::Account;

use crate::check;
use crate::session::{key, TOKEN, WSOL};
use crate::snapshot::{Baseline, Cluster, SavedAccount, SavedMarket, Snapshot, FORMAT};
use crate::source::{Recording, Rpc};

/// Every market state of `program` on the cluster behind `rpc`: the accounts it owns that
/// start with the market state's discriminator. An account with the discriminator but not
/// `MARKET_STATE_SIZE` bytes is an error, since no build ever wrote one.
pub fn find_markets(rpc: &mut Rpc, program: &Pubkey) -> Result<Vec<Pubkey>, String> {
    let mut markets = vec![];
    for (address, len) in rpc.program_accounts(program, MARKET_STATE_DISCRIMINATOR)? {
        if len != MARKET_STATE_SIZE {
            return Err(format!(
                "{address} carries the market state's discriminator but is {len} bytes, not \
                 {MARKET_STATE_SIZE}"
            ));
        }
        markets.push(address);
    }
    markets.sort();
    Ok(markets)
}

/// Snapshots `market_states` of `program` from `source`.
pub fn snapshot(
    source: &mut dyn AccountSource,
    program: &Pubkey,
    market_states: &[Pubkey],
    url: Option<String>,
    synthetic: bool,
    note: &str,
) -> Result<Snapshot, String> {
    let mut recording = Recording::new(source);
    // The program and the router, even when no market exists yet.
    recording.get_accounts(&[
        *program,
        pda::program_data(program),
        pipeline_client::PROGRAM_ID,
        pda::program_data(&pipeline_client::PROGRAM_ID),
    ])?;
    let mut saved_markets = vec![];
    for market_state in market_states {
        let market = pda::market(program, market_state);
        let [state_account, market_account] =
            <[Option<Account>; 2]>::try_from(recording.get_accounts(&[*market_state, market])?)
                .map_err(|_| "the source served the wrong number of accounts")?;
        let state = state_account
            .and_then(|account| read_state(&account.data))
            .ok_or_else(|| format!("market state {market_state} is not a buy wall market"))?;
        let registered = market_account.is_some_and(|a| a.owner == client::PROGRAM_ID);
        let cloned = if registered {
            clone_market(&mut recording, market, None, &CheckOptions::default())
        } else {
            let mut unregistered = Unregistered {
                inner: &mut recording,
                market,
                account: market_record(program, market_state, &state)?,
            };
            clone_market(&mut unregistered, market, None, &CheckOptions::default())
        };
        cloned.map_err(|e| format!("market state {market_state}: {e}"))?;
        recording.get_accounts(&payout_accounts(&state))?;
        saved_markets.push(SavedMarket {
            market: market.to_string(),
            market_state: market_state.to_string(),
            layout_version: state.layout_version,
            registered,
        });
    }

    // Cloning read the accounts over many calls, at slots that can differ; read them all again
    // in as few calls as there can be (a hundred accounts a call), so the market states, their
    // vaults and the rest agree, and only then the clock, so it is no earlier than the state.
    let keys: Vec<Pubkey> = recording.served.values().map(|(key, _)| *key).collect();
    for (key, account) in keys.iter().zip(recording.get_accounts(&keys)?) {
        if account.is_none() {
            recording.served.remove(&key.to_string());
        }
    }
    let mut info = recording.cluster_info()?;
    for market_state in market_states {
        if let Some(state) = recording
            .served
            .get(&market_state.to_string())
            .and_then(|(_, account)| read_state(&account.data))
        {
            info.slot = info.slot.max(state.last_slot());
            for time in [
                state.seed_time(),
                state.decay_time(),
                state.ref_time(),
                state.floor_time(),
            ] {
                info.unix_timestamp = info.unix_timestamp.max(time);
            }
        }
    }

    let mut snapshot = Snapshot {
        format: FORMAT.into(),
        program: program.to_string(),
        cluster: Cluster {
            name: info
                .genesis_hash
                .as_deref()
                .and_then(pipeline_check::clone::cluster_name)
                .map(str::to_string),
            genesis_hash: info.genesis_hash,
            url: url.as_deref().map(crate::source::redacted),
            slot: info.slot,
            epoch: info.epoch,
            unix_timestamp: info.unix_timestamp,
        },
        synthetic,
        note: note.into(),
        baseline: Baseline::default(),
        markets: saved_markets,
        accounts: recording
            .served
            .values()
            .map(|(address, account)| SavedAccount::new(address, account))
            .collect(),
    };

    // What the deployed build does on that state.
    if let Some(deployed) = snapshot.program_elf(program)? {
        snapshot.baseline = check::record_baseline(&snapshot, &deployed, None)?;
    } else if !market_states.is_empty() {
        return Err(format!("{program} has markets but is not deployed"));
    }
    Ok(snapshot)
}

/// The router's Market for a market state it never recorded, as `register_existing_market`
/// would write it from `pipeline_market_info`, which the cloning needs to find the market's
/// accounts. It is never saved: the replay registers the market through the router itself.
fn market_record(
    program: &Pubkey,
    market_state: &Pubkey,
    state: &MarketState,
) -> Result<Account, String> {
    let mut mints = [Pubkey::default(); pipeline_strategy_interface::MAX_MARKET_MINTS];
    let mut vaults = mints;
    mints[..2].copy_from_slice(&[key(&state.token_mint), key(&state.wsol_mint)]);
    vaults[..2].copy_from_slice(&[key(&state.token_vault), key(&state.sol_vault)]);
    let record = client::Market {
        strategy_program: *program,
        market_state: *market_state,
        mint_count: 2,
        mints,
        vaults,
        supports_exact_out: buy_wall_amm::pricing::SUPPORTS_EXACT_OUT,
        created_by: Pubkey::default(),
        created_at: 0,
        bump: 0,
        fee_authority_bump: 0,
    };
    let mut data = client::account_discriminator("Market").to_vec();
    record.serialize(&mut data).map_err(|e| e.to_string())?;
    Ok(Account {
        lamports: 1,
        data,
        owner: client::PROGRAM_ID,
        executable: false,
        rent_epoch: 0,
    })
}

/// An account source that serves `account` at `market`, which the source behind it does not
/// hold, and serves everything else from it; so only what it served from behind is
/// recorded.
struct Unregistered<'a> {
    inner: &'a mut dyn AccountSource,
    market: Pubkey,
    account: Account,
}

impl AccountSource for Unregistered<'_> {
    fn get_accounts(&mut self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, String> {
        let mut accounts = self.inner.get_accounts(keys)?;
        for (key, account) in keys.iter().zip(accounts.iter_mut()) {
            if *key == self.market {
                *account = Some(self.account.clone());
            }
        }
        Ok(accounts)
    }

    fn cluster_info(&mut self) -> Result<ClusterInfo, String> {
        self.inner.cluster_info()
    }
}

/// A market state's body, read with this tree's layout.
fn read_state(data: &[u8]) -> Option<MarketState> {
    let body = data
        .get(8..)
        .filter(|b| b.len() == std::mem::size_of::<MarketState>())?;
    Some(*bytemuck::from_bytes(body))
}

/// The token accounts the payouts pay into, which a payout creates when missing: the rewards
/// recipient's for the token, and each fee slot's wallet's for wrapped SOL.
fn payout_accounts(state: &MarketState) -> Vec<Pubkey> {
    let token_mint = key(&state.token_mint);
    let unset = anchor_lang::prelude::Pubkey::default();
    let mut accounts = vec![];
    if state.rewards_recipient != unset {
        let recipient = key(&state.rewards_recipient);
        for program in [TOKEN, pipeline_client::TOKEN_2022_PROGRAM_ID] {
            accounts.push(pda::associated_token(&recipient, &token_mint, &program));
        }
    }
    for wallet in [state.fee_recipient, DESIGNER_RECIPIENT, SUITE_TREASURY] {
        if wallet != unset {
            accounts.push(pda::associated_token(&key(&wallet), &WSOL, &TOKEN));
        }
    }
    accounts
}
