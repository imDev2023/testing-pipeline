//! # Where the tax goes
//!
//! [`split_tax`] books each tax to the slots it is owed to (docs/spec/tax-amm.md, "Where
//! the tax goes"): the suite share first, `floor(tax × SUITE_SHARE_BPS / 10,000)`, then the
//! creator's part, the rest, split by the market's shares, each recipient
//! `floor(rest × share / 10,000)` and the burn `floor(rest × burn_share_bps / 10,000)`,
//! with any rounding remainder to the first recipient. The parts always add up to the tax.
//!
//! A pure function taking no accounts, so the property tests (`tests/maths.rs`) exercise
//! exactly what the program runs.

use crate::config::{MAX_RECIPIENTS, SUITE_SHARE_BPS};
use crate::errors::StrategyError;
use crate::state::{BURN_SLOT, OWED_SLOTS, SUITE_SLOT};

/// Basis points in a whole, Pipeline's denominator.
const BPS: u128 = pipeline_strategy_interface::BPS_DENOMINATOR as u128;

/// Splits `tax` into what each slot is owed, by slot index: the tax recipients, then the
/// burn, then the suite share. The shares are a market's, which its creation rules make
/// sum to 10,000 with the burn share; shares that sum to more are refused.
pub fn split_tax(
    tax: u64,
    shares: &[u16; MAX_RECIPIENTS],
    burn_share_bps: u16,
) -> Result<[u64; OWED_SLOTS], StrategyError> {
    let tax = tax as u128;
    let suite = tax * SUITE_SHARE_BPS as u128 / BPS;
    let rest = tax - suite;
    let mut slots = [0u64; OWED_SLOTS];
    let mut booked: u128 = 0;
    for (slot, &share) in slots.iter_mut().zip(shares) {
        let part = rest * share as u128 / BPS;
        booked += part;
        *slot = part as u64;
    }
    let burn = rest * burn_share_bps as u128 / BPS;
    booked += burn;
    slots[BURN_SLOT] = burn as u64;
    slots[SUITE_SLOT] = suite as u64;
    // Each part rounds down, so what is left over is under one unit per part.
    let remainder = rest.checked_sub(booked).ok_or(StrategyError::Overflow)?;
    slots[0] = slots[0]
        .checked_add(remainder as u64)
        .ok_or(StrategyError::Overflow)?;
    Ok(slots)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_suite_share_comes_first_and_the_remainder_goes_to_the_first_recipient() {
        // A tax of 1,001: the suite share floor(100.1) = 100, the rest 901; 60% is 540.6 →
        // 540, 30% is 270.3 → 270, the burn's 10% 90.1 → 90, and the 1 left over goes to the
        // first recipient.
        let slots = split_tax(1_001, &[6_000, 3_000, 0, 0], 1_000).unwrap();
        assert_eq!(slots, [541, 270, 0, 0, 90, 100]);
        assert_eq!(slots.iter().sum::<u64>(), 1_001);
    }

    #[test]
    fn shares_that_sum_past_the_whole_are_refused() {
        assert!(matches!(
            split_tax(1_000, &[10_000, 10_000, 0, 0], 0),
            Err(StrategyError::Overflow)
        ));
    }
}
