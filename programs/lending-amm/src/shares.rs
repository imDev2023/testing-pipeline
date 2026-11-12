//! # LP shares
//!
//! The share maths, in pure functions that take no accounts (docs/spec/lending-pool.md,
//! "Shares" and "Adding"), so Proptest, Kani and Z3 can check them on their own.
//!
//! A market's share count is `N = LP mint supply + MINIMUM_LIQUIDITY`: the locked minimum
//! is never minted, so it can never be withdrawn, and it stops the first depositor from
//! inflating the value of one share. `add_liquidity` is the only instruction here that
//! moves `N`.

use crate::config::MINIMUM_LIQUIDITY;
use crate::errors::StrategyError;

/// What a deposit takes and mints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deposit {
    /// The LP shares minted to the LP.
    pub shares: u64,
    /// What the market takes of the other side.
    pub other: u64,
    /// What the market takes of the lent side.
    pub lent: u64,
}

/// The market's share count for an LP mint supply.
pub fn share_count(lp_supply: u64) -> Result<u64, StrategyError> {
    lp_supply
        .checked_add(MINIMUM_LIQUIDITY)
        .ok_or(StrategyError::Overflow)
}

/// The first deposit takes both amounts in full, both above 0, sets the price, and mints
/// `isqrt(other x lent) - MINIMUM_LIQUIDITY` shares, which must be above 0.
pub fn first_deposit(other: u64, lent: u64) -> Result<Deposit, StrategyError> {
    if other == 0 || lent == 0 {
        return Err(StrategyError::ZeroDeposit);
    }
    let root = isqrt(other as u128 * lent as u128);
    if root <= MINIMUM_LIQUIDITY {
        return Err(StrategyError::FirstDepositTooSmall);
    }
    Ok(Deposit {
        shares: root - MINIMUM_LIQUIDITY,
        other,
        lent,
    })
}

/// A later deposit at the current ratio `R : L` with share count `N`: it mints
/// `min(max_other x N / R, max_lent x N / L)` shares, rounded down, and takes only the
/// amounts those shares are worth, `shares x R / N` and `shares x L / N`, rounded up, so
/// it never mints more than its share of either side.
pub fn later_deposit(
    max_other: u64,
    max_lent: u64,
    reserve_other: u64,
    reserve_lent: u64,
    share_count: u64,
) -> Result<Deposit, StrategyError> {
    if reserve_other == 0 || reserve_lent == 0 || share_count == 0 {
        return Err(StrategyError::EmptySide);
    }
    let n = share_count as u128;
    let by_other = max_other as u128 * n / reserve_other as u128;
    let by_lent = max_lent as u128 * n / reserve_lent as u128;
    let shares = by_other.min(by_lent);
    if shares == 0 {
        return Err(StrategyError::ZeroShares);
    }
    // The share count must stay a u64 after the deposit.
    let shares = u64::try_from(shares).map_err(|_| StrategyError::Overflow)?;
    share_count
        .checked_add(shares)
        .ok_or(StrategyError::Overflow)?;
    let worth = |reserve: u64| -> u64 {
        // At most the offered amount, since shares x reserve / N <= max, so a u64.
        (shares as u128 * reserve as u128).div_ceil(n) as u64
    };
    Ok(Deposit {
        shares,
        other: worth(reserve_other),
        lent: worth(reserve_lent),
    })
}

/// The integer square root, `floor(sqrt(n))`, digit by digit: at most 64 rounds, and no
/// floating point.
pub fn isqrt(n: u128) -> u64 {
    let mut rest = n;
    let mut root: u128 = 0;
    // The highest power of four not above n.
    let mut bit: u128 = 1 << 126;
    while bit > rest {
        bit >>= 2;
    }
    while bit != 0 {
        if rest >= root + bit {
            rest -= root + bit;
            root = (root >> 1) + bit;
        } else {
            root >>= 1;
        }
        bit >>= 2;
    }
    // The root of a u128 is below 2^64.
    root as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn isqrt_at_the_edges() {
        assert_eq!(isqrt(0), 0);
        assert_eq!(isqrt(1), 1);
        assert_eq!(isqrt(3), 1);
        assert_eq!(isqrt(4), 2);
        assert_eq!(isqrt(u128::MAX), u64::MAX);
        assert_eq!(isqrt((u64::MAX as u128) * (u64::MAX as u128)), u64::MAX);
    }

    /// A result with its error as the error's number, so results can be compared.
    fn code(result: Result<Deposit, StrategyError>) -> Result<Deposit, u32> {
        result.map_err(|error| error as u32)
    }

    #[test]
    fn the_first_deposit_at_its_boundary() {
        assert_eq!(
            code(first_deposit(1_001, 1_001)),
            Ok(Deposit {
                shares: 1,
                other: 1_001,
                lent: 1_001
            })
        );
        assert_eq!(
            code(first_deposit(1_000, 1_000)),
            Err(StrategyError::FirstDepositTooSmall as u32)
        );
        assert_eq!(
            code(first_deposit(0, 5)),
            Err(StrategyError::ZeroDeposit as u32)
        );
        assert_eq!(
            code(first_deposit(5, 0)),
            Err(StrategyError::ZeroDeposit as u32)
        );
        assert!(first_deposit(u64::MAX, u64::MAX).is_ok());
    }

    #[test]
    fn a_later_deposit_at_the_ratio() {
        // R : L = 1 : 2, N = 1,000: 10 and 20 mint 10 shares and take exactly that.
        assert_eq!(
            code(later_deposit(10, 50, 1_000, 2_000, 1_000)),
            Ok(Deposit {
                shares: 10,
                other: 10,
                lent: 20
            })
        );
        // Rounding up the takes: 1 share of R = 3, L = 3, N = 2 is worth 1.5 of each.
        assert_eq!(
            code(later_deposit(2, 2, 3, 3, 2)),
            Ok(Deposit {
                shares: 1,
                other: 2,
                lent: 2
            })
        );
        assert_eq!(
            code(later_deposit(1, 1, 10, 10, 1)),
            Err(StrategyError::ZeroShares as u32)
        );
        assert_eq!(
            code(later_deposit(1, 1, 0, 10, 1)),
            Err(StrategyError::EmptySide as u32)
        );
        assert_eq!(
            code(later_deposit(u64::MAX, u64::MAX, 1, 1, u64::MAX)),
            Err(StrategyError::Overflow as u32)
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        #[test]
        fn isqrt_is_the_floor_of_the_square_root(n: u128) {
            let root = isqrt(n) as u128;
            prop_assert!(root * root <= n);
            prop_assert!((root + 1).checked_mul(root + 1).is_none_or(|next| next > n));
        }

        /// The first deposit's shares, with the locked minimum, never exceed what the two
        /// amounts back: (shares + MINIMUM_LIQUIDITY)^2 <= other x lent.
        #[test]
        fn the_first_deposits_shares_never_exceed_what_the_amounts_back(other: u64, lent: u64) {
            if let Ok(deposit) = first_deposit(other, lent) {
                let total = (deposit.shares + MINIMUM_LIQUIDITY) as u128;
                prop_assert!(total * total <= other as u128 * lent as u128);
                prop_assert_eq!((deposit.other, deposit.lent), (other, lent));
            }
        }

        /// A later deposit never mints more than its share of either side,
        /// shares / N <= taken / reserve, and never takes more than offered.
        #[test]
        fn a_later_deposit_never_mints_more_than_its_share_of_either_side(
            max_other: u64,
            max_lent: u64,
            reserve_other in 1u64..,
            reserve_lent in 1u64..,
            share_count in 1u64..,
        ) {
            if let Ok(d) = later_deposit(max_other, max_lent, reserve_other, reserve_lent, share_count) {
                let n = share_count as u128;
                prop_assert!(d.shares > 0);
                prop_assert!(d.shares as u128 * reserve_other as u128 <= d.other as u128 * n);
                prop_assert!(d.shares as u128 * reserve_lent as u128 <= d.lent as u128 * n);
                prop_assert!(d.other <= max_other && d.lent <= max_lent);
            }
        }
    }
}

// Kani proofs of the share maths (`cargo kani`, docs/toolchain.md), in the tiers of
// `pricing.rs`: bounded by default, full domain behind `RUSTFLAGS="--cfg kani_full"`.
// `proofs/lending_amm_z3.py` proves the same division properties for every u64 with Z3,
// where Kani cannot relate a division's output to its inputs.
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the bounded tier.
    const SMALL: u64 = 1 << 5;

    fn assert_first_deposit_is_backed(other: u64, lent: u64) {
        if let Ok(deposit) = first_deposit(other, lent) {
            let total = (deposit.shares + MINIMUM_LIQUIDITY) as u128;
            assert!(total * total <= other as u128 * lent as u128);
            assert!(deposit.shares > 0);
        }
    }

    /// Bounded around the locked minimum, where the first deposit starts to mint: both
    /// amounts within 32 of `MINIMUM_LIQUIDITY`, on both sides of it.
    #[kani::proof]
    #[kani::unwind(66)]
    #[kani::solver(cadical)]
    fn the_first_deposits_shares_never_exceed_what_the_amounts_back_bounded() {
        let near = |x: &u64| (MINIMUM_LIQUIDITY - 32..MINIMUM_LIQUIDITY + 32).contains(x);
        assert_first_deposit_is_backed(kani::any_where(near), kani::any_where(near));
    }

    /// Up to 2^11 each: about 17 minutes on the owner's Mac.
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(66)]
    #[kani::solver(cadical)]
    fn the_first_deposits_shares_never_exceed_what_the_amounts_back_wide() {
        let other: u64 = kani::any_where(|&x| x < (1 << 11));
        let lent: u64 = kani::any_where(|&x| x < (1 << 11));
        assert_first_deposit_is_backed(other, lent);
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_later_deposit_never_mints_more_than_its_share_of_either_side_bounded() {
        let max_other: u64 = kani::any_where(|&x| x < SMALL);
        let max_lent: u64 = kani::any_where(|&x| x < SMALL);
        let reserve_other: u64 = kani::any_where(|&x| x < SMALL);
        let reserve_lent: u64 = kani::any_where(|&x| x < SMALL);
        let share_count: u64 = kani::any_where(|&x| x < SMALL);
        if let Ok(d) = later_deposit(
            max_other,
            max_lent,
            reserve_other,
            reserve_lent,
            share_count,
        ) {
            let n = share_count as u128;
            assert!(d.shares as u128 * reserve_other as u128 <= d.other as u128 * n);
            assert!(d.shares as u128 * reserve_lent as u128 <= d.lent as u128 * n);
            assert!(d.other <= max_other && d.lent <= max_lent);
        }
    }

    /// For any amounts, reserves and share count, a later deposit never panics.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_later_deposit_never_panics() {
        let _ = later_deposit(
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
        );
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_later_deposit_never_mints_more_than_its_share_of_either_side() {
        let (max_other, max_lent, reserve_other, reserve_lent, share_count): (
            u64,
            u64,
            u64,
            u64,
            u64,
        ) = kani::any();
        if let Ok(d) = later_deposit(
            max_other,
            max_lent,
            reserve_other,
            reserve_lent,
            share_count,
        ) {
            let n = share_count as u128;
            assert!(d.shares as u128 * reserve_other as u128 <= d.other as u128 * n);
            assert!(d.shares as u128 * reserve_lent as u128 <= d.lent as u128 * n);
        }
    }
}
