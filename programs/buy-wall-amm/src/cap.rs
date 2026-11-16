//! The inventory cap, in pure functions that take no accounts (docs/spec/pool4-for-solana.md,
//! "After pricing" steps 5 and 6), so the proofs and the worked example run against them
//! directly.
//!
//! After every swap, once its output is decided and its books and price are written:
//!
//! - **The decay credit** builds up in token-seconds, `cap_decay_per_day` for every second
//!   since the last swap, and stops at `DECAY_CREDIT_WINDOW` seconds' worth: at most one
//!   day's allowance, however long the market sat idle.
//! - **The ratchet**: a curve holding less than the cap lowers the cap to
//!   `max(held, cap - floor(decay_credit / 86,400), cap_floor)`, spending 86,400
//!   token-seconds of credit for every unit it fell.
//! - **The trim**: a curve holding more than the cap gives its excess back without moving
//!   the price: its liquidity falls to `new_L = max(floor(cap × s / Q), MIN_LIQUIDITY)`, the
//!   tokens and SOL that frees leave the pool ledgers for `retired_tokens` and `idle_sol`,
//!   and `sqrt_price` is not touched.
//!
//! None of it changes the trade just priced, and pricing reads no clock, so quotes still
//! equal swaps. Every product of a 128-bit value runs on the program's checked 256-bit
//! type (`math.rs`), and an overflow returns `None`, which the program turns into an error.

use crate::config::{DECAY_CREDIT_WINDOW, MIN_LIQUIDITY};
use crate::math::U256;

/// Seconds in a day: the decay credit is in token-seconds and the cap decay in token units
/// a day, so a day's worth of credit lowers the cap by one day's decay. A unit, not a
/// policy value.
pub const SECONDS_PER_DAY: u128 = 86_400;

/// What step 6 reads and writes of a market, with the clock of the last decay step.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Inventory {
    /// The square-root price the swap left, Q64.64. Read, never written.
    pub sqrt_price: u128,
    /// The curve's liquidity `L`.
    pub liquidity: u128,
    pub pool_tokens: u64,
    pub pool_sol: u64,
    pub retired_tokens: u64,
    pub idle_sol: u64,
    /// The inventory cap, in token units.
    pub cap: u64,
    /// Token-seconds of cap decay allowance built up and not yet spent.
    pub decay_credit: u128,
    /// The Unix time the credit was last brought up to date.
    pub decay_time: i64,
    /// Lifetime total of token units trimmed.
    pub tokens_trimmed: u128,
    /// Lifetime total of lamports trimmed.
    pub sol_trimmed: u128,
}

/// A market's cap rules, fixed at its seed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CapRules {
    pub cap_floor: u64,
    pub cap_decay_per_day: u64,
}

/// What a trim takes from the curve.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Trim {
    /// The curve's new liquidity, `new_L`.
    pub liquidity: u128,
    /// Token units moved from `pool_tokens` to `retired_tokens`.
    pub tokens: u64,
    /// Lamports moved from `pool_sol` to `idle_sol`.
    pub sol: u64,
}

/// What step 6 did, for the swap's event and the lifetime totals.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Moved {
    /// The curve held exactly the cap, or less with no credit to spend, or more with the
    /// curve already at `MIN_LIQUIDITY`.
    #[default]
    Nothing,
    /// The ratchet lowered the cap by `by` units; the curve held `held`.
    Lowered { by: u64, held: u64 },
    /// The trim took this from the curve.
    Trimmed(Trim),
}

/// What the curve holds at its price: `floor(L × Q / s)`.
pub fn held(liquidity: u128, sqrt_price: u128) -> Option<u128> {
    U256::times_q(liquidity)
        .div_floor(U256::from(sqrt_price))?
        .to_u128()
}

/// What a curve of liquidity `liquidity` holds at `sqrt_price`, each rounded up:
/// `(ceil(L × Q / s), ceil(L × s / Q))` token units and lamports, the least ledgers that cover
/// it. The trim keeps these for the curve it leaves, and `place_wall` keeps them in the pool.
pub fn held_rounded_up(liquidity: u128, sqrt_price: u128) -> Option<(u128, u128)> {
    let tokens = U256::times_q(liquidity)
        .div_ceil(U256::from(sqrt_price))?
        .to_u128()?;
    let sol = U256::mul(liquidity, sqrt_price)?.checked_ceil_shr64()?;
    Some((tokens, sol))
}

/// Step 5: `min(decay_credit + cap_decay_per_day × (now - decay_time),
/// cap_decay_per_day × DECAY_CREDIT_WINDOW)`, the time difference saturating at 0.
///
/// The sum saturates rather than failing: it only overflows far above the limit, where the
/// minimum is the limit either way, so the step never refuses a swap.
pub fn accrue(decay_credit: u128, cap_decay_per_day: u64, decay_time: i64, now: i64) -> u128 {
    let elapsed = u128::try_from(now.saturating_sub(decay_time)).unwrap_or(0);
    let window = u128::try_from(DECAY_CREDIT_WINDOW).unwrap_or(0);
    let per_day = cap_decay_per_day as u128;
    // A u64 times a value below 2^63 fits in 128 bits; saturating keeps it total anyway.
    let limit = per_day.saturating_mul(window);
    decay_credit
        .saturating_add(per_day.saturating_mul(elapsed))
        .min(limit)
}

/// Step 6's ratchet, for a curve holding `held < cap`: the new cap,
/// `max(held, cap - floor(decay_credit / 86,400), cap_floor)` with the subtraction
/// saturating at 0, and the credit left after spending 86,400 for every unit the cap fell.
/// `None` only if the cap would rise, which a market whose cap is at or above its floor
/// never does.
pub fn ratchet(cap: u64, held: u128, decay_credit: u128, cap_floor: u64) -> Option<(u64, u128)> {
    let allowance = decay_credit / SECONDS_PER_DAY;
    let decayed = (cap as u128).saturating_sub(allowance);
    let lowered = held.max(decayed).max(cap_floor as u128);
    let fell = (cap as u128).checked_sub(lowered)?;
    let credit = decay_credit.checked_sub(fell.checked_mul(SECONDS_PER_DAY)?)?;
    Some((u64::try_from(lowered).ok()?, credit))
}

/// Step 6's trim, for a curve of liquidity `liquidity` at `sqrt_price` holding `held`
/// (`floor(L × Q / s)`): when `held > cap`, `new_L = max(floor(cap × s / Q),
/// MIN_LIQUIDITY)`, and if that is below `L`, the curve gives up `held - ceil(new_L × Q /
/// s)` token units and `floor(L × s / Q) - ceil(new_L × s / Q)` lamports, each 0 if
/// negative. `Some(None)` when the curve is within the cap or `MIN_LIQUIDITY` leaves nothing
/// to trim; `None` on an overflow.
pub fn trim(cap: u64, sqrt_price: u128, liquidity: u128, held: u128) -> Option<Option<Trim>> {
    if held <= cap as u128 {
        return Some(None);
    }
    let at_cap = U256::mul(cap as u128, sqrt_price)?.checked_shr64()?;
    let new_liquidity = at_cap.max(MIN_LIQUIDITY);
    if new_liquidity >= liquidity {
        return Some(None);
    }
    let (kept_tokens, kept_sol) = held_rounded_up(new_liquidity, sqrt_price)?;
    let curve_sol = U256::mul(liquidity, sqrt_price)?.checked_shr64()?;
    Some(Some(Trim {
        liquidity: new_liquidity,
        tokens: u64::try_from(held.saturating_sub(kept_tokens)).ok()?,
        sol: u64::try_from(curve_sol.saturating_sub(kept_sol)).ok()?,
    }))
}

impl Inventory {
    /// Steps 5 and 6 at Unix time `now`: the decay credit brought up to date, then the
    /// ratchet or the trim. `None` on an overflow or a ledger that cannot pay a trim, which
    /// the ledgers covering the curve rule out.
    pub fn after_swap(self, rules: CapRules, now: i64) -> Option<(Inventory, Moved)> {
        let mut next = Inventory {
            decay_credit: accrue(
                self.decay_credit,
                rules.cap_decay_per_day,
                self.decay_time,
                now,
            ),
            decay_time: now,
            ..self
        };
        let held = held(self.liquidity, self.sqrt_price)?;
        let cap = self.cap as u128;
        let moved = if held < cap {
            let (lowered, credit) = ratchet(self.cap, held, next.decay_credit, rules.cap_floor)?;
            next.decay_credit = credit;
            let by = self.cap.checked_sub(lowered)?;
            next.cap = lowered;
            if by == 0 {
                Moved::Nothing
            } else {
                // `held < cap` fits in 64 bits.
                Moved::Lowered {
                    by,
                    held: u64::try_from(held).ok()?,
                }
            }
        } else if held > cap {
            match trim(self.cap, self.sqrt_price, self.liquidity, held)? {
                None => Moved::Nothing,
                Some(trim) => {
                    next.liquidity = trim.liquidity;
                    next.pool_tokens = self.pool_tokens.checked_sub(trim.tokens)?;
                    next.retired_tokens = self.retired_tokens.checked_add(trim.tokens)?;
                    next.pool_sol = self.pool_sol.checked_sub(trim.sol)?;
                    next.idle_sol = self.idle_sol.checked_add(trim.sol)?;
                    next.tokens_trimmed = self.tokens_trimmed.checked_add(trim.tokens as u128)?;
                    next.sol_trimmed = self.sol_trimmed.checked_add(trim.sol as u128)?;
                    Moved::Trimmed(trim)
                }
            }
        } else {
            Moved::Nothing
        };
        Some((next, moved))
    }
}

// Kani proofs of the cap, in the tiers Pipeline uses (see `opening.rs`). The decay credit
// and the ratchet need no division loop, so they are proved here; their 128-bit products and
// the division by 86,400 are bounded in the default tier, as Pipeline bounds its own
// `ceil_bps` (a 64-bit division by 10,000 over every input kept CBMC busy for over 9 minutes
// on the owner's Mac, `books.rs`), and unbounded in the full tier. The trim divides by the
// price with `U256::div_rem`, whose loop runs once per quotient bit, about 64 of them for
// any inputs, so its harnesses run in the full tier only and Z3 proves its properties for
// every input (`proofs/cap_z3.py`); Proptest checks all of it on 10,000 cases each (below),
// and the invariant fuzzer after every swap through the router.
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the default tier, for token amounts, credits and times.
    const SMALL: u64 = 1 << 12;

    /// The credit never exceeds one day's allowance, never falls, and builds up by exactly
    /// the decay of the time passed while below the limit.
    fn credit_stays_within_a_day(credit: u128, per_day: u64, then: i64, now: i64) {
        let window = DECAY_CREDIT_WINDOW as u128;
        kani::assume(credit <= per_day as u128 * window);
        let after = accrue(credit, per_day, then, now);
        assert!(after <= per_day as u128 * window);
        assert!(after >= credit);
        if now <= then {
            assert_eq!(after, credit);
        }
    }

    #[kani::proof]
    fn the_decay_credit_never_exceeds_one_days_allowance_bounded() {
        let (credit, per_day): (u128, u64) = (kani::any(), kani::any());
        let (then, now): (i64, i64) = (kani::any(), kani::any());
        kani::assume(per_day < SMALL && credit < (SMALL as u128) << 20);
        kani::assume(then.unsigned_abs() < SMALL && now.unsigned_abs() < (SMALL << 8));
        credit_stays_within_a_day(credit, per_day, then, now);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    fn the_decay_credit_never_exceeds_one_days_allowance() {
        credit_stays_within_a_day(kani::any(), kani::any(), kani::any(), kani::any());
    }

    /// For a cap at or above its floor and a curve below it, the ratchet never raises the
    /// cap, never takes it below the floor or below what the curve holds, never lowers it
    /// by more than the credit allows, and spends exactly 86,400 of credit per unit.
    fn ratchet_is_bounded(cap: u64, held: u128, credit: u128, floor: u64) {
        kani::assume(floor <= cap && held < cap as u128);
        let (lowered, left) = ratchet(cap, held, credit, floor).unwrap();
        assert!(lowered <= cap);
        assert!(lowered >= floor);
        assert!(lowered as u128 >= held);
        let fell = (cap - lowered) as u128;
        assert!(fell * SECONDS_PER_DAY <= credit);
        assert_eq!(left, credit - fell * SECONDS_PER_DAY);
    }

    #[kani::proof]
    fn the_ratchet_never_raises_the_cap_or_passes_the_floor_bounded() {
        let (cap, floor): (u64, u64) = (kani::any(), kani::any());
        let (held, credit): (u128, u128) = (kani::any(), kani::any());
        kani::assume(cap < SMALL && credit < (SMALL as u128) << 20);
        ratchet_is_bounded(cap, held, credit, floor);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    fn the_ratchet_never_raises_the_cap_or_passes_the_floor() {
        ratchet_is_bounded(kani::any(), kani::any(), kani::any(), kani::any());
    }

    /// Steps 5 and 6 never touch the price; a trim keeps the pool ledgers covering the
    /// curve, never raises the liquidity or takes it below `MIN_LIQUIDITY`, and moves value
    /// between ledgers without creating or losing any; and the cap never rises or falls
    /// below the floor. In the full tier only (see above).
    ///
    /// Bounded as the pricing's step harnesses are (`pricing.rs`): a price within 2^5 of
    /// one and a liquidity within 2^5 of the minimum keep each division's quotient near 20
    /// bits, within the unwind.
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(75)]
    fn steps_5_and_6_keep_the_price_and_the_ledgers() {
        let before = Inventory {
            sqrt_price: kani::any(),
            liquidity: kani::any(),
            pool_tokens: kani::any(),
            pool_sol: kani::any(),
            retired_tokens: kani::any(),
            idle_sol: kani::any(),
            cap: kani::any(),
            decay_credit: kani::any(),
            decay_time: kani::any(),
            tokens_trimmed: kani::any(),
            sol_trimmed: kani::any(),
        };
        let rules = CapRules {
            cap_floor: kani::any(),
            cap_decay_per_day: kani::any(),
        };
        let q = crate::math::Q;
        kani::assume(before.sqrt_price >= q && before.sqrt_price < q + (1 << 5));
        kani::assume(
            before.liquidity >= MIN_LIQUIDITY && before.liquidity < MIN_LIQUIDITY + (1 << 5),
        );
        kani::assume(rules.cap_floor <= before.cap);
        // Each vault's ledgers fit in its balance, a u64, and the totals have room, as on
        // any real market.
        kani::assume(
            before.pool_tokens as u128 + before.retired_tokens as u128 <= u64::MAX as u128,
        );
        kani::assume(before.pool_sol as u128 + before.idle_sol as u128 <= u64::MAX as u128);
        kani::assume(
            before.tokens_trimmed <= u64::MAX as u128 && before.sol_trimmed <= u64::MAX as u128,
        );
        kani::assume(
            U256::mul(before.liquidity, q).unwrap()
                <= U256::mul(before.pool_tokens as u128, before.sqrt_price).unwrap(),
        );
        kani::assume(
            U256::mul(before.liquidity, before.sqrt_price).unwrap()
                <= U256::mul(before.pool_sol as u128, q).unwrap(),
        );
        // On such a market the steps never fail, so they never refuse a swap its quote
        // allowed.
        let result = before.after_swap(rules, kani::any());
        assert!(result.is_some());
        if let Some((after, _)) = result {
            assert_eq!(after.sqrt_price, before.sqrt_price);
            assert!(after.cap <= before.cap && after.cap >= rules.cap_floor);
            assert!(after.liquidity <= before.liquidity && after.liquidity >= MIN_LIQUIDITY);
            assert!(
                U256::mul(after.liquidity, q).unwrap()
                    <= U256::mul(after.pool_tokens as u128, after.sqrt_price).unwrap()
            );
            assert!(
                U256::mul(after.liquidity, after.sqrt_price).unwrap()
                    <= U256::mul(after.pool_sol as u128, q).unwrap()
            );
            assert_eq!(
                after.pool_tokens as u128 + after.retired_tokens as u128,
                before.pool_tokens as u128 + before.retired_tokens as u128
            );
            assert_eq!(
                after.pool_sol as u128 + after.idle_sol as u128,
                before.pool_sol as u128 + before.idle_sol as u128
            );
            assert_eq!(
                after.tokens_trimmed - before.tokens_trimmed,
                (after.retired_tokens - before.retired_tokens) as u128
            );
            assert_eq!(
                after.sol_trimmed - before.sol_trimmed,
                (after.idle_sol - before.idle_sol) as u128
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::Q;
    use proptest::prelude::*;

    const DAY: i64 = 86_400;

    /// The worked example's market after its buy an hour after the seed
    /// (docs/spec/pool4-for-solana.md, "Worked example").
    fn after_the_buy() -> (Inventory, CapRules) {
        let inventory = Inventory {
            sqrt_price: 2_027_297_173_702_505_949,
            liquidity: 99_999_999_999,
            pool_tokens: 1_000_000_000_000 - 90_081_892_629,
            pool_sol: 10_000_000_000 + 1_000_000_000 - 10_000_000,
            retired_tokens: 0,
            idle_sol: 4_000_000,
            cap: 1_000_000_000_000,
            decay_credit: 0,
            decay_time: 1_000_000,
            tokens_trimmed: 0,
            sol_trimmed: 0,
        };
        let rules = CapRules {
            cap_floor: 200_000_000_000,
            cap_decay_per_day: 200_000_000_000,
        };
        (inventory, rules)
    }

    #[test]
    fn the_worked_examples_cap_falls_by_one_hours_allowance_after_the_buy() {
        let (inventory, rules) = after_the_buy();
        let (after, moved) = inventory.after_swap(rules, 1_000_000 + 3_600).unwrap();
        assert_eq!(after.cap, 991_666_666_667);
        assert_eq!(after.decay_credit, 28_800);
        assert_eq!(after.decay_time, 1_003_600);
        assert_eq!(
            (after.sqrt_price, after.liquidity),
            (inventory.sqrt_price, inventory.liquidity)
        );
        let held = held(inventory.liquidity, inventory.sqrt_price).unwrap() as u64;
        assert_eq!(
            moved,
            Moved::Lowered {
                by: 8_333_333_333,
                held
            }
        );
    }

    #[test]
    fn the_worked_examples_sell_back_is_trimmed_at_the_spec_numbers() {
        // After the sell of 90,081,892,629 units 60 seconds later: gross 989,999,999 left
        // the pool and 3,960,000 of the fee joined the wall's idle SOL.
        let inventory = Inventory {
            sqrt_price: 1_844_674_407_372_029_099,
            liquidity: 99_999_999_999,
            pool_tokens: 1_000_000_000_000,
            pool_sol: 10_990_000_000 - 989_999_999,
            retired_tokens: 0,
            idle_sol: 4_000_000 + 3_960_000,
            cap: 991_666_666_667,
            decay_credit: 28_800,
            decay_time: 1_003_600,
            tokens_trimmed: 0,
            sol_trimmed: 0,
        };
        let (_, rules) = after_the_buy();
        let (after, moved) = inventory.after_swap(rules, 1_003_660).unwrap();
        assert_eq!(
            moved,
            Moved::Trimmed(Trim {
                liquidity: 99_166_666_666,
                tokens: 8_333_333_329,
                sol: 83_333_332
            })
        );
        assert_eq!(after.sqrt_price, inventory.sqrt_price);
        assert_eq!(after.liquidity, 99_166_666_666);
        assert_eq!(after.pool_tokens, 991_666_666_671);
        assert_eq!(after.pool_sol, 9_916_666_669);
        assert_eq!(after.idle_sol, 91_293_332);
        assert_eq!(after.retired_tokens, 8_333_333_329);
        assert_eq!(after.cap, 991_666_666_667);
        assert_eq!(after.decay_credit, 28_800 + 200_000_000_000 * 60);
    }

    #[test]
    fn the_credit_stops_at_one_days_allowance_and_ignores_a_clock_going_back() {
        assert_eq!(accrue(0, 10, 0, 3 * DAY), 10 * 86_400);
        assert_eq!(accrue(5, 10, 0, 1), 15);
        assert_eq!(accrue(5, 10, 100, 50), 5);
        assert_eq!(accrue(0, 0, 0, i64::MAX), 0);
        assert_eq!(
            accrue(u128::MAX, u64::MAX, i64::MIN, i64::MAX),
            u64::MAX as u128 * 86_400
        );
    }

    #[test]
    fn a_ratchet_with_no_credit_or_at_the_floor_leaves_the_cap() {
        assert_eq!(ratchet(1_000, 10, 86_399, 1), Some((1_000, 86_399)));
        assert_eq!(
            ratchet(1_000, 10, 86_400 * 5_000, 1_000),
            Some((1_000, 86_400 * 5_000))
        );
        assert_eq!(
            ratchet(1_000, 10, 86_400 * 5_000, 300),
            Some((300, 86_400 * 4_300))
        );
        assert_eq!(
            ratchet(1_000, 900, 86_400 * 5_000, 300),
            Some((900, 86_400 * 4_900))
        );
        // A floor above the cap would raise it, which no market reaches: refused.
        assert_eq!(ratchet(1_000, 10, 0, 1_001), None);
    }

    #[test]
    fn a_curve_exactly_at_its_cap_is_not_trimmed() {
        // At 0.7, a liquidity of 100 holds floor(100 / 0.7) = 142 units, and 142 units at
        // the cap back only floor(142 × 0.7) = 99 of liquidity: the rounding alone would
        // trim a curve that is within its cap.
        let s = Q / 10 * 7;
        let held = held(100, s).unwrap();
        assert_eq!(held, 142);
        assert_eq!(trim(142, s, 100, held), Some(None));
    }

    #[test]
    fn min_liquidity_bounds_a_trim() {
        let s = 35 * Q;
        // At the cap, 20,000 units at 35 back 700,000 of liquidity, below the minimum.
        let held = held(1_414_213, s).unwrap();
        let trimmed = trim(20_000, s, 1_414_213, held).unwrap().unwrap();
        assert_eq!(trimmed.liquidity, MIN_LIQUIDITY);
        // At the minimum already, nothing is trimmed.
        let held = super::held(MIN_LIQUIDITY, s).unwrap();
        assert_eq!(trim(20_000, s, MIN_LIQUIDITY, held), Some(None));
    }

    /// The pool ledgers cover a curve: `L × Q <= pool_tokens × s` and `L × s <= pool_sol ×
    /// Q`.
    fn covers(liquidity: u128, s: u128, pool_tokens: u64, pool_sol: u64) -> bool {
        U256::mul(liquidity, Q).unwrap() <= U256::mul(pool_tokens as u128, s).unwrap()
            && U256::mul(liquidity, s).unwrap() <= U256::mul(pool_sol as u128, Q).unwrap()
    }

    /// Markets the program can reach: a price anywhere within the trading bounds, a curve
    /// liquidity whose holdings fit the ledgers, and ledgers covering the curve with up to
    /// 64 units of slack each.
    fn market() -> impl Strategy<Value = Inventory> {
        (32u32..96, any::<u128>())
            .prop_map(|(exponent, low)| (1u128 << exponent) | (low % (1u128 << exponent)))
            .prop_filter_map("a liquidity above the minimum fits", |s| {
                // Both sides of the curve stay below 2^62 units.
                let room = 1u128 << 62;
                let by_tokens = U256::mul(room, s)?.checked_shr64()?;
                let by_sol = U256::times_q(room).div_floor(U256::from(s))?.to_u128()?;
                let most = by_tokens.min(by_sol);
                (most > MIN_LIQUIDITY).then_some((s, most))
            })
            .prop_flat_map(|(s, most)| {
                (
                    Just(s),
                    MIN_LIQUIDITY..most,
                    0u64..64,
                    0u64..64,
                    any::<u64>(),
                    any::<u128>(),
                )
            })
            .prop_filter_map(
                "the curve fits the ledgers",
                |(s, liquidity, token_slack, sol_slack, cap, credit)| {
                    let tokens = U256::times_q(liquidity).div_ceil(U256::from(s))?.to_u64()?;
                    let sol = U256::mul(liquidity, s)?.checked_ceil_shr64()?;
                    let pool_tokens = tokens.checked_add(token_slack)?;
                    let pool_sol = u64::try_from(sol).ok()?.checked_add(sol_slack)?;
                    Some(Inventory {
                        sqrt_price: s,
                        liquidity,
                        pool_tokens,
                        pool_sol,
                        retired_tokens: token_slack,
                        idle_sol: sol_slack,
                        // Caps from far below to above what the curve holds.
                        cap: cap % pool_tokens.saturating_mul(2).max(1),
                        decay_credit: credit,
                        decay_time: 0,
                        tokens_trimmed: token_slack as u128,
                        sol_trimmed: sol_slack as u128,
                    })
                },
            )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Steps 5 and 6 on any reachable market: the price never moves; the credit stays
        /// within a day's allowance; the cap never rises nor falls below its floor or what
        /// the curve holds; a trim leaves the ledgers covering the curve, conserves every
        /// ledger's sum, keeps `MIN_LIQUIDITY`, and leaves the curve within the cap unless
        /// `MIN_LIQUIDITY` stopped it; and the spec's formulas hold exactly.
        #[test]
        fn steps_5_and_6_hold_their_invariants(
            market in market(),
            floor_share in 0u64..=10_000,
            per_day in any::<u64>(),
            elapsed in -DAY..10 * DAY,
        ) {
            let rules = CapRules {
                cap_floor: (market.cap as u128 * floor_share as u128 / 10_000) as u64,
                cap_decay_per_day: per_day,
            };
            let limit = per_day as u128 * 86_400;
            let market = Inventory { decay_credit: market.decay_credit % (limit + 1), ..market };
            let (after, moved) = market.after_swap(rules, elapsed).unwrap();
            prop_assert_eq!(after.sqrt_price, market.sqrt_price);
            prop_assert_eq!(after.decay_time, elapsed);
            prop_assert!(after.decay_credit <= limit);
            prop_assert!(after.cap <= market.cap && after.cap >= rules.cap_floor);
            prop_assert!(after.liquidity <= market.liquidity && after.liquidity >= MIN_LIQUIDITY);
            prop_assert!(covers(after.liquidity, after.sqrt_price, after.pool_tokens, after.pool_sol));
            prop_assert_eq!(
                after.pool_tokens as u128 + after.retired_tokens as u128,
                market.pool_tokens as u128 + market.retired_tokens as u128
            );
            prop_assert_eq!(
                after.pool_sol as u128 + after.idle_sol as u128,
                market.pool_sol as u128 + market.idle_sol as u128
            );
            let held_before = held(market.liquidity, market.sqrt_price).unwrap();
            let held_after = held(after.liquidity, after.sqrt_price).unwrap();
            prop_assert!(held_after <= after.cap as u128 || after.liquidity == MIN_LIQUIDITY);

            if !matches!(moved, Moved::Trimmed(_)) {
                prop_assert_eq!((after.tokens_trimmed, after.sol_trimmed), (market.tokens_trimmed, market.sol_trimmed));
            }

            // The spec's step 5, written out here.
            let credit = (market.decay_credit + per_day as u128 * elapsed.max(0) as u128).min(limit);
            match moved {
                Moved::Nothing => {
                    prop_assert_eq!(after.cap, market.cap);
                    prop_assert_eq!(after.decay_credit, credit);
                    prop_assert_eq!(after.liquidity, market.liquidity);
                }
                Moved::Lowered { by, held } => {
                    prop_assert_eq!(held as u128, held_before);
                    let spec = held_before
                        .max((market.cap as u128).saturating_sub(credit / 86_400))
                        .max(rules.cap_floor as u128);
                    prop_assert_eq!(after.cap as u128, spec);
                    prop_assert_eq!(by, market.cap - after.cap);
                    prop_assert_eq!(after.decay_credit, credit - by as u128 * 86_400);
                }
                Moved::Trimmed(trim) => {
                    prop_assert!(held_before > market.cap as u128);
                    prop_assert_eq!(after.cap, market.cap);
                    prop_assert_eq!(after.decay_credit, credit);
                    let at_cap = U256::mul(market.cap as u128, market.sqrt_price).unwrap().checked_shr64().unwrap();
                    prop_assert_eq!(trim.liquidity, at_cap.max(MIN_LIQUIDITY));
                    prop_assert!(trim.liquidity < market.liquidity);
                    prop_assert_eq!(after.pool_tokens, market.pool_tokens - trim.tokens);
                    prop_assert_eq!(after.idle_sol, market.idle_sol + trim.sol);
                    prop_assert_eq!(after.tokens_trimmed, market.tokens_trimmed + trim.tokens as u128);
                    prop_assert_eq!(after.sol_trimmed, market.sol_trimmed + trim.sol as u128);
                }
            }
        }
    }
}
