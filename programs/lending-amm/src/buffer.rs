//! # The buffer's rule
//!
//! What `rebalance` does, as a pure function of numbers (docs/spec/lending-pool.md, "The
//! rule"): the buffer's share of the lent side is `B / L`, where `L = B + V`.
//!
//! - Inside the band, `BUFFER_MIN_BPS` to `BUFFER_MAX_BPS` with both edges included, there is
//!   nothing to do: [`plan`] refuses with `WithinBand`, so a keeper's simulation shows it and
//!   nobody pays for a no-op.
//! - Above the band it deposits `B - t` into Kamino, and below it redeems `t - B`, capped at
//!   what Kamino can pay right now, where `t = floor(L x BUFFER_TARGET_BPS / 10,000)` is the
//!   target buffer.
//! - A move smaller than the lent mint's `MIN_REBALANCE` is skipped: [`plan`] refuses with
//!   `BelowMinRebalance`.
//!
//! So at the rate the move is planned at, a deposit lands the buffer exactly on its target, an
//! uncapped redeem asks for exactly the target, and no move ever carries the buffer past its
//! target. Kamino then rounds in its own favour, by at most one cToken's worth
//! ([`crate::kamino::ctokens_to_redeem`] and klend's deposit), which the instruction measures
//! rather than assumes. Proptest checks these properties here, Kani proves them below, and
//! `proofs/buffer_z3.py` proves them with Z3 for every input.

use crate::config::{BUFFER_MAX_BPS, BUFFER_MIN_BPS, BUFFER_TARGET_BPS};
use crate::errors::StrategyError;

/// Basis points in a whole.
const BPS: u128 = 10_000;

/// Where the buffer's share of the lent side sits against the band.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Band {
    /// Below `BUFFER_MIN_BPS`.
    Below,
    /// From `BUFFER_MIN_BPS` to `BUFFER_MAX_BPS`, both included.
    Within,
    /// Above `BUFFER_MAX_BPS`.
    Above,
}

/// What `rebalance` should move, in the lent mint's base units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Move {
    /// Deposit this much of the buffer into Kamino.
    Deposit(u64),
    /// Redeem cTokens worth this much from Kamino into the buffer.
    Redeem(u64),
}

/// Where `buffer` sits in the band, as a share of `lent_total` (`L = B + V`), compared
/// exactly in u128. An empty lent side is within the band: there is nothing to move.
pub fn band(buffer: u64, lent_total: u64) -> Band {
    let scaled = buffer as u128 * BPS;
    if scaled < lent_total as u128 * BUFFER_MIN_BPS as u128 {
        Band::Below
    } else if scaled > lent_total as u128 * BUFFER_MAX_BPS as u128 {
        Band::Above
    } else {
        Band::Within
    }
}

/// The target buffer, `floor(L x BUFFER_TARGET_BPS / 10,000)`.
pub fn target(lent_total: u64) -> u64 {
    // At most L, since BUFFER_TARGET_BPS is below 10,000.
    (lent_total as u128 * BUFFER_TARGET_BPS as u128 / BPS) as u64
}

/// What `rebalance` should move for a market whose buffer is `buffer` out of a lent side of
/// `lent_total` (at least `buffer`), when Kamino can pay `kamino_can_pay` right now and the lent
/// mint's `MIN_REBALANCE` is `min_rebalance`.
pub fn plan(
    buffer: u64,
    lent_total: u64,
    kamino_can_pay: u64,
    min_rebalance: u64,
) -> Result<Move, StrategyError> {
    let t = target(lent_total);
    let planned = match band(buffer, lent_total) {
        Band::Within => return Err(StrategyError::WithinBand),
        // Above the band B x 10,000 > L x 3,000 >= t x 10,000, so B > t.
        Band::Above => Move::Deposit(buffer.saturating_sub(t)),
        Band::Below => Move::Redeem(t.saturating_sub(buffer).min(kamino_can_pay)),
    };
    let (Move::Deposit(amount) | Move::Redeem(amount)) = planned;
    if amount == 0 || amount < min_rebalance {
        return Err(StrategyError::BelowMinRebalance);
    }
    Ok(planned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn code(result: Result<Move, StrategyError>) -> Result<Move, u32> {
        result.map_err(|error| error as u32)
    }

    #[test]
    fn the_band_includes_its_edges() {
        // 10% and 30% of 1,000 are inside; one unit beyond either is outside.
        assert_eq!(band(100, 1_000), Band::Within);
        assert_eq!(band(300, 1_000), Band::Within);
        assert_eq!(band(99, 1_000), Band::Below);
        assert_eq!(band(301, 1_000), Band::Above);
        assert_eq!(band(0, 0), Band::Within);
        assert_eq!(band(1_000, 1_000), Band::Above);
    }

    #[test]
    fn the_examples_move_the_buffer_to_its_target() {
        // All 50 in the buffer: deposit 40, leaving the 10 that are 20% of 50.
        assert_eq!(code(plan(50, 50, 0, 1)), Ok(Move::Deposit(40)));
        // 5 of 100 in the buffer: redeem 15.
        assert_eq!(code(plan(5, 100, 1_000, 1)), Ok(Move::Redeem(15)));
        // Kamino can pay only 4 right now.
        assert_eq!(code(plan(5, 100, 4, 1)), Ok(Move::Redeem(4)));
        // Inside the band.
        assert_eq!(
            code(plan(20, 100, 1_000, 1)),
            Err(StrategyError::WithinBand as u32)
        );
        // Below the floor, whichever way, and a redeem Kamino can pay nothing of.
        assert_eq!(
            code(plan(50, 50, 0, 41)),
            Err(StrategyError::BelowMinRebalance as u32)
        );
        assert_eq!(
            code(plan(5, 100, 1_000, 16)),
            Err(StrategyError::BelowMinRebalance as u32)
        );
        assert_eq!(
            code(plan(5, 100, 0, 0)),
            Err(StrategyError::BelowMinRebalance as u32)
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Inside the band nothing moves; outside it the move only ever goes towards the
        /// target, lands a deposit exactly on it and an uncapped redeem exactly on it, never
        /// carries the buffer past it, never redeems more than Kamino can pay, and is never
        /// below the floor.
        #[test]
        fn the_move_lands_on_the_target_and_never_crosses_it(
            buffer: u64,
            lent_value: u64,
            can_pay: u64,
            min_rebalance in 0u64..=100_000_000,
        ) {
            let Some(lent_total) = buffer.checked_add(lent_value) else { return Ok(()) };
            let t = target(lent_total);
            match plan(buffer, lent_total, can_pay, min_rebalance) {
                Ok(Move::Deposit(d)) => {
                    prop_assert_eq!(band(buffer, lent_total), Band::Above);
                    prop_assert_eq!(buffer - d, t);
                    prop_assert!(d >= min_rebalance && d > 0);
                }
                Ok(Move::Redeem(r)) => {
                    prop_assert_eq!(band(buffer, lent_total), Band::Below);
                    prop_assert!(buffer + r <= t);
                    prop_assert!(r <= can_pay);
                    prop_assert!(r == t - buffer || r == can_pay);
                    prop_assert!(r >= min_rebalance && r > 0);
                }
                Err(StrategyError::WithinBand) => {
                    prop_assert_eq!(band(buffer, lent_total), Band::Within);
                }
                Err(StrategyError::BelowMinRebalance) => {
                    prop_assert!(band(buffer, lent_total) != Band::Within);
                    let wanted = if buffer > t { buffer - t } else { (t - buffer).min(can_pay) };
                    prop_assert!(wanted == 0 || wanted < min_rebalance);
                }
                Err(other) => prop_assert!(false, "unexpected {:?}", other),
            }
        }

        /// The band's comparison is the buffer's share in basis points, exactly.
        #[test]
        fn the_band_is_the_share_in_basis_points(buffer: u64, lent_value: u64) {
            let Some(lent_total) = buffer.checked_add(lent_value) else { return Ok(()) };
            prop_assume!(lent_total > 0);
            let share = buffer as u128 * BPS;
            let expected = if share < lent_total as u128 * BUFFER_MIN_BPS as u128 {
                Band::Below
            } else if share > lent_total as u128 * BUFFER_MAX_BPS as u128 {
                Band::Above
            } else {
                Band::Within
            };
            prop_assert_eq!(band(buffer, lent_total), expected);
        }
    }
}

// Kani proofs of the rule (`cargo kani`, docs/toolchain.md), in the tiers `pricing.rs` uses:
// full domain for what needs no reasoning about a quotient (nothing panics or overflows), the
// rule's properties bounded below `SMALL`, and the same properties for every input behind
// `RUSTFLAGS="--cfg kani_full"`, which may not finish. `proofs/buffer_z3.py` proves them
// for every input with Z3.
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the bounded tier, on the buffer, the lent value, what Kamino can pay and the
    /// floor.
    const SMALL: u64 = 1 << 8;

    /// For any buffer, lent total, payable amount and floor, the rule runs without panicking.
    #[kani::proof]
    fn plan_never_panics() {
        let _ = plan(kani::any(), kani::any(), kani::any(), kani::any());
    }

    fn assert_lands_on_target_and_never_crosses(
        buffer: u64,
        lent_value: u64,
        can_pay: u64,
        min_rebalance: u64,
    ) {
        let Some(lent_total) = buffer.checked_add(lent_value) else {
            return;
        };
        let t = target(lent_total);
        match plan(buffer, lent_total, can_pay, min_rebalance) {
            Ok(Move::Deposit(d)) => {
                assert!(band(buffer, lent_total) == Band::Above);
                assert!(d <= buffer && buffer - d == t);
                assert!(d >= min_rebalance && d > 0);
            }
            Ok(Move::Redeem(r)) => {
                assert!(band(buffer, lent_total) == Band::Below);
                assert!(buffer as u128 + r as u128 <= t as u128);
                assert!(r <= can_pay && (r == t - buffer || r == can_pay));
                assert!(r >= min_rebalance && r > 0);
            }
            Err(StrategyError::WithinBand) => assert!(band(buffer, lent_total) == Band::Within),
            Err(StrategyError::BelowMinRebalance) => {
                assert!(band(buffer, lent_total) != Band::Within);
                // The move it would have made is nothing or below the floor.
                let wanted = if buffer > t {
                    buffer - t
                } else {
                    (t - buffer).min(can_pay)
                };
                assert!(wanted == 0 || wanted < min_rebalance);
            }
            Err(_) => panic!("plan only refuses inside the band or below the floor"),
        }
    }

    /// The band is the buffer's share in basis points, compared exactly, both edges inside:
    /// bounded below 2^16, since CBMC checks the products' equality slowly over every u64; the
    /// full domain behind `kani_full`, and `proofs/buffer_z3.py` for every input.
    #[kani::proof]
    fn the_band_is_the_share_in_basis_points_bounded() {
        assert_band_is_the_share(
            kani::any_where(|&b| b < (1 << 16)),
            kani::any_where(|&l| l < (1 << 16)),
        );
    }

    #[cfg(kani_full)]
    #[kani::proof]
    fn the_band_is_the_share_in_basis_points() {
        assert_band_is_the_share(kani::any(), kani::any());
    }

    fn assert_band_is_the_share(buffer: u64, lent_total: u64) {
        let share = buffer as u128 * BPS;
        let low = lent_total as u128 * BUFFER_MIN_BPS as u128;
        let high = lent_total as u128 * BUFFER_MAX_BPS as u128;
        match band(buffer, lent_total) {
            Band::Below => assert!(share < low),
            Band::Within => assert!(low <= share && share <= high),
            Band::Above => assert!(share > high),
        }
    }

    fn assert_target_is_the_floor(lent_total: u64) {
        let t = target(lent_total) as u128;
        let scaled = lent_total as u128 * BUFFER_TARGET_BPS as u128;
        // t = floor(L x BUFFER_TARGET_BPS / 10,000), stated without a division, and at most L.
        assert!(t * BPS <= scaled && scaled < (t + 1) * BPS);
        assert!(t <= lent_total as u128);
    }

    /// The target is exactly `floor(L x BUFFER_TARGET_BPS / 10,000)`, at most `L`: bounded
    /// below 2^16; `proofs/buffer_z3.py` proves it for every input.
    #[kani::proof]
    fn the_target_is_the_floor_of_its_share_bounded() {
        assert_target_is_the_floor(kani::any_where(|&l| l < (1 << 16)));
    }

    #[cfg(kani_full)]
    #[kani::proof]
    fn the_target_is_the_floor_of_its_share() {
        assert_target_is_the_floor(kani::any());
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_move_lands_on_the_target_and_never_crosses_it_bounded() {
        assert_lands_on_target_and_never_crosses(
            kani::any_where(|&b| b < SMALL),
            kani::any_where(|&v| v < SMALL),
            kani::any_where(|&p| p < SMALL),
            kani::any_where(|&m| m < SMALL),
        );
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_move_lands_on_the_target_and_never_crosses_it() {
        assert_lands_on_target_and_never_crosses(
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
        );
    }
}
