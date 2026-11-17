//! Records of passing gate runs against a cluster, which the deploy script checks before it
//! deploys (docs/spec/pool4-for-solana.md, "A release gate").
//!
//! Records are kept per cluster, in `<dir>/<cluster>.json` (`devnet.json`), or
//! `local-<genesis hash prefix>.json` for a local validator, as a JSON list, newest last.
//! The repo keeps devnet's in `deployments/release-gate/buy-wall-amm/`, where a local
//! validator's are ignored by git.
//!
//! A record counts for a deploy only if it was made against the same cluster, for the same
//! build, against the build deployed there now, and covering every market there now: an
//! upgrade or a new market since the run means the gate must run again.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub program: String,
    pub genesis_hash: String,
    /// `devnet` and the like, when the genesis hash is a known cluster's.
    pub cluster: Option<String>,
    pub url: String,
    /// The slot and time of the snapshot the run checked.
    pub slot: u64,
    pub unix_timestamp: i64,
    /// When the run passed, Unix seconds.
    pub recorded_at: i64,
    pub candidate_sha256: String,
    /// The build deployed when the snapshot was taken; `None` before the first deploy.
    pub deployed_sha256: Option<String>,
    pub market_states: Vec<String>,
    pub pricing_change_declared: bool,
    /// The steps that failed but did not count, because the deployed build failed them the
    /// same way on the same snapshot: the markets nobody can fully trade, and why.
    #[serde(default)]
    pub shared_failures: Vec<SharedFailure>,
}

/// A step that failed under the candidate and the deployed build alike.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedFailure {
    pub market_state: String,
    pub step: String,
    /// The error, where it started, and how the deployed build failed.
    pub detail: String,
}

/// What a deploy is about to do, which a record must cover.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub program: String,
    pub genesis_hash: String,
    pub candidate_sha256: String,
    pub deployed_sha256: Option<String>,
    pub market_states: Vec<String>,
}

/// The file a cluster's records are kept in.
pub fn file(dir: &Path, genesis_hash: &str) -> PathBuf {
    let name = match pipeline_check::clone::cluster_name(genesis_hash) {
        Some(name) => name.to_string(),
        None => format!("local-{}", genesis_hash.get(..8).unwrap_or(genesis_hash)),
    };
    dir.join(format!("{name}.json"))
}

pub fn read(path: &Path) -> Result<Vec<Record>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|e| format!("{} is not a list of records: {e}", path.display()))
}

/// Adds `record` to its cluster's file.
pub fn append(dir: &Path, record: &Record) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = file(dir, &record.genesis_hash);
    let mut records = read(&path)?;
    records.push(record.clone());
    let mut text = serde_json::to_string_pretty(&records).map_err(|e| e.to_string())?;
    text.push('\n');
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(path)
}

/// The newest record in `dir` that covers `target`, or why there is none.
pub fn find(dir: &Path, target: &Target) -> Result<Record, String> {
    let path = file(dir, &target.genesis_hash);
    let records: Vec<Record> = read(&path)?
        .into_iter()
        .filter(|r| {
            r.program == target.program
                && r.genesis_hash == target.genesis_hash
                && r.candidate_sha256 == target.candidate_sha256
        })
        .collect();
    if let Some(record) = records
        .iter()
        .filter(|r| why_not(r, target).is_none())
        .max_by_key(|r| r.recorded_at)
    {
        return Ok(record.clone());
    }
    match records.iter().max_by_key(|r| r.recorded_at) {
        None => Err(format!(
            "no passing release gate run for build {} of {} on this cluster (genesis {}) in {}",
            target.candidate_sha256,
            target.program,
            target.genesis_hash,
            path.display()
        )),
        Some(newest) => Err(format!(
            "the last passing release gate run for this build no longer covers a deploy, so run \
             the gate again: {}",
            why_not(newest, target).unwrap_or_default()
        )),
    }
}

/// Why `record` does not cover `target`, if it does not.
fn why_not(record: &Record, target: &Target) -> Option<String> {
    if record.deployed_sha256 != target.deployed_sha256 {
        return Some(format!(
            "it checked against deployed build {}, but {} is deployed now",
            record.deployed_sha256.as_deref().unwrap_or("(none)"),
            target.deployed_sha256.as_deref().unwrap_or("(none)")
        ));
    }
    let missing: Vec<&str> = target
        .market_states
        .iter()
        .filter(|m| !record.market_states.contains(m))
        .map(String::as_str)
        .collect();
    (!missing.is_empty()).then(|| {
        format!(
            "it did not check market state(s) created since: {}",
            missing.join(", ")
        )
    })
}
