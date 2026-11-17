//! A snapshot: every market state of the program on a cluster at one moment, with every
//! account a trade or a keeper job on it reads (its mints, vaults, the router's Market,
//! config and fee accounts, the strategy's registration, the recipients' token accounts),
//! and what the deployed build did on that state: its quotes, and whether each of the
//! gate's other steps passed with it, which decides whether a step the candidate fails
//! counts against it (`check.rs`).
//!
//! One file, one format, for both uses: a cluster run downloads one into a scratch file and
//! replays it, and the repo keeps one per layout version as a fixture
//! (docs/spec/pool4-for-solana.md, "Fixtures in CI"). A cluster snapshot also holds the
//! programs it ran (the router and the deployed build, as their ProgramData accounts); a
//! fixture leaves them out, because CI replays it with the pinned router and the build under
//! test, and compares its quotes and step outcomes with the ones recorded here.

use std::path::Path;

use base64::Engine;
use pipeline_client::{pda, Pubkey};
use serde::{Deserialize, Serialize};
use solana_account::Account;

/// The format this build reads and writes.
pub const FORMAT: &str = "buy-wall-gate-snapshot/2";
/// The format before the deployed build's step outcomes were recorded, which only `rerecord`
/// reads, to record them.
pub const FORMAT_1: &str = "buy-wall-gate-snapshot/1";

/// The upgradeable loader, which owns every deployed program and its ProgramData.
pub const LOADER_V3: Pubkey =
    pipeline_client::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
/// Where a ProgramData account's executable starts.
pub const PROGRAMDATA_HEADER_LEN: usize = 45;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub format: String,
    /// The buy wall AMM's program id, base58.
    pub program: String,
    pub cluster: Cluster,
    /// Made by a LiteSVM run rather than taken from a real cluster (`POOL4-20`).
    pub synthetic: bool,
    /// What the snapshot is, for whoever reads the file.
    pub note: String,
    pub baseline: Baseline,
    pub markets: Vec<SavedMarket>,
    pub accounts: Vec<SavedAccount>,
}

/// Where and when the accounts were read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cluster {
    pub genesis_hash: Option<String>,
    /// `devnet`, `mainnet-beta` or `testnet` when the genesis hash is one of theirs.
    pub name: Option<String>,
    pub url: Option<String>,
    pub slot: u64,
    pub epoch: u64,
    pub unix_timestamp: i64,
}

/// The build the snapshot's quotes and step outcomes came from: on a cluster the deployed
/// build, for a synthetic fixture the build that made it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Baseline {
    /// SHA-256 of the executable with trailing zeros removed, as `solana-verify` computes it.
    pub executable_sha256: Option<String>,
    pub quotes: Vec<Quote>,
    /// Each of the gate's other steps on each market, as the baseline build ran it, every
    /// keeper job included whether due or not.
    #[serde(default)]
    pub steps: Vec<RecordedStep>,
}

impl Baseline {
    /// What the baseline build did at step `kind` on `market_state`, if it got that far.
    pub fn outcome(&self, market_state: &str, kind: &StepKind) -> Option<&Outcome> {
        self.steps
            .iter()
            .find(|s| s.market_state == market_state && s.kind == *kind)
            .map(|s| &s.outcome)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedMarket {
    /// The router's Market account.
    pub market: String,
    pub market_state: String,
    pub layout_version: u8,
    /// Whether the router had a Market for it; one it had none for (a market a wallet made
    /// by calling `pipeline_seed_liquidity` itself) is registered in the replay.
    #[serde(default = "registered_by_default")]
    pub registered: bool,
}

fn registered_by_default() -> bool {
    true
}

/// One step of the gate on one market, as the baseline build ran it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordedStep {
    pub market_state: String,
    #[serde(flatten)]
    pub kind: StepKind,
    pub outcome: Outcome,
}

/// What a step is, without the amounts its name shows, which can drift between replays.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "step", rename_all = "snake_case")]
pub enum StepKind {
    ReadState,
    Register,
    FindMarket,
    FeeAccounts,
    Resolve {
        input_index: u8,
    },
    Quote {
        input_index: u8,
        amount: u64,
    },
    MarketInfo,
    Seed,
    Job {
        job: crate::keeper::Job,
    },
    Buy,
    Sell,
    /// Making the gate's own market (`POOL4-53`): readying the router as on devnet, creating
    /// and seeding the market through it, and trading it past its first wall and settlement.
    /// Never in a baseline, since the deployed build never makes one.
    MakeMarket,
}

impl StepKind {
    /// Whether a failure of this step can be one the deployed build shares: a step that moves
    /// tokens, so a market's token, its recipients or the router can make it fail under any
    /// build. The layout checks (reading the market state, finding the market, account
    /// resolution, the quotes and `pipeline_market_info`) never are, so a build that breaks
    /// the layout is refused even on a market whose trades are blocked.
    pub fn may_fail_under_any_build(&self) -> bool {
        matches!(
            self,
            StepKind::Register
                | StepKind::FeeAccounts
                | StepKind::Seed
                | StepKind::Job { .. }
                | StepKind::Buy
                | StepKind::Sell
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Passed,
    Failed {
        /// The program the failure started in, as the logs show it, or `None` when no
        /// program raised it (the gate could not even send the step).
        program: Option<String>,
        /// The error, without the logs.
        error: String,
    },
}

/// One exact-in quote and what the baseline build answered.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Quote {
    pub market_state: String,
    pub input_index: u8,
    pub output_index: u8,
    pub amount: u64,
    pub result: QuoteOutcome,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuoteOutcome {
    AmountOut(u64),
    /// The transaction error the quote failed with.
    Refused(String),
}

impl std::fmt::Display for QuoteOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QuoteOutcome::AmountOut(amount) => write!(f, "{amount} out"),
            QuoteOutcome::Refused(error) => write!(f, "refused ({error})"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedAccount {
    pub address: String,
    pub lamports: u64,
    pub owner: String,
    pub executable: bool,
    pub rent_epoch: u64,
    /// Base64.
    pub data: String,
}

impl SavedAccount {
    pub fn new(address: &Pubkey, account: &Account) -> Self {
        SavedAccount {
            address: address.to_string(),
            lamports: account.lamports,
            owner: account.owner.to_string(),
            executable: account.executable,
            rent_epoch: account.rent_epoch,
            data: base64::engine::general_purpose::STANDARD.encode(&account.data),
        }
    }

    pub fn decode(&self) -> Result<(Pubkey, Account), String> {
        let address = parse_key(&self.address)?;
        let data = base64::engine::general_purpose::STANDARD
            .decode(&self.data)
            .map_err(|e| format!("account {address}: data is not base64: {e}"))?;
        Ok((
            address,
            Account {
                lamports: self.lamports,
                data,
                owner: parse_key(&self.owner)?,
                executable: self.executable,
                rent_epoch: self.rent_epoch,
            },
        ))
    }
}

pub fn parse_key(text: &str) -> Result<Pubkey, String> {
    text.parse()
        .map_err(|_| format!("{text:?} is not a base58 address"))
}

impl Snapshot {
    pub fn read(path: &Path) -> Result<Self, String> {
        let snapshot = Self::read_any(path)?;
        if snapshot.format == FORMAT_1 {
            return Err(format!(
                "{} is in format {FORMAT_1:?}, which does not record the deployed build's step \
                 outcomes; record them with its baseline build: cargo run -p buy-wall-gate -- \
                 rerecord --fixture {} --build <the build whose hash it names>",
                path.display(),
                path.display()
            ));
        }
        Ok(snapshot)
    }

    /// Reads a snapshot in this format or the one before it, for `rerecord`, which records
    /// its whole baseline again and writes it in this format.
    pub fn read_any(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let snapshot: Snapshot = serde_json::from_str(&text)
            .map_err(|e| format!("{} is not a snapshot: {e}", path.display()))?;
        if snapshot.format != FORMAT && snapshot.format != FORMAT_1 {
            return Err(format!(
                "{} is in format {:?}; this build reads {FORMAT:?}",
                path.display(),
                snapshot.format
            ));
        }
        Ok(snapshot)
    }

    pub fn write(&self, path: &Path) -> Result<(), String> {
        let mut text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        text.push('\n');
        std::fs::write(path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
    }

    pub fn program_id(&self) -> Result<Pubkey, String> {
        parse_key(&self.program)
    }

    pub fn accounts(&self) -> Result<Vec<(Pubkey, Account)>, String> {
        self.accounts.iter().map(SavedAccount::decode).collect()
    }

    /// The executable of `program` as the snapshot holds it, from its ProgramData account.
    pub fn program_elf(&self, program: &Pubkey) -> Result<Option<Vec<u8>>, String> {
        let address = pda::program_data(program).to_string();
        let Some(saved) = self.accounts.iter().find(|a| a.address == address) else {
            return Ok(None);
        };
        let (_, account) = saved.decode()?;
        Ok(account
            .data
            .get(PROGRAMDATA_HEADER_LEN..)
            .map(<[u8]>::to_vec))
    }

    /// The same snapshot without the router's and the program's accounts and ProgramData,
    /// as the repo keeps fixtures: CI loads the pinned router and the build under test.
    pub fn without_programs(mut self) -> Result<Self, String> {
        let program = self.program_id()?;
        let dropped: Vec<String> = [
            program,
            pda::program_data(&program),
            pipeline_client::PROGRAM_ID,
            pda::program_data(&pipeline_client::PROGRAM_ID),
        ]
        .iter()
        .map(Pubkey::to_string)
        .collect();
        self.accounts.retain(|a| !dropped.contains(&a.address));
        Ok(self)
    }
}
