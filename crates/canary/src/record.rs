//! Canary results and the per-version roll-up (`CANARY-10`, `CANARY-20`;
//! `docs/spec/pipescope-canary.md`, "Outcomes" and "Records").

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::market::Version;

/// One of the five outcomes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub enum Outcome {
    #[serde(rename = "pass")]
    Pass,
    #[serde(rename = "warn")]
    Warn,
    #[serde(rename = "fail")]
    Fail,
    #[serde(rename = "not run")]
    NotRun,
    #[serde(rename = "noted")]
    Noted,
}

impl Outcome {
    pub fn words(self) -> &'static str {
        match self {
            Outcome::Pass => "pass",
            Outcome::Warn => "warn",
            Outcome::Fail => "fail",
            Outcome::NotRun => "not run",
            Outcome::Noted => "noted",
        }
    }
}

/// What a check concluded, before the run's context is added.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Verdict {
    pub outcome: Outcome,
    /// One sentence, written by code.
    pub reason: String,
    pub inputs: Value,
    pub numbers: Value,
}

impl Verdict {
    pub fn new(outcome: Outcome, reason: impl Into<String>, inputs: Value, numbers: Value) -> Self {
        Verdict {
            outcome,
            reason: reason.into(),
            inputs,
            numbers,
        }
    }

    pub fn not_run(reason: impl Into<String>) -> Self {
        Verdict::new(Outcome::NotRun, reason, Value::Null, Value::Null)
    }
}

/// One Canary result: one check on one market, strategy version and slot.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Record {
    /// The check, the market, the strategy version's deploy slot and the run's slot.
    pub id: String,
    pub check: String,
    pub harness: String,
    pub cluster: Option<String>,
    pub slot: u64,
    /// Unix seconds.
    pub run_at: u64,
    pub strategy: Option<String>,
    pub strategy_version: Version,
    pub router_version: Version,
    pub market: String,
    pub inputs: Value,
    pub outcome: Outcome,
    pub reason: String,
    pub numbers: Value,
}

/// The run's context, shared by every record of one market.
#[derive(Clone, Debug)]
pub struct RecordContext {
    pub cluster: Option<String>,
    pub slot: u64,
    pub run_at: u64,
    pub strategy: Option<String>,
    pub strategy_version: Version,
    pub router_version: Version,
    pub market: String,
}

impl RecordContext {
    pub fn record(&self, check: &str, verdict: Verdict) -> Record {
        let deploy_slot = self
            .strategy_version
            .deploy_slot
            .map_or_else(|| "unknown".to_string(), |s| s.to_string());
        Record {
            id: format!("{check}:{}:{deploy_slot}:{}", self.market, self.slot),
            check: check.to_string(),
            harness: crate::config::HARNESS.to_string(),
            cluster: self.cluster.clone(),
            slot: self.slot,
            run_at: self.run_at,
            strategy: self.strategy.clone(),
            strategy_version: self.strategy_version.clone(),
            router_version: self.router_version.clone(),
            market: self.market.clone(),
            inputs: verdict.inputs,
            outcome: verdict.outcome,
            reason: verdict.reason,
            numbers: verdict.numbers,
        }
    }
}

/// One check's outcomes across a strategy version's markets.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CheckRollup {
    /// Markets per outcome.
    pub outcomes: BTreeMap<String, usize>,
    /// The markets that warn or fail.
    pub warn: Vec<String>,
    pub fail: Vec<String>,
}

/// A strategy version's roll-up: for each check, how many markets got each outcome.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Rollup {
    pub harness: String,
    pub strategy: Option<String>,
    pub strategy_version: Version,
    pub markets: usize,
    /// Markets the version cannot read: `readable` fails.
    pub stranded: usize,
    pub checks: BTreeMap<String, CheckRollup>,
}

/// Rolls records up by strategy version, in the order versions first appear.
pub fn rollups(records: &[Record]) -> Vec<Rollup> {
    let mut out: Vec<Rollup> = vec![];
    for record in records {
        let index = match out.iter().position(|r| {
            r.strategy == record.strategy && r.strategy_version == record.strategy_version
        }) {
            Some(index) => index,
            None => {
                out.push(Rollup {
                    harness: crate::config::HARNESS.to_string(),
                    strategy: record.strategy.clone(),
                    strategy_version: record.strategy_version.clone(),
                    markets: 0,
                    stranded: 0,
                    checks: BTreeMap::new(),
                });
                out.len() - 1
            }
        };
        let rollup = &mut out[index];
        let check = rollup.checks.entry(record.check.clone()).or_default();
        *check
            .outcomes
            .entry(record.outcome.words().to_string())
            .or_default() += 1;
        match record.outcome {
            Outcome::Warn => check.warn.push(record.market.clone()),
            Outcome::Fail => check.fail.push(record.market.clone()),
            _ => {}
        }
    }
    for rollup in &mut out {
        rollup.markets = rollup
            .checks
            .values()
            .map(|c| c.outcomes.values().sum::<usize>())
            .max()
            .unwrap_or(0);
        rollup.stranded = rollup
            .checks
            .get(crate::checks::READABLE)
            .map_or(0, |c| c.fail.len());
    }
    out
}
