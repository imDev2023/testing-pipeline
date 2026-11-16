//! `exit_hold`: buys the reference size, then sells after each wait, each wait from the same
//! bought state (`CANARY-08`, `CANARY-13`).
//!
//! - Fail: the sale fails in the same slot or the next.
//! - Warn: after a longer wait the sale fails, or returns more than the tolerance less than
//!   in the same slot.
//! - Pass: every wait sells within the tolerance of the same slot.

use solana_clock::Clock;

use crate::checks::exit_sizes;
use crate::checks::exits::references;
use crate::checks::readable::Trading;
use crate::checks::timed::{self, Measured, Timed, TimedPair, Words};
use crate::clock;
use crate::config::{Wait, WAITS};
use crate::record::Verdict;
use crate::swap::SwapPath;
use crate::trade::RoundTrip;

/// A wait, in the words of a sale after it.
pub fn after_wait(label: &str, wait: Wait) -> String {
    match wait {
        Wait::SameSlot => "in the same slot".to_string(),
        Wait::NextSlot => "in the next slot".to_string(),
        Wait::Seconds(_) => format!("after {label}"),
    }
}

pub const WORDS: Words = Words {
    check: super::EXIT_HOLD,
    subject: |amount| format!("A wallet that bought {amount}"),
    base: "in the same slot",
    base_clause: |base| format!("in the same slot it got back {base}"),
    one_buy: true,
    failed: "could not sell",
    pass: |tolerance, base, _| {
        format!(
            "sold {tolerance} of the same slot's {base} after every wait, up to {}",
            WAITS[WAITS.len() - 1].0
        )
    },
    note: "",
    ordinary_fails: true,
};

/// Buys once per pair, then sells everything bought after each wait, each from a copy of the
/// bought state.
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
            let mut bought = session.fresh();
            let trader = session
                .seed
                .wallet(&session.market.address, &format!("exit_hold {token}"));
            session.fund(&mut bought, &trader, money, token, reference.amount);
            let buy = session.leg(&mut bought, path, &trader, money, token, reference.amount);
            let now: Clock = bought.get_sysvar();
            let rows = WAITS
                .iter()
                .map(|(label, wait)| {
                    let mut svm = bought.clone();
                    clock::set(&mut svm, &clock::after(&now, *wait));
                    let sell = session.sell_all(&mut svm, path, &buy, &trader, token, money);
                    Timed {
                        position: after_wait(label, *wait),
                        ordinary: matches!(wait, Wait::SameSlot | Wait::NextSlot),
                        row: RoundTrip {
                            amount: reference.amount,
                            wallet: trader,
                            buy: buy.clone(),
                            sell,
                        },
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
    timed::judge(m, sizes, trading, &WORDS, true)
}
