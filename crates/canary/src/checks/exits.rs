//! What the exit checks over time and across wallets share (`docs/spec/pipescope-canary.md`,
//! "Exit test"): the amount they trade, how a round trip is described, how one market's
//! pairs come to one outcome, and the swaps they commit, which `quote_matches_swap` compares.
//!
//! Each of these checks trades the reference size against every mint other than the money
//! side, or, when the reference size could not be bought and sold back in `exit_sizes`, the
//! largest size that could, which stands in for it and is named as such.

use serde::Serialize;
use serde_json::{json, Value};

use crate::bands::{band, Band};
use crate::checks::exit_sizes;
use crate::config::{PPM, TOLERANCE_PPM};
use crate::failure::Failure;
use crate::record::Outcome;
use crate::trade::{Leg, RoundTrip};
use crate::words;

/// The amount one pair's exit checks trade.
#[derive(Clone, Debug, Serialize)]
pub struct Reference {
    /// The mint bought.
    pub token: usize,
    pub amount: u64,
    /// Whether `amount` stands in for a reference size that could not be bought and sold back.
    pub stand_in: bool,
    /// What the same round trip returned in `exit_sizes`, from the copy's own state.
    pub own_return_ppm: Option<u64>,
}

/// The reference amount of each pair `exit_sizes` traded, or `None` for a pair where no size
/// could be bought and sold back.
pub fn references(sizes: &exit_sizes::Measured) -> Vec<(usize, Option<Reference>)> {
    sizes
        .pairs
        .iter()
        .map(|pair| {
            let reference = pair
                .reference_row(sizes.ladder.reference)
                .map(|(row, stand_in)| Reference {
                    token: pair.token,
                    amount: row.amount,
                    stand_in,
                    own_return_ppm: row.return_ppm(),
                });
            (pair.token, reference)
        })
        .collect()
}

/// A swap one of these checks committed, for `quote_matches_swap`.
#[derive(Clone, Debug)]
pub struct Committed {
    pub leg: Leg,
    /// Whether it belongs to the ordinary trade: the reference size or its stand-in, at the
    /// cluster's clock or the next slot, by a fresh wallet in the copy's own state.
    pub ordinary: bool,
    /// Which check and step, in words: "exit_hold's sale after 1 day".
    pub context: String,
}

/// Why a round trip did not come back: the buy failed, it bought nothing to sell, or the sale
/// failed. `None` when it sold back.
pub fn round_trip_failure(row: &RoundTrip) -> Option<String> {
    if let Err(failure) = &row.buy.swap {
        return Some(format!("the buy failed: {failure}"));
    }
    match &row.sell {
        None => Some("the buy delivered nothing to sell".to_string()),
        Some(leg) => leg.swap.as_ref().err().map(Failure::to_string),
    }
}

/// Whether a wallet's buy worked and the sale of what it bought then failed: "a buyer could
/// not sell back" (`CANARY-21`).
pub fn could_not_sell_back(row: &RoundTrip) -> bool {
    row.buy.swap.is_ok() && row.sale_failure().is_some()
}

/// Whether `ppm` is more than the tolerance below `base` (`CANARY-13`).
pub fn below_tolerance(base: u64, ppm: u64) -> bool {
    base.saturating_sub(ppm) > TOLERANCE_PPM
}

/// "within 1.0 point".
pub fn tolerance_words() -> String {
    format!("within {}", words::points(TOLERANCE_PPM))
}

/// What `got_back` is of `put_in`, in parts per million rounded down.
pub fn return_ppm(put_in: u64, got_back: u64) -> Option<u64> {
    (put_in > 0).then(|| (got_back as u128 * PPM as u128 / put_in as u128) as u64)
}

/// The words for an amount on the money side.
pub struct Money<'a>(pub &'a exit_sizes::Measured);

impl Money<'_> {
    pub fn amount(&self, amount: u64) -> String {
        self.0.amount(amount)
    }

    /// "99.4% (0.01 SOL in, 0.00994 SOL back)".
    pub fn returned(&self, put_in: u64, got_back: u64) -> String {
        format!(
            "{} ({} in, {} back)",
            words::percent(return_ppm(put_in, got_back).unwrap_or(0)),
            self.amount(put_in),
            self.amount(got_back)
        )
    }

    /// A round trip's figures, for a record's numbers.
    pub fn row(&self, row: &RoundTrip) -> Value {
        json!({
            "wallet": row.wallet.to_string(),
            "amount": row.amount,
            "amount_words": self.amount(row.amount),
            "bought": row.bought(),
            "put_in": row.put_in(),
            "tokens_bought": row.buy.swap.as_ref().ok().map(|r| r.trader_received),
            "sold_back": row.sold().is_some(),
            "got_back": row.sold().map(|r| r.trader_received),
            "return_ppm": row.return_ppm(),
            "band": row.return_ppm().map(band),
            "clock": row.sell.as_ref().map_or(row.buy.clock, |s| s.clock),
            "buy_failure": row.buy.swap.as_ref().err(),
            "sale_failure": row.sale_failure(),
        })
    }
}

/// Whether `ppm` is in the pass band.
pub fn in_pass_band(ppm: u64) -> bool {
    band(ppm) == Band::Pass
}

/// One pair's outcome and reason.
#[derive(Clone, Debug)]
pub struct PairVerdict {
    pub token: usize,
    pub outcome: Outcome,
    pub reason: String,
}

fn severity(outcome: Outcome) -> u8 {
    match outcome {
        Outcome::Fail => 3,
        Outcome::Warn => 2,
        Outcome::Pass | Outcome::Noted => 1,
        Outcome::NotRun => 0,
    }
}

/// One market's outcome from its pairs': the most severe, with that pair's reason, naming the
/// mint when the market has more than one pair.
pub fn across_pairs(pairs: &[PairVerdict]) -> (Outcome, String) {
    let Some(worst) = pairs.iter().max_by_key(|p| severity(p.outcome)) else {
        return (
            Outcome::NotRun,
            "Not run: the market has no mint to buy.".to_string(),
        );
    };
    if pairs.iter().all(|p| p.reason == worst.reason) {
        return (worst.outcome, worst.reason.clone());
    }
    let reason = match worst.reason.strip_prefix("Not run: ") {
        Some(rest) => format!("Not run: buying mint {}, {rest}", worst.token),
        None => format!("Buying mint {}: {}", worst.token, worst.reason),
    };
    (worst.outcome, reason)
}
