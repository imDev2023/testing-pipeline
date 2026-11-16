//! `exit_late`: moves the clock forward by each wait, then buys and sells the reference size
//! (`CANARY-08`, `CANARY-13`).
//!
//! - Fail: never; it is not the present.
//! - Warn: a later round trip fails, or returns more than the tolerance less than now.
//! - Pass: every later round trip is within the tolerance of now.

use solana_clock::Clock;

use crate::checks::exit_sizes;
use crate::checks::exits::references;
use crate::checks::readable::Trading;
use crate::checks::timed::{self, Measured, Timed, TimedPair, Words};
use crate::clock;
use crate::config::{Wait, WAITS};
use crate::record::Verdict;
use crate::swap::SwapPath;

/// A wait, in the words of a trader arriving after it.
pub fn later(label: &str, wait: Wait) -> String {
    match wait {
        Wait::SameSlot => "now".to_string(),
        Wait::NextSlot => "a slot later".to_string(),
        Wait::Seconds(_) => format!("{label} later"),
    }
}

pub const WORDS: Words = Words {
    check: super::EXIT_LATE,
    subject: |amount| format!("A round trip of {amount}"),
    base: "now",
    base_clause: |base| format!("now it gets back {base}"),
    one_buy: false,
    failed: "failed",
    pass: |tolerance, base, _| {
        format!(
            "returns {tolerance} of now's {base} at every later time, up to {} later",
            WAITS[WAITS.len() - 1].0
        )
    },
    note: "",
    ordinary_fails: false,
};

/// Round-trips the reference amount at each wait from now, each from a fresh copy.
pub fn measure(
    session: &mut crate::market::Session,
    path: &dyn SwapPath,
    sizes: &exit_sizes::Measured,
) -> Measured {
    let money = sizes.money;
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
            let rows = WAITS
                .iter()
                .map(|(label, wait)| {
                    let mut svm = session.fresh();
                    let now: Clock = svm.get_sysvar();
                    clock::set(&mut svm, &clock::after(&now, *wait));
                    let trader = session.seed.wallet(
                        &session.market.address,
                        &format!("exit_late {token} {label}"),
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
                        position: later(label, *wait),
                        ordinary: matches!(wait, Wait::SameSlot | Wait::NextSlot),
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
    timed::judge(m, sizes, trading, &WORDS, false)
}
