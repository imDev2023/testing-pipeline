//! `exit_sizes`: buys each size and sells everything bought in the same slot, each size
//! from a fresh copy and a new wallet.
//!
//! - Fail: at the reference size or the smallest size, the tokens cannot be sold back.
//! - Warn: at a larger size, the tokens cannot be sold back; or a step crashed or ran out of
//!   compute.
//! - Pass: every size that could be bought was sold back; sizes that could not be bought
//!   are listed and are not a finding.

use serde::Serialize;
use serde_json::{json, Value};

use crate::checks::readable::Trading;
use crate::failure::Failure;
use crate::market::{MintFacts, Session};
use crate::record::{Outcome, Verdict};
use crate::sizes::{share_of_vault_ppm, Ladder};
use crate::swap::SwapPath;
use crate::trade::RoundTrip;
use crate::words;

/// The sizes traded against one other mint.
#[derive(Clone, Debug, Serialize)]
pub struct Pair {
    pub token: usize,
    pub rows: Vec<RoundTrip>,
}

/// What the size ladder measured: one [`Pair`] for each mint other than the money side.
#[derive(Clone, Debug, Serialize)]
pub struct Measured {
    pub money: usize,
    pub ladder: Ladder,
    pub money_vault: u64,
    pub money_decimals: u8,
    /// The market's mints, for their transfer fees.
    #[serde(skip)]
    pub mints: Vec<MintFacts>,
    pub pairs: Vec<Pair>,
}

/// Round-trips every size of `ladder` against every other mint.
pub fn measure(
    session: &mut Session,
    path: &dyn SwapPath,
    money: usize,
    ladder: &Ladder,
    money_vault: u64,
) -> Measured {
    let n = session.market.len();
    let pairs = (0..n)
        .filter(|t| *t != money)
        .map(|token| Pair {
            token,
            rows: ladder
                .sizes
                .iter()
                .map(|amount| session.round_trip(path, money, token, *amount))
                .collect(),
        })
        .collect();
    Measured {
        money,
        ladder: ladder.clone(),
        money_vault,
        money_decimals: session.market.mints[money].decimals,
        mints: session.market.mints.clone(),
        pairs,
    }
}

impl Measured {
    pub fn amount(&self, amount: u64) -> String {
        words::money(amount, self.ladder.basis, self.money_decimals)
    }

    /// Whether `amount` is the smallest size or the reference size, the ordinary trade.
    pub fn is_ordinary_size(&self, amount: u64) -> bool {
        self.ladder.sizes.first() == Some(&amount) || self.ladder.reference == amount
    }
}

impl Pair {
    /// The row of the reference size, or the largest size that round-tripped standing in for
    /// it when the reference size could not; `None` when no size round-tripped.
    pub fn reference_row(&self, reference: u64) -> Option<(&RoundTrip, bool)> {
        let sold = |row: &&RoundTrip| row.sold().is_some();
        if let Some(row) = self
            .rows
            .iter()
            .filter(sold)
            .find(|r| r.amount == reference)
        {
            return Some((row, false));
        }
        self.rows.iter().rev().find(sold).map(|row| (row, true))
    }

    /// The ordinary trade's rows: the smallest size and the reference size (or its stand-in).
    pub fn ordinary_rows(&self, reference: u64) -> Vec<&RoundTrip> {
        let mut rows: Vec<&RoundTrip> = self.rows.first().into_iter().collect();
        if let Some((row, _)) = self.reference_row(reference) {
            if rows.first().map(|r| r.amount) != Some(row.amount) {
                rows.push(row);
            }
        }
        rows
    }
}

/// One size's figures, for the record.
fn size_numbers(m: &Measured, row: &RoundTrip) -> Value {
    json!({
        "amount": row.amount,
        "amount_words": m.amount(row.amount),
        "wallet": row.wallet.to_string(),
        "share_of_money_vault_ppm": share_of_vault_ppm(row.amount, m.money_vault),
        "bought": row.bought(),
        "put_in": row.put_in(),
        "tokens_bought": row.buy.swap.as_ref().ok().map(|r| r.trader_received),
        "sold_back": row.sold().is_some(),
        "got_back": row.sold().map(|r| r.trader_received),
        "return_ppm": row.return_ppm(),
        "buy_failure": row.buy.swap.as_ref().err(),
        "sale_failure": row.sale_failure(),
    })
}

pub fn numbers(m: &Measured) -> Value {
    json!({
        "money": m.money,
        "basis": m.ladder.basis,
        "money_vault": m.money_vault,
        "reference": m.ladder.reference,
        "pairs": m.pairs.iter().map(|pair| {
            let reference = pair.reference_row(m.ladder.reference);
            json!({
                "token": pair.token,
                "reference": m.ladder.reference,
                "stand_in": reference.filter(|(_, stand_in)| *stand_in).map(|(row, _)| row.amount),
                "sizes": pair.rows.iter().map(|row| size_numbers(m, row)).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
    })
}

fn inputs(m: &Measured) -> Value {
    json!({
        "sizes": m.ladder.sizes,
        "reference": m.ladder.reference,
        "basis": m.ladder.basis,
        "money": m.money,
        "tokens": m.pairs.iter().map(|p| p.token).collect::<Vec<_>>(),
        "sold": "everything bought, in the same slot",
    })
}

/// Every failure in the measurement.
fn failures(m: &Measured) -> impl Iterator<Item = &Failure> {
    m.pairs
        .iter()
        .flat_map(|p| p.rows.iter())
        .flat_map(|r| r.legs())
        .flat_map(|leg| leg.failures())
}

pub fn judge(m: &Measured, trading: &Trading) -> Verdict {
    if let Trading::NotRun(why) = trading {
        return Verdict::not_run(format!("Not run: {why}."));
    }
    let numbers = numbers(m);
    let inputs = inputs(m);
    let rows = || m.pairs.iter().flat_map(|p| p.rows.iter());
    let Some(_) = rows().find(|r| r.bought()) else {
        let why = rows().find_map(|r| r.buy.swap.as_ref().err()).map_or_else(
            || "every buy delivered nothing to sell".to_string(),
            |f| f.to_string(),
        );
        return Verdict::new(
            Outcome::NotRun,
            format!("Not run: no size could be bought ({why})."),
            inputs,
            numbers,
        );
    };
    let stuck: Vec<&RoundTrip> = rows()
        .filter(|r| r.bought() && r.sold().is_none())
        .collect();
    let sold: Vec<u64> = rows()
        .filter(|r| r.sold().is_some())
        .map(|r| r.amount)
        .collect();
    let unbought: Vec<String> = rows()
        .filter(|r| !r.bought())
        .map(|r| m.amount(r.amount))
        .collect();
    let unbought_note = if unbought.is_empty() {
        String::new()
    } else {
        format!(
            " {} could not be bought, which is not a finding.",
            unbought.join(", ")
        )
    };
    let mut ordinary: Vec<&&RoundTrip> = stuck
        .iter()
        .filter(|r| m.is_ordinary_size(r.amount))
        .collect();
    ordinary.sort_by_key(|r| r.amount);
    if let Some(first) = ordinary.first() {
        // The error shown is the first size named's own.
        let failure = first
            .sale_failure()
            .map_or_else(String::new, |f| format!(" ({f})"));
        let mut amounts: Vec<String> = ordinary.iter().map(|r| m.amount(r.amount)).collect();
        amounts.dedup();
        return Verdict::new(
            Outcome::Fail,
            format!(
                "A wallet that bought {} could not sell it back in the same slot{failure}.{unbought_note}",
                amounts.join(" or ")
            ),
            inputs,
            numbers,
        );
    }
    if let Some(smallest_stuck) = stuck.iter().min_by_key(|r| r.amount) {
        let failure = smallest_stuck
            .sale_failure()
            .map_or_else(String::new, |f| format!(" ({f})"));
        // "X or more" only when every size from X up that was bought is stuck.
        let all_above = rows()
            .filter(|r| r.bought() && r.amount >= smallest_stuck.amount)
            .all(|r| r.sold().is_none());
        let bought_words = if all_above {
            format!("{} or more", m.amount(smallest_stuck.amount))
        } else {
            let mut amounts: Vec<u64> = stuck.iter().map(|r| r.amount).collect();
            amounts.sort_unstable();
            amounts.dedup();
            amounts
                .iter()
                .map(|a| m.amount(*a))
                .collect::<Vec<_>>()
                .join(" or ")
        };
        let sold_words = sold
            .iter()
            .copied()
            .filter(|a| *a < smallest_stuck.amount)
            .max()
            .map_or_else(String::new, |largest| {
                format!("; buys of {} and less sold back", m.amount(largest))
            });
        return Verdict::new(
            Outcome::Warn,
            format!("A wallet that bought {bought_words} could not sell back{failure}{sold_words}.{unbought_note}"),
            inputs,
            numbers,
        );
    }
    if let Some(fault) = failures(m).find(|f| f.class.is_fault()) {
        return Verdict::new(
            Outcome::Warn,
            format!(
                "Every size that could be bought sold back, but {} hit {} ({}).{unbought_note}",
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
        format!(
            "Every size that could be bought sold back in the same slot ({} of {}).{unbought_note}",
            sold.len(),
            rows().count()
        ),
        inputs,
        numbers,
    )
}
