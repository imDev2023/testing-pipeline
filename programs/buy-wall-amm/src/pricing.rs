//! The one pricing function `pipeline_quote` and `pipeline_swap` share, so a quote is exactly
//! what the swap does (docs/spec/pool4-for-solana.md, "Pricing").

use anchor_lang::prelude::*;
use pipeline_strategy_interface::fees;

use crate::config::{MAX_SQRT_PRICE, MIN_SQRT_PRICE};
use crate::errors::StrategyError;
use crate::interface::{TradeMode, TradeRequest};
use crate::math::U256;
use crate::state::{MarketState, STATUS_OPEN};
use crate::wall::Wall;

/// Exact-in only (`POOL4-14`): an exact-out quote or swap is refused.
pub const SUPPORTS_EXACT_OUT: bool = false;

/// The curve a trade moves along.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Curve {
    /// The square-root price, Q64.64.
    pub sqrt_price: u128,
    /// The curve's liquidity `L`.
    pub liquidity: u128,
}

/// Which way a trade goes: a sell brings tokens (mint 0) for SOL, a buy brings SOL (mint 1)
/// for tokens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Sell,
    Buy,
}

/// A priced trade.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Priced {
    pub side: Side,
    /// The credited input, all of it kept.
    pub amount_in: u64,
    /// The market's fee, in lamports.
    pub fee: u64,
    /// What the trader is paid.
    pub amount_out: u64,
    /// The square-root price after the trade.
    pub sqrt_price: u128,
}

/// Why a trade is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    ZeroInput,
    ZeroOutput,
    NothingAfterFee,
    PriceBoundReached,
    Overflow,
}

impl From<Refusal> for StrategyError {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::ZeroInput => StrategyError::ZeroInput,
            Refusal::ZeroOutput => StrategyError::ZeroOutput,
            Refusal::NothingAfterFee => StrategyError::NothingAfterFee,
            Refusal::PriceBoundReached => StrategyError::PriceBoundReached,
            Refusal::Overflow => StrategyError::Overflow,
        }
    }
}

/// One step of a sell along liquidity `liq` from `s` toward `target` (below `s`) with
/// `remaining` token units: `(next, used, gross)`, exactly as the spec's "A sell" writes it:
///
/// - `need = ceil(liq × Q × (s - target) / (s × target))`, the units that reach `target`;
/// - with `remaining >= need`, `next = target` and `used = need`; otherwise
///   `next = ceil(liq × Q × s / (liq × Q + remaining × s))` and `used = remaining`;
/// - `gross = floor(liq × (s - next) / Q)`, the lamports the step frees.
///
/// `remaining >= need` holds exactly when that `next` is at or below `target` (both say
/// `remaining × s × target >= liq × Q × (s - target)`, and `target` is whole), so `need`,
/// two divisions, is computed only for a step that reaches `target`; a test checks this
/// against the spec's order of operations.
///
/// The spec stages divisions where a product could overflow; a product of two square-root
/// prices never does (each is below 2^128, so it fits in 256 bits), so a division by two
/// prices divides once by their product, which takes the loop in `U256::div_rem` about as
/// many passes as the quotient has bits instead of as many as the first stage's quotient
/// has. Only numerators can overflow, and an overflow refuses the trade.
pub fn sell_step(
    liq: u128,
    s: u128,
    target: u128,
    remaining: u64,
) -> core::result::Result<(u128, u64, u64), Refusal> {
    let liq_q = U256::times_q(liq);
    let drop = s.checked_sub(target).ok_or(Refusal::Overflow)?;
    let denominator = U256::mul(remaining as u128, s)
        .and_then(|added| liq_q.checked_add(added))
        .ok_or(Refusal::Overflow)?;
    let free_next = liq_q
        .mul_u128(s)
        .and_then(|n| n.div_ceil(denominator))
        .ok_or(Refusal::Overflow)?;
    let (next, used) = if free_next <= U256::from(target) {
        let need = U256::mul(s, target)
            .and_then(|prices| liq_q.mul_u128(drop)?.div_ceil(prices))
            .and_then(U256::to_u64)
            .ok_or(Refusal::Overflow)?;
        (target, need)
    } else {
        // Above `target`, which is a u128.
        (free_next.to_u128().ok_or(Refusal::Overflow)?, remaining)
    };
    let gross = s
        .checked_sub(next)
        .and_then(|fall| U256::mul(liq, fall))
        .and_then(U256::checked_shr64)
        .and_then(|gross| u64::try_from(gross).ok())
        .ok_or(Refusal::Overflow)?;
    Ok((next, used, gross))
}

/// One step of a buy along liquidity `liq` from `s` toward `target` (above `s`) with
/// `remaining` lamports: `(next, used, out)`, where
///
/// - `need = ceil(liq × (target - s) / Q)`, the lamports that reach `target`;
/// - with `remaining >= need`, `next = target` and `used = need`; otherwise
///   `next = s + floor(remaining × Q / liq)` and `used = remaining`;
/// - `out = floor(liq × Q × (next - s) / (next × s))`, the token units the step frees,
///   divided once by the product of the two prices (see `sell_step`).
pub fn buy_step(
    liq: u128,
    s: u128,
    target: u128,
    remaining: u64,
) -> core::result::Result<(u128, u64, u64), Refusal> {
    let rise = target.checked_sub(s).ok_or(Refusal::Overflow)?;
    let need = U256::mul(liq, rise)
        .and_then(U256::checked_ceil_shr64)
        .ok_or(Refusal::Overflow)?;
    let (next, used) = if remaining as u128 >= need {
        // `need <= remaining` fits in 64 bits.
        (target, u64::try_from(need).map_err(|_| Refusal::Overflow)?)
    } else {
        // `remaining < need` keeps the step below `target - s`, so it fits in 128 bits.
        let step = U256::times_q(remaining as u128)
            .div_floor(U256::from(liq))
            .and_then(U256::to_u128)
            .ok_or(Refusal::Overflow)?;
        (s.checked_add(step).ok_or(Refusal::Overflow)?, remaining)
    };
    let out = next
        .checked_sub(s)
        .and_then(|rise| U256::times_q(liq).mul_u128(rise))
        .zip(U256::mul(next, s))
        .and_then(|(n, prices)| n.div_floor(prices))
        .and_then(U256::to_u64)
        .ok_or(Refusal::Overflow)?;
    Ok((next, used, out))
}

/// The most steps a trade takes: a trade crosses at most one boundary, the wall's top.
const MAX_STEPS: usize = 2;

/// The step function of one side: `(liq, s, target, remaining) -> (next, used, freed)`.
type Step = fn(u128, u128, u128, u64) -> core::result::Result<(u128, u64, u64), Refusal>;

/// Takes at most `MAX_STEPS` steps of `step` from `s` with `remaining` input, each along the
/// liquidity and toward the target `leg` gives for the price it starts at, until the input
/// is used up: `(the price reached, the output freed)`. Input left over means a price bound
/// was reached, which refuses the trade.
fn walk(
    mut s: u128,
    mut remaining: u64,
    leg: impl Fn(u128) -> (u128, u128),
    step: Step,
) -> core::result::Result<(u128, u64), Refusal> {
    let mut freed = 0u64;
    for _ in 0..MAX_STEPS {
        let (liq, target) = leg(s);
        let (next, used, out) = step(liq, s, target, remaining)?;
        freed = freed.checked_add(out).ok_or(Refusal::Overflow)?;
        remaining = remaining.checked_sub(used).ok_or(Refusal::Overflow)?;
        s = next;
        if remaining == 0 {
            return Ok((s, freed));
        }
    }
    Err(Refusal::PriceBoundReached)
}

/// A sell of `a` credited token units (the spec's "A sell"), in at most two steps: while a
/// wall is placed and the price is above its top, along the curve `L` toward the top;
/// otherwise along the curve and the wall together, `L + W`, toward `MIN_SQRT_PRICE`. Then
/// `fee = ceil(gross × fee_bps / 10,000)` and `out = gross - fee`.
pub fn sell(
    curve: Curve,
    wall: Wall,
    a: u64,
    fee_bps: u16,
) -> core::result::Result<Priced, Refusal> {
    if a == 0 {
        return Err(Refusal::ZeroInput);
    }
    let both = curve
        .liquidity
        .checked_add(wall.liquidity)
        .ok_or(Refusal::Overflow)?;
    let leg = |s: u128| {
        if wall.is_placed() && s > wall.top {
            (curve.liquidity, wall.top)
        } else {
            (both, MIN_SQRT_PRICE)
        }
    };
    let (sqrt_price, gross) = walk(curve.sqrt_price, a, leg, sell_step)?;
    let fee = fees::ceil_bps(gross, fee_bps as u64).ok_or(Refusal::Overflow)?;
    let amount_out = gross.checked_sub(fee).ok_or(Refusal::Overflow)?;
    if amount_out == 0 {
        return Err(Refusal::ZeroOutput);
    }
    Ok(Priced {
        side: Side::Sell,
        amount_in: a,
        fee,
        amount_out,
        sqrt_price,
    })
}

/// A buy with `a` credited lamports (the spec's "A buy"): `fee = ceil(a × fee_bps /
/// 10,000)` comes off the input first, then at most two steps: while a wall is placed and
/// the price is below its top, along the curve and the wall together, `L + W`, toward the
/// top; otherwise along the curve `L` toward `MAX_SQRT_PRICE`.
pub fn buy(
    curve: Curve,
    wall: Wall,
    a: u64,
    fee_bps: u16,
) -> core::result::Result<Priced, Refusal> {
    if a == 0 {
        return Err(Refusal::ZeroInput);
    }
    let fee = fees::ceil_bps(a, fee_bps as u64).ok_or(Refusal::Overflow)?;
    let after_fee = a.checked_sub(fee).ok_or(Refusal::NothingAfterFee)?;
    if after_fee == 0 {
        return Err(Refusal::NothingAfterFee);
    }
    let both = curve
        .liquidity
        .checked_add(wall.liquidity)
        .ok_or(Refusal::Overflow)?;
    let leg = |s: u128| {
        if wall.is_placed() && s < wall.top {
            (both, wall.top)
        } else {
            (curve.liquidity, MAX_SQRT_PRICE)
        }
    };
    let (sqrt_price, amount_out) = walk(curve.sqrt_price, after_fee, leg, buy_step)?;
    if amount_out == 0 {
        return Err(Refusal::ZeroOutput);
    }
    Ok(Priced {
        side: Side::Buy,
        amount_in: a,
        fee,
        amount_out,
        sqrt_price,
    })
}

/// A priced trade and what it leaves the market's books and counters at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settled {
    pub priced: Priced,
    pub books: crate::books::Books,
    pub counters: crate::books::Counters,
}

/// Prices `request` on `state` and books it, without changing anything: what
/// `pipeline_quote` answers and `pipeline_swap` writes, so a trade the books could not take
/// is refused by both alike.
pub fn settle(state: &MarketState, request: &TradeRequest) -> Result<Settled> {
    let priced = quote(state, request)?;
    let books = state
        .books()
        .after(&priced, state.wall_split_bps())
        .ok_or(StrategyError::Overflow)?;
    let counters = state
        .counters()
        .and_then(|counters| counters.after(&priced))
        .ok_or(StrategyError::Overflow)?;
    Ok(Settled {
        priced,
        books,
        counters,
    })
}

/// Prices `request` on `state`, with `request.amount` as the credited input. Reads no
/// clock, so a quote never depends on when it is asked.
pub fn quote(state: &MarketState, request: &TradeRequest) -> Result<Priced> {
    require!(
        request.mode == TradeMode::ExactIn,
        StrategyError::ExactOutNotSupported
    );
    state.vaults(request.input_index, request.output_index)?;
    require!(state.status == STATUS_OPEN, StrategyError::MarketNotOpen);
    let curve = Curve {
        sqrt_price: state.sqrt_price(),
        liquidity: state.liquidity(),
    };
    let wall = state.wall();
    let priced = match request.input_index {
        0 => sell(curve, wall, request.amount, state.fee_bps()),
        _ => buy(curve, wall, request.amount, state.fee_bps()),
    };
    priced.map_err(|refusal| error!(StrategyError::from(refusal)))
}

// Kani proofs of the pricing, in the tiers Pipeline uses (see `opening.rs`). A step divides
// with a quotient of about 64 bits whatever its inputs are bounded to (it is a square-root
// price, or `liq × Q` over one), and `U256::div_rem` loops once per quotient bit, so CBMC
// unrolls some 70 passes of 256-bit arithmetic per division: a step harness bounded to
// inputs below 2^5 ran over 18 minutes without finishing on the owner's Mac (2026-11-12).
// The step proofs therefore run in the full tier only, and Z3 proves the same properties
// for every input over the integers (`proofs/pricing_z3.py`), from the exactness of
// `div_rem`, which Kani proves in the default tier (`math.rs`); Proptest checks the steps
// themselves on 10,000 random markets each (below). The fee's rounding needs no division
// loop and is proved here in Pipeline's two tiers, as its own `ceil_bps` is.
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the step harnesses, for liquidities, prices and amounts.
    #[cfg(kani_full)]
    const SMALL: u128 = 1 << 5;

    /// A buy step never panics; it moves the price no further than the input it uses pays
    /// for (`(next - s) × liq <= used × Q`), never past its target, and pays out no more
    /// than the curve frees between the two prices (`out × next × s <= liq × Q × (next -
    /// s)`).
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(75)]
    fn a_buy_step_rounds_against_the_trader_bounded() {
        let (liq, s, target): (u128, u128, u128) = (kani::any(), kani::any(), kani::any());
        let remaining: u64 = kani::any();
        kani::assume(liq > 0 && liq < SMALL && s > 0 && s < target && target <= SMALL);
        kani::assume((remaining as u128) < SMALL);
        if let Ok((next, used, out)) = buy_step(liq, s, target, remaining) {
            assert!(next >= s && next <= target && used <= remaining);
            assert!(U256::mul(next - s, liq).unwrap() <= U256::times_q(used as u128));
            let paid = U256::mul(next, s).unwrap().mul_u64(out).unwrap();
            assert!(paid <= U256::times_q(liq).mul_u128(next - s).unwrap());
        }
    }

    /// A sell step never panics; it moves the price down no further than its input pays for
    /// (`next × (liq × Q + used × s) >= liq × Q × s`), never past its target, and frees no
    /// more SOL than the curve holds between the two prices (`gross × Q <= liq × (s -
    /// next)`).
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(75)]
    fn a_sell_step_rounds_against_the_trader_bounded() {
        let (liq, s, target): (u128, u128, u128) = (kani::any(), kani::any(), kani::any());
        let remaining: u64 = kani::any();
        kani::assume(liq > 0 && liq < SMALL && target > 0 && target < s && s <= SMALL);
        kani::assume((remaining as u128) < SMALL);
        if let Ok((next, used, gross)) = sell_step(liq, s, target, remaining) {
            assert!(next >= target && next <= s && used <= remaining);
            let liq_q = U256::times_q(liq);
            let moved = liq_q
                .checked_add(U256::mul(used as u128, s).unwrap())
                .unwrap();
            assert!(moved.mul_u128(next).unwrap() >= liq_q.mul_u128(s).unwrap());
            assert!(U256::times_q(gross as u128) <= U256::mul(liq, s - next).unwrap());
        }
    }

    /// At the wall's top, the two-step pricing rounds against the trader: ledgers that
    /// covered the curve and the wall before a sell that crosses the top still cover both
    /// after, and the same for a buy that crosses it upward. Bounded as the step harnesses
    /// are; Z3 proves it for every input (`proofs/wall_z3.py`).
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(75)]
    fn the_two_steps_round_against_the_trader_at_the_walls_top_bounded() {
        let curve = Curve {
            sqrt_price: kani::any(),
            liquidity: kani::any(),
        };
        let wall = Wall {
            liquidity: kani::any(),
            top: kani::any(),
        };
        let a: u64 = kani::any();
        kani::assume(curve.liquidity > 0 && curve.liquidity < SMALL);
        kani::assume(wall.liquidity > 0 && wall.liquidity < SMALL);
        kani::assume(curve.sqrt_price > 0 && curve.sqrt_price <= SMALL);
        kani::assume(wall.top > 0 && wall.top <= SMALL && wall.top != curve.sqrt_price);
        kani::assume((a as u128) < SMALL);
        let (l, w, s, t) = (curve.liquidity, wall.liquidity, curve.sqrt_price, wall.top);
        let side = if s > t {
            sell(curve, wall, a, 25)
        } else {
            buy(curve, wall, a, 25)
        };
        if let Ok(p) = side {
            let next = p.sqrt_price;
            // The trader never gets more than the curve and the wall free between the two
            // prices: lamports for a sell, token units for a buy (through `L + W` below the
            // top, `L` above it).
            if p.side == Side::Sell && next < t {
                let freed = U256::mul(l, s - t)
                    .unwrap()
                    .checked_add(U256::mul(l + w, t - next).unwrap())
                    .unwrap();
                assert!(U256::times_q((p.amount_out + p.fee) as u128) <= freed);
            }
            if p.side == Side::Buy && next > t {
                let (lq, bq) = (U256::times_q(l), U256::times_q(l + w));
                // out <= (L + W) × Q × (t - s) / (t × s) + L × Q × (next - t) / (next × t),
                // over the common denominator s × t × next.
                let paid = U256::mul(s, t)
                    .unwrap()
                    .mul_u128(next)
                    .unwrap()
                    .mul_u64(p.amount_out)
                    .unwrap();
                let owed = bq
                    .mul_u128(t - s)
                    .unwrap()
                    .mul_u128(next)
                    .unwrap()
                    .checked_add(lq.mul_u128(next - t).unwrap().mul_u128(s).unwrap())
                    .unwrap();
                assert!(paid <= owed);
            }
        }
    }

    /// The fee rounds up and the output down: a sell's fee is `ceil(gross × bps / 10,000)`
    /// and its output `gross - fee`, for gross amounts below 2^12 (as Pipeline bounds its
    /// own `ceil_bps`) and every fee a market may charge.
    #[kani::proof]
    fn a_sells_fee_rounds_up_bounded() {
        let gross: u64 = kani::any();
        kani::assume(gross < 1 << 12);
        a_sells_fee_rounds_up(gross);
    }

    /// The same for every gross amount.
    #[cfg(kani_full)]
    #[kani::proof]
    fn a_sells_fee_rounds_up_for_every_amount() {
        a_sells_fee_rounds_up(kani::any());
    }

    fn a_sells_fee_rounds_up(gross: u64) {
        let fee_bps: u16 = kani::any();
        kani::assume((crate::config::MIN_FEE_BPS..=crate::config::MAX_FEE_BPS).contains(&fee_bps));
        let fee = fees::ceil_bps(gross, fee_bps as u64).unwrap();
        // fee × 10,000 >= gross × bps > (fee - 1) × 10,000, and the fee never exceeds gross.
        let exact = gross as u128 * fee_bps as u128;
        assert!(fee as u128 * 10_000 >= exact);
        assert!(fee == 0 || (fee as u128 - 1) * 10_000 < exact);
        assert!(fee <= gross);
    }

    /// Every step, for every input, in the full tier.
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(260)]
    fn every_trade_rounds_against_the_trader() {
        let curve = Curve {
            sqrt_price: kani::any(),
            liquidity: kani::any(),
        };
        let a: u64 = kani::any();
        let fee_bps: u16 = kani::any();
        kani::assume((crate::config::MIN_FEE_BPS..=crate::config::MAX_FEE_BPS).contains(&fee_bps));
        if let Ok(bought) = buy(curve, Wall::NONE, a, fee_bps) {
            assert!(bought.sqrt_price > curve.sqrt_price && bought.sqrt_price <= MAX_SQRT_PRICE);
            let after = Curve {
                sqrt_price: bought.sqrt_price,
                ..curve
            };
            if let Ok(sold) = sell(after, Wall::NONE, bought.amount_out, fee_bps) {
                assert!(sold.amount_out < a);
            }
        }
    }

    /// A sell step that returns any result meeting the step contract `proofs/pricing_z3.py`
    /// proves of `sell_step`: the price falls no further than the target, the input used is
    /// at most what is left, and the step stops short of its target only by using all of it.
    fn any_sell_step(
        _liq: u128,
        s: u128,
        target: u128,
        remaining: u64,
    ) -> core::result::Result<(u128, u64, u64), Refusal> {
        let (next, used, out): (u128, u64, u64) = (kani::any(), kani::any(), kani::any());
        kani::assume(target <= next && next <= s && used <= remaining);
        kani::assume(next == target || used == remaining);
        Ok((next, used, out))
    }

    /// The same for a buy step, whose price rises toward its target.
    fn any_buy_step(
        _liq: u128,
        s: u128,
        target: u128,
        remaining: u64,
    ) -> core::result::Result<(u128, u64, u64), Refusal> {
        let (next, used, out): (u128, u64, u64) = (kani::any(), kani::any(), kani::any());
        kani::assume(s <= next && next <= target && used <= remaining);
        kani::assume(next == target || used == remaining);
        Ok((next, used, out))
    }

    /// A curve, a wall and an input as trading can reach them (R1 and R3 of INV-PM-9): the
    /// price within the bounds and a placed wall's top within them too.
    fn any_market() -> (u128, u128, u128, u128, u64) {
        let (l, w, top, s): (u128, u128, u128, u128) =
            (kani::any(), kani::any(), kani::any(), kani::any());
        kani::assume((MIN_SQRT_PRICE..=MAX_SQRT_PRICE).contains(&s));
        kani::assume(w == 0 || (MIN_SQRT_PRICE..=MAX_SQRT_PRICE).contains(&top));
        // `sell` and `buy` refuse `L + W` past 128 bits before they walk.
        kani::assume(l.checked_add(w).is_some());
        (l, w, top, s, kani::any())
    }

    /// Two steps always suffice for a sell, and it is refused at a price bound only at the
    /// bound (INV-PM-9): `walk` with `sell`'s legs (restated here: along `L` toward the top
    /// while a placed wall's top is below the price, otherwise along `L + W` toward
    /// `MIN_SQRT_PRICE`) and any step meeting the step contract crosses at most the wall's
    /// top, its second step starts where the first stopped and heads for `MIN_SQRT_PRICE`,
    /// and `PriceBoundReached` comes only after a step toward `MIN_SQRT_PRICE` left input
    /// over, which the contract makes a step that reached it. The step being abstract, no
    /// division loop runs, so it holds for every curve, wall and input: verified in 5
    /// seconds on the owner's Mac (2026-11-16). The Proptest
    /// `a_reachable_trade_never_overflows` (below) replays the real steps.
    #[kani::proof]
    #[kani::unwind(3)]
    fn two_steps_always_suffice_for_a_sell() {
        let (l, w, top, s, a) = any_market();
        let calls = core::cell::Cell::new([(0u128, 0u128, 0u128); 2]);
        let count = core::cell::Cell::new(0usize);
        let leg = |s: u128| {
            let (liq, target) = if w > 0 && s > top {
                (l, top)
            } else {
                (l + w, MIN_SQRT_PRICE)
            };
            let mut log = calls.get();
            log[count.get()] = (s, liq, target);
            calls.set(log);
            count.set(count.get() + 1);
            (liq, target)
        };
        let walked = walk(s, a, leg, any_sell_step);
        let (n, log) = (count.get(), calls.get());
        assert!(n == 1 || n == 2);
        // The first step heads for the top only from above it.
        assert_eq!(
            log[0].2 == top && top != MIN_SQRT_PRICE,
            w > 0 && s > top && top != MIN_SQRT_PRICE
        );
        if n == 2 {
            // The second starts where the first stopped, at its target, and heads for the
            // bound along the curve and the wall together.
            assert_eq!(log[1].0, log[0].2);
            assert_eq!((log[1].1, log[1].2), (l + w, MIN_SQRT_PRICE));
        }
        match walked {
            Ok((next, _)) => assert!(MIN_SQRT_PRICE <= next && next <= s),
            Err(Refusal::PriceBoundReached) => {
                assert!(n == 2 && log[1].2 == MIN_SQRT_PRICE)
            }
            // Only the freed sum's overflow, INV-PM-4's to rule out.
            Err(refusal) => assert!(refusal == Refusal::Overflow),
        }
        kani::cover!(walked == Err(Refusal::PriceBoundReached) && w > 0 && s > top);
        kani::cover!(walked.is_ok() && n == 2 && w > 0);
    }

    /// The same for a buy (INV-PM-9): with `buy`'s legs (along `L + W` toward the top while
    /// a placed wall's top is above the price, otherwise along `L` toward `MAX_SQRT_PRICE`),
    /// it crosses at most the wall's top and is refused at a price bound only at
    /// `MAX_SQRT_PRICE`. Verified in 5 seconds on the owner's Mac (2026-11-16).
    #[kani::proof]
    #[kani::unwind(3)]
    fn two_steps_always_suffice_for_a_buy() {
        let (l, w, top, s, a) = any_market();
        let calls = core::cell::Cell::new([(0u128, 0u128, 0u128); 2]);
        let count = core::cell::Cell::new(0usize);
        let leg = |s: u128| {
            let (liq, target) = if w > 0 && s < top {
                (l + w, top)
            } else {
                (l, MAX_SQRT_PRICE)
            };
            let mut log = calls.get();
            log[count.get()] = (s, liq, target);
            calls.set(log);
            count.set(count.get() + 1);
            (liq, target)
        };
        let walked = walk(s, a, leg, any_buy_step);
        let (n, log) = (count.get(), calls.get());
        assert!(n == 1 || n == 2);
        assert_eq!(
            log[0].2 == top && top != MAX_SQRT_PRICE,
            w > 0 && s < top && top != MAX_SQRT_PRICE
        );
        if n == 2 {
            assert_eq!(log[1].0, log[0].2);
            assert_eq!((log[1].1, log[1].2), (l, MAX_SQRT_PRICE));
        }
        match walked {
            Ok((next, _)) => assert!(s <= next && next <= MAX_SQRT_PRICE),
            Err(Refusal::PriceBoundReached) => {
                assert!(n == 2 && log[1].2 == MAX_SQRT_PRICE)
            }
            Err(refusal) => assert!(refusal == Refusal::Overflow),
        }
        kani::cover!(walked == Err(Refusal::PriceBoundReached) && w > 0 && s < top);
        kani::cover!(walked.is_ok() && n == 2 && w > 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{MAX_FEE_BPS, MIN_FEE_BPS, MIN_LIQUIDITY};
    use proptest::prelude::*;

    /// The worked example's market after its seed (docs/spec/pool4-for-solana.md, "Worked
    /// example"): 1,000,000 tokens of 6 decimals against 10 SOL, fee 100.
    const SEEDED: Curve = Curve {
        sqrt_price: 1_844_674_407_370_955_161,
        liquidity: 99_999_999_999,
    };
    const FEE_BPS: u16 = 100;

    #[test]
    fn the_worked_examples_buy_and_sell_price_at_the_spec_numbers() {
        // A buy of 1 SOL.
        let bought = buy(SEEDED, Wall::NONE, 1_000_000_000, FEE_BPS).unwrap();
        assert_eq!(bought.fee, 10_000_000);
        assert_eq!(bought.amount_out, 90_081_892_629);
        assert_eq!(bought.sqrt_price, 2_027_297_173_702_505_949);
        // Selling those units back, on the same liquidity (a cap ratchet never changes it).
        let after_buy = Curve {
            sqrt_price: bought.sqrt_price,
            ..SEEDED
        };
        let sold = sell(after_buy, Wall::NONE, bought.amount_out, FEE_BPS).unwrap();
        assert_eq!(sold.amount_out + sold.fee, 989_999_999);
        assert_eq!(sold.fee, 9_900_000);
        assert_eq!(sold.amount_out, 980_099_999);
        assert_eq!(sold.sqrt_price, 1_844_674_407_372_029_099);
    }

    /// The worked example's market after `place_wall`: the curve trimmed to 99,166,666,666 and
    /// a wall of 903,804,010 placed at the opening price, the lowest close since the seed, a
    /// hair below the price (`POOL4-50`).
    const AFTER_PLACE_WALL: Curve = Curve {
        sqrt_price: 1_844_674_407_372_029_099,
        liquidity: 99_166_666_666,
    };
    const WALL: Wall = Wall {
        liquidity: 903_804_010,
        top: 1_844_674_407_370_955_161,
    };

    #[test]
    fn the_worked_examples_sell_into_the_wall_prices_at_the_spec_numbers() {
        // 60 seconds after `place_wall`, a sell of 20,000,000,000 units, through the curve and
        // the wall together (from a hair above the wall's top, so the curve alone to it first).
        let sold = sell(AFTER_PLACE_WALL, WALL, 20_000_000_000, FEE_BPS).unwrap();
        assert_eq!(sold.amount_out + sold.fee, 196_081_138);
        assert_eq!(sold.fee, 1_960_812);
        assert_eq!(sold.amount_out, 194_120_326);
        assert_eq!(sold.sqrt_price, 1_808_529_293_214_755_428);
        // The wall has spent 1,770,941 lamports on 180,633,508 units.
        let placed = 90_380_400;
        assert_eq!(placed - WALL.sol_at(sold.sqrt_price).unwrap(), 1_770_941);
        assert_eq!(WALL.tokens_at(sold.sqrt_price).unwrap(), 180_633_508);
    }

    #[test]
    fn without_a_wall_trades_price_as_on_the_curve_alone() {
        // No wall, or a wall with no liquidity: one step along the curve, as before the wall.
        for wall in [
            Wall::NONE,
            Wall {
                liquidity: 0,
                top: SEEDED.sqrt_price * 2,
            },
        ] {
            let bought = buy(SEEDED, wall, 1_000_000_000, FEE_BPS).unwrap();
            assert_eq!(bought.amount_out, 90_081_892_629);
            let sold = sell(SEEDED, wall, 90_081_892_629, FEE_BPS).unwrap();
            assert_eq!(
                sold,
                sell(SEEDED, Wall::NONE, 90_081_892_629, FEE_BPS).unwrap()
            );
        }
    }

    #[test]
    fn a_trade_crosses_the_walls_top_in_two_steps() {
        // A wall placed below the price: a sell that stays above its top moves along the
        // curve alone; one that crosses it takes the curve to the top, then the curve and
        // the wall together.
        let top = SEEDED.sqrt_price - SEEDED.sqrt_price / 100;
        let wall = Wall {
            liquidity: SEEDED.liquidity / 10,
            top,
        };
        let small = sell(SEEDED, wall, 1_000_000, FEE_BPS).unwrap();
        assert_eq!(small, sell(SEEDED, Wall::NONE, 1_000_000, FEE_BPS).unwrap());
        assert!(small.sqrt_price > top);
        let big = 100_000_000_000;
        let crossed = sell(SEEDED, wall, big, FEE_BPS).unwrap();
        assert!(crossed.sqrt_price < top);
        let (_, need, first) = sell_step(SEEDED.liquidity, SEEDED.sqrt_price, top, big).unwrap();
        let (next, used, second) = sell_step(
            SEEDED.liquidity + wall.liquidity,
            top,
            MIN_SQRT_PRICE,
            big - need,
        )
        .unwrap();
        assert_eq!(used, big - need);
        assert_eq!(crossed.sqrt_price, next);
        assert_eq!(crossed.amount_out + crossed.fee, first + second);
        // The wall makes the price fall less than the curve alone would.
        assert!(crossed.sqrt_price > sell(SEEDED, Wall::NONE, big, FEE_BPS).unwrap().sqrt_price);

        // From inside the wall, a buy that stays below its top moves along both; one that
        // crosses it takes both to the top, then the curve alone.
        let inside = Curve {
            sqrt_price: crossed.sqrt_price,
            ..SEEDED
        };
        let both = Curve {
            liquidity: SEEDED.liquidity + wall.liquidity,
            ..inside
        };
        let small = buy(inside, wall, 1_000_000, FEE_BPS).unwrap();
        assert_eq!(small, buy(both, Wall::NONE, 1_000_000, FEE_BPS).unwrap());
        let a = 5_000_000_000;
        let crossed = buy(inside, wall, a, FEE_BPS).unwrap();
        assert!(crossed.sqrt_price > top);
        let remaining = a - crossed.fee;
        let (_, need, first) = buy_step(both.liquidity, inside.sqrt_price, top, remaining).unwrap();
        let (next, _, second) =
            buy_step(SEEDED.liquidity, top, MAX_SQRT_PRICE, remaining - need).unwrap();
        assert_eq!(crossed.sqrt_price, next);
        assert_eq!(crossed.amount_out, first + second);

        // At the top exactly, a sell goes through both and a buy through the curve alone.
        let at_top = Curve {
            sqrt_price: top,
            ..SEEDED
        };
        let both = Curve {
            liquidity: SEEDED.liquidity + wall.liquidity,
            ..at_top
        };
        assert_eq!(
            sell(at_top, wall, 1_000_000, FEE_BPS),
            sell(both, Wall::NONE, 1_000_000, FEE_BPS)
        );
        assert_eq!(
            buy(at_top, wall, 1_000_000, FEE_BPS),
            buy(at_top, Wall::NONE, 1_000_000, FEE_BPS)
        );
    }

    #[test]
    fn each_refusal_is_on_the_right_side_of_its_bound() {
        // Zero input, either way.
        assert_eq!(
            sell(SEEDED, Wall::NONE, 0, FEE_BPS),
            Err(Refusal::ZeroInput)
        );
        assert_eq!(buy(SEEDED, Wall::NONE, 0, FEE_BPS), Err(Refusal::ZeroInput));
        // One lamport pays a one-lamport fee, leaving nothing.
        assert_eq!(
            buy(SEEDED, Wall::NONE, 1, FEE_BPS),
            Err(Refusal::NothingAfterFee)
        );
        // At about 0.01 lamport a unit, a few units free nothing; the least sell that pays
        // anything is just above 100 units (gross 1, fee 1, out 0 is refused too).
        assert_eq!(
            sell(SEEDED, Wall::NONE, 1, FEE_BPS),
            Err(Refusal::ZeroOutput)
        );
        let first_paying = (1..10_000)
            .find(|a| sell(SEEDED, Wall::NONE, *a, FEE_BPS).is_ok())
            .unwrap();
        assert_eq!(
            sell(SEEDED, Wall::NONE, first_paying - 1, FEE_BPS),
            Err(Refusal::ZeroOutput)
        );
        assert_eq!(
            sell(SEEDED, Wall::NONE, first_paying, FEE_BPS)
                .unwrap()
                .amount_out,
            1
        );
        // Two lamports leave one after the fee, which buys about 100 units.
        assert!(buy(SEEDED, Wall::NONE, 2, FEE_BPS).unwrap().amount_out > 0);
    }

    #[test]
    fn a_trade_reaching_a_price_bound_with_input_left_is_refused() {
        // On a thin curve both bounds are within a u64's reach: liquidity 1,000,000 at a
        // price of 1 lamport a unit holds 10^6 of each, and MIN_SQRT_PRICE is 2^32 below.
        let thin = Curve {
            sqrt_price: 1 << 64,
            liquidity: 1_000_000,
        };
        // Selling down to MIN_SQRT_PRICE takes `need` units exactly; one more is refused.
        let (next, need, _) =
            sell_step(thin.liquidity, thin.sqrt_price, MIN_SQRT_PRICE, u64::MAX).unwrap();
        assert_eq!(next, MIN_SQRT_PRICE);
        let at_bound = sell(thin, Wall::NONE, need, FEE_BPS).unwrap();
        assert_eq!(at_bound.sqrt_price, MIN_SQRT_PRICE);
        assert_eq!(
            sell(thin, Wall::NONE, need + 1, FEE_BPS),
            Err(Refusal::PriceBoundReached)
        );
        // From the bound, every further sell is refused.
        let at_min = Curve {
            sqrt_price: MIN_SQRT_PRICE,
            ..thin
        };
        assert_eq!(
            sell(at_min, Wall::NONE, 1, FEE_BPS),
            Err(Refusal::PriceBoundReached)
        );
        // On the worked example's market the bound needs over 4 × 10^20 units, more than
        // any u64: selling everything a u64 holds stays above it.
        let (next, used, _) = sell_step(
            SEEDED.liquidity,
            SEEDED.sqrt_price,
            MIN_SQRT_PRICE,
            u64::MAX,
        )
        .unwrap();
        assert!(next > MIN_SQRT_PRICE && used == u64::MAX);

        // Buying up to MAX_SQRT_PRICE on the thin curve costs about 2^32 × 10^6 lamports.
        let (_, need, _) =
            buy_step(thin.liquidity, thin.sqrt_price, MAX_SQRT_PRICE, u64::MAX).unwrap();
        // The input that leaves exactly `need` after the fee, then one lamport more.
        let after_fee = |a: u64| a - fees::ceil_bps(a, FEE_BPS as u64).unwrap();
        // The least input leaving `need`, found from just below its estimate.
        let estimate = (need as u128 * 10_000 / (10_000 - FEE_BPS as u128)) as u64;
        let input = (estimate.saturating_sub(10)..)
            .find(|a| after_fee(*a) >= need)
            .unwrap();
        assert!(input - estimate.saturating_sub(10) < 100);
        if after_fee(input) == need {
            assert_eq!(
                buy(thin, Wall::NONE, input, FEE_BPS).unwrap().sqrt_price,
                MAX_SQRT_PRICE
            );
        }
        assert_eq!(
            buy(thin, Wall::NONE, input + 200, FEE_BPS),
            Err(Refusal::PriceBoundReached)
        );
    }

    #[test]
    fn absurd_curves_refuse_with_overflow_never_panic() {
        for curve in [
            Curve {
                sqrt_price: u128::MAX,
                liquidity: u128::MAX,
            },
            Curve {
                sqrt_price: MAX_SQRT_PRICE,
                liquidity: u128::MAX,
            },
            Curve {
                sqrt_price: 1,
                liquidity: 1,
            },
            Curve {
                sqrt_price: 1 << 64,
                liquidity: 0,
            },
        ] {
            for a in [1, 2, 1 << 32, u64::MAX] {
                for fee_bps in [MIN_FEE_BPS, MAX_FEE_BPS] {
                    // Any answer but a panic; an accepted trade still obeys the bounds.
                    if let Ok(priced) = sell(curve, Wall::NONE, a, fee_bps) {
                        assert!(priced.sqrt_price >= MIN_SQRT_PRICE);
                    }
                    if let Ok(priced) = buy(curve, Wall::NONE, a, fee_bps) {
                        assert!(priced.sqrt_price <= MAX_SQRT_PRICE);
                    }
                }
            }
        }
    }

    /// The spec's "A sell" step in its own order: `need` first, then the comparison.
    fn sell_step_as_written(
        liq: u128,
        s: u128,
        target: u128,
        remaining: u64,
    ) -> core::result::Result<(u128, u64, u64), Refusal> {
        let liq_q = U256::times_q(liq);
        let need = liq_q
            .mul_u128(s - target)
            .and_then(|n| n.div_ceil(U256::mul(s, target).unwrap()))
            .ok_or(Refusal::Overflow)?;
        let (next, used) = if U256::from(remaining) >= need {
            (target, need.to_u64().unwrap())
        } else {
            let denominator = liq_q
                .checked_add(U256::mul(remaining as u128, s).unwrap())
                .unwrap();
            let next = liq_q
                .mul_u128(s)
                .ok_or(Refusal::Overflow)?
                .div_ceil(denominator)
                .unwrap();
            (next.to_u128().unwrap(), remaining)
        };
        let gross = U256::mul(liq, s - next).unwrap().checked_shr64().unwrap();
        Ok((
            next,
            used,
            u64::try_from(gross).map_err(|_| Refusal::Overflow)?,
        ))
    }

    /// A market of any size a seed can open, at any price trading can reach.
    fn curve() -> impl Strategy<Value = Curve> {
        (MIN_SQRT_PRICE..=MAX_SQRT_PRICE, MIN_LIQUIDITY..1u128 << 96).prop_map(
            |(sqrt_price, liquidity)| Curve {
                sqrt_price,
                liquidity,
            },
        )
    }

    /// Input amounts across the whole u64 range, weighted toward ordinary sizes.
    fn amount() -> impl Strategy<Value = u64> {
        prop_oneof![1u64..1_000, 1_000u64..1 << 40, any::<u64>()]
    }

    fn fee_bps() -> impl Strategy<Value = u16> {
        prop_oneof![
            Just(MIN_FEE_BPS),
            Just(MAX_FEE_BPS),
            MIN_FEE_BPS..=MAX_FEE_BPS
        ]
    }

    /// Pool sizes from tiny to huge on either side, so their ledgers fit in a u64.
    fn pool_side() -> impl Strategy<Value = u64> {
        prop_oneof![
            1_000_000u64..1_000_000_000,
            1_000_000_000u64..1_000_000_000_000_000,
            1_000_000_000_000_000u64..1 << 62,
        ]
    }

    /// A curve holding `x` token units and `y` lamports, at a price within the trading
    /// bounds, so the ledgers that cover it fit in a u64: `(curve, x, y)`.
    fn pool() -> impl Strategy<Value = (Curve, u64, u64)> {
        (pool_side(), pool_side()).prop_filter_map("a price within the trading bounds", |(x, y)| {
            let sqrt_price = crate::opening::opening_sqrt_price(x, y)?;
            let liquidity = crate::opening::opening_liquidity(x, y, sqrt_price)?;
            ((MIN_SQRT_PRICE..=MAX_SQRT_PRICE).contains(&sqrt_price) && liquidity >= MIN_LIQUIDITY)
                .then_some((
                    Curve {
                        sqrt_price,
                        liquidity,
                    },
                    x,
                    y,
                ))
        })
    }

    /// A curve as in `pool()`, a wall of up to twice its liquidity with its top from half to
    /// twice the price (or no wall), and a trade size: a share of the pool's side the trade
    /// brings, from a millionth to twice it, or any amount.
    fn curve_and_wall() -> impl Strategy<Value = (Curve, Wall, u64, u64)> {
        (
            pool(),
            0u128..=2_000,
            500u128..=2_000,
            any::<bool>(),
            1u64..=2_000_000,
            amount(),
            any::<bool>(),
        )
            .prop_map(
                |((c, x, y), w_permille, top_permille, placed, share, any_amount, relative)| {
                    let top =
                        (c.sqrt_price / 1_000 * top_permille).clamp(MIN_SQRT_PRICE, MAX_SQRT_PRICE);
                    let wall = if placed {
                        Wall {
                            liquidity: c.liquidity / 1_000 * w_permille,
                            top,
                        }
                    } else {
                        Wall::NONE
                    };
                    let of = |side: u64| (side as u128 * share as u128 / 1_000_000).max(1) as u64;
                    let (sell_amount, buy_amount) = if relative {
                        (of(x), of(y))
                    } else {
                        (any_amount, any_amount)
                    };
                    (c, wall, sell_amount, buy_amount)
                },
            )
    }

    /// Whether `tokens` and `lamports` cover the curve and the wall at the curve's price.
    fn covers(c: Curve, wall: Wall, tokens: u64, lamports: u64) -> bool {
        crate::wall::covers(c.liquidity, c.sqrt_price, wall, tokens, lamports)
    }

    /// The least ledgers that cover the curve and the wall, rounded up, if they fit.
    fn least_cover(c: Curve, wall: Wall) -> Option<(u64, u64)> {
        let (l, s) = (c.liquidity, c.sqrt_price);
        let tokens = U256::times_q(l)
            .div_ceil(U256::from(s))?
            .to_u64()?
            .checked_add(wall.tokens_at(s)?)?
            .checked_add(1)?;
        let lamports = u64::try_from(U256::mul(l, s)?.checked_ceil_shr64()?)
            .ok()?
            .checked_add(wall.sol_at(s)?)?
            .checked_add(1)?;
        Some((tokens, lamports))
    }

    /// Whether `tokens` and `lamports` cover the curve alone at its price.
    fn covered(curve: Curve, tokens: u64, lamports: u64) -> bool {
        covers(curve, Wall::NONE, tokens, lamports)
    }

    /// Whether trading can reach this curve and wall (R1 to R5 of INV-PM-4): the price within
    /// the bounds, the liquidity at least `MIN_LIQUIDITY`, a placed wall's top within the
    /// bounds with what it held at its top fitting in a u64 (`place_wall` places `W =
    /// floor(idle × Q / top)` from a u64 of idle SOL), and the least ledgers that cover the
    /// curve and the wall fitting in a u64, as the vaults' balances do.
    fn reachable(c: Curve, wall: Wall) -> bool {
        let bounds = MIN_SQRT_PRICE..=MAX_SQRT_PRICE;
        bounds.contains(&c.sqrt_price)
            && c.liquidity >= MIN_LIQUIDITY
            && (!wall.is_placed()
                || (bounds.contains(&wall.top) && wall.sol_at(wall.top).is_some()))
            && least_cover(c, wall).is_some()
    }

    /// The trade `priced` of `a` on `side` if accepted, and otherwise a check of its refusal's
    /// kind (INV-PM-4), so no case skips a refusal unseen: zero input only for nothing in, a
    /// buy's fee may leave nothing, either may pay nothing out or reach a price bound, and
    /// `Overflow` only on a market trading cannot reach.
    fn accepted(
        c: Curve,
        wall: Wall,
        side: Side,
        a: u64,
        priced: core::result::Result<Priced, Refusal>,
    ) -> core::result::Result<Option<Priced>, TestCaseError> {
        let refusal = match priced {
            Ok(p) => return Ok(Some(p)),
            Err(refusal) => refusal,
        };
        let legitimate = match refusal {
            Refusal::ZeroInput => a == 0,
            Refusal::NothingAfterFee => side == Side::Buy && a > 0,
            Refusal::ZeroOutput | Refusal::PriceBoundReached => a > 0,
            Refusal::Overflow => !reachable(c, wall),
        };
        prop_assert!(
            legitimate,
            "{:?} of {} refused as {:?} on {:?} with {:?}",
            side,
            a,
            refusal,
            c,
            wall
        );
        Ok(None)
    }

    /// `sell`'s legs, restated from the spec: along the curve toward a placed wall's top
    /// while the price is above it, otherwise along the curve and the wall together toward
    /// `MIN_SQRT_PRICE`.
    fn sell_leg(c: Curve, wall: Wall, s: u128) -> (u128, u128) {
        if wall.is_placed() && s > wall.top {
            (c.liquidity, wall.top)
        } else {
            (c.liquidity + wall.liquidity, MIN_SQRT_PRICE)
        }
    }

    /// `buy`'s legs: along the curve and the wall together toward a placed wall's top while
    /// the price is below it, otherwise along the curve toward `MAX_SQRT_PRICE`.
    fn buy_leg(c: Curve, wall: Wall, s: u128) -> (u128, u128) {
        if wall.is_placed() && s < wall.top {
            (c.liquidity + wall.liquidity, wall.top)
        } else {
            (c.liquidity, MAX_SQRT_PRICE)
        }
    }

    /// A side's legs: the liquidity and target a step from a price takes.
    type Leg = fn(Curve, Wall, u128) -> (u128, u128);

    /// Replays a trade the real steps refused at a price bound, step by step along the
    /// spec's legs (INV-PM-9's concrete layer): it took both steps, the second from where the
    /// first stopped, and the second reached the bound it heads for with input left over.
    fn refused_only_at_the_bound(
        c: Curve,
        wall: Wall,
        side: Side,
        amount: u64,
    ) -> core::result::Result<(), TestCaseError> {
        let (leg, step, bound): (Leg, Step, u128) = match side {
            Side::Sell => (sell_leg, sell_step, MIN_SQRT_PRICE),
            Side::Buy => (buy_leg, buy_step, MAX_SQRT_PRICE),
        };
        let (mut s, mut remaining) = (c.sqrt_price, amount);
        for taken in 1..=MAX_STEPS {
            let (liq, target) = leg(c, wall, s);
            let (next, used, _) = step(liq, s, target, remaining).unwrap();
            remaining -= used;
            prop_assert!(remaining > 0, "refused after using all its input");
            if taken == MAX_STEPS {
                prop_assert_eq!((target, next), (bound, bound));
            } else {
                // Input left over: the step reached its target.
                prop_assert_eq!(next, target);
            }
            s = next;
        }
        Ok(())
    }

    /// A curve at or near `MIN_LIQUIDITY`, where a u64 of input reaches either price bound,
    /// and the deepest wall `place_wall` can place on it: `W = floor(idle × Q / top)` for any
    /// u64 of idle SOL at a top from `MIN_SQRT_PRICE` up, so `W` reaches about 2^96 at a low
    /// top (INV-PM-4's worst case, `(L + W) × Q × s` the largest product pricing forms). The
    /// price is anywhere from just below the top, inside the wall, to above it. Only markets
    /// trading can reach (`reachable`).
    fn thin_curve_and_deep_wall() -> impl Strategy<Value = (Curve, Wall)> {
        (
            MIN_LIQUIDITY..MIN_LIQUIDITY * 1_000,
            prop_oneof![
                MIN_SQRT_PRICE..MIN_SQRT_PRICE << 8,
                MIN_SQRT_PRICE..=MAX_SQRT_PRICE
            ],
            prop_oneof![any::<u64>(), u64::MAX - (1 << 20)..=u64::MAX, 1u64..1 << 40],
            any::<bool>(),
            prop_oneof![0u128..1 << 16, 0u128..=1 << 64, any::<u128>()],
            any::<bool>(),
        )
            .prop_map(|(liquidity, top, idle, placed, offset, above)| {
                let wall = Wall {
                    liquidity: if placed {
                        ((idle as u128) << 64) / top
                    } else {
                        0
                    },
                    top,
                };
                // Above the top, or below it by at most half of it.
                let sqrt_price = if above {
                    top.saturating_add(offset).min(MAX_SQRT_PRICE)
                } else {
                    top - offset % (top / 2)
                };
                (
                    Curve {
                        sqrt_price,
                        liquidity,
                    },
                    wall,
                )
            })
            .prop_filter("a market trading can reach", |(c, wall)| {
                reachable(*c, *wall)
            })
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Outputs round down and the fee rounds up: a sell's fee is `ceil(gross × bps /
        /// 10,000)` of a gross no larger than the exact curve output, and its price is the
        /// least that the input pays for; a buy's fee is `ceil(a × bps / 10,000)` and its
        /// output no larger than the exact curve output for the price it reaches.
        #[test]
        fn outputs_round_down_and_fees_round_up(c in curve(), a in amount(), fee_bps in fee_bps()) {
            let (l, s) = (c.liquidity, c.sqrt_price);
            let lq = U256::times_q(l);
            if let Some(p) = accepted(c, Wall::NONE, Side::Sell, a, sell(c, Wall::NONE, a, fee_bps))? {
                let gross = p.amount_out + p.fee;
                prop_assert_eq!(p.fee, fees::ceil_bps(gross, fee_bps as u64).unwrap());
                let next = p.sqrt_price;
                prop_assert!(next >= MIN_SQRT_PRICE && next <= s);
                // gross × Q <= L × (s - next)
                prop_assert!(U256::times_q(gross as u128) <= U256::mul(l, s - next).unwrap());
                // next × (L × Q + a × s) >= L × Q × s, and next - 1 is not enough.
                let denominator = lq.checked_add(U256::mul(a as u128, s).unwrap()).unwrap();
                let target = lq.mul_u128(s).unwrap();
                // A product past 256 bits is past `target` too.
                let reached = |n: u128| denominator.mul_u128(n).is_none_or(|v| v >= target);
                if next > MIN_SQRT_PRICE {
                    prop_assert!(reached(next));
                    prop_assert!(!reached(next - 1));
                }
            }
            if let Some(p) = accepted(c, Wall::NONE, Side::Buy, a, buy(c, Wall::NONE, a, fee_bps))? {
                prop_assert_eq!(p.fee, fees::ceil_bps(a, fee_bps as u64).unwrap());
                let rem = (a - p.fee) as u128;
                let next = p.sqrt_price;
                prop_assert!(next > s && next <= MAX_SQRT_PRICE);
                // (next - s) × L <= rem × Q: the price moves no further than the input pays.
                prop_assert!(U256::mul(next - s, l).unwrap() <= U256::times_q(rem));
                // out × next × s <= L × Q × (next - s)
                let lhs = U256::mul(next, s).unwrap().mul_u64(p.amount_out);
                let rhs = lq.mul_u128(next - s).unwrap();
                prop_assert!(lhs.is_some_and(|lhs| lhs <= rhs));
            }
        }

        /// The price moves no further than the input pays for: ledgers that covered the
        /// curve before a trade still cover it after, at the new price.
        #[test]
        fn the_ledgers_still_cover_the_curve_after_a_trade(
            (c, _, sell_amount, buy_amount) in curve_and_wall(),
            fee_bps in fee_bps(),
            sell_side in any::<bool>(),
        ) {
            let a = if sell_side { sell_amount } else { buy_amount };
            let (l, s) = (c.liquidity, c.sqrt_price);
            // The least ledgers that cover the curve: ceil(L × Q / s) and ceil(L × s / Q),
            // which fit for a curve built from pool sizes (`pool()`).
            let tokens = U256::times_q(l).div_ceil(U256::from(s)).unwrap().to_u64().unwrap();
            let lamports = u64::try_from(U256::mul(l, s).unwrap().checked_ceil_shr64().unwrap()).unwrap();
            prop_assert!(covered(c, tokens, lamports));
            let priced = if sell_side { sell(c, Wall::NONE, a, fee_bps) } else { buy(c, Wall::NONE, a, fee_bps) };
            let side = if sell_side { Side::Sell } else { Side::Buy };
            if let Some(p) = accepted(c, Wall::NONE, side, a, priced)? {
                let after = Curve { sqrt_price: p.sqrt_price, ..c };
                let (tokens, lamports) = match p.side {
                    Side::Sell => (tokens.checked_add(p.amount_in), lamports.checked_sub(p.amount_out + p.fee)),
                    Side::Buy => (tokens.checked_sub(p.amount_out), lamports.checked_add(p.amount_in - p.fee)),
                };
                let (Some(tokens), Some(lamports)) = (tokens, lamports) else {
                    // A ledger would leave the u64 range: a sell or buy too big for this
                    // market's books, which `Books::after` refuses.
                    return Ok(());
                };
                prop_assert!(covered(after, tokens, lamports));
            }
        }

        /// A buy sold straight back never returns more than it cost.
        #[test]
        fn a_buy_sold_straight_back_never_returns_more(c in curve(), a in amount(), fee_bps in fee_bps()) {
            if let Some(bought) = accepted(c, Wall::NONE, Side::Buy, a, buy(c, Wall::NONE, a, fee_bps))? {
                let after = Curve { sqrt_price: bought.sqrt_price, ..c };
                let sold = sell(after, Wall::NONE, bought.amount_out, fee_bps);
                if let Some(sold) = accepted(after, Wall::NONE, Side::Sell, bought.amount_out, sold)? {
                    prop_assert!(sold.amount_out < a);
                    // And the price returns no lower than it started.
                    prop_assert!(sold.sqrt_price >= c.sqrt_price);
                }
            }
        }

        /// `sell_step` gives what the spec's order of operations gives: `need` first, then
        /// the comparison.
        #[test]
        fn the_sell_step_is_the_spec_as_written(
            liq in MIN_LIQUIDITY..1u128 << 96,
            s in MIN_SQRT_PRICE..=MAX_SQRT_PRICE,
            target_below in 0u128..1 << 96,
            remaining in amount(),
        ) {
            let target = (s - target_below.min(s - 1)).max(1);
            prop_assert_eq!(
                sell_step(liq, s, target, remaining),
                sell_step_as_written(liq, s, target, remaining)
            );
            // And at the bound every sell steps toward.
            prop_assert_eq!(
                sell_step(liq, s, MIN_SQRT_PRICE, remaining),
                sell_step_as_written(liq, s, MIN_SQRT_PRICE, remaining)
            );
        }

        /// With a wall, two steps at most: the pool ledgers that covered the curve and the
        /// wall before a trade still cover both after it, at the new price, whichever side of
        /// the wall's top it starts and ends on. So at the boundary the trade rounds against
        /// the trader: each step moves the price no further than its input pays for and frees
        /// no more than the liquidity it moves through holds.
        #[test]
        fn the_ledgers_still_cover_the_curve_and_the_wall_after_a_trade(
            (c, wall, sell_amount, buy_amount) in curve_and_wall(),
            fee_bps in fee_bps(),
            sell_side in any::<bool>(),
        ) {
            let a = if sell_side { sell_amount } else { buy_amount };
            let (tokens, lamports) = least_cover(c, wall).expect("a pool's ledgers fit");
            prop_assert!(covers(c, wall, tokens, lamports));
            let priced = if sell_side { sell(c, wall, a, fee_bps) } else { buy(c, wall, a, fee_bps) };
            let side = if sell_side { Side::Sell } else { Side::Buy };
            if let Some(p) = accepted(c, wall, side, a, priced)? {
                let after = Curve { sqrt_price: p.sqrt_price, ..c };
                let (tokens, lamports) = match p.side {
                    Side::Sell => (tokens.checked_add(p.amount_in), lamports.checked_sub(p.amount_out + p.fee)),
                    Side::Buy => (tokens.checked_sub(p.amount_out), lamports.checked_add(p.amount_in - p.fee)),
                };
                let (Some(tokens), Some(lamports)) = (tokens, lamports) else { return Ok(()) };
                prop_assert!(covers(after, wall, tokens, lamports));
                prop_assert_eq!(p.fee, fees::ceil_bps(if sell_side { p.amount_out + p.fee } else { a }, fee_bps as u64).unwrap());
            }
        }

        /// With a wall, a buy sold straight back never returns more than it cost, and the
        /// price returns no lower than it started.
        #[test]
        fn a_buy_sold_straight_back_through_the_wall_never_returns_more(
            (c, wall, _, a) in curve_and_wall(),
            fee_bps in fee_bps(),
        ) {
            if let Some(bought) = accepted(c, wall, Side::Buy, a, buy(c, wall, a, fee_bps))? {
                let after = Curve { sqrt_price: bought.sqrt_price, ..c };
                let sold = sell(after, wall, bought.amount_out, fee_bps);
                if let Some(sold) = accepted(after, wall, Side::Sell, bought.amount_out, sold)? {
                    prop_assert!(sold.amount_out < a);
                    prop_assert!(sold.sqrt_price >= c.sqrt_price);
                }
            }
        }

        /// With a wall, more input never buys less, and the same quote comes twice.
        #[test]
        fn more_input_never_buys_less_through_the_wall(
            (c, wall, sell_amount, buy_amount) in curve_and_wall(),
            extra in 1u64..1 << 20,
            fee_bps in fee_bps(),
        ) {
            for side in [Side::Sell, Side::Buy] {
                let a = if side == Side::Sell { sell_amount } else { buy_amount }.min(u64::MAX - extra);
                let price = |amount| match side {
                    Side::Sell => sell(c, wall, amount, fee_bps),
                    Side::Buy => buy(c, wall, amount, fee_bps),
                };
                let small = accepted(c, wall, side, a, price(a))?;
                let large = accepted(c, wall, side, a + extra, price(a + extra))?;
                if let (Some(small), Some(large)) = (small, large) {
                    prop_assert!(large.amount_out >= small.amount_out);
                }
                prop_assert_eq!(price(a), price(a));
            }
        }

        /// A reachable trade never refuses with `Overflow` (INV-PM-4), even against the
        /// deepest wall `place_wall` can place on the thinnest curve, and a trade refused at
        /// a price bound took both its steps and reached the bound (INV-PM-9, replayed on
        /// the real steps).
        #[test]
        fn a_reachable_trade_never_overflows(
            (c, wall) in thin_curve_and_deep_wall(),
            a in amount(),
            fee_bps in fee_bps(),
        ) {
            for side in [Side::Sell, Side::Buy] {
                let priced = match side {
                    Side::Sell => sell(c, wall, a, fee_bps),
                    Side::Buy => buy(c, wall, a, fee_bps),
                };
                if accepted(c, wall, side, a, priced)?.is_none()
                    && priced == Err(Refusal::PriceBoundReached)
                {
                    let after_fee = match side {
                        Side::Sell => a,
                        Side::Buy => a - fees::ceil_bps(a, fee_bps as u64).unwrap(),
                    };
                    refused_only_at_the_bound(c, wall, side, after_fee)?;
                }
            }
        }

        /// A sell bought straight back never profits (INV-PM-6): spending all a sell paid
        /// out on a buy at the price it left returns fewer token units than were sold, and
        /// the price ends no higher than it started, with no wall.
        #[test]
        fn a_sell_bought_straight_back_never_returns_more(c in curve(), a in amount(), fee_bps in fee_bps()) {
            if let Some(sold) = accepted(c, Wall::NONE, Side::Sell, a, sell(c, Wall::NONE, a, fee_bps))? {
                let after = Curve { sqrt_price: sold.sqrt_price, ..c };
                let back = buy(after, Wall::NONE, sold.amount_out, fee_bps);
                if let Some(back) = accepted(after, Wall::NONE, Side::Buy, sold.amount_out, back)? {
                    prop_assert!(back.amount_out < a);
                    prop_assert!(back.sqrt_price <= c.sqrt_price);
                }
            }
        }

        /// The same through the wall, whichever side of its top each leg starts and ends on
        /// (INV-PM-6), and on the thinnest curves against the deepest walls.
        #[test]
        fn a_sell_bought_straight_back_through_the_wall_never_returns_more(
            (c, wall, a, _) in curve_and_wall(),
            (thin, deep) in thin_curve_and_deep_wall(),
            thin_amount in amount(),
            fee_bps in fee_bps(),
        ) {
            for (c, wall, a) in [(c, wall, a), (thin, deep, thin_amount)] {
                if let Some(sold) = accepted(c, wall, Side::Sell, a, sell(c, wall, a, fee_bps))? {
                    let after = Curve { sqrt_price: sold.sqrt_price, ..c };
                    let back = buy(after, wall, sold.amount_out, fee_bps);
                    if let Some(back) = accepted(after, wall, Side::Buy, sold.amount_out, back)? {
                        prop_assert!(back.amount_out < a);
                        prop_assert!(back.sqrt_price <= c.sqrt_price);
                    }
                }
            }
        }

        /// The quote never depends on anything but the curve, the amount and the fee, and
        /// more input never buys less.
        #[test]
        fn more_input_never_buys_less(c in curve(), a in 1u64..1 << 50, extra in 1u64..1 << 20, fee_bps in fee_bps()) {
            for side in [Side::Sell, Side::Buy] {
                let price = |amount| match side {
                    Side::Sell => sell(c, Wall::NONE, amount, fee_bps),
                    Side::Buy => buy(c, Wall::NONE, amount, fee_bps),
                };
                let small = accepted(c, Wall::NONE, side, a, price(a))?;
                let large = accepted(c, Wall::NONE, side, a + extra, price(a + extra))?;
                if let (Some(small), Some(large)) = (small, large) {
                    prop_assert!(large.amount_out >= small.amount_out);
                }
                prop_assert_eq!(price(a), price(a));
            }
        }
    }
}
