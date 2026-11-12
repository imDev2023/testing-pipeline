//! Where a run reads accounts from (`docs/spec/pipescope-canary.md`, "How a run works"):
//! read-only RPC on a developer's machine, or the snapshot the `CanaryRun` Durable Object
//! posts into the container, which has no network.
//!
//! Every source is a `pipeline-check` [`AccountSource`], so `pipeline-check`'s own cloner
//! builds the copy from it. A snapshot also remembers every address it was asked for and
//! does not hold, so the endpoint can answer with exactly those.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use base64::Engine;
use pipeline_check::rpc::RpcSource;
use pipeline_check::{AccountSource, ClusterInfo, SvmSource};
use pipeline_client::{self as client, Pubkey};
use serde::{Deserialize, Serialize};

use crate::config::{RPC_ACCOUNTS_PER_CALL, RPC_READ_ATTEMPTS, RPC_READ_RETRY_MS};
use solana_account::Account;

/// An account source Canary can run on.
pub trait Source: AccountSource {
    /// Every address asked for that this source does not hold, in the order first asked.
    /// Always empty for a source that can read the whole cluster.
    fn missing(&self) -> Vec<Pubkey> {
        vec![]
    }
}

impl Source for SvmSource {}

/// Read-only RPC, with program accounts kept between markets so a sweep reads each
/// program once, and a count of every request made.
pub struct RpcAccounts {
    rpc: RpcSource,
    programs: HashMap<Pubkey, Account>,
    calls: usize,
}

impl RpcAccounts {
    pub fn new(url: &str) -> Result<Self, String> {
        Ok(RpcAccounts {
            rpc: RpcSource::new(url)?,
            programs: HashMap::new(),
            calls: 0,
        })
    }

    /// RPC requests sent so far, every retry included.
    pub fn requests(&self) -> usize {
        self.rpc.requests
    }

    /// RPC calls the run asked for so far, not counting retries: the cluster's clock is four
    /// (`getSlot`, `getEpochInfo`, `getBlockTime`, `getGenesisHash`), and each read of up to
    /// 100 accounts is one `getMultipleAccounts`.
    pub fn calls(&self) -> usize {
        self.calls
    }

    /// Every market registered with the router.
    pub fn markets(&mut self) -> Result<Vec<(Pubkey, client::Market)>, String> {
        self.calls += 1;
        let rpc = &mut self.rpc;
        with_retries(|| rpc.markets())
    }
}

/// The calls `pipeline-check`'s `cluster_info` makes.
const CLUSTER_INFO_CALLS: usize = 4;

/// Runs `read` up to [`RPC_READ_ATTEMPTS`] times, waiting longer before each retry.
fn with_retries<T>(mut read: impl FnMut() -> Result<T, String>) -> Result<T, String> {
    let mut wait = std::time::Duration::from_millis(RPC_READ_RETRY_MS);
    let mut attempt = 1;
    loop {
        match read() {
            Ok(value) => return Ok(value),
            Err(error) if attempt >= RPC_READ_ATTEMPTS => {
                return Err(format!("{error} (after {attempt} tries)"))
            }
            Err(_) => {
                std::thread::sleep(wait);
                wait *= 2;
                attempt += 1;
            }
        }
    }
}

fn is_program_bytes(account: &Account) -> bool {
    const PROGRAM_DATA_TAG: [u8; 4] = [3, 0, 0, 0];
    account.executable
        || (account.owner == client::BPF_LOADER_UPGRADEABLE_ID
            && account.data.get(..4) == Some(&PROGRAM_DATA_TAG[..]))
}

impl AccountSource for RpcAccounts {
    fn get_accounts(&mut self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, String> {
        let unknown: Vec<Pubkey> = keys
            .iter()
            .filter(|k| !self.programs.contains_key(*k))
            .copied()
            .collect();
        let mut fetched: HashMap<Pubkey, Option<Account>> = HashMap::new();
        if !unknown.is_empty() {
            self.calls += unknown.len().div_ceil(RPC_ACCOUNTS_PER_CALL);
            let rpc = &mut self.rpc;
            let accounts = with_retries(|| rpc.get_accounts(&unknown))?;
            fetched = unknown.into_iter().zip(accounts).collect();
        }
        Ok(keys
            .iter()
            .map(|key| {
                if let Some(program) = self.programs.get(key) {
                    return Some(program.clone());
                }
                let account = fetched.get(key).cloned().flatten();
                if let Some(account) = account.as_ref().filter(|a| is_program_bytes(a)) {
                    self.programs.insert(*key, account.clone());
                }
                account
            })
            .collect())
    }

    fn cluster_info(&mut self) -> Result<ClusterInfo, String> {
        self.calls += CLUSTER_INFO_CALLS;
        let rpc = &mut self.rpc;
        with_retries(|| rpc.cluster_info())
    }
}

impl Source for RpcAccounts {}

/// An account as a snapshot carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotAccount {
    pub lamports: u64,
    pub owner: String,
    pub executable: bool,
    #[serde(default)]
    pub rent_epoch: u64,
    /// The account's data, base64.
    pub data: String,
}

impl SnapshotAccount {
    pub fn from_account(account: &Account) -> Self {
        SnapshotAccount {
            lamports: account.lamports,
            owner: account.owner.to_string(),
            executable: account.executable,
            rent_epoch: account.rent_epoch,
            data: base64::engine::general_purpose::STANDARD.encode(&account.data),
        }
    }

    fn to_account(&self, address: &str) -> Result<Account, String> {
        Ok(Account {
            lamports: self.lamports,
            owner: self
                .owner
                .parse()
                .map_err(|_| format!("account {address}: the owner is not an address"))?,
            executable: self.executable,
            rent_epoch: self.rent_epoch,
            data: base64::engine::general_purpose::STANDARD
                .decode(&self.data)
                .map_err(|e| format!("account {address}: the data is not base64 ({e})"))?,
        })
    }
}

/// The cluster's clock when the snapshot was read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotCluster {
    pub slot: u64,
    pub epoch: u64,
    pub unix_timestamp: i64,
    #[serde(default)]
    pub genesis_hash: Option<String>,
}

/// One market's snapshot, as the `CanaryRun` Durable Object posts it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    /// The market to run.
    pub market: String,
    /// Which posting this is, from 1; at the last ([`crate::config::SNAPSHOT_ROUNDS`]) the
    /// run answers with results whatever it still lacks.
    pub round: u32,
    pub cluster: SnapshotCluster,
    /// Every account read, by address; `null` for an address the cluster has no account at.
    /// An address absent from this map is one the snapshot lacks.
    pub accounts: BTreeMap<String, Option<SnapshotAccount>>,
}

/// A [`Snapshot`] as an account source.
pub struct SnapshotSource {
    cluster: ClusterInfo,
    accounts: HashMap<Pubkey, Option<Account>>,
    missing: Vec<Pubkey>,
    seen_missing: BTreeSet<Pubkey>,
}

impl SnapshotSource {
    pub fn new(snapshot: &Snapshot) -> Result<Self, String> {
        let mut accounts = HashMap::with_capacity(snapshot.accounts.len());
        for (address, account) in &snapshot.accounts {
            let key: Pubkey = address
                .parse()
                .map_err(|_| format!("{address:?} is not an address"))?;
            let account = account
                .as_ref()
                .map(|a| a.to_account(address))
                .transpose()?;
            accounts.insert(key, account);
        }
        Ok(SnapshotSource {
            cluster: ClusterInfo {
                slot: snapshot.cluster.slot,
                epoch: snapshot.cluster.epoch,
                unix_timestamp: snapshot.cluster.unix_timestamp,
                genesis_hash: snapshot.cluster.genesis_hash.clone(),
            },
            accounts,
            missing: vec![],
            seen_missing: BTreeSet::new(),
        })
    }
}

impl AccountSource for SnapshotSource {
    fn get_accounts(&mut self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, String> {
        Ok(keys
            .iter()
            .map(|key| match self.accounts.get(key) {
                Some(account) => account.clone(),
                None => {
                    if self.seen_missing.insert(*key) {
                        self.missing.push(*key);
                    }
                    None
                }
            })
            .collect())
    }

    fn cluster_info(&mut self) -> Result<ClusterInfo, String> {
        Ok(self.cluster.clone())
    }
}

impl Source for SnapshotSource {
    fn missing(&self) -> Vec<Pubkey> {
        self.missing.clone()
    }
}

/// A source that remembers every account it was asked for, so a snapshot can be made from
/// any source.
pub struct Recorder<'a> {
    inner: &'a mut dyn Source,
    pub accounts: BTreeMap<Pubkey, Option<Account>>,
    pub cluster: Option<ClusterInfo>,
}

impl<'a> Recorder<'a> {
    pub fn new(inner: &'a mut dyn Source) -> Self {
        Recorder {
            inner,
            accounts: BTreeMap::new(),
            cluster: None,
        }
    }
}

impl AccountSource for Recorder<'_> {
    fn get_accounts(&mut self, keys: &[Pubkey]) -> Result<Vec<Option<Account>>, String> {
        let accounts = self.inner.get_accounts(keys)?;
        for (key, account) in keys.iter().zip(&accounts) {
            self.accounts.insert(*key, account.clone());
        }
        Ok(accounts)
    }

    fn cluster_info(&mut self) -> Result<ClusterInfo, String> {
        let info = self.inner.cluster_info()?;
        self.cluster.get_or_insert_with(|| info.clone());
        Ok(info)
    }
}

impl Source for Recorder<'_> {
    fn missing(&self) -> Vec<Pubkey> {
        self.inner.missing()
    }
}

/// The snapshot of `market` a full run reads from `source`: every account the copy and the
/// trades asked for, as the `CanaryRun` Durable Object would post it after its rounds.
pub fn record_snapshot(source: &mut dyn Source, market: Pubkey) -> Result<Snapshot, String> {
    let mut recorder = Recorder::new(source);
    crate::run::run_market(&mut recorder, market, &crate::run::RunOptions::default());
    let cluster = recorder
        .cluster
        .clone()
        .ok_or_else(|| "the run never read the cluster's clock".to_string())?;
    Ok(Snapshot {
        market: market.to_string(),
        round: 1,
        cluster: SnapshotCluster {
            slot: cluster.slot,
            epoch: cluster.epoch,
            unix_timestamp: cluster.unix_timestamp,
            genesis_hash: cluster.genesis_hash,
        },
        accounts: recorder
            .accounts
            .iter()
            .map(|(key, account)| {
                (
                    key.to_string(),
                    account.as_ref().map(SnapshotAccount::from_account),
                )
            })
            .collect(),
    })
}
