//! The buy wall, in pure functions that take no accounts (docs/spec/pool4-for-solana.md,
//! "What is stored" and "`place_wall`"), so the proofs and the worked example run against
//! them directly.
//!
//! The wall is one stretch of liquidity `W` from `wall_top` down to zero. At or above its
//! top it is all SOL, `W × wall_top / Q` lamports; below it, it has bought tokens and holds
//! `W × s / Q` lamports. Pricing trades through it (`pricing.rs`); `place_wall` closes it at
//! the current price and places it again with everything idle (`place` below), only in a slot
//! no swap has run in yet, under the floor brought up to date for that slot and no higher
//! than the last traded slot's lowest close (`place_in_slot`, `POOL4-50`).

use crate::config::{KEEPER_TIP_CAP, WALL_THRESHOLD};
use crate::guard::Guard;
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

/// What `place` reads of a market and never writes (`place_in_slot` first brings the floor
/// up to date for its slot, and the instruction writes that floor through the guard).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct At {
    /// The square-root price, Q64.64.
    pub sqrt_price: u128,
    /// The curve's liquidity `L`.
    pub liquidity: u128,
    /// The wall's floor, Q64.64.
    pub floor: u128,
    /// The lowest close of the last slot that traded, Q64.64, the guard's `last_slot_low`;
    /// 0 caps nothing.
    pub last_slot_low: u128,
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
    /// A swap, or the seed, already ran in this slot (`POOL4-50`).
    SwapThisSlot,
}

impl From<Refusal> for crate::errors::StrategyError {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::BelowThreshold => crate::errors::StrategyError::WallBelowThreshold,
            Refusal::Overflow => crate::errors::StrategyError::Overflow,
            Refusal::SwapThisSlot => crate::errors::StrategyError::SwapThisSlot,
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

/// Step 5's top: `min(s, floor, last_slot_low)`, so a placed wall's top is never above the
/// price at placement, the floor, nor the last traded slot's lowest close (`POOL4-50`); a
/// zero `last_slot_low`, a market written before that field, caps nothing.
pub fn placement_top(s: u128, floor: u128, last_slot_low: u128) -> u128 {
    let top = s.min(floor);
    if last_slot_low == 0 {
        top
    } else {
        top.min(last_slot_low)
    }
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
/// 5. the wall placed with everything left: `wall_top = min(s, floor, last_slot_low)`
///    (`placement_top`), `W = floor(idle_sol × Q / wall_top)`, `wall_sol_placed = floor(W ×
///    wall_top / Q)`, and `idle_sol` into `pool_sol`.
///
/// It never moves the price or the curve, and it moves value only between the ledgers of
/// each vault, except the tip, which leaves the SOL vault. Nothing it retires is rewardable
/// (`retired_rewardable`, outside these books), so the closed wall's tokens and the dust
/// burn whole (`POOL4-49`).
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

    // 5. The new wall, with everything left, never above the price, the floor or the last
    // traded slot's lowest close.
    let top = placement_top(s, at.floor, at.last_slot_low);
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

/// `place_wall` as the instruction runs it in the Clock's `slot` at time `now`
/// (docs/spec/pool4-for-solana.md, "`place_wall`", `POOL4-50`): refused with `SwapThisSlot`
/// in a slot a swap already ran in (`slot` not later than the guard's `last_slot`);
/// otherwise the floor is brought up to date as a swap's first update in the slot would
/// (`Guard::open_floor`, which marks no slot), then `place` (steps 1 to 5) runs under that
/// floor and the guard's `last_slot_low`, whatever `at` holds for them. The floor is never
/// above the last close, which is the price, since only a swap moves either, so the wall's
/// top is the lower of the floor and the last traded slot's lowest close: a dip bought back
/// in its own slot leaves the floor up but still caps this placement at the dip. Returns the
/// books, what it did and the guard to store.
pub fn place_in_slot(
    books: WallBooks,
    at: At,
    guard: Guard,
    slot: u64,
    now: i64,
) -> Result<(WallBooks, Placement, Guard), Refusal> {
    if slot <= guard.last_slot {
        return Err(Refusal::SwapThisSlot);
    }
    let guard = guard.open_floor(now).ok_or(Refusal::Overflow)?;
    let (placed, placement) = place(
        books,
        At {
            floor: guard.floor,
            last_slot_low: guard.last_slot_low,
            ..at
        },
    )?;
    Ok((placed, placement, guard))
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
    /// or below the floor, the price and a nonzero last traded slot's low. Bounded as the pricing's step harnesses are: a price
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
            last_slot_low: kani::any(),
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
        kani::assume(at.last_slot_low == 0 || (at.last_slot_low >= q && at.last_slot_low < q + (1 << 5)));
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
            assert!(at.last_slot_low == 0 || after.wall.top <= at.last_slot_low);
            assert!(after.wall.top == placement_top(at.sqrt_price, at.floor, at.last_slot_low));
        }
    }

    /// The coverage oracle compares exactly (INV-PM-12, INV-WG-8): `covers_checked` answers
    /// on these markets, and its answer is the spec's "Ledgers" over the rationals,
    /// cross-multiplied in 256 bits (`lamports × Q >= L × s + W × min(s, top)` and `tokens ×
    /// T × s >= L × Q × T + W × Q × (top - s)` with `T` the top while the wall holds tokens,
    /// 1 otherwise). Bounded to a family of markets whose two quotients are small, so
    /// `div_rem` loops a dozen times at most: prices within 2^8 of 2^60, a liquidity below
    /// 2^8, a wall of `w × 2^48` for `w` below 2^8 (so its token quotient reaches 2^8 too)
    /// on either side of the price, every u64 of lamports and every u16 of tokens, which
    /// covers each branch of the whole-plus-remainder shortcut, the one-unit-to-spare test
    /// with both remainders among them. Every input is the Proptest's
    /// `the_coverage_oracle_compares_exactly` (below), against unbounded integers. In the
    /// full tier: with its 256-bit products and two division loops it ran past a 5-minute
    /// limit on the owner's Mac (2026-11-16).
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(14)]
    fn the_coverage_oracle_compares_exactly_bounded() {
        const BASE: u128 = 1 << 60;
        let (l, w, ds, dt): (u8, u8, u8, u8) = (kani::any(), kani::any(), kani::any(), kani::any());
        let (liquidity, s, top) = (l as u128, BASE + ds as u128, BASE + dt as u128);
        let wall = Wall {
            liquidity: (w as u128) << 48,
            top,
        };
        let (tokens, lamports): (u16, u64) = (kani::any(), kani::any());
        let answer = covers_checked(liquidity, s, wall, tokens as u64, lamports);
        let sol = U256::mul(liquidity, s)
            .unwrap()
            .checked_add(U256::mul(wall.liquidity, s.min(top)).unwrap())
            .unwrap();
        let lamports_cover = U256::times_q(lamports as u128) >= sol;
        let below = wall.liquidity > 0 && s < top;
        let t = if below { top } else { 1 };
        let wall_term = if below {
            U256::times_q(wall.liquidity).mul_u128(top - s).unwrap()
        } else {
            U256::ZERO
        };
        let need = U256::times_q(liquidity)
            .mul_u128(t)
            .unwrap()
            .checked_add(wall_term)
            .unwrap();
        let have = U256::mul(tokens as u128, t).unwrap().mul_u128(s).unwrap();
        assert_eq!(answer, Some(lamports_cover && have >= need));
        kani::cover!(answer == Some(true) && below && have == need);
        kani::cover!(answer == Some(false) && lamports_cover && below);
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
        // `place_wall`, in a later slot than the sell, brings the floor down to the sell's
        // price, the price that slot opened at (`POOL4-50`), which is also the sell's slot's
        // lowest close.
        floor: PRICE,
        last_slot_low: PRICE,
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

    /// The worked example's guard after the sell back: the floor crawled 60 seconds' worth
    /// at the sell's slot's first update, above the sell's price, which is the last close.
    const SOLD: Guard = Guard {
        reference: 1_863_121_151_444_664_712,
        ref_time: 4_660,
        floor: 1_844_700_027_848_835_313,
        floor_time: 4_660,
        last_slot: 9_160,
        last_close: PRICE,
        last_slot_low: PRICE,
    };

    #[test]
    fn place_wall_waits_for_a_later_slot_and_places_under_the_floor_brought_up_to_date() {
        // In the sell's slot: refused, before the threshold is looked at.
        assert_eq!(
            place_in_slot(BEFORE, AT, SOLD, SOLD.last_slot, 4_660),
            Err(Refusal::SwapThisSlot)
        );
        let idle = WallBooks {
            idle_sol: 0,
            ..BEFORE
        };
        assert_eq!(
            place_in_slot(idle, AT, SOLD, SOLD.last_slot, 4_660),
            Err(Refusal::SwapThisSlot)
        );
        // From the next slot: the floor drops to the sell's price and the guard's low caps
        // the top, whatever `at` held, and the worked example's numbers follow.
        let stale = At {
            floor: SOLD.floor,
            last_slot_low: 0,
            ..AT
        };
        let (after, placement, guard) =
            place_in_slot(BEFORE, stale, SOLD, SOLD.last_slot + 1, 4_660).unwrap();
        assert_eq!((after, placement), place(BEFORE, AT).unwrap());
        assert_eq!(
            guard,
            Guard {
                floor: PRICE,
                ..SOLD
            }
        );
        // Below the threshold it is still refused there, and the guard is not written.
        assert_eq!(
            place_in_slot(idle, AT, SOLD, SOLD.last_slot + 1, 4_660),
            Err(Refusal::BelowThreshold)
        );
    }

    #[test]
    fn the_last_traded_slots_low_caps_the_wall_below_the_floor_and_the_price() {
        // A dip bought back in its own slot: the floor and the price stay up, the slot's low
        // is the dip's, and the wall goes there, with the same idle SOL.
        let dip = PRICE / 2;
        let (after, _) = place(
            BEFORE,
            At {
                last_slot_low: dip,
                ..AT
            },
        )
        .unwrap();
        assert_eq!(after.wall.top, dip);
        assert_eq!(after.idle_sol, 0);
        // A low above the floor or the price caps nothing; 0, a market written before the
        // field, caps nothing either.
        for low in [PRICE, PRICE + 1, u128::MAX, 0] {
            assert_eq!(placement_top(PRICE, PRICE + 7, low), PRICE);
            assert_eq!(placement_top(PRICE + 7, PRICE, low), PRICE);
        }
        assert_eq!(placement_top(PRICE, PRICE, 1), 1);
        // `place_in_slot` takes the low from the guard.
        let dipped = Guard {
            last_slot_low: dip,
            ..SOLD
        };
        let (after, _, guard) =
            place_in_slot(BEFORE, AT, dipped, SOLD.last_slot + 1, 4_660).unwrap();
        assert_eq!(after.wall.top, dip);
        assert_eq!(guard.last_slot_low, dip);
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
    /// to twice the price (or none), the floor at or below the price, the last traded slot's
    /// low from a fifth to twice the price (or none), and pool ledgers that cover both with
    /// some dust; idle SOL from nothing to a lot.
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
            (0u64..3, 0u64..1 << 30, 0u128..=2_000),
        )
            .prop_filter_map(
                "a price within the bounds and ledgers that fit in a u64",
                |(
                    (x, y),
                    (w_permille, top_permille, placed, floor_bps),
                    (idle, dust_t, dust_s, fee_bps),
                    (sol_extra, retired, low_permille),
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
                    // The last traded slot's low: none (0) or from a fifth to twice the price.
                    let last_slot_low = if low_permille < 200 {
                        0
                    } else {
                        (s / 1_000).checked_mul(low_permille)?.max(MIN_SQRT_PRICE)
                    };
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
                            last_slot_low,
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
        /// `floor(work × fee_bps / 10,000)` or what was idle; the new wall's top is
        /// `min(price, floor, last_slot_low)`, a zero low capping nothing; everything idle is
        /// placed; the pool ledgers
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
                Err(Refusal::SwapThisSlot) => prop_assert!(false, "only place_in_slot reads the slot"),
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
                    prop_assert!(at.last_slot_low == 0 || after.wall.top <= at.last_slot_low);
                    let mut lowest = at.sqrt_price.min(at.floor);
                    if at.last_slot_low > 0 {
                        lowest = lowest.min(at.last_slot_low);
                    }
                    prop_assert_eq!(after.wall.top, lowest);
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

        /// `place_wall` in a slot (`POOL4-50`): refused with `SwapThisSlot` exactly when a
        /// swap already ran in the slot, whatever else holds; otherwise it is `place` under
        /// the floor brought up to date, which is never above the price (the last close) nor
        /// the reference, and the guard's last traded slot's low, so the wall's top is never
        /// above the price at placement, that floor, nor that low, and only the floor and its
        /// clock change in the guard.
        #[test]
        fn place_wall_runs_only_in_a_slot_no_swap_has_run_in(
            (books, at) in market(),
            (reference_bps, floor_bps, floor_time, dt) in (0u128..=20_000, 0u128..=10_000, 0i64..1 << 40, -100i64..200_000),
            (last_slot, slots) in (0u64..1 << 40, 0u64..3),
        ) {
            let s = at.sqrt_price;
            // A guard as trading could leave it: the last close at the price, the floor at or
            // below the reference, either side of the price.
            let reference = (s + s / 10_000 * reference_bps).min(MAX_SQRT_PRICE);
            let floor = (MIN_SQRT_PRICE + (reference - MIN_SQRT_PRICE) / 10_000 * floor_bps).max(MIN_SQRT_PRICE);
            // The low as `market` drew it, and `at` holding a stale one.
            let guard = Guard {
                reference, ref_time: floor_time, floor, floor_time, last_slot, last_close: s,
                last_slot_low: at.last_slot_low,
            };
            let at = At { last_slot_low: 0, ..at };
            let now = floor_time + dt;
            let result = place_in_slot(books, at, guard, last_slot + slots, now);
            if slots == 0 {
                prop_assert_eq!(result, Err(Refusal::SwapThisSlot));
            } else {
                let opened = guard.open_floor(now).unwrap();
                prop_assert!(opened.floor <= s && opened.floor <= reference);
                prop_assert_eq!(opened, Guard { floor: opened.floor, floor_time: opened.floor_time, ..guard });
                let expected = place(books, At { floor: opened.floor, last_slot_low: guard.last_slot_low, ..at });
                match (result, expected) {
                    (Ok((after, placement, stored)), Ok((books_expected, placement_expected))) => {
                        prop_assert_eq!((after, placement), (books_expected, placement_expected));
                        prop_assert_eq!(stored, opened);
                        prop_assert!(after.wall.top <= s && after.wall.top <= opened.floor);
                        prop_assert!(guard.last_slot_low == 0 || after.wall.top <= guard.last_slot_low);
                    }
                    (Err(refusal), Err(expected)) => prop_assert_eq!(refusal, expected),
                    (result, expected) => prop_assert!(false, "{:?} against {:?}", result, expected),
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

        /// The coverage oracle compares exactly (INV-PM-12, INV-WG-8): on every market
        /// trading can reach (the price and the wall's top within the bounds, `W × top <=
        /// idle × Q < 2^128`, any liquidity) `covers_checked` answers, and its answer is the
        /// spec's "Ledgers" over the rationals, checked by cross-multiplying in unbounded
        /// integers written apart from `U256`. The ledgers are drawn at and next to the
        /// least that cover, so every branch of its whole-plus-remainder shortcut runs,
        /// both outcomes of the one-unit-to-spare test among them.
        #[test]
        fn the_coverage_oracle_compares_exactly(
            (liquidity, s, wall) in reachable_curve_and_wall(),
            token_offset in -2i64..=3,
            lamport_offset in -2i64..=2,
            raw in any::<(u64, u64)>(),
            near in any::<bool>(),
        ) {
            let (tokens, lamports) = if near {
                near_the_least_cover(liquidity, s, wall, token_offset, lamport_offset).unwrap_or(raw)
            } else {
                raw
            };
            let answer = covers_checked(liquidity, s, wall, tokens, lamports);
            prop_assert_eq!(answer, Some(covers_exactly(liquidity, s, wall, tokens, lamports)));
        }

        /// The same on any inputs at all, reachable or not: whenever `covers_checked` answers,
        /// the answer is exact.
        #[test]
        fn the_coverage_oracle_never_answers_wrong(
            liquidity in any::<u128>(),
            s in prop_oneof![1u128..=u128::MAX, MIN_SQRT_PRICE..=MAX_SQRT_PRICE],
            w in prop_oneof![Just(0u128), any::<u128>(), 0u128..1 << 96],
            top in prop_oneof![any::<u128>(), MIN_SQRT_PRICE..=MAX_SQRT_PRICE],
            token_offset in -2i64..=3,
            lamport_offset in -2i64..=2,
            raw in any::<(u64, u64)>(),
        ) {
            let wall = Wall { liquidity: w, top };
            let (tokens, lamports) =
                near_the_least_cover(liquidity, s, wall, token_offset, lamport_offset).unwrap_or(raw);
            if let Some(answer) = covers_checked(liquidity, s, wall, tokens, lamports) {
                prop_assert_eq!(answer, covers_exactly(liquidity, s, wall, tokens, lamports));
            }
        }
    }

    /// A natural number of any size, as little-endian 32-bit limbs: the coverage oracle's
    /// arithmetic, written apart from `U256` so a slip in one is not repeated in the other.
    #[derive(Clone, Debug)]
    struct Natural(Vec<u32>);

    impl Natural {
        fn of(value: u128) -> Natural {
            Natural((0..4).map(|i| (value >> (32 * i)) as u32).collect())
        }

        fn times(&self, other: &Natural) -> Natural {
            let mut limbs = vec![0u64; self.0.len() + other.0.len() + 1];
            for (i, a) in self.0.iter().enumerate() {
                let mut carry = 0u64;
                for (j, b) in other.0.iter().enumerate() {
                    let sum = limbs[i + j] + *a as u64 * *b as u64 + carry;
                    limbs[i + j] = sum & 0xffff_ffff;
                    carry = sum >> 32;
                }
                let mut k = i + other.0.len();
                while carry > 0 {
                    let sum = limbs[k] + carry;
                    limbs[k] = sum & 0xffff_ffff;
                    carry = sum >> 32;
                    k += 1;
                }
            }
            Natural(limbs.into_iter().map(|limb| limb as u32).collect())
        }

        fn plus(&self, other: &Natural) -> Natural {
            let len = self.0.len().max(other.0.len()) + 1;
            let (mut limbs, mut carry) = (Vec::with_capacity(len), 0u64);
            for i in 0..len {
                let sum = *self.0.get(i).unwrap_or(&0) as u64
                    + *other.0.get(i).unwrap_or(&0) as u64
                    + carry;
                limbs.push(sum as u32);
                carry = sum >> 32;
            }
            Natural(limbs)
        }

        /// The limbs from the most significant, without leading zeros, so the derived
        /// lexicographic order of equal-length vectors is the numeric order.
        fn key(&self) -> (usize, Vec<u32>) {
            let mut limbs = self.0.clone();
            while limbs.last() == Some(&0) {
                limbs.pop();
            }
            limbs.reverse();
            (limbs.len(), limbs)
        }

        fn at_least(&self, other: &Natural) -> bool {
            self.key() >= other.key()
        }
    }

    /// The spec's "Ledgers" for the pool, over the rationals, cross-multiplied: lamports
    /// cover `L × s / Q + W × min(s, top) / Q`, and tokens cover `L × Q / s + W × Q × (top -
    /// s) / (top × s)`, the wall's term only while it holds tokens (placed, and the price
    /// below its top).
    fn covers_exactly(liquidity: u128, s: u128, wall: Wall, tokens: u64, lamports: u64) -> bool {
        let n = Natural::of;
        let q = n(1 << 64);
        let (l, w, top) = (n(liquidity), n(wall.liquidity), wall.top);
        let lamports_cover = n(lamports as u128)
            .times(&q)
            .at_least(&l.times(&n(s)).plus(&w.times(&n(s.min(top)))));
        let tokens_cover = if wall.liquidity > 0 && s < top {
            // tokens × top × s >= L × Q × top + W × Q × (top - s)
            n(tokens as u128).times(&n(top)).times(&n(s)).at_least(
                &l.times(&q)
                    .times(&n(top))
                    .plus(&w.times(&q).times(&n(top - s))),
            )
        } else {
            // tokens × s >= L × Q
            n(tokens as u128).times(&n(s)).at_least(&l.times(&q))
        };
        lamports_cover && tokens_cover
    }

    /// Ledgers at and next to the least that cover, offset by the given units: the whole
    /// token quotients `floor(L × Q / s) + floor(W × Q × (top - s) / (top × s))` and the
    /// lamports `ceil((L × s + W × min(s, top)) / Q)`, computed with `U256` (only to choose
    /// the inputs; the oracle checks the answer). `None` if they do not fit in a u64.
    fn near_the_least_cover(
        liquidity: u128,
        s: u128,
        wall: Wall,
        token_offset: i64,
        lamport_offset: i64,
    ) -> Option<(u64, u64)> {
        let qa = U256::times_q(liquidity).div_floor(U256::from(s))?;
        let qb = if wall.liquidity > 0 && s < wall.top {
            U256::times_q(wall.liquidity)
                .mul_u128(wall.top - s)?
                .div_floor(U256::mul(wall.top, s)?)?
        } else {
            U256::ZERO
        };
        let whole = qa.checked_add(qb)?.to_u64()?;
        let sol = U256::mul(liquidity, s)?
            .checked_add(U256::mul(wall.liquidity, s.min(wall.top))?)?
            .checked_ceil_shr64()?;
        let sol = u64::try_from(sol).ok()?;
        Some((
            whole.checked_add_signed(token_offset)?,
            sol.checked_add_signed(lamport_offset)?,
        ))
    }

    /// A curve of any liquidity at a price within the bounds, and no wall or a wall
    /// `place_wall` could place: its top within the bounds and `W = floor(idle × Q / top)`
    /// for a u64 of idle SOL, the price on either side of it.
    fn reachable_curve_and_wall() -> impl Strategy<Value = (u128, u128, Wall)> {
        (
            prop_oneof![MIN_LIQUIDITY..1u128 << 64, any::<u128>()],
            MIN_SQRT_PRICE..=MAX_SQRT_PRICE,
            MIN_SQRT_PRICE..=MAX_SQRT_PRICE,
            prop_oneof![Just(0u64), any::<u64>(), 1u64..1 << 30],
            prop_oneof![0u128..1 << 32, any::<u128>()],
            any::<bool>(),
        )
            .prop_map(|(liquidity, s, top, idle, offset, near_top)| {
                let liquidity_of_wall = ((idle as u128) << 64) / top;
                // Often just around the top, where the wall's term turns on and off.
                let s = if near_top {
                    (top.saturating_sub(1 << 31) + offset % (1 << 32))
                        .clamp(MIN_SQRT_PRICE, MAX_SQRT_PRICE)
                } else {
                    s
                };
                (
                    liquidity,
                    s,
                    Wall {
                        liquidity: liquidity_of_wall,
                        top,
                    },
                )
            })
    }
}
