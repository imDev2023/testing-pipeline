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
/// sum to 10,000 with the burn share; shares that do not are refused for every tax, so the
/// parts always add up to the tax and none exceeds it (docs/security/tax-amm, P1).
pub fn split_tax(
    tax: u64,
    shares: &[u16; MAX_RECIPIENTS],
    burn_share_bps: u16,
) -> Result<[u64; OWED_SLOTS], StrategyError> {
    let whole: u32 = shares.iter().map(|&share| share as u32).sum::<u32>() + burn_share_bps as u32;
    if whole as u128 != BPS {
        return Err(StrategyError::SharesNotWhole);
    }
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
    // Each part rounds down, so what is left over is under one unit per part; with whole
    // shares this never fails (proofs/pricing_z3.py, P1).
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
    fn shares_that_are_not_the_whole_are_refused_whatever_the_tax() {
        for tax in [0, 1, 9, 1_000, u64::MAX] {
            for (shares, burn) in [
                ([10_000, 10_000, 0, 0], 0),
                ([10_001, 0, 0, 0], 0),
                ([5_000, 0, 0, 0], 4_999),
                ([u16::MAX; 4], u16::MAX),
            ] {
                assert!(
                    matches!(
                        split_tax(tax, &shares, burn),
                        Err(StrategyError::SharesNotWhole)
                    ),
                    "tax {tax}, shares {shares:?}, burn {burn}"
                );
            }
        }
    }
}

// Kani proofs of the split (`cargo kani`, docs/toolchain.md), in the pricing's tiers
// (`crate::pricing`); the property IDs are docs/security/tax-amm/maths-properties.md's. Z3
// proves P1 for every tax (`proofs/pricing_z3.py`).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound on the tax in the bounded tier.
    const TAX_SMALL: u64 = 1 << 10;

    /// The shares of a valid market: each recipient's share and the burn share, summing to
    /// 10,000 (the creation rules also put used slots first, which the maths does not need).
    fn whole_shares() -> ([u16; MAX_RECIPIENTS], u16) {
        let shares: [u16; MAX_RECIPIENTS] = kani::any();
        let burn: u16 = kani::any();
        kani::assume(
            shares.iter().map(|&share| share as u32).sum::<u32>() + burn as u32 == BPS as u32,
        );
        (shares, burn)
    }

    /// P1 and N1: for every tax and any shares at all, the split never panics; when it books
    /// the tax, the suite share, the recipients' parts and the burn add up to exactly the
    /// tax and none exceeds it; and shares that are not the whole are always refused.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_split_adds_up_to_the_tax_or_is_refused() {
        let tax: u64 = kani::any();
        let shares: [u16; MAX_RECIPIENTS] = kani::any();
        let burn: u16 = kani::any();
        let whole = shares.iter().map(|&share| share as u32).sum::<u32>() + burn as u32;
        match split_tax(tax, &shares, burn) {
            Ok(slots) => {
                assert!(whole == BPS as u32);
                assert!(slots.iter().map(|&part| part as u128).sum::<u128>() == tax as u128);
                assert!(slots.iter().all(|&part| part <= tax));
            }
            Err(error) => {
                if whole != BPS as u32 {
                    assert!(matches!(error, StrategyError::SharesNotWhole));
                }
            }
        }
    }

    /// P1: with whole shares the split always books the tax: each part is its share rounded
    /// down, the suite share first, and what rounding leaves, under one unit a part, goes to
    /// the first recipient.
    fn assert_whole_shares_always_split(tax: u64) {
        let (shares, burn) = whole_shares();
        let slots = split_tax(tax, &shares, burn).unwrap();
        let suite = tax as u128 * SUITE_SHARE_BPS as u128 / BPS;
        assert!(slots[SUITE_SLOT] as u128 == suite);
        let rest = tax as u128 - suite;
        assert!(slots[BURN_SLOT] as u128 == rest * burn as u128 / BPS);
        for i in 1..MAX_RECIPIENTS {
            assert!(slots[i] as u128 == rest * shares[i] as u128 / BPS);
        }
        let first = rest * shares[0] as u128 / BPS;
        assert!(slots[0] as u128 >= first && (slots[0] as u128) < first + OWED_SLOTS as u128 - 1);
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn whole_shares_always_split_bounded() {
        assert_whole_shares_always_split(kani::any_where(|&tax| tax < TAX_SMALL));
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn whole_shares_always_split() {
        assert_whole_shares_always_split(kani::any());
    }
}
