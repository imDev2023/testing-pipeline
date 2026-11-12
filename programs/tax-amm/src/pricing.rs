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

/// The spec's pricing of an exact-in trade of `amount_in`, with the tax outside the curve.
pub fn exact_in(
    sides: Sides,
    tax: Tax,
    amount_in: u64,
) -> core::result::Result<Fill, StrategyError> {
    let effective_in = sides.reserve_in as u128 + sides.virtual_in as u128;
    let effective_out = sides.reserve_out as u128 + sides.virtual_out as u128;
    let (curve_input, rate) = match tax {
        Tax::Buy(bps) => {
            let tax = ceil_bps(amount_in, bps as u64).ok_or(StrategyError::Overflow)?;
            // At most 100% of the input, so this never underflows for a valid rate.
            let rest = amount_in.checked_sub(tax).ok_or(StrategyError::Overflow)?;
            (rest, bps)
        }
        Tax::Sell(bps) => (amount_in, bps),
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
            let tax = ceil_bps(curve, rate as u64).ok_or(StrategyError::Overflow)?;
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

// Kani proofs of the curve (`cargo kani`, docs/toolchain.md), in the tiers Book of
// Knowledge uses in Pipeline. CBMC turns a division into a fresh quotient tied to its
// operands by a multiplier, and SAT solvers find relating that quotient back to its inputs
// very hard, so:
// - full domain, default: properties that need no such relation, such as the maths never
//   panicking or overflowing for any reserves and amount;
// - bounded, default: properties about the quotient, with the reserves and the amount all
//   below `SMALL`;
// - full domain behind `RUSTFLAGS="--cfg kani_full"`: those same properties for every u64
//   amount, which may not finish (Z3 proves division where Kani cannot, docs/spec/README.md,
//   "Test layers" 2).
// The proofs of the taxed pricing and the split belong to
// [Tax AMM: proofs of the pricing, tax and split maths](https://github.com/imDev2023/testing-pipeline/issues/64).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the bounded tier, on the reserves and the amount alike.
    const SMALL: u64 = 1 << 4;

    /// For any real and virtual reserves and amount, the curve is computed without
    /// panicking: no overflow, no division by zero, no shift out of range.
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
        let effective_in: u64 = kani::any_where(|&r| r < SMALL);
        let effective_out: u64 = kani::any_where(|&r| r < SMALL);
        let input: u64 = kani::any_where(|&a| a < SMALL);
        assert_curve_out_is_safe(effective_in, effective_out, input);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn curve_out_never_empties_the_market() {
        assert_curve_out_is_safe(kani::any(), kani::any(), kani::any());
    }
}
