//! Taking a snapshot: each market state, with everything its trades touch, cloned as
//! pipeline-check clones a market (the router and its config, the Market, the strategy's
//! registration, program and ProgramData, the mints, vaults, fee accounts, transfer hooks
//! and every account `pipeline_resolve_accounts` lists), plus the token accounts the payouts
//! pay into; then the quotes the deployed build gives on that state.

use buy_wall_amm::config::{DESIGNER_RECIPIENT, MARKET_STATE_SIZE, SUITE_TREASURY};
use buy_wall_amm::state::{MarketState, MARKET_STATE_DISCRIMINATOR};
use pipeline_check::{clone_market, AccountSource, CheckOptions};
use pipeline_client::{pda, Pubkey};

use crate::quotes;
use crate::session::{key, Session, TOKEN, WSOL};
use crate::snapshot::{Baseline, Cluster, SavedAccount, SavedMarket, Snapshot, FORMAT};
use crate::source::{Recording, Rpc};
use crate::world;

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
        clone_market(&mut recording, market, None, &CheckOptions::default())
            .map_err(|e| format!("market state {market_state}: {e}"))?;
        let (_, account) = recording
            .served
            .get(&market_state.to_string())
            .ok_or_else(|| format!("market state {market_state} does not exist"))?;
        let state = read_state(&account.data)
            .ok_or_else(|| format!("market state {market_state} is not a buy wall market"))?;
        recording.get_accounts(&payout_accounts(&state))?;
        saved_markets.push(SavedMarket {
            market: market.to_string(),
            market_state: market_state.to_string(),
            layout_version: state.layout_version,
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
        baseline: Baseline {
            executable_sha256: None,
            quotes: vec![],
        },
        markets: saved_markets,
        accounts: recording
            .served
            .values()
            .map(|(address, account)| SavedAccount::new(address, account))
            .collect(),
    };

    // The quotes of the deployed build, on that state.
    if let Some(deployed) = snapshot.program_elf(program)? {
        snapshot.baseline.executable_sha256 = Some(pipeline_check::executable_sha256(&deployed).0);
        let svm = world::load(&snapshot, &deployed, None)?;
        let session = Session::new(svm, *program);
        snapshot.baseline.quotes = quotes::record(&session, market_states)?;
    } else if !market_states.is_empty() {
        return Err(format!("{program} has markets but is not deployed"));
    }
    Ok(snapshot)
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
