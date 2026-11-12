//! `exit_launch_clock`: sets the clock to each launch-clock position that is already past,
//! then buys and sells the reference size (`CANARY-09`, `CANARY-13`). The state is today's;
//! only the clock is set back, so the figures show the strategy's time rules, not what early
//! buyers got.
//!
//! - Fail: never; it is not the present.
//! - Warn: a launch-clock round trip fails, or returns more than the tolerance less than now.
//! - Pass: every one is within the tolerance of now.

use solana_clock::Clock;

use crate::checks::exit_sizes;
use crate::checks::exits::references;
use crate::checks::readable::Trading;
use crate::checks::timed::{self, Measured, Timed, TimedPair, Words};
use crate::clock;
use crate::config::LAUNCH_CLOCK_SECONDS;
use crate::record::{Outcome, Verdict};
use crate::swap::SwapPath;

/// A launch-clock position in words.
pub fn position(label: &str, offset: u64) -> String {
    if offset == 0 {
        "at the market's creation".to_string()
    } else {
        format!("{label} after creation")
    }
}

pub const WORDS: Words = Words {
    check: super::EXIT_LAUNCH_CLOCK,
    subject: |amount| format!("A round trip of {amount}"),
    base: "now",
    base_clause: |base| format!("now it gets back {base}"),
    one_buy: false,
    failed: "failed",
    pass: |tolerance, base, m| {
        let positions = m
            .pairs
            .first()
            .map_or(0, |p| p.rows.len().saturating_sub(1));
        format!("returns {tolerance} of now's {base} at every launch-clock position already past ({positions} of {})", LAUNCH_CLOCK_SECONDS.len())
    },
    note: " The state is today's; only the clock was set back.",
    ordinary_fails: false,
};

/// Round-trips the reference amount now, then at each launch-clock position already past,
/// each from a fresh copy.
pub fn measure(
    session: &mut crate::market::Session,
    path: &dyn SwapPath,
    sizes: &exit_sizes::Measured,
) -> Measured {
    let money = sizes.money;
    let created_at = session.market.record.created_at;
    let pairs = references(sizes)
        .into_iter()
        .map(|(token, reference)| {
            let Some(reference) = reference else {
                return TimedPair {
                    token,
                    reference: None,
                    rows: vec![],
                };
            };
            let now: Clock = session.base().get_sysvar();
            let positions = std::iter::once(("now".to_string(), Some(now.clone()), true)).chain(
                LAUNCH_CLOCK_SECONDS.iter().map(|(label, offset)| {
                    let then = created_at.saturating_add_unsigned(*offset);
                    (position(label, *offset), clock::at(&now, then), false)
                }),
            );
            let rows = positions
                .filter_map(|(words, at, ordinary)| at.map(|at| (words, at, ordinary)))
                .map(|(words, at, ordinary)| {
                    let mut svm = session.fresh();
                    clock::set(&mut svm, &at);
                    let trader = session.seed.wallet(
                        &session.market.address,
                        &format!("exit_launch_clock {token} {words}"),
                    );
                    let row = session.round_trip_in(
                        &mut svm,
                        path,
                        &trader,
                        money,
                        token,
                        reference.amount,
                    );
                    Timed {
                        position: words,
                        ordinary,
                        row,
                    }
                })
                .collect();
            TimedPair {
                token,
                reference: Some(reference),
                rows,
            }
        })
        .collect();
    Measured { pairs }
}

pub fn judge(m: &Measured, sizes: &exit_sizes::Measured, trading: &Trading) -> Verdict {
    let verdict = timed::judge(m, sizes, trading, &WORDS, false);
    // A market younger than the first launch-clock position has none in the past.
    if verdict.outcome == Outcome::Pass && m.pairs.iter().all(|p| p.rows.len() <= 1) {
        return Verdict::new(
            Outcome::NotRun,
            "Not run: no launch-clock position is in the past yet.",
            verdict.inputs,
            verdict.numbers,
        );
    }
    verdict
}
