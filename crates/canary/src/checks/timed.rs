//! What `exit_hold`, `exit_late` and `exit_launch_clock` share: round trips of the reference
//! amount at several clock positions, each judged against the first, which is the present
//! (`CANARY-13`: a return more than the tolerance below it is a finding).

use serde::Serialize;
use serde_json::{json, Value};

use crate::checks::exit_sizes;
use crate::checks::exits::{
    across_pairs, below_tolerance, could_not_sell_back, round_trip_failure, tolerance_words,
    Committed, Money, PairVerdict, Reference,
};
use crate::checks::readable::Trading;
use crate::record::{Outcome, Verdict};
use crate::trade::RoundTrip;
use crate::words;

/// One round trip at one clock position.
#[derive(Clone, Debug, Serialize)]
pub struct Timed {
    /// Where the clock stood, in words: "after 1 day", "at the market's creation".
    pub position: String,
    /// Whether this is the ordinary trade: at the cluster's clock or the next slot.
    pub ordinary: bool,
    pub row: RoundTrip,
}

/// One pair's round trips; the first is the present, which the others are judged against.
#[derive(Clone, Debug, Serialize)]
pub struct TimedPair {
    pub token: usize,
    pub reference: Option<Reference>,
    pub rows: Vec<Timed>,
}

/// What one of the timed checks measured.
#[derive(Clone, Debug, Serialize)]
pub struct Measured {
    pub pairs: Vec<TimedPair>,
}

/// How a timed check words its findings.
pub struct Words {
    /// The check id, for `quote_matches_swap`'s words.
    pub check: &'static str,
    /// "A wallet that bought 0.01 SOL", given the amount's words.
    pub subject: fn(&str) -> String,
    /// What the first row is, in words: "in the same slot", "now".
    pub base: &'static str,
    /// The clause that gives the first row's return, given its words: "in the same slot it got
    /// back 99.5%".
    pub base_clause: fn(&str) -> String,
    /// Whether the first row's buy is part of every row (`exit_hold` buys once).
    pub one_buy: bool,
    /// The verb for a later row that did not come back: "could not sell", "failed".
    pub failed: &'static str,
    /// The sentence a pass ends with, given the tolerance's and the base return's words.
    pub pass: fn(&str, &str, &Measured) -> String,
    /// A sentence added to every reason with figures, such as the launch clock's caveat.
    pub note: &'static str,
    /// Whether the ordinary trade failing fails the check; otherwise the check never fails.
    pub ordinary_fails: bool,
}

impl Measured {
    /// Every swap committed, for `quote_matches_swap`.
    pub fn committed(&self, words: &Words) -> Vec<Committed> {
        let mut out = vec![];
        for pair in &self.pairs {
            for (i, timed) in pair.rows.iter().enumerate() {
                if i == 0 || !words.one_buy {
                    out.push(Committed {
                        leg: timed.row.buy.clone(),
                        ordinary: timed.ordinary,
                        context: format!("{}'s buy {}", words.check, timed.position),
                    });
                }
                if let Some(sell) = &timed.row.sell {
                    out.push(Committed {
                        leg: sell.clone(),
                        ordinary: timed.ordinary,
                        context: format!("{}'s sale {}", words.check, timed.position),
                    });
                }
            }
        }
        out
    }

    /// Whether any row is "a buyer could not sell back"; only `exit_hold` counts it.
    pub fn could_not_sell_back(&self) -> bool {
        self.pairs
            .iter()
            .flat_map(|p| p.rows.iter())
            .any(|t| could_not_sell_back(&t.row))
    }
}

fn numbers(m: &Measured, money: &Money, counts: bool) -> Value {
    json!({
        "could_not_sell_back": counts && m.could_not_sell_back(),
        "pairs": m.pairs.iter().map(|pair| json!({
            "token": pair.token,
            "amount": pair.reference.as_ref().map(|r| r.amount),
            "stand_in": pair.reference.as_ref().is_some_and(|r| r.stand_in),
            "rows": pair.rows.iter().map(|t| {
                let mut row = money.row(&t.row);
                row["position"] = json!(t.position);
                row
            }).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn inputs(m: &Measured) -> Value {
    json!({
        "pairs": m.pairs.iter().map(|pair| json!({
            "token": pair.token,
            "amount": pair.reference.as_ref().map(|r| r.amount),
            "stand_in": pair.reference.as_ref().is_some_and(|r| r.stand_in),
            "positions": pair.rows.iter().map(|t| t.position.clone()).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

/// The note when the amount stands in for the reference size.
pub fn stand_in_note(reference: &Reference, money: &Money) -> String {
    if reference.stand_in {
        format!(
            " The reference size could not be bought and sold back, so {} stands in for it.",
            money.amount(reference.amount)
        )
    } else {
        String::new()
    }
}

fn judge_pair(pair: &TimedPair, money: &Money, words: &Words, measured: &Measured) -> PairVerdict {
    let verdict = |outcome, reason| PairVerdict {
        token: pair.token,
        outcome,
        reason,
    };
    let Some(reference) = &pair.reference else {
        return verdict(
            Outcome::NotRun,
            "Not run: no size could be bought and sold back.".to_string(),
        );
    };
    let subject = (words.subject)(&money.amount(reference.amount));
    let stand_in = stand_in_note(reference, money);
    let Some(base) = pair.rows.first() else {
        return verdict(Outcome::NotRun, "Not run: no clock position.".to_string());
    };
    if let Err(failure) = &base.row.buy.swap {
        return verdict(
            Outcome::NotRun,
            format!(
                "Not run: the buy of {} failed {} ({failure}).",
                money.amount(reference.amount),
                words.base
            ),
        );
    }
    // The ordinary trade's failures fail; when the present cannot sell and its failures
    // cannot fail the check, there is nothing to measure against.
    let ordinary_stuck = pair
        .rows
        .iter()
        .filter(|_| words.ordinary_fails)
        .find(|t| t.ordinary && round_trip_failure(&t.row).is_some());
    if let Some(stuck) = ordinary_stuck {
        let why = round_trip_failure(&stuck.row).unwrap_or_default();
        return verdict(
            Outcome::Fail,
            format!(
                "{subject} {} {} ({why}).{stand_in}",
                words.failed, stuck.position
            ),
        );
    }
    let Some(base_ppm) = base.row.return_ppm() else {
        let why = round_trip_failure(&base.row).unwrap_or_default();
        return verdict(
            Outcome::NotRun,
            format!(
                "Not run: the round trip of {} {} did not come back ({why}).",
                money.amount(reference.amount),
                words.base
            ),
        );
    };
    let base_words = words::percent(base_ppm);
    let mut returns = vec![];
    let mut failures: Vec<(Vec<&str>, String)> = vec![];
    for timed in pair.rows.iter().skip(1) {
        match timed.row.return_ppm() {
            None => {
                let why = round_trip_failure(&timed.row).unwrap_or_default();
                match failures.iter_mut().find(|(_, w)| *w == why) {
                    Some((positions, _)) => positions.push(&timed.position),
                    None => failures.push((vec![&timed.position], why)),
                }
            }
            Some(ppm) if below_tolerance(base_ppm, ppm) => {
                returns.push(format!("{} {}", words::percent(ppm), timed.position));
            }
            Some(_) => {}
        }
    }
    if returns.is_empty() && failures.is_empty() {
        return verdict(
            Outcome::Pass,
            format!(
                "{subject} {}.{stand_in}",
                (words.pass)(&tolerance_words(), &base_words, measured)
            ),
        );
    }
    let mut parts = vec![];
    if !returns.is_empty() {
        parts.push(format!("got back {}", returns.join(", ")));
    }
    for (positions, why) in &failures {
        parts.push(format!("{} {} ({why})", words.failed, join_or(positions)));
    }
    verdict(
        Outcome::Warn,
        format!(
            "{subject} {}; {}.{}{stand_in}",
            parts.join(" and "),
            (words.base_clause)(&base_words),
            words.note
        ),
    )
}

/// "a", "a or b", "a, b or c".
fn join_or(items: &[&str]) -> String {
    match items {
        [] => String::new(),
        [one] => one.to_string(),
        [rest @ .., last] => format!("{} or {last}", rest.join(", ")),
    }
}

/// Judges a timed check. `counts` says whether its stuck sales are "a buyer could not sell
/// back".
pub fn judge(
    m: &Measured,
    sizes: &exit_sizes::Measured,
    trading: &Trading,
    words: &Words,
    counts: bool,
) -> Verdict {
    if let Trading::NotRun(why) = trading {
        return Verdict::not_run(format!("Not run: {why}."));
    }
    let money = Money(sizes);
    let pairs: Vec<PairVerdict> = m
        .pairs
        .iter()
        .map(|pair| judge_pair(pair, &money, words, m))
        .collect();
    let (outcome, reason) = across_pairs(&pairs);
    Verdict::new(outcome, reason, inputs(m), numbers(m, &money, counts))
}
