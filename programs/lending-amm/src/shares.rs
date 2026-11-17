//! # LP shares
//!
//! The share maths, in pure functions that take no accounts (docs/spec/lending-pool.md,
//! "Shares" and "Adding"), so Proptest, Kani and Z3 can check them on their own.
//!
//! A market's share count is `N = LP mint supply + MINIMUM_LIQUIDITY`: the locked minimum
//! is never minted, so it can never be withdrawn, and it stops the first depositor from
//! inflating the value of one share. `N` moves only by `add_liquidity`, `remove_liquidity` and
//! SPL Token burns of LP shares; `lock_lp` moves shares into the lock account and leaves `N`
//! as it is.

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

/// What a removal pays an LP for the shares it burns: each part pro rata, rounded down.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Removal {
    /// Of the other side's reserve `R`, from its vault.
    pub other: u64,
    /// Of the buffer `B`, in the lent mint, from the buffer vault.
    pub buffer: u64,
    /// Of the market's cTokens `c`: paid as cTokens in kind, or redeemed from Kamino and paid
    /// in the lent mint in cash.
    pub ctokens: u64,
}

/// A removal of `lp` shares from a market with LP mint supply `lp_supply`, other-side reserve
/// `R`, buffer `B` and cTokens `c`: it pays `R x lp / N`, `B x lp / N` and `c x lp / N`, each
/// rounded down, with `N = lp_supply + MINIMUM_LIQUIDITY` (docs/spec/lending-pool.md,
/// "Removing"). So it never pays more than the burned shares' part of any of the three, and
/// since `lp <= lp_supply < N`, the locked minimum's part of each always stays behind.
/// Refused for no shares, for more shares than exist, and when every part rounds to nothing,
/// which would burn the shares for nothing.
pub fn removal(
    lp: u64,
    lp_supply: u64,
    reserve_other: u64,
    buffer: u64,
    ctokens: u64,
) -> Result<Removal, StrategyError> {
    if lp == 0 {
        return Err(StrategyError::ZeroRemoval);
    }
    if lp > lp_supply {
        return Err(StrategyError::NotEnoughShares);
    }
    let n = share_count(lp_supply)? as u128;
    // At most `whole`, since lp < N, so a u64.
    let part = |whole: u64| (whole as u128 * lp as u128 / n) as u64;
    let paid = Removal {
        other: part(reserve_other),
        buffer: part(buffer),
        ctokens: part(ctokens),
    };
    if paid.other == 0 && paid.buffer == 0 && paid.ctokens == 0 {
        return Err(StrategyError::ZeroRemoval);
    }
    Ok(paid)
}

/// The running totals deposited into and redeemed from Kamino after `paid` of a market's
/// `held` cTokens leave in kind: the cTokens take `paid / held` of the net amount lent,
/// `deposited - redeemed`, rounded towards zero, off `deposited` while it is positive and off
/// `redeemed` while it is negative. So the market's lending yield, `V + redeemed - deposited`,
/// falls by the same fraction as `V`, the part that left with the cTokens, without valuing them.
pub fn totals_after_in_kind(
    deposited: u128,
    redeemed: u128,
    paid: u64,
    held: u64,
) -> Result<(u128, u128), StrategyError> {
    if paid == 0 || held == 0 || paid > held {
        return Err(StrategyError::Overflow);
    }
    let take = |net: u128| -> Result<u128, StrategyError> {
        Ok(net
            .checked_mul(paid as u128)
            .ok_or(StrategyError::Overflow)?
            / held as u128)
    };
    if deposited >= redeemed {
        Ok((deposited - take(deposited - redeemed)?, redeemed))
    } else {
        Ok((deposited, redeemed - take(redeemed - deposited)?))
    }
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

    #[test]
    fn a_removal_pays_each_part_pro_rata_rounded_down() {
        // N = 2,000 + 1,000 = 3,000; burning 1,000 is a third of each, rounded down.
        assert_eq!(
            removal(1_000, 2_000, 9_001, 3_002, 302).map_err(|e| e as u32),
            Ok(Removal {
                other: 3_000,
                buffer: 1_000,
                ctokens: 100,
            })
        );
        // A part too small for one unit pays nothing, but the others still pay.
        assert_eq!(
            removal(1, 2_000, 9_000, 2, 0).map_err(|e| e as u32),
            Ok(Removal {
                other: 3,
                buffer: 0,
                ctokens: 0,
            })
        );
    }

    #[test]
    fn a_removal_of_nothing_or_of_more_than_exists_is_refused() {
        let code = |r: Result<Removal, StrategyError>| r.map_err(|e| e as u32);
        assert_eq!(
            code(removal(0, 2_000, 9_000, 3_000, 300)),
            Err(StrategyError::ZeroRemoval as u32)
        );
        // Shares worth less than one unit of every part pay out nothing.
        assert_eq!(
            code(removal(1, 2_000, 2, 2, 2)),
            Err(StrategyError::ZeroRemoval as u32)
        );
        assert_eq!(
            code(removal(2_001, 2_000, 9_000, 3_000, 300)),
            Err(StrategyError::NotEnoughShares as u32)
        );
    }

    #[test]
    fn ctokens_paid_in_kind_take_their_part_of_the_net_amount_lent() {
        // Half the cTokens leave: half the net 100 lent comes off what was deposited.
        assert_eq!(
            totals_after_in_kind(150, 50, 5, 10).map_err(|e| e as u32),
            Ok((100, 50))
        );
        // Redeemed beyond deposited, by yield: half the net 60 comes off what was redeemed.
        assert_eq!(
            totals_after_in_kind(40, 100, 5, 10).map_err(|e| e as u32),
            Ok((40, 70))
        );
        // Rounding towards zero, and every cToken leaving takes the whole net.
        assert_eq!(
            totals_after_in_kind(10, 0, 1, 3).map_err(|e| e as u32),
            Ok((7, 0))
        );
        assert_eq!(
            totals_after_in_kind(10, 3, 3, 3).map_err(|e| e as u32),
            Ok((3, 3))
        );
        assert!(totals_after_in_kind(10, 0, 4, 3).is_err());
    }

    #[test]
    fn the_last_lp_out_leaves_the_locked_minimums_part_of_every_side() {
        let all = removal(2_000, 2_000, 9_000, 3_000, 300).unwrap();
        assert_eq!((all.other, all.buffer, all.ctokens), (6_000, 2_000, 200));
        // The locked minimum's third of each stays.
        assert_eq!(
            (9_000 - all.other, 3_000 - all.buffer, 300 - all.ctokens),
            (3_000, 1_000, 100)
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// A removal never pays more than the burned shares' part of any of the three:
        /// part x N <= X x lp, and rounds each down by less than one unit.
        #[test]
        fn a_removal_never_pays_more_than_the_burned_shares_part(
            lp_supply: u64,
            burn: u64,
            other: u64,
            buffer: u64,
            ctokens: u64,
        ) {
            prop_assume!(lp_supply > 0);
            let lp = burn % lp_supply + 1;
            let removed = removal(lp, lp_supply, other, buffer, ctokens);
            prop_assume!(removed.is_ok());
            if let Ok(r) = removed {
                let n = lp_supply as u128 + MINIMUM_LIQUIDITY as u128;
                for (part, whole) in [(r.other, other), (r.buffer, buffer), (r.ctokens, ctokens)] {
                    prop_assert!(part as u128 * n <= whole as u128 * lp as u128);
                    prop_assert!((part as u128 + 1) * n > whole as u128 * lp as u128);
                    // What stays is at least the locked minimum's part.
                    prop_assert!((whole - part) as u128 * n >= whole as u128 * MINIMUM_LIQUIDITY as u128);
                }
            }
        }

        /// Adding liquidity and removing the shares it minted at once never returns more than
        /// was put in: of the other side, nor of the lent side, the buffer's part plus what the
        /// cTokens' part is worth at the reserve's rate, by klend's rounding. Inputs up to 2^50
        /// and rates from 1 to 2 lamports a cToken, where deposits mint and removals pay.
        #[test]
        fn adding_then_removing_at_once_never_returns_more_than_was_put_in(
            max_other in 0u64..1 << 50,
            max_lent in 0u64..1 << 50,
            reserve_other in 1u64..1 << 50,
            buffer in 0u64..1 << 50,
            ctokens in 0u64..1 << 50,
            lp_supply in 0u64..1 << 50,
            mint_total_supply in 1u64..1 << 50,
            rate_fraction in 0u128..1 << 60,
        ) {
            let total_supply_sf = mint_total_supply as u128 * ((1u128 << 60) + rate_fraction);
            let value = |k: u64| crate::kamino::collateral_value(k, total_supply_sf, mint_total_supply).unwrap();
            let lent_total = buffer + value(ctokens);
            prop_assume!(lent_total > 0);
            let n = share_count(lp_supply).unwrap();
            let deposit = later_deposit(max_other, max_lent, reserve_other, lent_total, n);
            prop_assume!(deposit.is_ok());
            let d = deposit.unwrap();
            // Shares too few to pay out a unit of anything are refused, returning nothing.
            let r = match removal(d.shares, lp_supply + d.shares, reserve_other + d.other, buffer + d.lent, ctokens) {
                Ok(r) => r,
                Err(StrategyError::ZeroRemoval) => return Ok(()),
                Err(other) => return Err(TestCaseError::fail(format!("{other:?}"))),
            };
            prop_assert!(r.other <= d.other);
            let paid_lent = r.buffer as u128 + value(r.ctokens) as u128;
            prop_assert!(paid_lent <= d.lent as u128, "{} > {}", paid_lent, d.lent);
        }

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

        /// A later depositor overpays by less than one unit of each side (Book of Knowledge
        /// SH-3): each take is the ceiling of what the shares are worth,
        /// taken x N < shares x reserve + N, and never more than offered.
        #[test]
        fn a_later_deposit_overpays_by_less_than_one_unit_of_each_side(
            max_other: u64,
            max_lent: u64,
            reserve_other in 1u64..,
            reserve_lent in 1u64..,
            share_count in 1u64..,
        ) {
            if let Ok(d) = later_deposit(max_other, max_lent, reserve_other, reserve_lent, share_count) {
                let n = share_count as u128;
                let shares = d.shares as u128;
                prop_assert!((d.other as u128) * n < shares * reserve_other as u128 + n);
                prop_assert!((d.lent as u128) * n < shares * reserve_lent as u128 + n);
                prop_assert!(d.other <= max_other && d.lent <= max_lent);
            }
        }

        /// The share count always fits a u64 after a later deposit (Book of Knowledge SH-9):
        /// from any LP supply whose share count fits, the supply after the deposit's shares are
        /// minted has a share count too, so a later removal never meets `share_count` refusing.
        /// Half the supplies are within 2^20 of the largest a share count allows, where the
        /// deposit's own check is what refuses.
        #[test]
        fn the_share_count_fits_a_u64_after_a_later_deposit(
            max_other: u64,
            max_lent: u64,
            reserve_other in 1u64..,
            reserve_lent in 1u64..,
            lp_supply in prop_oneof![
                0u64..=(u64::MAX - MINIMUM_LIQUIDITY),
                (u64::MAX - MINIMUM_LIQUIDITY - (1 << 20))..=(u64::MAX - MINIMUM_LIQUIDITY),
            ],
        ) {
            let n = share_count(lp_supply).unwrap();
            if let Ok(d) = later_deposit(max_other, max_lent, reserve_other, reserve_lent, n) {
                let after = lp_supply.checked_add(d.shares).map(share_count);
                prop_assert!(matches!(after, Some(Ok(count)) if count == n + d.shares));
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

    fn assert_later_deposit_overpays_by_less_than_one_unit(
        max_other: u64,
        max_lent: u64,
        reserve_other: u64,
        reserve_lent: u64,
        share_count: u64,
    ) {
        if let Ok(d) = later_deposit(
            max_other,
            max_lent,
            reserve_other,
            reserve_lent,
            share_count,
        ) {
            let (n, shares) = (share_count as u128, d.shares as u128);
            assert!((d.other as u128) * n < shares * reserve_other as u128 + n);
            assert!((d.lent as u128) * n < shares * reserve_lent as u128 + n);
            assert!(d.other <= max_other && d.lent <= max_lent);
        }
    }

    /// A later depositor overpays by less than one unit of each side, each take the ceiling
    /// of what the shares are worth (Book of Knowledge SH-3): bounded below `SMALL`;
    /// `proofs/lending_amm_z3.py` for every u64.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_later_deposit_overpays_by_less_than_one_unit_of_each_side_bounded() {
        let small = |x: &u64| *x < SMALL;
        assert_later_deposit_overpays_by_less_than_one_unit(
            kani::any_where(small),
            kani::any_where(small),
            kani::any_where(small),
            kani::any_where(small),
            kani::any_where(small),
        );
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_later_deposit_overpays_by_less_than_one_unit_of_each_side() {
        assert_later_deposit_overpays_by_less_than_one_unit(
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
        );
    }

    /// For any LP supply whose share count fits, and any amounts and reserves, the supply after
    /// a successful later deposit still has a share count, `N + shares`, so `removal` never
    /// refuses an exit for it (Book of Knowledge SH-9). The first deposit mints
    /// `isqrt(other x lent) - MINIMUM_LIQUIDITY`, whose share count is the root, a u64.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_share_count_fits_a_u64_after_a_later_deposit() {
        let lp_supply: u64 = kani::any();
        let Ok(n) = share_count(lp_supply) else {
            return;
        };
        if let Ok(d) = later_deposit(kani::any(), kani::any(), kani::any(), kani::any(), n) {
            let after = lp_supply.checked_add(d.shares).map(share_count);
            assert!(
                matches!(after, Some(Ok(count)) if count as u128 == n as u128 + d.shares as u128)
            );
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

    fn assert_removal_within_its_part(
        lp: u64,
        lp_supply: u64,
        other: u64,
        buffer: u64,
        ctokens: u64,
    ) {
        if let Ok(r) = removal(lp, lp_supply, other, buffer, ctokens) {
            let n = lp_supply as u128 + MINIMUM_LIQUIDITY as u128;
            assert!(r.other as u128 * n <= other as u128 * lp as u128);
            assert!(r.buffer as u128 * n <= buffer as u128 * lp as u128);
            assert!(r.ctokens as u128 * n <= ctokens as u128 * lp as u128);
            assert!(r.other <= other && r.buffer <= buffer && r.ctokens <= ctokens);
            // The locked minimum's part of each side always stays behind.
            for (part, whole) in [(r.other, other), (r.buffer, buffer), (r.ctokens, ctokens)] {
                assert!((whole - part) as u128 * n >= whole as u128 * MINIMUM_LIQUIDITY as u128);
            }
        }
    }

    /// For every LP mint supply, the share count is the supply plus the locked minimum, or
    /// refused exactly when that passes a u64.
    #[kani::proof]
    fn the_share_count_is_the_supply_plus_the_locked_minimum() {
        let supply: u64 = kani::any();
        match share_count(supply) {
            Ok(n) => assert!(n as u128 == supply as u128 + MINIMUM_LIQUIDITY as u128),
            Err(_) => assert!(supply as u128 + MINIMUM_LIQUIDITY as u128 > u64::MAX as u128),
        }
    }

    /// For every pair of amounts, the first deposit refuses an empty side, and a product whose
    /// root is not above the locked minimum, and otherwise takes both amounts in full.
    #[kani::proof]
    #[kani::unwind(66)]
    #[kani::solver(cadical)]
    fn the_first_deposit_takes_both_amounts_and_refuses_empty_sides() {
        let near =
            |x: &u64| (MINIMUM_LIQUIDITY - 32..MINIMUM_LIQUIDITY + 32).contains(x) || *x == 0;
        let (other, lent): (u64, u64) = (kani::any_where(near), kani::any_where(near));
        match first_deposit(other, lent) {
            Ok(d) => assert!(d.other == other && d.lent == lent && other > 0 && lent > 0),
            Err(StrategyError::ZeroDeposit) => assert!(other == 0 || lent == 0),
            Err(StrategyError::FirstDepositTooSmall) => {
                let m = MINIMUM_LIQUIDITY as u128 + 1;
                assert!(other > 0 && lent > 0 && (other as u128 * lent as u128) < m * m);
            }
            Err(_) => panic!("only the two refusals"),
        }
    }

    fn assert_isqrt_is_the_floor(n: u128) {
        let r = isqrt(n) as u128;
        assert!(r * r <= n);
        // (r + 1)^2 > n, in 129 bits: r < 2^64, so (r + 1)^2 <= 2^128 only at r = 2^64 - 1.
        let next = (r + 1).checked_mul(r + 1);
        assert!(next.is_none_or(|square| square > n));
    }

    /// The integer square root is the floor of the square root: bounded below 2^20;
    /// `proofs/shares_z3.py` proves each round of its loop keeps the invariant that makes it so,
    /// for every u128.
    #[kani::proof]
    #[kani::unwind(66)]
    #[kani::solver(cadical)]
    fn isqrt_is_the_floor_of_the_square_root_bounded() {
        assert_isqrt_is_the_floor(kani::any_where(|&n: &u128| n < (1 << 20)));
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(66)]
    #[kani::solver(cadical)]
    fn isqrt_is_the_floor_of_the_square_root() {
        assert_isqrt_is_the_floor(kani::any());
    }

    /// For any running totals and cTokens, moving cTokens out in kind never panics: a u128
    /// product divided by a symbolic u64 is beyond CBMC in the default tier, where the bounded
    /// property below proves it for small inputs; `proofs/shares_z3.py` for every input.
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn totals_after_in_kind_never_panic() {
        let _ = totals_after_in_kind(kani::any(), kani::any(), kani::any(), kani::any());
    }

    fn assert_in_kind_takes_its_part_of_the_net(
        deposited: u128,
        redeemed: u128,
        paid: u64,
        held: u64,
    ) {
        match totals_after_in_kind(deposited, redeemed, paid, held) {
            Ok((d, r)) => {
                assert!(paid > 0 && paid <= held);
                // Only the larger total moves, and the net amount lent keeps its sign.
                let (net, net_after) = if deposited >= redeemed {
                    assert!(r == redeemed && d <= deposited && d >= redeemed);
                    (deposited - redeemed, d - r)
                } else {
                    assert!(d == deposited && r <= redeemed && r >= deposited);
                    (redeemed - deposited, r - d)
                };
                // The cTokens left take `floor(net x paid / held)` off it: what is left is at
                // least the remaining cTokens' part of the net, and less than a unit above it.
                let take = net - net_after;
                assert!(take * held as u128 <= net * paid as u128);
                let above = take
                    .checked_add(1)
                    .and_then(|t| t.checked_mul(held as u128));
                assert!(above.is_none_or(|above| net * (paid as u128) < above));
            }
            Err(_) => assert!(
                paid == 0
                    || held == 0
                    || paid > held
                    || (deposited.abs_diff(redeemed))
                        .checked_mul(paid as u128)
                        .is_none()
            ),
        }
    }

    /// cTokens paid in kind take their part of the net amount lent, rounded towards zero, off
    /// the larger running total: bounded below 2^4; `proofs/shares_z3.py` for every input.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn ctokens_paid_in_kind_take_their_part_of_the_net_amount_lent_bounded() {
        let small = |x: &u64| *x < (1 << 4);
        assert_in_kind_takes_its_part_of_the_net(
            kani::any_where(|&d: &u128| d < (1 << 4)),
            kani::any_where(|&r: &u128| r < (1 << 4)),
            kani::any_where(small),
            kani::any_where(small),
        );
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn ctokens_paid_in_kind_take_their_part_of_the_net_amount_lent() {
        assert_in_kind_takes_its_part_of_the_net(
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
        );
    }

    /// A removal never pays more than the burned shares' part of any of the three: bounded,
    /// the shares below 2^5 and the three sides below 2^12, so that against the locked minimum
    /// in `N` every part can be above 0.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_removal_never_pays_more_than_the_burned_shares_part_bounded() {
        let side = |x: &u64| *x < (1 << 12);
        assert_removal_within_its_part(
            kani::any_where(|&x| x < SMALL),
            kani::any_where(|&x| x < SMALL),
            kani::any_where(side),
            kani::any_where(side),
            kani::any_where(side),
        );
    }

    /// For any inputs, a removal never panics.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_removal_never_panics() {
        let _ = removal(
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
    fn a_removal_never_pays_more_than_the_burned_shares_part() {
        assert_removal_within_its_part(
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any(),
        );
    }

    /// The cTokens' value at a rate `num / den`, rounded down as klend rounds: Kani cannot
    /// run the 64-step long division of `kamino::collateral_value` over symbolic inputs, so
    /// the bounded proof values cTokens at a small symbolic rate; Proptest checks the same
    /// property with the real valuation, and `proofs/removal_z3.py` for every input.
    fn value_at(ctokens: u64, num: u64, den: u64) -> u128 {
        ctokens as u128 * num as u128 / den as u128
    }

    /// Adding liquidity, then removing the shares it minted at once, never returns more than
    /// was put in, of either side, the lent side counting the cTokens' part at its value.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn adding_then_removing_at_once_never_returns_more_than_was_put_in_bounded() {
        let max_other: u64 = kani::any_where(|&x| x < SMALL);
        let max_lent: u64 = kani::any_where(|&x| x < SMALL);
        let reserve_other: u64 = kani::any_where(|&x| (1..SMALL).contains(&x));
        let buffer: u64 = kani::any_where(|&x| x < SMALL);
        let ctokens: u64 = kani::any_where(|&x| x < SMALL);
        let lp_supply: u64 = kani::any_where(|&x| x < SMALL);
        let num: u64 = kani::any_where(|&x| (1..8).contains(&x));
        let den: u64 = kani::any_where(|&x| (1..8).contains(&x));
        let lent_total = buffer + value_at(ctokens, num, den) as u64;
        let n = lp_supply + MINIMUM_LIQUIDITY;
        if let Ok(d) = later_deposit(max_other, max_lent, reserve_other, lent_total, n) {
            // Shares too few to pay out a unit of anything are refused, returning nothing.
            let r = match removal(
                d.shares,
                lp_supply + d.shares,
                reserve_other + d.other,
                buffer + d.lent,
                ctokens,
            ) {
                Ok(r) => r,
                Err(error) => {
                    assert!(matches!(error, StrategyError::ZeroRemoval));
                    return;
                }
            };
            assert!(r.other <= d.other);
            assert!(r.buffer as u128 + value_at(r.ctokens, num, den) <= d.lent as u128);
        }
    }
}
