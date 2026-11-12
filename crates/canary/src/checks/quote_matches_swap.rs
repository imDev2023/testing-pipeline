//! `quote_matches_swap`: compares every swap the run commits, in every exit check, with the quote taken in the
//! same state just before it: output received, input sent, Pipeline's fee, and the trader's
//! own balance changes.
//!
//! - Fail: in the ordinary trade, any difference, a quoted swap that fails, or a swap that
//!   works when its quote failed.
//! - Warn: the same at another size or clock position; or a step crashed or ran out of
//!   compute.
//! - Pass: every compared swap equals its quote; the count is reported.
//!
//! Canary trades exact-in only; exact-out quoting stays in the conformance report.

use serde_json::{json, Value};

use crate::checks::exit_sizes::Measured;
use crate::checks::exits::Committed;
use crate::checks::readable::Trading;
use crate::record::{Outcome, Verdict};
use crate::trade::{Disagreement, Leg};

/// A leg with whether it belongs to the ordinary trade.
struct Compared<'a> {
    leg: &'a Leg,
    ordinary: bool,
    role: &'static str,
    /// The check and step it came from, for a swap of a check other than `exit_sizes`.
    context: Option<&'a str>,
}

fn legs<'a>(m: &'a Measured, others: &'a [Committed]) -> Vec<Compared<'a>> {
    // Every swap of `exit_sizes` is at the cluster's current clock and sold back in the same
    // slot, so its ordinary trade is the ordinary sizes; the other checks say which of
    // theirs are.
    let mut out: Vec<Compared> = m
        .pairs
        .iter()
        .flat_map(|pair| pair.rows.iter())
        .flat_map(|row| {
            let ordinary = m.is_ordinary_size(row.amount);
            std::iter::once(Compared {
                leg: &row.buy,
                ordinary,
                role: "buy",
                context: None,
            })
            .chain(row.sell.as_ref().map(|leg| Compared {
                leg,
                ordinary,
                role: "sale",
                context: None,
            }))
        })
        .collect();
    out.extend(others.iter().map(|c| Compared {
        leg: &c.leg,
        ordinary: c.ordinary,
        role: if c.leg.input == m.money {
            "buy"
        } else {
            "sale"
        },
        context: Some(&c.context),
    }));
    out
}

fn describe(m: &Measured, c: &Compared, disagreement: &Disagreement) -> String {
    let size = match (c.context, c.role) {
        (Some(context), "buy") => format!("{context} of {}", m.amount(c.leg.amount_in)),
        (Some(context), _) => format!("{context} of {} units bought", c.leg.amount_in),
        (None, "buy") => format!("the buy of {}", m.amount(c.leg.amount_in)),
        (None, _) => format!("the sale of {} units bought", c.leg.amount_in),
    };
    match disagreement {
        Disagreement::Figures { fields } => {
            format!("{size} differed from its quote in {}", fields.join(", "))
        }
        Disagreement::QuotedSwapFailed => format!(
            "{size} was quoted and then failed ({})",
            c.leg
                .swap
                .as_ref()
                .err()
                .map_or_else(String::new, |f| f.to_string())
        ),
        Disagreement::SwapWithoutQuote => format!(
            "{size} went through although its quote failed ({})",
            c.leg
                .quote
                .as_ref()
                .err()
                .map_or_else(String::new, |f| f.to_string())
        ),
    }
}

fn numbers(m: &Measured, compared: &[Compared]) -> Value {
    json!({
        "swaps": compared.iter().filter(|c| c.leg.swap.is_ok() || c.leg.quote.is_ok()).count(),
        "compared": compared.iter().filter(|c| c.leg.compared()).count(),
        "matched": compared.iter().filter(|c| c.leg.compared() && c.leg.disagreement().is_none()).count(),
        "disagreements": compared.iter().filter_map(|c| c.leg.disagreement().map(|d| json!({
            "role": c.role,
            "ordinary": c.ordinary,
            "amount_in": c.leg.amount_in,
            "input": c.leg.input,
            "output": c.leg.output,
            "clock": c.leg.clock,
            "disagreement": d,
            "quote": c.leg.quote.as_ref().ok(),
            "quote_failure": c.leg.quote.as_ref().err(),
            "swap": c.leg.swap.as_ref().ok(),
            "swap_failure": c.leg.swap.as_ref().err(),
            "words": describe(m, c, &d),
        }))).collect::<Vec<_>>(),
    })
}

/// Judges every swap of `exit_sizes` and the `others` the other exit checks committed.
pub fn judge(m: &Measured, trading: &Trading, others: &[Committed]) -> Verdict {
    if let Trading::NotRun(why) = trading {
        return Verdict::not_run(format!("Not run: {why}."));
    }
    let compared = legs(m, others);
    let numbers = numbers(m, &compared);
    let inputs = json!({ "swaps": "every swap the run committed", "mode": "exact-in" });
    let disagreements: Vec<(&Compared, Disagreement)> = compared
        .iter()
        .filter_map(|c| c.leg.disagreement().map(|d| (c, d)))
        .collect();
    let count = compared.iter().filter(|c| c.leg.compared()).count();
    if let Some((c, d)) = disagreements.iter().find(|(c, _)| c.ordinary) {
        return Verdict::new(
            Outcome::Fail,
            format!("In the ordinary trade, {}.", describe(m, c, d)),
            inputs,
            numbers,
        );
    }
    if let Some((c, d)) = disagreements.first() {
        return Verdict::new(
            Outcome::Warn,
            format!(
                "The ordinary trade matched its quotes, but {} ({} of {count} compared swaps differ).",
                describe(m, c, d),
                disagreements.len()
            ),
            inputs,
            numbers,
        );
    }
    if count == 0 {
        return Verdict::new(
            Outcome::NotRun,
            "Not run: no swap went through with a quote to compare it with.",
            inputs,
            numbers,
        );
    }
    let fault = compared
        .iter()
        .flat_map(|c| c.leg.failures())
        .find(|f| f.class.is_fault());
    if let Some(fault) = fault {
        return Verdict::new(
            Outcome::Warn,
            format!(
                "All {count} compared swaps equal their quotes, but {} hit {} ({}).",
                fault.stage.describe(),
                fault.class.words(),
                fault.error_words()
            ),
            inputs,
            numbers,
        );
    }
    Verdict::new(
        Outcome::Pass,
        format!("All {count} compared swaps equal their quotes to the unit."),
        inputs,
        numbers,
    )
}
