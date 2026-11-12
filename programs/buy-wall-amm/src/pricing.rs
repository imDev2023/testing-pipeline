//! The one pricing function `pipeline_quote` and `pipeline_swap` share, so a quote is exactly
//! what the swap does (docs/spec/pool4-for-solana.md, "Pricing").

use anchor_lang::prelude::*;
use pipeline_strategy_interface::fees;

use crate::config::{MAX_SQRT_PRICE, MIN_SQRT_PRICE};
use crate::errors::StrategyError;
use crate::interface::{TradeMode, TradeRequest};
use crate::math::U256;
use crate::state::{MarketState, STATUS_OPEN};

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
/// `remaining` token units: `(next, used, gross)`, where
///
/// - `need = ceil(liq × Q × (s - target) / (s × target))`, the units that reach `target`;
/// - with `remaining >= need`, `next = target` and `used = need`; otherwise
///   `next = ceil(liq × Q × s / (liq × Q + remaining × s))` and `used = remaining`;
/// - `gross = floor(liq × (s - next) / Q)`, the lamports the step frees.
///
/// Divisions by two square-root prices are staged one price at a time, which is exact for
/// both floors and ceilings (`ceil(ceil(n / a) / b) = ceil(n / (a × b))`).
pub fn sell_step(
    liq: u128,
    s: u128,
    target: u128,
    remaining: u64,
) -> core::result::Result<(u128, u64, u64), Refusal> {
    let liq_q = U256::times_q(liq);
    let drop = s.checked_sub(target).ok_or(Refusal::Overflow)?;
    let need = liq_q
        .mul_u128(drop)
        .and_then(|n| n.div_ceil(U256::from(s)))
        .and_then(|n| n.div_ceil(U256::from(target)))
        .ok_or(Refusal::Overflow)?;
    let (next, used) = if U256::from(remaining) >= need {
        // `need <= remaining` fits in 64 bits.
        (target, need.to_u64().ok_or(Refusal::Overflow)?)
    } else {
        let denominator = U256::mul(remaining as u128, s)
            .and_then(|added| liq_q.checked_add(added))
            .ok_or(Refusal::Overflow)?;
        let next = liq_q
            .mul_u128(s)
            .and_then(|n| n.div_ceil(denominator))
            .and_then(U256::to_u128)
            .ok_or(Refusal::Overflow)?;
        (next, remaining)
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
///   staged one square-root price at a time.
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
        .and_then(|n| n.div_floor(U256::from(next)))
        .and_then(|n| n.div_floor(U256::from(s)))
        .and_then(U256::to_u64)
        .ok_or(Refusal::Overflow)?;
    Ok((next, used, out))
}

/// A sell of `a` credited token units (the spec's "A sell"), with no buy wall yet:
/// `fee = ceil(gross × fee_bps / 10,000)` and `out = gross - fee`.
pub fn sell(curve: Curve, a: u64, fee_bps: u16) -> core::result::Result<Priced, Refusal> {
    if a == 0 {
        return Err(Refusal::ZeroInput);
    }
    let (next, used, gross) = sell_step(curve.liquidity, curve.sqrt_price, MIN_SQRT_PRICE, a)?;
    if used < a {
        return Err(Refusal::PriceBoundReached);
    }
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
        sqrt_price: next,
    })
}

/// A buy with `a` credited lamports (the spec's "A buy"), with no buy wall yet:
/// `fee = ceil(a × fee_bps / 10,000)` comes off the input first.
pub fn buy(curve: Curve, a: u64, fee_bps: u16) -> core::result::Result<Priced, Refusal> {
    if a == 0 {
        return Err(Refusal::ZeroInput);
    }
    let fee = fees::ceil_bps(a, fee_bps as u64).ok_or(Refusal::Overflow)?;
    let remaining = a.checked_sub(fee).ok_or(Refusal::NothingAfterFee)?;
    if remaining == 0 {
        return Err(Refusal::NothingAfterFee);
    }
    let (next, used, amount_out) =
        buy_step(curve.liquidity, curve.sqrt_price, MAX_SQRT_PRICE, remaining)?;
    if used < remaining {
        return Err(Refusal::PriceBoundReached);
    }
    if amount_out == 0 {
        return Err(Refusal::ZeroOutput);
    }
    Ok(Priced {
        side: Side::Buy,
        amount_in: a,
        fee,
        amount_out,
        sqrt_price: next,
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
    let priced = match request.input_index {
        0 => sell(curve, request.amount, state.fee_bps()),
        _ => buy(curve, request.amount, state.fee_bps()),
    };
    priced.map_err(|refusal| error!(StrategyError::from(refusal)))
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
        let bought = buy(SEEDED, 1_000_000_000, FEE_BPS).unwrap();
        assert_eq!(bought.fee, 10_000_000);
        assert_eq!(bought.amount_out, 90_081_892_629);
        assert_eq!(bought.sqrt_price, 2_027_297_173_702_505_949);
        // Selling those units back, on the same liquidity (a cap ratchet never changes it).
        let after_buy = Curve {
            sqrt_price: bought.sqrt_price,
            ..SEEDED
        };
        let sold = sell(after_buy, bought.amount_out, FEE_BPS).unwrap();
        assert_eq!(sold.amount_out + sold.fee, 989_999_999);
        assert_eq!(sold.fee, 9_900_000);
        assert_eq!(sold.amount_out, 980_099_999);
        assert_eq!(sold.sqrt_price, 1_844_674_407_372_029_099);
    }

    #[test]
    fn each_refusal_is_on_the_right_side_of_its_bound() {
        // Zero input, either way.
        assert_eq!(sell(SEEDED, 0, FEE_BPS), Err(Refusal::ZeroInput));
        assert_eq!(buy(SEEDED, 0, FEE_BPS), Err(Refusal::ZeroInput));
        // One lamport pays a one-lamport fee, leaving nothing.
        assert_eq!(buy(SEEDED, 1, FEE_BPS), Err(Refusal::NothingAfterFee));
        // At about 0.01 lamport a unit, a few units free nothing; the least sell that pays
        // anything is just above 100 units (gross 1, fee 1, out 0 is refused too).
        assert_eq!(sell(SEEDED, 1, FEE_BPS), Err(Refusal::ZeroOutput));
        let first_paying = (1..10_000)
            .find(|a| sell(SEEDED, *a, FEE_BPS).is_ok())
            .unwrap();
        assert_eq!(
            sell(SEEDED, first_paying - 1, FEE_BPS),
            Err(Refusal::ZeroOutput)
        );
        assert_eq!(sell(SEEDED, first_paying, FEE_BPS).unwrap().amount_out, 1);
        // Two lamports leave one after the fee, which buys about 100 units.
        assert!(buy(SEEDED, 2, FEE_BPS).unwrap().amount_out > 0);
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
        let at_bound = sell(thin, need, FEE_BPS).unwrap();
        assert_eq!(at_bound.sqrt_price, MIN_SQRT_PRICE);
        assert_eq!(
            sell(thin, need + 1, FEE_BPS),
            Err(Refusal::PriceBoundReached)
        );
        // From the bound, every further sell is refused.
        let at_min = Curve {
            sqrt_price: MIN_SQRT_PRICE,
            ..thin
        };
        assert_eq!(sell(at_min, 1, FEE_BPS), Err(Refusal::PriceBoundReached));
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
            assert_eq!(buy(thin, input, FEE_BPS).unwrap().sqrt_price, MAX_SQRT_PRICE);
        }
        assert_eq!(
            buy(thin, input + 200, FEE_BPS),
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
                    if let Ok(priced) = sell(curve, a, fee_bps) {
                        assert!(priced.sqrt_price >= MIN_SQRT_PRICE);
                    }
                    if let Ok(priced) = buy(curve, a, fee_bps) {
                        assert!(priced.sqrt_price <= MAX_SQRT_PRICE);
                    }
                }
            }
        }
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
        prop_oneof![Just(MIN_FEE_BPS), Just(MAX_FEE_BPS), MIN_FEE_BPS..=MAX_FEE_BPS]
    }

    /// What the curve holds at `curve`, exactly: `L × Q / s` token units and `L × s / Q`
    /// lamports, as the numerators `L × Q` over `s` and `L × s` over `Q`.
    fn covered(curve: Curve, tokens: u64, lamports: u64) -> bool {
        let (l, s) = (curve.liquidity, curve.sqrt_price);
        U256::times_q(l) <= U256::mul(tokens as u128, s).unwrap()
            && U256::mul(l, s).unwrap() <= U256::times_q(lamports as u128)
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
            if let Ok(p) = sell(c, a, fee_bps) {
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
            if let Ok(p) = buy(c, a, fee_bps) {
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
            c in curve(),
            a in amount(),
            fee_bps in fee_bps(),
            sell_side in any::<bool>(),
        ) {
            let (l, s) = (c.liquidity, c.sqrt_price);
            // The least ledgers that cover the curve: ceil(L × Q / s) and ceil(L × s / Q).
            let tokens = U256::times_q(l).div_ceil(U256::from(s)).unwrap().to_u64();
            let lamports = U256::mul(l, s).unwrap().checked_ceil_shr64().and_then(|v| u64::try_from(v).ok());
            let (Some(tokens), Some(lamports)) = (tokens, lamports) else { return Ok(()) };
            prop_assert!(covered(c, tokens, lamports));
            let priced = if sell_side { sell(c, a, fee_bps) } else { buy(c, a, fee_bps) };
            if let Ok(p) = priced {
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
            if let Ok(bought) = buy(c, a, fee_bps) {
                let after = Curve { sqrt_price: bought.sqrt_price, ..c };
                if let Ok(sold) = sell(after, bought.amount_out, fee_bps) {
                    prop_assert!(sold.amount_out < a);
                    // And the price returns no lower than it started.
                    prop_assert!(sold.sqrt_price >= c.sqrt_price);
                }
            }
        }

        /// The quote never depends on anything but the curve, the amount and the fee, and
        /// more input never buys less.
        #[test]
        fn more_input_never_buys_less(c in curve(), a in 1u64..1 << 50, extra in 1u64..1 << 20, fee_bps in fee_bps()) {
            for side in [Side::Sell, Side::Buy] {
                let price = |amount| match side {
                    Side::Sell => sell(c, amount, fee_bps),
                    Side::Buy => buy(c, amount, fee_bps),
                };
                if let (Ok(small), Ok(large)) = (price(a), price(a + extra)) {
                    prop_assert!(large.amount_out >= small.amount_out);
                }
                prop_assert_eq!(price(a), price(a));
            }
        }
    }
}
