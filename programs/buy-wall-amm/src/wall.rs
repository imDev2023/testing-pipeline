//! The buy wall, in pure functions that take no accounts (docs/spec/pool4-for-solana.md,
//! "What is stored" and "`place_wall`"), so the proofs and the worked example run against
//! them directly.
//!
//! The wall is one stretch of liquidity `W` from `wall_top` down to zero. At or above its
//! top it is all SOL, `W × wall_top / Q` lamports; below it, it has bought tokens and holds
//! `W × s / Q` lamports. Pricing trades through it (`pricing.rs`); `place_wall` closes it at
//! the current price and places it again with everything idle (`place` below).

use crate::config::{KEEPER_TIP_CAP, WALL_THRESHOLD};
use crate::math::U256;

/// The buy wall: its liquidity `W` and its top, a Q64.64 square-root price.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Wall {
    pub liquidity: u128,
    pub top: u128,
}

impl Wall {
    /// No wall placed.
    pub const NONE: Wall = Wall {
        liquidity: 0,
        top: 0,
    };

    /// Whether a wall is placed: `wall_liquidity` is 0 when none is (the spec's "What is
    /// stored").
    pub fn is_placed(&self) -> bool {
        self.liquidity > 0
    }

    /// The lamports the wall holds at square-root price `s`: `floor(W × min(s, top) / Q)`.
    pub fn sol_at(&self, s: u128) -> Option<u64> {
        let sol = U256::mul(self.liquidity, s.min(self.top))?.checked_shr64()?;
        u64::try_from(sol).ok()
    }

    /// The token units the wall has bought at square-root price `s`: `floor(W × Q × (top -
    /// s) / (top × s))` below its top, divided once by the product of the two prices
    /// (`POOL4-26`), and 0 at or above it.
    pub fn tokens_at(&self, s: u128) -> Option<u64> {
        if s >= self.top || !self.is_placed() {
            return Some(0);
        }
        let fall = self.top.checked_sub(s)?;
        U256::times_q(self.liquidity)
            .mul_u128(fall)?
            .div_floor(U256::mul(self.top, s)?)?
            .to_u64()
    }
}

/// Whether pool ledgers of `tokens` and `lamports` cover what a curve of liquidity
/// `liquidity` and `wall` hold at `sqrt_price` (the spec's "Ledgers"), compared exactly: the
/// curve holds `L × Q / s` token units and `L × s / Q` lamports; the wall `W × Q × (top - s) /
/// (top × s)` token units below its top and `W × min(s, top) / Q` lamports. The tests and the
/// invariant fuzzer check every market state with it.
///
/// The token side is compared by whole quotients and then remainders, so no product passes
/// 256 bits for any price trading can reach and any wall `place_wall` can place
/// (`W × top <= idle × Q < 2^128`); a product that would is reported as not covered.
pub fn covers(liquidity: u128, sqrt_price: u128, wall: Wall, tokens: u64, lamports: u64) -> bool {
    covers_checked(liquidity, sqrt_price, wall, tokens, lamports).unwrap_or(false)
}

fn covers_checked(
    liquidity: u128,
    s: u128,
    wall: Wall,
    tokens: u64,
    lamports: u64,
) -> Option<bool> {
    let (w, top) = (wall.liquidity, wall.top);
    // Lamports: L × s + W × min(s, top) <= lamports × Q.
    let sol = U256::mul(liquidity, s)?.checked_add(U256::mul(w, s.min(top))?)?;
    if sol > U256::times_q(lamports as u128) {
        return Some(false);
    }
    // Tokens: L × Q / s + W × Q × (top - s) / (top × s) <= tokens. With each fraction split
    // into its whole part and remainder (a = qa + ra / s, b = qb + rb / (top × s)), the sum
    // is qa + qb plus a fraction below 2.
    let (qa, ra) = U256::times_q(liquidity).div_rem(U256::from(s))?;
    let (qb, rb) = if w > 0 && s < top {
        let fall = top.checked_sub(s)?;
        U256::times_q(w)
            .mul_u128(fall)?
            .div_rem(U256::mul(top, s)?)?
    } else {
        (U256::ZERO, U256::ZERO)
    };
    let whole = qa.checked_add(qb)?;
    let tokens = U256::from(tokens);
    if tokens < whole {
        return Some(false);
    }
    let spare = tokens.checked_sub(whole)?;
    if spare >= U256::from(2u64) {
        return Some(true);
    }
    if spare.is_zero() {
        return Some(ra.is_zero() && rb.is_zero());
    }
    // One unit to spare: ra / s + rb / (top × s) <= 1, that is ra × top + rb <= top × s
    // (with top taken as 1 when the wall holds no tokens, where rb is 0).
    let top = if w > 0 && s < top { top } else { 1 };
    Some(ra.mul_u128(top)?.checked_add(rb)? <= U256::mul(top, s)?)
}

/// What `place_wall` reads of a market and never writes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct At {
    /// The square-root price, Q64.64.
    pub sqrt_price: u128,
    /// The curve's liquidity `L`.
    pub liquidity: u128,
    /// The wall's floor, Q64.64.
    pub floor: u128,
    /// The market's fee, in basis points.
    pub fee_bps: u16,
}

/// What `place_wall` reads and writes of a market.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WallBooks {
    pub wall: Wall,
    /// The lamports the wall held when placed, `floor(W × wall_top / Q)`.
    pub wall_sol_placed: u64,
    pub pool_tokens: u64,
    pub pool_sol: u64,
    pub retired_tokens: u64,
    pub idle_sol: u64,
    /// Lifetime total of the token units the wall bought.
    pub wall_tokens_bought: u128,
    /// Lifetime total of the lamports tipped to callers.
    pub tips_paid: u128,
}

/// What one `place_wall` did, for its event.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Placement {
    /// The SOL the old wall had spent buying tokens.
    pub converted: u64,
    /// Lamports the old wall still held, moved from `pool_sol` to `idle_sol`.
    pub closed_sol: u64,
    /// Token units the old wall had bought, moved from `pool_tokens` to `retired_tokens`.
    pub closed_tokens: u64,
    /// Lamports the pool held beyond the curve's own holdings, moved to `idle_sol`.
    pub dust_sol: u64,
    /// Token units the pool held beyond the curve's own holdings, moved to `retired_tokens`.
    pub dust_tokens: u64,
    /// The tip, in lamports, paid to the caller from `idle_sol`.
    pub tip: u64,
}

/// Why `place_wall` is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Neither `idle_sol` nor the wall's `converted` reaches `WALL_THRESHOLD`.
    BelowThreshold,
    /// An overflow, or ledgers that do not cover what they must, which the invariants rule
    /// out.
    Overflow,
}

impl From<Refusal> for crate::errors::StrategyError {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::BelowThreshold => crate::errors::StrategyError::WallBelowThreshold,
            Refusal::Overflow => crate::errors::StrategyError::Overflow,
        }
    }
}

/// Step 1's `converted`: the SOL the placed wall has spent buying tokens,
/// `wall_sol_placed - floor(W × min(s, wall_top) / Q)`, or 0 with no wall.
pub fn converted(wall: Wall, wall_sol_placed: u64, s: u128) -> Option<u64> {
    if !wall.is_placed() {
        return Some(0);
    }
    Some(wall_sol_placed.saturating_sub(wall.sol_at(s)?))
}

/// Step 4's tip: `min(KEEPER_TIP_CAP, floor(work × fee_bps / 10,000), idle_sol)`, so it never
/// exceeds the fee the market earned on the work (IMD's rule) nor what is idle.
pub fn tip(work: u64, fee_bps: u16, idle_sol: u64) -> Option<u64> {
    let earned = crate::books::share(work, fee_bps)?;
    Some(KEEPER_TIP_CAP.min(earned).min(idle_sol))
}

/// `place_wall`'s steps 1 to 5 (docs/spec/pool4-for-solana.md, "`place_wall`"):
///
/// 1. refused unless `idle_sol` or the wall's `converted` reaches `WALL_THRESHOLD`;
/// 2. the old wall closed at the current price: its SOL to `idle_sol`, the tokens it bought
///    to `retired_tokens`;
/// 3. whatever the pool ledgers hold beyond the curve's own holdings, rounded up, to
///    `idle_sol` and `retired_tokens`;
/// 4. the caller's tip from `idle_sol`, on `work`, the larger of `converted` and step 1's
///    idle SOL;
/// 5. the wall placed with everything left: `wall_top = min(s, floor)`, `W = floor(idle_sol
///    × Q / wall_top)`, `wall_sol_placed = floor(W × wall_top / Q)`, and `idle_sol` into
///    `pool_sol`.
///
/// It never moves the price or the curve, and it moves value only between the ledgers of
/// each vault, except the tip, which leaves the SOL vault.
pub fn place(books: WallBooks, at: At) -> Result<(WallBooks, Placement), Refusal> {
    let s = at.sqrt_price;
    // 1. The threshold. What the old wall holds at the price is both what it has not spent
    // and, in step 2, what closing it moves to idle SOL.
    let (closed_sol, closed_tokens) = if books.wall.is_placed() {
        (
            books.wall.sol_at(s).ok_or(Refusal::Overflow)?,
            books.wall.tokens_at(s).ok_or(Refusal::Overflow)?,
        )
    } else {
        (0, 0)
    };
    let converted = if books.wall.is_placed() {
        books.wall_sol_placed.saturating_sub(closed_sol)
    } else {
        0
    };
    if books.idle_sol < WALL_THRESHOLD && converted < WALL_THRESHOLD {
        return Err(Refusal::BelowThreshold);
    }
    let work = converted.max(books.idle_sol);

    // 2. The old wall, closed at the current price.
    let pool_sol = books
        .pool_sol
        .checked_sub(closed_sol)
        .ok_or(Refusal::Overflow)?;
    let pool_tokens = books
        .pool_tokens
        .checked_sub(closed_tokens)
        .ok_or(Refusal::Overflow)?;

    // 3. The dust: the pool keeps the curve's own holdings, rounded up.
    let (curve_tokens, curve_sol) =
        crate::cap::held_rounded_up(at.liquidity, s).ok_or(Refusal::Overflow)?;
    let curve_tokens = u64::try_from(curve_tokens).map_err(|_| Refusal::Overflow)?;
    let curve_sol = u64::try_from(curve_sol).map_err(|_| Refusal::Overflow)?;
    let dust_tokens = pool_tokens
        .checked_sub(curve_tokens)
        .ok_or(Refusal::Overflow)?;
    let dust_sol = pool_sol.checked_sub(curve_sol).ok_or(Refusal::Overflow)?;
    let idle_sol = books
        .idle_sol
        .checked_add(closed_sol)
        .and_then(|idle| idle.checked_add(dust_sol))
        .ok_or(Refusal::Overflow)?;
    let retired_tokens = books
        .retired_tokens
        .checked_add(closed_tokens)
        .and_then(|retired| retired.checked_add(dust_tokens))
        .ok_or(Refusal::Overflow)?;

    // 4. The tip.
    let tip = tip(work, at.fee_bps, idle_sol).ok_or(Refusal::Overflow)?;
    let idle_sol = idle_sol.checked_sub(tip).ok_or(Refusal::Overflow)?;

    // 5. The new wall, with everything left, never above the floor or the price.
    let top = s.min(at.floor);
    let liquidity = U256::times_q(idle_sol as u128)
        .div_floor(U256::from(top))
        .and_then(U256::to_u128)
        .ok_or(Refusal::Overflow)?;
    let wall = Wall { liquidity, top };
    let wall_sol_placed = wall.sol_at(top).ok_or(Refusal::Overflow)?;

    let placed = WallBooks {
        wall,
        wall_sol_placed,
        pool_tokens: curve_tokens,
        pool_sol: curve_sol.checked_add(idle_sol).ok_or(Refusal::Overflow)?,
        retired_tokens,
        idle_sol: 0,
        wall_tokens_bought: books
            .wall_tokens_bought
            .checked_add(closed_tokens as u128)
            .ok_or(Refusal::Overflow)?,
        tips_paid: books
            .tips_paid
            .checked_add(tip as u128)
            .ok_or(Refusal::Overflow)?,
    };
    Ok((
        placed,
        Placement {
            converted,
            closed_sol,
            closed_tokens,
            dust_sol,
            dust_tokens,
            tip,
        },
    ))
}

// Kani proofs of the wall, in the tiers Pipeline uses (see `opening.rs`). The tip needs no
// division loop: its share is proved here like the fee split (`books.rs`), bounded in the
// default tier as Pipeline bounds its own `ceil_bps` and unbounded in the full tier.
// Closing and placing the wall divides by square-root prices with `U256::div_rem`, whose loop
// runs once per quotient bit, so that harness runs in the full tier only, and Z3 proves its
// properties for every input (`proofs/wall_z3.py`); Proptest checks all of it on 10,000
// cases each (below), and the invariant fuzzer after every `place_wall` through the router.
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the default tier, for the work.
    const SMALL: u64 = 1 << 12;

    /// The tip never exceeds `floor(work × fee_bps / 10,000)`, `KEEPER_TIP_CAP` or what is
    /// idle, and is exactly the least of the three: one more lamport would break one of them.
    /// Bounded to work and idle SOL below `SMALL` and the fees a market may charge, every
    /// product fits in 64 bits: with 128-bit products and any fee up to 10,000 basis points
    /// this harness ran over 10 minutes on the owner's Mac (2026-11-16).
    #[kani::proof]
    fn the_tip_never_exceeds_the_fee_earned_on_the_work_bounded() {
        let (work, fee_bps, idle): (u64, u16, u64) = (kani::any(), kani::any(), kani::any());
        kani::assume(work < SMALL && idle < SMALL);
        kani::assume((crate::config::MIN_FEE_BPS..=crate::config::MAX_FEE_BPS).contains(&fee_bps));
        let tip = tip(work, fee_bps, idle).unwrap();
        let earned = work * fee_bps as u64;
        assert!(tip * 10_000 <= earned);
        assert!(tip <= KEEPER_TIP_CAP && tip <= idle);
        assert!(tip == KEEPER_TIP_CAP || tip == idle || (tip + 1) * 10_000 > earned);
    }

    /// The same for every work, in 128 bits.
    #[cfg(kani_full)]
    #[kani::proof]
    fn the_tip_never_exceeds_the_fee_earned_on_the_work() {
        let (work, fee_bps, idle): (u64, u16, u64) = (kani::any(), kani::any(), kani::any());
        kani::assume(fee_bps <= crate::params::BPS);
        let tip = tip(work, fee_bps, idle).unwrap();
        let earned = work as u128 * fee_bps as u128;
        assert!(tip as u128 * 10_000 <= earned);
        assert!(tip <= KEEPER_TIP_CAP && tip <= idle);
        assert!(tip == KEEPER_TIP_CAP || tip == idle || (tip as u128 + 1) * 10_000 > earned);
    }

    /// Closing and placing the wall conserves the ledgers: the token ledgers keep their sum,
    /// the SOL ledgers lose exactly the tip, nothing stays idle, and the new wall's top is at
    /// or below the floor and the price. Bounded as the pricing's step harnesses are: a price
    /// within 2^5 of one and liquidities within 2^5 of a small base keep each division's
    /// quotient near 20 bits, within the unwind.
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(75)]
    fn closing_and_placing_the_wall_conserves_the_ledgers() {
        let q = crate::math::Q;
        let at = At {
            sqrt_price: kani::any(),
            liquidity: kani::any(),
            floor: kani::any(),
            fee_bps: kani::any(),
        };
        let books = WallBooks {
            wall: Wall {
                liquidity: kani::any(),
                top: kani::any(),
            },
            wall_sol_placed: kani::any(),
            pool_tokens: kani::any(),
            pool_sol: kani::any(),
            retired_tokens: kani::any(),
            idle_sol: kani::any(),
            wall_tokens_bought: kani::any(),
            tips_paid: kani::any(),
        };
        kani::assume(at.sqrt_price >= q && at.sqrt_price < q + (1 << 5));
        kani::assume(at.floor >= q && at.floor <= at.sqrt_price);
        kani::assume(at.liquidity >= 1 << 20 && at.liquidity < (1 << 20) + (1 << 5));
        kani::assume(books.wall.liquidity < 1 << 5);
        kani::assume(books.wall.top >= q && books.wall.top < q + (1 << 5));
        kani::assume(books.wall_tokens_bought < 1 << 64 && books.tips_paid < 1 << 64);
        if let Ok((after, placement)) = place(books, at) {
            let tokens = |b: &WallBooks| b.pool_tokens as u128 + b.retired_tokens as u128;
            let sol = |b: &WallBooks| b.pool_sol as u128 + b.idle_sol as u128;
            assert_eq!(tokens(&after), tokens(&books));
            assert_eq!(sol(&after) + placement.tip as u128, sol(&books));
            assert_eq!(after.idle_sol, 0);
            assert!(after.wall.top <= at.floor && after.wall.top <= at.sqrt_price);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{MAX_FEE_BPS, MAX_SQRT_PRICE, MIN_FEE_BPS, MIN_LIQUIDITY, MIN_SQRT_PRICE};
    use proptest::prelude::*;

    /// The worked example's market just before `place_wall` (docs/spec/pool4-for-solana.md,
    /// "Worked example"): after the buy of 1 SOL and the sell back, which trimmed the curve.
    const PRICE: u128 = 1_844_674_407_372_029_099;
    const BEFORE: WallBooks = WallBooks {
        wall: Wall::NONE,
        wall_sol_placed: 0,
        pool_tokens: 991_666_666_671,
        pool_sol: 9_916_666_669,
        retired_tokens: 8_333_333_329,
        idle_sol: 91_293_332,
        wall_tokens_bought: 0,
        tips_paid: 0,
    };
    const AT: At = At {
        sqrt_price: PRICE,
        liquidity: 99_166_666_666,
        // The sell left the floor at its own price (it dropped to it at once).
        floor: PRICE,
        fee_bps: 100,
    };

    #[test]
    fn the_worked_examples_place_wall_lands_on_the_spec_numbers() {
        let (after, placement) = place(BEFORE, AT).unwrap();
        assert_eq!(placement.tip, 912_933);
        assert_eq!(after.wall.top, 1_844_674_407_372_029_099);
        assert_eq!(after.wall.liquidity, 903_804_009);
        assert_eq!(after.wall_sol_placed, 90_380_400);
        assert_eq!(after.pool_sol, 10_007_047_068);
        assert_eq!(placement.dust_tokens, 11);
        assert_eq!(after.retired_tokens, 8_333_333_340);
        assert_eq!(after.pool_tokens, 991_666_666_660);
        assert_eq!(after.idle_sol, 0);
        assert_eq!(after.tips_paid, 912_933);
        // No wall was placed before, so none was closed.
        assert_eq!(
            (
                placement.converted,
                placement.closed_sol,
                placement.closed_tokens
            ),
            (0, 0, 0)
        );
    }

    #[test]
    fn below_the_threshold_place_wall_is_refused() {
        let idle = WallBooks {
            idle_sol: WALL_THRESHOLD - 1,
            ..BEFORE
        };
        assert_eq!(place(idle, AT), Err(Refusal::BelowThreshold));
        let idle = WallBooks {
            idle_sol: WALL_THRESHOLD,
            ..BEFORE
        };
        assert!(place(idle, AT).is_ok());
        // Nor may the price be one the wall cannot be placed at.
        assert_eq!(place(BEFORE, At { floor: 0, ..AT }), Err(Refusal::Overflow));
    }

    #[test]
    fn a_wall_that_has_spent_enough_is_closed_and_placed_again() {
        let (placed, _) = place(BEFORE, AT).unwrap();
        // The price falls into the wall: it has spent SOL and bought tokens.
        let lower = PRICE - PRICE / 5;
        let spent = placed.wall_sol_placed - placed.wall.sol_at(lower).unwrap();
        let bought = placed.wall.tokens_at(lower).unwrap();
        assert!(spent >= WALL_THRESHOLD && bought > 0);
        assert_eq!(
            converted(placed.wall, placed.wall_sol_placed, lower),
            Some(spent)
        );
        // What a sell into the wall did to the pool ledgers, curve and wall together, at the
        // least the ledgers may hold: the curve's holdings and the wall's, rounded up.
        let liquidity = AT.liquidity;
        let curve_tokens = U256::times_q(liquidity)
            .div_ceil(U256::from(lower))
            .and_then(U256::to_u64)
            .unwrap();
        let curve_sol = U256::mul(liquidity, lower)
            .unwrap()
            .checked_ceil_shr64()
            .unwrap() as u64;
        let books = WallBooks {
            pool_tokens: curve_tokens + bought + 1,
            pool_sol: curve_sol + placed.wall.sol_at(lower).unwrap() + 1,
            ..placed
        };
        let at = At {
            sqrt_price: lower,
            floor: lower,
            ..AT
        };
        let (again, placement) = place(books, at).unwrap();
        assert_eq!(placement.converted, spent);
        assert_eq!(placement.closed_tokens, bought);
        assert_eq!(placement.closed_sol, placed.wall.sol_at(lower).unwrap());
        assert_eq!((placement.dust_tokens, placement.dust_sol), (1, 1));
        assert_eq!(again.wall_tokens_bought, bought as u128);
        assert_eq!(again.retired_tokens, books.retired_tokens + bought + 1);
        assert_eq!(again.pool_tokens, curve_tokens);
        assert_eq!(again.wall.top, lower);
        // The tip is on the larger work, the SOL the wall spent, capped at KEEPER_TIP_CAP.
        assert_eq!(placement.tip, (spent / 100).min(KEEPER_TIP_CAP));
        // The SOL ledgers lost exactly the tip, the token ledgers nothing.
        assert_eq!(
            again.pool_sol + again.idle_sol,
            books.pool_sol + books.idle_sol - placement.tip
        );
        assert_eq!(
            again.pool_tokens + again.retired_tokens,
            books.pool_tokens + books.retired_tokens
        );
    }

    #[test]
    fn the_tip_is_the_least_of_the_cap_the_fee_earned_and_what_is_idle() {
        // The fee on the work.
        assert_eq!(tip(91_293_332, 100, u64::MAX), Some(912_933));
        // The cap.
        assert_eq!(
            tip(10_000_000_000, MAX_FEE_BPS, u64::MAX),
            Some(KEEPER_TIP_CAP)
        );
        // What is idle.
        assert_eq!(tip(10_000_000_000, MAX_FEE_BPS, 7), Some(7));
        // At the lowest fee on the smallest work, 25,000 lamports (the keeper runner's spec).
        assert_eq!(tip(WALL_THRESHOLD, MIN_FEE_BPS, u64::MAX), Some(25_000));
    }

    /// The pool ledgers of `books` cover the curve and the wall at `s`.
    fn covered(books: &WallBooks, liquidity: u128, s: u128) -> bool {
        covers(liquidity, s, books.wall, books.pool_tokens, books.pool_sol)
    }

    /// A market as trading could leave it: a curve from any pool sizes at a price within
    /// the trading bounds, a wall of up to twice the curve's liquidity with its top from half
    /// to twice the price (or none), the floor at or below the price, and pool ledgers that
    /// cover both with some dust; idle SOL from nothing to a lot.
    fn market() -> impl Strategy<Value = (WallBooks, At)> {
        (
            (1_000_000u64..1 << 62, 1_000_000u64..1 << 62),
            (
                0u128..=2_000,
                500u128..=2_000,
                any::<bool>(),
                0u128..=10_000,
            ),
            (
                prop_oneof![0u64..2 * WALL_THRESHOLD, 0u64..1 << 40],
                0u64..1_000,
                0u64..1_000,
                MIN_FEE_BPS..=MAX_FEE_BPS,
            ),
            (0u64..3, 0u64..1 << 30),
        )
            .prop_filter_map(
                "a price within the bounds and ledgers that fit in a u64",
                |(
                    (x, y),
                    (w_permille, top_permille, placed, floor_bps),
                    (idle, dust_t, dust_s, fee_bps),
                    (sol_extra, retired),
                )| {
                    let s = crate::opening::opening_sqrt_price(x, y)?;
                    let liquidity = crate::opening::opening_liquidity(x, y, s)?;
                    if !(MIN_SQRT_PRICE..=MAX_SQRT_PRICE).contains(&s) || liquidity < MIN_LIQUIDITY
                    {
                        return None;
                    }
                    let top = (s / 1_000).checked_mul(top_permille)?.max(MIN_SQRT_PRICE);
                    let wall = if placed {
                        Wall {
                            liquidity: liquidity / 1_000 * w_permille,
                            top,
                        }
                    } else {
                        Wall::NONE
                    };
                    let floor = s - (s - MIN_SQRT_PRICE) / 10_000 * floor_bps;
                    let curve_tokens =
                        U256::times_q(liquidity).div_ceil(U256::from(s))?.to_u64()?;
                    let curve_sol =
                        u64::try_from(U256::mul(liquidity, s)?.checked_ceil_shr64()?).ok()?;
                    let wall_tokens = wall.tokens_at(s)?.checked_add(1)?;
                    let wall_sol = wall.sol_at(s)?.checked_add(1)?;
                    let books = WallBooks {
                        wall,
                        wall_sol_placed: wall.sol_at(wall.top)?.checked_add(sol_extra)?,
                        pool_tokens: curve_tokens.checked_add(wall_tokens)?.checked_add(dust_t)?,
                        pool_sol: curve_sol.checked_add(wall_sol)?.checked_add(dust_s)?,
                        retired_tokens: retired,
                        idle_sol: idle,
                        wall_tokens_bought: 0,
                        tips_paid: 0,
                    };
                    covered(&books, liquidity, s).then_some((
                        books,
                        At {
                            sqrt_price: s,
                            liquidity,
                            floor,
                            fee_bps,
                        },
                    ))
                },
            )
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Closing and placing the wall conserves the ledgers: the token ledgers keep their
        /// sum, the SOL ledgers lose exactly the tip; the tip never exceeds `KEEPER_TIP_CAP`,
        /// `floor(work × fee_bps / 10,000)` or what was idle; the new wall's top is at or
        /// below both the floor and the price; everything idle is placed; the pool ledgers
        /// still cover the curve and the new wall; and it is refused exactly when neither
        /// idle SOL nor the wall's spent SOL reaches `WALL_THRESHOLD`.
        #[test]
        fn closing_and_placing_the_wall_conserves_the_ledgers((books, at) in market()) {
            let spent = converted(books.wall, books.wall_sol_placed, at.sqrt_price).unwrap();
            match place(books, at) {
                Err(Refusal::BelowThreshold) => {
                    prop_assert!(books.idle_sol < WALL_THRESHOLD && spent < WALL_THRESHOLD);
                }
                Err(Refusal::Overflow) => prop_assert!(false, "a covered market never overflows"),
                Ok((after, placement)) => {
                    prop_assert!(books.idle_sol >= WALL_THRESHOLD || spent >= WALL_THRESHOLD);
                    prop_assert_eq!(placement.converted, spent);
                    let tokens = |b: &WallBooks| b.pool_tokens as u128 + b.retired_tokens as u128;
                    let sol = |b: &WallBooks| b.pool_sol as u128 + b.idle_sol as u128;
                    prop_assert_eq!(tokens(&after), tokens(&books));
                    prop_assert_eq!(sol(&after) + placement.tip as u128, sol(&books));
                    let work = spent.max(books.idle_sol) as u128;
                    prop_assert!(placement.tip <= KEEPER_TIP_CAP);
                    prop_assert!(placement.tip as u128 <= work * at.fee_bps as u128 / 10_000);
                    prop_assert!(placement.tip as u128 <= books.idle_sol as u128 + placement.closed_sol as u128 + placement.dust_sol as u128);
                    prop_assert_eq!(after.tips_paid, placement.tip as u128);
                    prop_assert_eq!(after.wall_tokens_bought, placement.closed_tokens as u128);
                    prop_assert!(after.wall.top <= at.floor && after.wall.top <= at.sqrt_price);
                    prop_assert_eq!(after.idle_sol, 0);
                    prop_assert!(after.wall_sol_placed <= after.pool_sol);
                    prop_assert!(covered(&after, at.liquidity, at.sqrt_price));
                    // The wall placed uses what was idle, to within its rounding.
                    let idle = sol(&after) - U256::mul(at.liquidity, at.sqrt_price).unwrap().checked_ceil_shr64().unwrap();
                    prop_assert!(after.wall_sol_placed as u128 <= idle);
                    prop_assert!(U256::mul(after.wall.liquidity + 1, after.wall.top).unwrap() > U256::times_q(idle));
                }
            }
        }

        /// The tip is the least of the three, never more than the fee earned on the work.
        #[test]
        fn the_tip_never_exceeds_the_fee_earned_on_the_work(work in any::<u64>(), fee_bps in 0u16..=10_000, idle in any::<u64>()) {
            let tip = tip(work, fee_bps, idle).unwrap();
            let earned = work as u128 * fee_bps as u128 / 10_000;
            prop_assert_eq!(tip as u128, earned.min(KEEPER_TIP_CAP as u128).min(idle as u128));
        }

        /// What the wall holds moves the right way with the price: its SOL never rises as
        /// the price falls, its bought tokens never fall, and at or above its top it is all
        /// SOL.
        #[test]
        fn the_wall_holds_sol_above_its_top_and_buys_tokens_below_it(
            w in 1u128..1 << 96, top in MIN_SQRT_PRICE..=MAX_SQRT_PRICE, s in MIN_SQRT_PRICE..=MAX_SQRT_PRICE, lower in 0u128..1 << 64,
        ) {
            let wall = Wall { liquidity: w, top };
            let t = lower.min(s - MIN_SQRT_PRICE);
            if let (Some(sol), Some(tokens), Some(sol_lower), Some(tokens_lower)) =
                (wall.sol_at(s), wall.tokens_at(s), wall.sol_at(s - t), wall.tokens_at(s - t))
            {
                prop_assert!(sol_lower <= sol && tokens_lower >= tokens);
                if s >= top {
                    prop_assert_eq!(tokens, 0);
                    prop_assert_eq!(Some(sol), wall.sol_at(top));
                }
            }
        }
    }
}
