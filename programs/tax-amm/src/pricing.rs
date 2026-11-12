//! # Pricing
//!
//! [`fill`] is the only pricing function. `pipeline_quote` calls it to answer quotes and
//! `pipeline_swap` calls it to settle trades, so a quote is always exactly what a swap
//! delivers (docs/spec/tax-amm.md, "Pricing and the tax").
//!
//! The maths is in pure functions that take no accounts, [`exact_in`] and [`curve_out`],
//! so the property tests (`tests/maths.rs`) and the Kani proofs below exercise exactly
//! what the program runs.
//!
//! A tax market prices exact-in trades only, and only once it is open. Pricing is
//! constant product on the effective reserves, the real reserves plus the virtual reserve
//! on its side, with the tax taken outside the curve on the tax side:
//!
//! - **buy tax** (the tax side is the input): `tax = ceil(a × buy / 10,000)`, and the
//!   curve prices the rest, `out = floor(E_o × (a − tax) / (E_i + a − tax))`;
//! - **sell tax** (the tax side is the output): the curve prices all of it,
//!   `g = floor(E_o × a / (E_i + a))`, and `tax = ceil(g × sell / 10,000)` stays in the
//!   output vault while the trader gets `g − tax`.
//!
//! The tax rounds up and the curve rounds down, so the product of the effective reserves
//! never falls. A trade is refused when the trader would get nothing, or when the curve
//! would pay out more than the output side's real reserve: the virtual reserve is priced
//! as if held, but never paid out.
//!
//! Amounts are measured at the market's vaults: input is what arrived, output is what
//! leaves. Pipeline's 0.25% fee is charged by the router on top; it is not included here.

use anchor_lang::prelude::*;
use pipeline_strategy_interface::{fees::ceil_bps, QuoteResult};

use crate::config::MAX_TAX_BPS;
use crate::errors::StrategyError;
use crate::interface::{TradeMode, TradeRequest};
use crate::state::{MarketStatus, TaxMarket};

/// Reported to the router at market creation: traders can only swap exact-in, and [`quote`]
/// refuses [`TradeMode::ExactOut`].
pub const SUPPORTS_EXACT_OUT: bool = false;

/// A trade's two sides as the curve sees them: the real reserves, and the virtual reserve
/// each adds in pricing (0 on the side without one).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sides {
    pub reserve_in: u64,
    pub reserve_out: u64,
    pub virtual_in: u64,
    pub virtual_out: u64,
}

/// The tax of a trade, by where it is taken, at its rate in basis points.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tax {
    /// The tax side is the input: a buy tax, taken from the input before the curve.
    Buy(u16),
    /// The tax side is the output: a sell tax, taken from the curve's output.
    Sell(u16),
}

/// What an exact-in trade does to a market.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fill {
    /// The input the market keeps: all of it, since exact-in never refunds.
    pub amount_in: u64,
    /// What the trader receives.
    pub amount_out: u64,
    /// The tax, in the tax-side mint, which stays in the tax-side vault as owed.
    pub tax: u64,
    /// The input side's real reserve afterwards.
    pub reserve_in: u64,
    /// The output side's real reserve afterwards.
    pub reserve_out: u64,
}

/// Prices an exact-in trade of `trade` against `market`, answering quotes.
pub fn quote(market: &TaxMarket, trade: &TradeRequest) -> Result<QuoteResult> {
    require!(
        trade.mode == TradeMode::ExactIn,
        StrategyError::ExactOutNotSupported
    );
    let fill = fill(market, trade.input_index, trade.output_index, trade.amount)?;
    Ok(QuoteResult {
        amount_in: fill.amount_in,
        amount_out: fill.amount_out,
    })
}

/// Prices `amount_in` of mint index `input` for mint index `output` against `market`, as
/// it stands: refused until the market is open, and for any direction that is not one of
/// its two.
pub fn fill(market: &TaxMarket, input: u8, output: u8, amount_in: u64) -> Result<Fill> {
    require!(
        market.status == MarketStatus::Open,
        StrategyError::MarketNotOpen
    );
    let (i, o) = TaxMarket::direction(input, output).ok_or(StrategyError::WrongAccount)?;
    let virtual_of = |side: usize| {
        if market.virtual_side as usize == side {
            market.virtual_reserve
        } else {
            0
        }
    };
    let sides = Sides {
        reserve_in: market.reserves[i],
        reserve_out: market.reserves[o],
        virtual_in: virtual_of(i),
        virtual_out: virtual_of(o),
    };
    let tax = if market.tax_side as usize == i {
        Tax::Buy(market.buy_tax_bps)
    } else {
        Tax::Sell(market.sell_tax_bps)
    };
    Ok(exact_in(sides, tax, amount_in)?)
}

/// The tax on `amount` at `bps`: `ceil(amount × bps / 10,000)`, the spec's rounding up.
///
/// A rate above `MAX_TAX_BPS` is refused whatever the amount, so no pricing can ever
/// apply one, even if a market state somehow held it; creation and the tax authority's
/// changes refuse such rates before they are stored (docs/spec/tax-amm.md, "Rates").
/// Within the cap the tax never exceeds the amount, so it always fits.
pub fn tax_of(amount: u64, bps: u16) -> core::result::Result<u64, StrategyError> {
    ceil_bps(amount, capped(bps)? as u64).ok_or(StrategyError::Overflow)
}

/// `bps`, unless it is above `MAX_TAX_BPS`.
fn capped(bps: u16) -> core::result::Result<u16, StrategyError> {
    if bps > MAX_TAX_BPS {
        return Err(StrategyError::TaxAboveCap);
    }
    Ok(bps)
}

/// The spec's pricing of an exact-in trade of `amount_in`, with the tax outside the curve.
pub fn exact_in(
    sides: Sides,
    tax: Tax,
    amount_in: u64,
) -> core::result::Result<Fill, StrategyError> {
    let effective_in = sides.reserve_in as u128 + sides.virtual_in as u128;
    let effective_out = sides.reserve_out as u128 + sides.virtual_out as u128;
    // Refused before anything is priced, so a rate above the cap fails for every input.
    let (curve_input, rate) = match tax {
        Tax::Buy(bps) => {
            let tax = tax_of(amount_in, bps)?;
            // At most 10% of the input, so this never underflows.
            let rest = amount_in.checked_sub(tax).ok_or(StrategyError::Overflow)?;
            (rest, bps)
        }
        Tax::Sell(bps) => (amount_in, capped(bps)?),
    };
    let curve = curve_out(effective_in, effective_out, curve_input);
    // The virtual reserve is priced as if held, but only real reserves are ever paid out.
    if curve > sides.reserve_out as u128 {
        return Err(StrategyError::InsufficientLiquidity);
    }
    let curve = curve as u64;
    let (amount_out, tax) = match tax {
        Tax::Buy(_) => (curve, amount_in - curve_input),
        Tax::Sell(_) => {
            let tax = tax_of(curve, rate)?;
            (curve.checked_sub(tax).ok_or(StrategyError::Overflow)?, tax)
        }
    };
    if amount_out == 0 {
        return Err(StrategyError::ZeroOutput);
    }
    Ok(Fill {
        amount_in,
        amount_out,
        tax,
        reserve_in: sides
            .reserve_in
            .checked_add(curve_input)
            .ok_or(StrategyError::Overflow)?,
        // `curve` is at most the real reserve, checked above.
        reserve_out: sides.reserve_out - curve,
    })
}

/// The constant-product curve: `floor(effective_out × input / (effective_in + input))`,
/// rounded down so the market never pays out more than the curve allows. It is always
/// below `effective_out` while `effective_in` is above 0, and 0 for no input.
pub fn curve_out(effective_in: u128, effective_out: u128, input: u64) -> u128 {
    let denominator = effective_in + input as u128;
    if input == 0 || denominator == 0 {
        return 0;
    }
    mul_div(effective_out, input as u128, denominator).0
}

/// `a × b / d` as (quotient, remainder), with a 256-bit product so large pools and
/// trades can't overflow. The quotient saturates at `u128::MAX`; `d` must not be 0.
fn mul_div(a: u128, b: u128, d: u128) -> (u128, u128) {
    let mask = u64::MAX as u128;
    let (a1, a0) = (a >> 64, a & mask);
    let (b1, b0) = (b >> 64, b & mask);
    let (mid, mid_carry) = (a1 * b0).overflowing_add(a0 * b1);
    let (lo, lo_carry) = (a0 * b0).overflowing_add(mid << 64);
    let hi = a1 * b1 + (mid >> 64) + ((mid_carry as u128) << 64) + lo_carry as u128;
    if hi == 0 {
        return (lo / d, lo % d);
    }
    if hi >= d {
        return (u128::MAX, 0);
    }
    // Long division of (hi, lo) by d. The running remainder stays below 2d, so a carry
    // bit plus a wrapping subtraction keeps it exact.
    let mut remainder = hi;
    let mut quotient = 0u128;
    for bit in (0..128).rev() {
        let carry = remainder >> 127;
        remainder = (remainder << 1) | ((lo >> bit) & 1);
        if carry == 1 || remainder >= d {
            remainder = remainder.wrapping_sub(d);
            quotient |= 1 << bit;
        }
    }
    (quotient, remainder)
}

// Fast unit tests of worked examples, run by `cargo test`; the property tests are in
// `tests/maths.rs` and the router tests in `tests/`.
#[cfg(test)]
mod tests {
    use super::*;

    const SIDES: Sides = Sides {
        reserve_in: 1_000_000,
        reserve_out: 2_000_000,
        virtual_in: 0,
        virtual_out: 0,
    };

    #[test]
    fn a_buy_tax_comes_off_the_input_before_the_curve() {
        // 10,000 in at 3%: tax ceil(300) = 300, the curve prices 9,700:
        // 2,000,000 × 9,700 / 1,009,700 = 19,213.6..., rounded down.
        let fill = exact_in(SIDES, Tax::Buy(300), 10_000).unwrap();
        assert_eq!((fill.tax, fill.amount_out), (300, 19_213));
        assert_eq!((fill.reserve_in, fill.reserve_out), (1_009_700, 1_980_787));
    }

    #[test]
    fn a_sell_tax_comes_off_the_curves_output() {
        // 10,000 in: the curve gives 2,000,000 × 10,000 / 1,010,000 = 19,801.9... → 19,801,
        // and 5% of it rounded up, 991, stays in the vault.
        let fill = exact_in(SIDES, Tax::Sell(500), 10_000).unwrap();
        assert_eq!((fill.tax, fill.amount_out), (991, 18_810));
        assert_eq!((fill.reserve_in, fill.reserve_out), (1_010_000, 1_980_199));
    }

    #[test]
    fn the_virtual_reserve_prices_but_never_pays_out() {
        let sides = Sides {
            reserve_out: 0,
            virtual_out: 2_000_000,
            ..SIDES
        };
        assert!(matches!(
            exact_in(sides, Tax::Sell(0), 10_000),
            Err(StrategyError::InsufficientLiquidity)
        ));
        let sides = Sides {
            reserve_out: 19_801,
            virtual_out: 2_000_000 - 19_801,
            ..SIDES
        };
        assert_eq!(
            exact_in(sides, Tax::Sell(0), 10_000).unwrap().amount_out,
            19_801
        );
    }

    #[test]
    fn nothing_out_is_refused() {
        assert!(matches!(
            exact_in(SIDES, Tax::Buy(0), 0),
            Err(StrategyError::ZeroOutput)
        ));
        // 1 unit at a 10% buy tax is all tax.
        assert!(matches!(
            exact_in(SIDES, Tax::Buy(1_000), 1),
            Err(StrategyError::ZeroOutput)
        ));
        assert_eq!(curve_out(1, 2_000_000, 0), 0);
        assert!(curve_out(1, 2_000_000, u64::MAX) < 2_000_000);
    }
}

// Kani proofs of the pricing (`cargo kani`, docs/toolchain.md), in the tiers Book of
// Knowledge uses in Pipeline; the property IDs are docs/security/tax-amm/maths-properties.md's.
// CBMC turns a division into a fresh quotient tied to its operands by a multiplier, and SAT
// solvers find relating that quotient back to its inputs very hard, so:
// - full domain, default: properties that need no such relation, such as the maths never
//   panicking, the rate cap, and what a fill pays out against the real reserve;
// - bounded, default: properties about quotients, with the reserves and amounts below
//   `SMALL` (the tax's own maths below `TAX_SMALL`) and every rate up to the cap;
// - full domain behind `RUSTFLAGS="--cfg kani_full"`: those same properties for every
//   input, which do not finish (Z3 proves them for every input instead, `proofs/pricing_z3.py`).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the bounded tier, on the reserves, virtual reserves and amounts alike.
    const SMALL: u64 = 1 << 4;
    /// Bound on the amount in the bounded proofs of the tax alone, which has no curve.
    const TAX_SMALL: u64 = 1 << 10;

    fn any_rate() -> u16 {
        kani::any_where(|&bps| bps <= MAX_TAX_BPS)
    }

    fn below(bound: u64) -> u64 {
        kani::any_where(|&value| value < bound)
    }

    fn sides_below(bound: u64) -> Sides {
        Sides {
            reserve_in: below(bound),
            reserve_out: below(bound),
            virtual_in: below(bound),
            virtual_out: below(bound),
        }
    }

    fn any_sides() -> Sides {
        Sides {
            reserve_in: kani::any(),
            reserve_out: kani::any(),
            virtual_in: kani::any(),
            virtual_out: kani::any(),
        }
    }

    fn tax_at(buy: bool, bps: u16) -> Tax {
        if buy {
            Tax::Buy(bps)
        } else {
            Tax::Sell(bps)
        }
    }

    /// N1: for any reserves, virtual reserves, rate (capped or not) and amount, pricing and
    /// the tax are computed without panicking: no overflow, no division by zero, no shift
    /// out of range. Every case that would overflow returns an error instead.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn exact_in_never_panics() {
        let _ = exact_in(any_sides(), tax_at(kani::any(), kani::any()), kani::any());
    }

    /// For any real and virtual reserves and amount, the curve is computed without
    /// panicking.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn curve_out_never_panics() {
        let (reserve_in, virtual_in, reserve_out, virtual_out, input): (u64, u64, u64, u64, u64) =
            kani::any();
        curve_out(
            reserve_in as u128 + virtual_in as u128,
            reserve_out as u128 + virtual_out as u128,
            input,
        );
    }

    /// T2: a rate above `MAX_TAX_BPS` is refused for every amount and every market, by the
    /// tax and by the pricing alike, and no other refusal comes first.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn no_rate_above_the_cap_is_ever_applied() {
        let bps: u16 = kani::any_where(|&bps| bps > MAX_TAX_BPS);
        let amount: u64 = kani::any();
        assert!(matches!(
            tax_of(amount, bps),
            Err(StrategyError::TaxAboveCap)
        ));
        assert!(matches!(
            exact_in(any_sides(), tax_at(kani::any(), bps), amount),
            Err(StrategyError::TaxAboveCap)
        ));
    }

    /// T1, the zero case: for every amount and capped rate, the tax is 0 exactly when the
    /// amount or the rate is 0, and it is never more than the amount.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_tax_is_zero_exactly_when_the_amount_or_the_rate_is() {
        let amount: u64 = kani::any();
        let bps = any_rate();
        let tax = tax_of(amount, bps).unwrap();
        assert_eq!(tax == 0, amount == 0 || bps == 0);
        assert!(tax <= amount);
    }

    /// T1: the tax is exactly `ceil(amount × rate / 10,000)`, stated without division.
    fn assert_tax_is_the_rate_rounded_up(amount: u64, bps: u16) {
        let tax = tax_of(amount, bps).unwrap() as u128;
        let exact = amount as u128 * bps as u128;
        assert!(tax * 10_000 >= exact);
        assert!(tax * 10_000 < exact + 10_000);
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_tax_is_the_rate_rounded_up_bounded() {
        assert_tax_is_the_rate_rounded_up(below(TAX_SMALL), any_rate());
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_tax_is_the_rate_rounded_up() {
        assert_tax_is_the_rate_rounded_up(kani::any(), any_rate());
    }

    /// S2: a fill never pays out more than the output side's real reserve, whatever the
    /// virtual reserves: what leaves the real reserve is what the trader gets plus a sell
    /// tax, which stays in the vault; the input reserve grows by the input less a buy tax;
    /// and a fill always gives the trader something.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_fill_never_pays_out_more_than_the_real_reserve() {
        let sides = any_sides();
        let buy: bool = kani::any();
        let amount: u64 = kani::any();
        if let Ok(fill) = exact_in(sides, tax_at(buy, any_rate()), amount) {
            assert!(fill.amount_in == amount);
            assert!(fill.amount_out >= 1);
            assert!(fill.reserve_out <= sides.reserve_out);
            let paid = sides.reserve_out - fill.reserve_out;
            let (kept_out, kept_in) = if buy { (0, fill.tax) } else { (fill.tax, 0) };
            assert!(paid as u128 == fill.amount_out as u128 + kept_out as u128);
            assert!(
                fill.reserve_in as u128 == sides.reserve_in as u128 + (amount - kept_in) as u128
            );
        }
    }

    /// The curve's output never reaches its whole output side while the input side holds
    /// anything, so no trade can empty a market, and zero input buys nothing.
    fn assert_curve_out_is_safe(effective_in: u64, effective_out: u64, input: u64) {
        let out = curve_out(effective_in as u128, effective_out as u128, input);
        assert!(out <= effective_out as u128);
        if effective_in > 0 && effective_out > 0 {
            assert!(out < effective_out as u128);
        }
        if input == 0 {
            assert!(out == 0);
        }
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn curve_out_never_empties_the_market_bounded() {
        assert_curve_out_is_safe(below(SMALL), below(SMALL), below(SMALL));
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn curve_out_never_empties_the_market() {
        assert_curve_out_is_safe(kani::any(), kani::any(), kani::any());
    }

    /// S1: a swap never lowers the product of the effective reserves. Within the bounds the
    /// products fit in a u128.
    fn assert_k_never_falls(sides: Sides, tax: Tax, amount: u64) {
        if let Ok(fill) = exact_in(sides, tax, amount) {
            let before = (sides.reserve_in as u128 + sides.virtual_in as u128)
                * (sides.reserve_out as u128 + sides.virtual_out as u128);
            let after = (fill.reserve_in as u128 + sides.virtual_in as u128)
                * (fill.reserve_out as u128 + sides.virtual_out as u128);
            assert!(after >= before);
        }
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_swap_never_lowers_the_product_of_the_effective_reserves_bounded() {
        assert_k_never_falls(
            sides_below(SMALL),
            tax_at(kani::any(), any_rate()),
            below(SMALL),
        );
    }

    /// S3: the output never rises when the input falls or the tax rises.
    fn assert_output_is_monotone(sides: Sides, buy: bool, amounts: (u64, u64), rates: (u16, u16)) {
        let (low, high) = (amounts.0.min(amounts.1), amounts.0.max(amounts.1));
        let (cheap, dear) = (rates.0.min(rates.1), rates.0.max(rates.1));
        if let (Ok(small), Ok(large)) = (
            exact_in(sides, tax_at(buy, cheap), low),
            exact_in(sides, tax_at(buy, cheap), high),
        ) {
            assert!(small.amount_out <= large.amount_out);
        }
        if let (Ok(cheap), Ok(dear)) = (
            exact_in(sides, tax_at(buy, cheap), high),
            exact_in(sides, tax_at(buy, dear), high),
        ) {
            assert!(dear.amount_out <= cheap.amount_out);
        }
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_output_never_rises_when_the_input_falls_or_the_tax_rises_bounded() {
        assert_output_is_monotone(
            sides_below(SMALL),
            kani::any(),
            (below(SMALL), below(SMALL)),
            (any_rate(), any_rate()),
        );
    }

    /// S4: two trades in the same direction never return more than one of their sum.
    fn assert_split_never_pays_more(sides: Sides, tax: Tax, first: u64, second: u64) {
        let Some(whole) = first.checked_add(second) else {
            return;
        };
        let Ok(one) = exact_in(sides, tax, first) else {
            return;
        };
        let later = Sides {
            reserve_in: one.reserve_in,
            reserve_out: one.reserve_out,
            ..sides
        };
        let Ok(two) = exact_in(later, tax, second) else {
            return;
        };
        match exact_in(sides, tax, whole) {
            Ok(single) => assert!(
                one.amount_out as u128 + two.amount_out as u128 <= single.amount_out as u128
            ),
            Err(error) => assert!(matches!(
                error,
                StrategyError::InsufficientLiquidity | StrategyError::Overflow
            )),
        }
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn splitting_a_trade_in_two_never_returns_more_bounded() {
        assert_split_never_pays_more(
            sides_below(SMALL),
            tax_at(kani::any(), any_rate()),
            below(SMALL),
            below(SMALL),
        );
    }

    /// S5: trading `amount` for the other side and all of it straight back never returns
    /// more than `amount`, whichever side carries the tax, at any rates. The virtual reserve
    /// stays on its side, as in a market.
    fn assert_round_trip_never_gains(
        reserves: [u64; 2],
        virtual_reserve: u64,
        virtual_side: usize,
        tax_side: usize,
        rates: (u16, u16),
        amount: u64,
    ) {
        let virtual_of = |side: usize| {
            if side == virtual_side {
                virtual_reserve
            } else {
                0
            }
        };
        let tax_of_trade = |input: usize| {
            if input == tax_side {
                Tax::Buy(rates.0)
            } else {
                Tax::Sell(rates.1)
            }
        };
        let (x, y) = (0, 1);
        let there = Sides {
            reserve_in: reserves[x],
            reserve_out: reserves[y],
            virtual_in: virtual_of(x),
            virtual_out: virtual_of(y),
        };
        let Ok(first) = exact_in(there, tax_of_trade(x), amount) else {
            return;
        };
        let back = Sides {
            reserve_in: first.reserve_out,
            reserve_out: first.reserve_in,
            virtual_in: virtual_of(y),
            virtual_out: virtual_of(x),
        };
        if let Ok(second) = exact_in(back, tax_of_trade(y), first.amount_out) {
            assert!(second.amount_out <= amount);
        }
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn buying_and_selling_straight_back_never_returns_more_bounded() {
        assert_round_trip_never_gains(
            [below(SMALL), below(SMALL)],
            below(SMALL),
            kani::any_where(|&side: &usize| side < 2),
            kani::any_where(|&side: &usize| side < 2),
            (any_rate(), any_rate()),
            below(SMALL),
        );
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_swap_never_lowers_the_product_of_the_effective_reserves() {
        // The products can pass 2^128, so they are compared through `mul_div`'s exact
        // 256-bit product: (E_i' × E_o') / (E_i × E_o) >= 1 whenever E_i × E_o > 0.
        let sides = any_sides();
        let amount: u64 = kani::any();
        let tax = tax_at(kani::any(), any_rate());
        if let Ok(fill) = exact_in(sides, tax, amount) {
            let (in_before, out_before) = (
                sides.reserve_in as u128 + sides.virtual_in as u128,
                sides.reserve_out as u128 + sides.virtual_out as u128,
            );
            let (in_after, out_after) = (
                fill.reserve_in as u128 + sides.virtual_in as u128,
                fill.reserve_out as u128 + sides.virtual_out as u128,
            );
            // out_after × in_after >= out_before × in_before, as floor(out_after × in_after
            // / in_before) >= out_before.
            if in_before > 0 {
                assert!(mul_div(out_after, in_after, in_before).0 >= out_before);
            }
        }
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_output_never_rises_when_the_input_falls_or_the_tax_rises() {
        assert_output_is_monotone(
            any_sides(),
            kani::any(),
            (kani::any(), kani::any()),
            (any_rate(), any_rate()),
        );
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn splitting_a_trade_in_two_never_returns_more() {
        assert_split_never_pays_more(
            any_sides(),
            tax_at(kani::any(), any_rate()),
            kani::any(),
            kani::any(),
        );
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn buying_and_selling_straight_back_never_returns_more() {
        assert_round_trip_never_gains(
            kani::any(),
            kani::any(),
            kani::any_where(|&side: &usize| side < 2),
            kani::any_where(|&side: &usize| side < 2),
            (any_rate(), any_rate()),
            kani::any(),
        );
    }
}
