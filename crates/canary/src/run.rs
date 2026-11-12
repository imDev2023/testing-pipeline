//! A Canary run on one market (`docs/spec/pipescope-canary.md`, "How a run works"): copy
//! the market, measure each check in fresh copies of it, judge, and write one record per
//! check; or, when the snapshot lacks an account a trade names, answer with the missing
//! addresses instead.

use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

use pipeline_check::{clone::cluster_name, CheckOptions};
use pipeline_client::Pubkey;
use serde::Serialize;

use crate::checks::{self, conformance, cost, exit_sizes, quote_matches_swap, readable};
use crate::market::{token_amount, Copy, Session, Version};
use crate::record::{Record, RecordContext, Verdict};
use crate::sizes::{ladder, money_side, Side};
use crate::source::{ClockMemo, Source};
use crate::swap::{SwapPath, ThroughRouter};
use crate::wallets::Seed;

/// How to run.
pub struct RunOptions {
    /// `TradeRequest::extra` on every quote and swap; Canary's own runs pass none.
    pub extra: Vec<u8>,
    /// Whether this is the last snapshot the run will get: if so, checks that still lack
    /// accounts are "not run", naming them, instead of the run asking for them.
    pub last_round: bool,
    /// The licence seam's swap function.
    pub swap: &'static dyn SwapPath,
    /// The run's seed, from which every wallet comes; `None` picks a new random one. The
    /// snapshot rounds of one run pass the seed the first round answered with.
    pub seed: Option<Seed>,
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions {
            extra: vec![],
            last_round: true,
            swap: &ThroughRouter,
            seed: None,
        }
    }
}

/// The records of one market's run.
#[derive(Clone, Debug, Serialize)]
pub struct MarketResults {
    pub records: Vec<Record>,
    /// What the copy or the run could not do, for the operator's information.
    pub notes: Vec<String>,
    /// The seed the run's wallets came from.
    #[serde(skip)]
    pub seed: Seed,
}

impl MarketResults {
    /// The record of `check`.
    ///
    /// # Panics
    /// If the run wrote none, which it always does for every check it runs.
    pub fn record(&self, check: &str) -> &Record {
        self.records
            .iter()
            .find(|r| r.check == check)
            .unwrap_or_else(|| panic!("no record for {check}"))
    }
}

/// What a run on one market produced.
#[derive(Clone, Debug)]
pub enum MarketRun {
    Results(MarketResults),
    /// Addresses the snapshot lacks that a trade named, in the order first asked for, and
    /// the seed to post the next round with.
    Missing {
        addresses: Vec<Pubkey>,
        seed: Seed,
    },
}

impl MarketRun {
    pub fn into_results(self) -> Option<MarketResults> {
        match self {
            MarketRun::Results(results) => Some(results),
            MarketRun::Missing { .. } => None,
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn naming(accounts: &BTreeSet<Pubkey>) -> String {
    let list: Vec<String> = accounts.iter().map(|k| k.to_string()).collect();
    format!(
        "Not run: the snapshot lacks {} the trades name: {}.",
        if list.len() == 1 {
            "an account"
        } else {
            "accounts"
        },
        list.join(", ")
    )
}

/// Runs every check on `market`, reading from `source`.
pub fn run_market(source: &mut dyn Source, market: Pubkey, options: &RunOptions) -> MarketRun {
    let run_at = now();
    let seed = options.seed.unwrap_or_else(Seed::random);
    let mut clock = ClockMemo::new(source);
    let copy = Copy::build(&mut clock, market, &CheckOptions::default());
    let cluster = clock.last.take();
    let copy_lacking: BTreeSet<Pubkey> = source.missing().into_iter().collect();
    let copy = match copy {
        Ok(copy) => copy,
        Err(error) => {
            if !copy_lacking.is_empty() && !options.last_round {
                return MarketRun::Missing {
                    addresses: source.missing(),
                    seed,
                };
            }
            let reason = if copy_lacking.is_empty() {
                format!("Not run: the market could not be copied ({error}).")
            } else {
                naming(&copy_lacking)
            };
            let context = RecordContext {
                cluster: cluster
                    .as_ref()
                    .and_then(|c| c.genesis_hash.as_deref())
                    .and_then(cluster_name)
                    .map(str::to_string),
                slot: cluster.map_or(0, |c| c.slot),
                run_at,
                strategy: None,
                strategy_version: Version::default(),
                router_version: Version::default(),
                market: market.to_string(),
            };
            return MarketRun::Results(MarketResults {
                records: checks::CHECKS
                    .iter()
                    .map(|check| context.record(check, Verdict::not_run(&reason)))
                    .collect(),
                notes: vec![error],
                seed,
            });
        }
    };
    let context = RecordContext {
        cluster: copy
            .cluster
            .genesis_hash
            .as_deref()
            .and_then(cluster_name)
            .map(str::to_string),
        slot: copy.cluster.slot,
        run_at,
        strategy: Some(copy.market.strategy().to_string()),
        strategy_version: copy.strategy_version.clone(),
        router_version: copy.router_version.clone(),
        market: market.to_string(),
    };
    let mut session = Session::new(&copy, source, options.extra.clone(), seed);

    let sides: Vec<Side> = session
        .market
        .mints
        .iter()
        .enumerate()
        .map(|(i, mint)| Side {
            is_wrapped_sol: mint.is_wrapped_sol(),
            supply: mint.supply,
            vault: token_amount(session.base(), &session.market.vault(i)).unwrap_or(0),
        })
        .collect();
    let money = money_side(&sides);
    let sizes = ladder(
        sides[money].is_wrapped_sol,
        sides[money].vault,
        session.market.mints[money].decimals,
    );

    session.begin_measurement();
    let readable_measured = readable::measure(&mut session, money, sizes.sizes[0]);
    let readable_lacking = session.lacking_since_begin();
    let (readable_verdict, trading) = readable::judge(&readable_measured);

    session.begin_measurement();
    let sizes_measured = match trading {
        readable::Trading::Open => exit_sizes::measure(
            &mut session,
            options.swap,
            money,
            &sizes,
            sides[money].vault,
        ),
        readable::Trading::NotRun(_) => exit_sizes::Measured {
            money,
            ladder: sizes.clone(),
            money_vault: sides[money].vault,
            money_decimals: session.market.mints[money].decimals,
            mints: session.market.mints.clone(),
            pairs: vec![],
        },
    };
    let sizes_lacking = session.lacking_since_begin();

    let mut lacking = copy_lacking.clone();
    lacking.extend(readable_lacking.iter().copied());
    lacking.extend(sizes_lacking.iter().copied());
    if !lacking.is_empty() && !options.last_round {
        return MarketRun::Missing {
            addresses: source_order(&lacking, &session),
            seed,
        };
    }
    // The trading checks rest on readable's verdict when it closed trading, so they also
    // lack whatever readable's probes lacked.
    let mut trading_lacking = sizes_lacking.clone();
    if matches!(trading, readable::Trading::NotRun(_)) {
        trading_lacking.extend(readable_lacking.iter().copied());
    }
    let gate = |own: &BTreeSet<Pubkey>, verdict: Verdict| {
        let mut needed = copy_lacking.clone();
        needed.extend(own.iter().copied());
        if needed.is_empty() {
            verdict
        } else {
            Verdict::not_run(naming(&needed))
        }
    };
    let records = vec![
        context.record(checks::READABLE, gate(&readable_lacking, readable_verdict)),
        context.record(
            checks::CONFORMANCE,
            gate(
                &BTreeSet::new(),
                conformance::run(&copy, options.swap.runs_router()),
            ),
        ),
        context.record(
            checks::EXIT_SIZES,
            gate(
                &trading_lacking,
                exit_sizes::judge(&sizes_measured, &trading),
            ),
        ),
        context.record(
            checks::QUOTE_MATCHES_SWAP,
            gate(
                &trading_lacking,
                quote_matches_swap::judge(&sizes_measured, &trading),
            ),
        ),
        context.record(
            checks::COST,
            gate(&trading_lacking, cost::judge(&sizes_measured, &trading)),
        ),
    ];
    let mut notes = copy.notes.clone();
    notes.extend(session.notes.iter().cloned());
    MarketRun::Results(MarketResults {
        records,
        notes,
        seed,
    })
}

/// The lacking addresses in the order the source was first asked for them.
fn source_order(lacking: &BTreeSet<Pubkey>, session: &Session) -> Vec<Pubkey> {
    session
        .source_missing()
        .into_iter()
        .filter(|k| lacking.contains(k))
        .collect()
}

/// Records, roll-ups and notes from runs over several markets.
#[derive(Clone, Debug, Serialize)]
pub struct Sweep {
    pub harness: String,
    pub records: Vec<Record>,
    pub rollups: Vec<crate::record::Rollup>,
    /// What each market's copy or run could not do, by market.
    pub notes: std::collections::BTreeMap<String, Vec<String>>,
}

/// Runs every check on each of `markets` in turn, each market on its own, and rolls the
/// records up by strategy version. A source that lacks accounts answers with results anyway
/// (its affected checks "not run"), because a sweep has no one to ask for more.
pub fn sweep(source: &mut dyn Source, markets: &[Pubkey], options: &RunOptions) -> Sweep {
    let options = RunOptions {
        extra: options.extra.clone(),
        last_round: true,
        swap: options.swap,
        seed: None,
    };
    let mut records = vec![];
    let mut notes = std::collections::BTreeMap::new();
    for market in markets {
        if let MarketRun::Results(results) = run_market(source, *market, &options) {
            records.extend(results.records);
            if !results.notes.is_empty() {
                notes.insert(market.to_string(), results.notes);
            }
        }
    }
    Sweep {
        harness: crate::config::HARNESS.to_string(),
        rollups: crate::record::rollups(&records),
        records,
        notes,
    }
}
