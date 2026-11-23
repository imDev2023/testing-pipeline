//! Taking a snapshot: each market state, with everything its trades touch, cloned as
//! pipeline-check clones a market (the router and its config, the Market, the strategy's
//! registration, program and ProgramData, the mints, vaults, fee accounts, transfer hooks and
//! every account `pipeline_resolve_accounts` lists), its cToken account, and Kamino Lend's
//! program with the accounts of every lent mint's reserve this tree knows, whether or not a
//! market lends it yet, so the gate's own market can lend; then what the deployed build does on
//! that state (`check::record_baseline`).
//!
//! A market state the router has no Market for (a launchpad's `pipeline_seed_liquidity` makes
//! one, which anyone may register later) is cloned the same way, as if the router had recorded
//! what `pipeline_market_info` would give it, and saved without that Market: the replay
//! registers it, as anyone could (`check.rs`).

use anchor_lang::{AccountDeserialize, Discriminator};
use borsh::BorshSerialize;
use lending_amm::config::LENT_MINTS;
use lending_amm::LendingAmmMarket;
use pipeline_check::{clone_market, AccountSource, CheckOptions, ClusterInfo};
use pipeline_client::{self as client, pda, Pubkey};
use release_gate::source::{redacted, Recording, Rpc};
use solana_account::Account;

use crate::check;
use crate::kamino::{self, key};
use crate::snapshot::{Baseline, Cluster, SavedAccount, SavedMarket, Snapshot, FORMAT};
use crate::world::Programs;

/// Every market state of `program` on the cluster behind `rpc`: the accounts it owns that
/// start with the market state's discriminator. An account with the discriminator but not the
/// market state's size is an error, since no build ever wrote one.
pub fn find_markets(rpc: &mut Rpc, program: &Pubkey) -> Result<Vec<Pubkey>, String> {
    let size = lending_amm::state::layout::LEN;
    let mut markets = vec![];
    for (address, len) in rpc.program_accounts(program, LendingAmmMarket::DISCRIMINATOR)? {
        if len != size {
            return Err(format!(
                "{address} carries the market state's discriminator but is {len} bytes, not {size}"
            ));
        }
        markets.push(address);
    }
    markets.sort();
    Ok(markets)
}

/// Snapshots `market_states` of `program` from `source`; `programs` are the router and klend
/// the deployed build's replay runs when the source holds none of its own (a test's).
pub fn snapshot(
    source: &mut dyn AccountSource,
    program: &Pubkey,
    market_states: &[Pubkey],
    url: Option<String>,
    note: &str,
    programs: Programs,
) -> Result<Snapshot, String> {
    let mut recording = Recording::new(source);
    // The program, the router and klend, even when no market exists yet: the deployed build is
    // the baseline, and the router and klend run every replay.
    recording.get_accounts(&[
        *program,
        pda::program_data(program),
        client::PROGRAM_ID,
        pda::program_data(&client::PROGRAM_ID),
        kamino::klend(),
        pda::program_data(&kamino::klend()),
    ])?;
    kamino_accounts(&mut recording)?;

    let mut saved_markets = vec![];
    for market_state in market_states {
        let market = pda::market(program, market_state);
        let [state_account, market_account] =
            <[Option<Account>; 2]>::try_from(recording.get_accounts(&[*market_state, market])?)
                .map_err(|_| "the source served the wrong number of accounts")?;
        let state = state_account
            .and_then(|account| read_state(&account.data))
            .ok_or_else(|| format!("market state {market_state} is not a lending AMM market"))?;
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
        recording.get_accounts(&[key(&state.ctoken_account), key(&state.lp_mint)])?;
        saved_markets.push(SavedMarket {
            market: market.to_string(),
            market_state: market_state.to_string(),
            layout_version: state.version,
            registered,
        });
    }

    // Cloning read the accounts over many calls, at slots that can differ; read them all again
    // in as few calls as there can be (a hundred accounts a call), so the market states, their
    // vaults, the reserves and the rest agree, and only then the clock, so it is no earlier than
    // the state.
    let keys: Vec<Pubkey> = recording.served.values().map(|(key, _)| *key).collect();
    for (key, account) in keys.iter().zip(recording.get_accounts(&keys)?) {
        if account.is_none() {
            recording.served.remove(&key.to_string());
        }
    }
    let mut info = recording.cluster_info()?;
    // Never a clock before what the accounts saw: the last slot a reserve was refreshed at, or
    // a market was created at.
    for (_, account) in recording.served.values() {
        if account.owner == kamino::klend()
            && account.data.len() == lending_amm::kamino::RESERVE_LEN
        {
            let last = u64::from_le_bytes(
                account.data[lending_amm::kamino::offsets::LAST_UPDATE_SLOT..][..8]
                    .try_into()
                    .expect("8 bytes"),
            );
            info.slot = info.slot.max(last);
        }
    }
    for market_state in market_states {
        if let Some(state) = recording
            .served
            .get(&market_state.to_string())
            .and_then(|(_, account)| read_state(&account.data))
        {
            info.slot = info.slot.max(state.created_slot);
            info.unix_timestamp = info.unix_timestamp.max(state.created_at);
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
            url: url.as_deref().map(redacted),
            slot: info.slot,
            epoch: info.epoch,
            unix_timestamp: info.unix_timestamp,
        },
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
        snapshot.baseline = check::record_baseline(&snapshot, &deployed, programs)?;
    } else if !market_states.is_empty() {
        return Err(format!("{program} has markets but is not deployed"));
    }
    Ok(snapshot)
}

/// Copies the Kamino accounts of every lent mint of this tree: the reserve first, from which
/// its liquidity supply is read, then the rest.
fn kamino_accounts(recording: &mut Recording) -> Result<(), String> {
    let reserves: Vec<Pubkey> = LENT_MINTS.iter().map(|e| key(&e.reserve)).collect();
    let read = recording.get_accounts(&reserves)?;
    let mut keys = vec![];
    for (entry, reserve) in LENT_MINTS.iter().zip(read) {
        if let Some(accounts) = reserve.and_then(|r| kamino::Accounts::of(entry, &r.data)) {
            keys.extend(accounts.addresses());
        }
    }
    recording.get_accounts(&keys)?;
    Ok(())
}

/// The router's Market for a market state it never recorded, as `register_existing_market`
/// would write it from `pipeline_market_info`, which the cloning needs to find the market's
/// accounts. It is never saved: the replay registers the market through the router itself.
fn market_record(
    program: &Pubkey,
    market_state: &Pubkey,
    state: &LendingAmmMarket,
) -> Result<Account, String> {
    let mut mints = [Pubkey::default(); pipeline_strategy_interface::MAX_MARKET_MINTS];
    let mut vaults = mints;
    for i in 0..2 {
        mints[i] = key(&state.mints[i]);
        vaults[i] = key(&state.vaults[i]);
    }
    let record = client::Market {
        strategy_program: *program,
        market_state: *market_state,
        mint_count: 2,
        mints,
        vaults,
        supports_exact_out: false,
        created_by: Pubkey::default(),
        created_at: 0,
        bump: 0,
        fee_authority_bump: 0,
        // As the router records it for a strategy that declares no fee mint, as the lending AMM
        // does (Pipeline 0.3, `BAR-44`): wrapped SOL's index if the market trades it, else none.
        fee_mint_index: mints[..2]
            .iter()
            .position(|mint| *mint == client::wallet::NATIVE_MINT)
            .map_or(client::NO_FEE_MINT, |index| index as u8),
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
/// hold, and serves everything else from it; so only what it served from behind is recorded.
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

/// A market state, read with this tree's layout.
fn read_state(data: &[u8]) -> Option<LendingAmmMarket> {
    (data.len() == lending_amm::state::layout::LEN)
        .then(|| LendingAmmMarket::try_deserialize(&mut &data[..]).ok())
        .flatten()
}
