//! A Canary run on one market (`docs/spec/pipescope-canary.md`, "How a run works"): copy
//! the market, measure each check in fresh copies of it, judge, and write one record per
//! check; or, when the snapshot lacks an account a trade names, answer with the missing
//! addresses instead.

use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

use pipeline_check::{clone::cluster_name, CheckOptions};
use pipeline_client::Pubkey;
use serde::Serialize;

use crate::checks::{
    self, conformance, contained_mint, cost, direct_call, exit_hold, exit_late, exit_launch_clock,
    exit_queue, exit_sizes, exit_transferred, exit_wallets, outside_supply, quote_matches_swap,
    readable, timed, token_authorities, transaction_accounts,
};
use crate::market::{token_amount, Copy, Session, Version};
use crate::record::{Record, RecordContext, Verdict};
use crate::sizes::{ladder, money_side, Side};
use crate::source::{ClockMemo, Source};
use crate::swap::SwapPath;
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
    /// The strategy version's instruction list, from the snapshot (`PIPESCOPE-92`).
    pub instructions: Option<checks::custom_instructions::StrategyInstructions>,
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions {
            extra: vec![],
            last_round: true,
            swap: crate::config::SWAP_PATH,
            seed: None,
            instructions: None,
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
                    .map(|check| match *check {
                        // Read from the instruction list alone, never the copy.
                        checks::CUSTOM_INSTRUCTIONS => context.record(
                            check,
                            checks::custom_instructions::judge(options.instructions.as_ref()),
                        ),
                        _ => context.record(check, Verdict::not_run(&reason)),
                    })
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

    // The checks over time and across wallets trade the reference size `exit_sizes` found,
    // each in fresh copies of its own, and each notes the accounts it lacked.
    let open = matches!(trading, readable::Trading::Open);
    let path = options.swap;
    let none = || timed::Measured { pairs: vec![] };
    let (hold, hold_lacking) = measuring(&mut session, open, none(), |s| {
        exit_hold::measure(s, path, &sizes_measured)
    });
    let (late, late_lacking) = measuring(&mut session, open, none(), |s| {
        exit_late::measure(s, path, &sizes_measured)
    });
    let (launch, launch_lacking) = measuring(&mut session, open, none(), |s| {
        exit_launch_clock::measure(s, path, &sizes_measured)
    });
    let no_wallets = exit_wallets::Measured {
        insiders: vec![],
        pairs: vec![],
    };
    let (wallets, wallets_lacking) = measuring(&mut session, open, no_wallets, |s| {
        exit_wallets::measure(s, path, &sizes_measured)
    });
    let no_transfers = exit_transferred::Measured { pairs: vec![] };
    let (transferred, transferred_lacking) = measuring(&mut session, open, no_transfers, |s| {
        exit_transferred::measure(s, path, &sizes_measured)
    });
    // Canary's own evidence on each contained mint, which `conformance`'s known-failure rule
    // needs (R2T-10); a trade like any other, so it runs even when trading is closed and
    // simply shows no refusal by the hook then.
    let reference = sizes.sizes[0];
    let (hook_probe, hook_probe_lacking) = measuring(&mut session, true, vec![], |s| {
        conformance::probe_hook(s, path, reference)
    });
    let no_queue = exit_queue::Measured { pairs: vec![] };
    let (queue, queue_lacking) = measuring(&mut session, open, no_queue, |s| {
        exit_queue::measure(s, path, &sizes_measured)
    });

    // The control checks, each in fresh copies of its own.
    let first_token = (0..session.market.len()).find(|t| *t != money);
    let (direct_measured, direct_lacking) = measuring(&mut session, open, None, |s| {
        first_token.map(|token| direct_call::measure(s, money, token, sizes.reference))
    });
    let reference_words = sizes_measured.amount(sizes.reference);
    let (authorities_measured, authorities_lacking) = measuring(&mut session, open, None, |s| {
        Some(token_authorities::measure(
            s,
            path,
            money,
            sizes.reference,
            reference_words,
        ))
    });
    let (hooked_mints, hooks_lacking) =
        measuring(&mut session, true, vec![], contained_mint::measure);
    let (outside_measured, outside_lacking) = measuring(&mut session, open, None, |s| {
        Some(outside_supply::measure(s, path, money, sizes.reference))
    });

    let mut lacking = copy_lacking.clone();
    for own in [
        &readable_lacking,
        &sizes_lacking,
        &hold_lacking,
        &late_lacking,
        &launch_lacking,
        &wallets_lacking,
        &transferred_lacking,
        &queue_lacking,
        &direct_lacking,
        &authorities_lacking,
        &hooks_lacking,
        &outside_lacking,
    ] {
        lacking.extend(own.iter().copied());
    }
    if !lacking.is_empty() && !options.last_round {
        return MarketRun::Missing {
            addresses: source_order(&lacking, &session),
            seed,
        };
    }
    // The trading checks rest on readable's verdict when it closed trading, so they also
    // lack whatever readable's probes lacked; and every check over time and across wallets
    // rests on the size ladder's reference amount.
    let closed_lacking: BTreeSet<Pubkey> = if open {
        BTreeSet::new()
    } else {
        readable_lacking.clone()
    };
    let with = |own: &BTreeSet<Pubkey>, also: &BTreeSet<Pubkey>| {
        let mut all = closed_lacking.clone();
        all.extend(own.iter().copied());
        all.extend(also.iter().copied());
        all
    };
    let trading_lacking = with(&sizes_lacking, &BTreeSet::new());
    let mut every_swap_lacking = trading_lacking.clone();
    for own in [
        &hold_lacking,
        &late_lacking,
        &launch_lacking,
        &wallets_lacking,
        &transferred_lacking,
        &queue_lacking,
    ] {
        every_swap_lacking.extend(own.iter().copied());
    }
    let direct_needed = with(&direct_lacking, &BTreeSet::new());
    let authorities_needed = with(&authorities_lacking, &BTreeSet::new());
    let outside_needed = with(&outside_lacking, &BTreeSet::new());
    let money_words = |amount: u64| sizes_measured.amount(amount);
    let gate = |own: &BTreeSet<Pubkey>, verdict: Verdict| {
        let mut needed = copy_lacking.clone();
        needed.extend(own.iter().copied());
        if needed.is_empty() {
            verdict
        } else {
            Verdict::not_run(naming(&needed))
        }
    };
    let mut committed = hold.committed(&exit_hold::WORDS);
    committed.extend(late.committed(&exit_late::WORDS));
    committed.extend(launch.committed(&exit_launch_clock::WORDS));
    committed.extend(wallets.committed());
    committed.extend(transferred.committed());
    committed.extend(queue.committed());
    let records = vec![
        context.record(checks::READABLE, gate(&readable_lacking, readable_verdict)),
        context.record(
            checks::CONFORMANCE,
            gate(
                &hook_probe_lacking,
                conformance::run(&copy, options.swap.runs_router(), &hook_probe),
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
            checks::EXIT_HOLD,
            gate(
                &with(&sizes_lacking, &hold_lacking),
                exit_hold::judge(&hold, &sizes_measured, &trading),
            ),
        ),
        context.record(
            checks::EXIT_LATE,
            gate(
                &with(&sizes_lacking, &late_lacking),
                exit_late::judge(&late, &sizes_measured, &trading),
            ),
        ),
        context.record(
            checks::EXIT_LAUNCH_CLOCK,
            gate(
                &with(&sizes_lacking, &launch_lacking),
                exit_launch_clock::judge(&launch, &sizes_measured, &trading),
            ),
        ),
        context.record(
            checks::EXIT_WALLETS,
            gate(
                &with(&sizes_lacking, &wallets_lacking),
                exit_wallets::judge(&wallets, &sizes_measured, &trading),
            ),
        ),
        context.record(
            checks::EXIT_TRANSFERRED,
            gate(
                &with(&sizes_lacking, &transferred_lacking),
                exit_transferred::judge(&transferred, &sizes_measured, &trading),
            ),
        ),
        context.record(
            checks::EXIT_QUEUE,
            gate(
                &with(&sizes_lacking, &queue_lacking),
                exit_queue::judge(&queue, &sizes_measured, &trading),
            ),
        ),
        context.record(
            checks::QUOTE_MATCHES_SWAP,
            gate(
                &every_swap_lacking,
                quote_matches_swap::judge(&sizes_measured, &trading, &committed),
            ),
        ),
        context.record(
            checks::COST,
            gate(&trading_lacking, cost::judge(&sizes_measured, &trading)),
        ),
        context.record(
            checks::DIRECT_CALL,
            gate(
                &direct_needed,
                direct_call::judge(
                    direct_measured.as_ref(),
                    &trading,
                    &market,
                    sizes_measured.amount(sizes.reference),
                ),
            ),
        ),
        context.record(
            checks::TOKEN_AUTHORITIES,
            gate(
                &authorities_needed,
                token_authorities::judge(authorities_measured.as_ref(), &trading, &money_words),
            ),
        ),
        // Every resolution of the run, so it comes after every other measurement.
        context.record(
            checks::TRANSACTION_ACCOUNTS,
            gate(&lacking, transaction_accounts::judge(&session.resolutions)),
        ),
        context.record(
            checks::CONTAINED_MINT,
            gate(&hooks_lacking, contained_mint::judge(&hooked_mints)),
        ),
        context.record(
            checks::OUTSIDE_SUPPLY,
            gate(
                &outside_needed,
                outside_supply::judge(outside_measured.as_ref(), &trading, &money_words),
            ),
        ),
        context.record(
            checks::CUSTOM_INSTRUCTIONS,
            checks::custom_instructions::judge(options.instructions.as_ref()),
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

/// Runs one check's measurement when trading is open, otherwise takes `empty`, and returns
/// it with the accounts the snapshot lacked that the measurement asked for.
fn measuring<T>(
    session: &mut Session,
    open: bool,
    empty: T,
    measure: impl FnOnce(&mut Session) -> T,
) -> (T, BTreeSet<Pubkey>) {
    session.begin_measurement();
    let measured = if open { measure(session) } else { empty };
    (measured, session.lacking_since_begin())
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
        // One strategy version's list must never be judged as another's.
        instructions: None,
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
