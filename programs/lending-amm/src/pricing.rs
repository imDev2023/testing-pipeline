//! # Pricing
//!
//! [`quote`] is the only pricing function: `pipeline_quote` calls it to answer quotes and
//! `pipeline_swap` to settle trades, so a quote is always exactly what a swap delivers
//! (docs/spec/lending-pool.md, "Pricing"; docs/spec/README.md, "Strategy rules").
//!
//! For a trade from side `i` to side `o`, with effective reserves `E` (`R` for the other
//! side, `L` for the lent side) and credited input `a`:
//!
//! - `a_net = a - ceil(a x lp_fee_bps / 10,000)` and `out = floor(E_o x a_net / (E_i + a_net))`;
//! - the whole of `a` joins side `i`, so the LP fee stays in the market and accrues to LPs;
//! - the fee rounds up and the output rounds down, so the product of the effective reserves
//!   never falls.
//!
//! The maths is in [`exact_in`], a pure function of numbers, which Proptest, Kani and Z3
//! check on its own. Amounts are measured at the market's vaults; Pipeline's 0.25% fee is
//! charged by the router on top and is not included here.

use anchor_lang::prelude::*;
use pipeline_strategy_interface::QuoteResult;

use crate::errors::StrategyError;
use crate::interface::{TradeMode, TradeRequest};
use crate::kamino::Reserve;
use crate::state::LendingAmmMarket;

/// Reported to the router at market creation: traders can only swap exact-in, and [`quote`]
/// refuses [`TradeMode::ExactOut`].
pub const SUPPORTS_EXACT_OUT: bool = false;

/// Basis points in a whole, Pipeline's denominator.
const BPS: u128 = pipeline_strategy_interface::BPS_DENOMINATOR as u128;

/// An exact-in trade's maths.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExactIn {
    /// The LP fee, `ceil(a x lp_fee_bps / 10,000)`, which stays in the market.
    pub fee: u64,
    /// What prices the trade, `a - fee`.
    pub net: u64,
    /// What the trader receives.
    pub out: u64,
}

/// Prices `amount_in` against effective reserves `reserve_in` and `reserve_out` with the LP
/// fee `fee_bps` (at most 10,000). Refuses a trade that pays out nothing or a side's whole
/// reserve.
pub fn exact_in(
    reserve_in: u64,
    reserve_out: u64,
    amount_in: u64,
    fee_bps: u16,
) -> core::result::Result<ExactIn, StrategyError> {
    let fee = (amount_in as u128 * fee_bps as u128).div_ceil(BPS);
    let net = (amount_in as u128)
        .checked_sub(fee)
        .ok_or(StrategyError::Overflow)?;
    let denominator = reserve_in as u128 + net;
    if denominator == 0 {
        return Err(StrategyError::ZeroOutput);
    }
    // Below reserve_out x 2^64, so it fits; the quotient is at most reserve_out.
    let out = (reserve_out as u128 * net / denominator) as u64;
    if out == 0 {
        return Err(StrategyError::ZeroOutput);
    }
    if out >= reserve_out {
        return Err(StrategyError::WouldEmptySide);
    }
    Ok(ExactIn {
        fee: fee as u64,
        net: net as u64,
        out,
    })
}

/// The lent side's total, `L = B + V`: the buffer the market has recorded in its lent-mint
/// vault, plus the value of the cTokens it has recorded at the reserve's stored rate
/// (docs/spec/lending-pool.md, "Total reserves"). Only recorded amounts count, so tokens or
/// cTokens sent to the market outside its own instructions are never priced.
pub fn lent_total(
    market: &LendingAmmMarket,
    reserve: &Reserve,
) -> core::result::Result<u64, StrategyError> {
    let buffer = market.reserves[market.lent_side()];
    buffer
        .checked_add(reserve.lent_value(market.ctokens)?)
        .ok_or(StrategyError::Overflow)
}

/// The shortfall `s = out - B` a lent-side output of `out` must redeem from Kamino when the
/// buffer holds `buffer` and Kamino can pay `kamino_can_pay` right now: 0 when the buffer
/// covers it, refused when it needs more than the buffer plus what Kamino can pay
/// (docs/spec/lending-pool.md, "Pricing" and "Redeeming the shortfall").
pub fn shortfall(
    out: u64,
    buffer: u64,
    kamino_can_pay: u64,
) -> core::result::Result<u64, StrategyError> {
    let shortfall = out.saturating_sub(buffer);
    if shortfall > kamino_can_pay {
        return Err(StrategyError::BeyondBuffer);
    }
    Ok(shortfall)
}

/// A priced trade: what [`quote`] returns to `pipeline_quote` and settles in `pipeline_swap`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    pub amount_in: u64,
    pub amount_out: u64,
    /// What the swap redeems from Kamino before paying out, `out - B`, or 0 when the buffer
    /// covers the output or the output is the other side.
    pub shortfall: u64,
}

impl Quote {
    /// The quote as Pipeline's interface returns it.
    pub fn result(&self) -> QuoteResult {
        QuoteResult {
            amount_in: self.amount_in,
            amount_out: self.amount_out,
        }
    }
}

/// Prices `trade` against `market`, with its lent side valued from `reserve`, which the caller
/// has checked ([`crate::kamino::reserve_of`]): exact-in only, once the first deposit has
/// opened it. A lent-side output beyond the buffer asks `kamino_can_pay` what Kamino can pay
/// right now, and only then, so a trade the buffer covers never reads Kamino's other accounts;
/// it is refused when the shortfall is more than that.
pub fn quote(
    market: &LendingAmmMarket,
    reserve: &Reserve,
    trade: &TradeRequest,
    kamino_can_pay: impl FnOnce() -> Result<u64>,
) -> Result<Quote> {
    require!(
        trade.mode == TradeMode::ExactIn,
        StrategyError::ExactOutNotSupported
    );
    let (input, output) = market
        .trade_sides(trade.input_index, trade.output_index)
        .ok_or(StrategyError::WrongAccount)?;
    require!(market.is_open(), StrategyError::MarketNotOpen);
    let lent = market.lent_side();
    let mut effective = market.reserves;
    effective[lent] = lent_total(market, reserve)?;
    let priced = exact_in(
        effective[input],
        effective[output],
        trade.amount,
        market.lp_fee_bps,
    )?;
    let buffer = market.reserves[lent];
    let shortfall = if output == lent && priced.out > buffer {
        shortfall(priced.out, buffer, kamino_can_pay()?)?
    } else {
        0
    };
    Ok(Quote {
        amount_in: trade.amount,
        amount_out: priced.out,
        shortfall,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn code(
        result: core::result::Result<ExactIn, StrategyError>,
    ) -> core::result::Result<ExactIn, u32> {
        result.map_err(|error| error as u32)
    }

    #[test]
    fn exact_in_matches_the_formula_and_rounds_down() {
        // 1,000 in at 0.3% against 1,000,000 : 2,000,000: the fee is ceil(3) = 3, and
        // 2,000,000 x 997 / (1,000,000 + 997) = 1992.01..., rounded down.
        assert_eq!(
            code(exact_in(1_000_000, 2_000_000, 1_000, 30)),
            Ok(ExactIn {
                fee: 3,
                net: 997,
                out: 1_992
            })
        );
        // The fee rounds up: 1,001 at 0.3% is 3.003, so 4.
        assert_eq!(exact_in(1_000_000, 2_000_000, 1_001, 30).unwrap().fee, 4);
    }

    #[test]
    fn exact_in_refuses_nothing_out_and_emptying_a_side() {
        assert_eq!(
            code(exact_in(1_000_000, 2_000_000, 0, 30)),
            Err(StrategyError::ZeroOutput as u32)
        );
        assert_eq!(
            code(exact_in(1_000_000, 2_000_000, 1, 30)),
            Err(StrategyError::ZeroOutput as u32)
        );
        // Only an empty input side could pay out the whole other side.
        assert_eq!(
            code(exact_in(0, 100, 50, 0)),
            Err(StrategyError::WouldEmptySide as u32)
        );
        assert!(exact_in(1, 2_000_000, u64::MAX, 30).unwrap().out < 2_000_000);
        assert!(exact_in(u64::MAX, u64::MAX, u64::MAX, 0).is_ok());
    }

    #[test]
    fn a_lent_output_beyond_the_buffer_redeems_its_shortfall_or_is_refused() {
        let code = |r: core::result::Result<u64, StrategyError>| r.map_err(|e| e as u32);
        assert_eq!(code(shortfall(10, 10, 0)), Ok(0));
        assert_eq!(code(shortfall(9, 10, 0)), Ok(0));
        assert_eq!(code(shortfall(15, 10, 5)), Ok(5));
        assert_eq!(
            code(shortfall(16, 10, 5)),
            Err(StrategyError::BeyondBuffer as u32)
        );
        assert_eq!(
            code(shortfall(11, 10, 0)),
            Err(StrategyError::BeyondBuffer as u32)
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// The fee never rounds in the trader's favour: fee x 10,000 >= a x fee_bps, and by
        /// less than one unit.
        #[test]
        fn the_fee_never_rounds_in_the_traders_favour(
            reserve_in: u64,
            reserve_out: u64,
            amount_in: u64,
            fee_bps in 0u16..=200,
        ) {
            if let Ok(t) = exact_in(reserve_in, reserve_out, amount_in, fee_bps) {
                let exact = amount_in as u128 * fee_bps as u128;
                prop_assert!(t.fee as u128 * BPS >= exact);
                prop_assert!((t.fee as u128) * BPS < exact + BPS);
                prop_assert_eq!(t.fee + t.net, amount_in);
            }
        }

        /// A swap never lowers the product of the reserves, with the whole input joining
        /// its side, and never pays out a whole side.
        #[test]
        fn a_swap_never_lowers_the_product_of_the_reserves(
            reserve_in in 1u64..,
            reserve_out in 1u64..,
            amount_in: u64,
            fee_bps in 0u16..=200,
        ) {
            if let Ok(t) = exact_in(reserve_in, reserve_out, amount_in, fee_bps) {
                prop_assert!(t.out < reserve_out);
                if let Some(new_in) = reserve_in.checked_add(amount_in) {
                    let before = reserve_in as u128 * reserve_out as u128;
                    let after = new_in as u128 * (reserve_out - t.out) as u128;
                    prop_assert!(after >= before);
                }
            }
        }

        /// A round trip at fixed reserves returns at most what went in (Book of Knowledge
        /// PR-3): selling `a` of side i for `out`, then selling `out` back against the reserves
        /// the first trade left (the whole input joined side i, the output left side o), returns
        /// at most `a`, at each of the spec's edge fees. Reserves and amount below 2^63, so the
        /// input side after the first trade fits a u64.
        #[test]
        fn a_round_trip_never_returns_more_than_went_in(
            reserve_in in 1u64..(1 << 63),
            reserve_out in 1u64..(1 << 63),
            amount_in in 0u64..(1 << 63),
            fee_bps in prop::sample::select(vec![0u16, 30, crate::config::MAX_LP_FEE_BPS]),
        ) {
            if let Ok(there) = exact_in(reserve_in, reserve_out, amount_in, fee_bps) {
                let back = exact_in(
                    reserve_out - there.out,
                    reserve_in + amount_in,
                    there.out,
                    fee_bps,
                );
                if let Ok(back) = back {
                    prop_assert!(back.out <= amount_in, "{} back for {}", back.out, amount_in);
                }
            }
        }
    }
}

// Kani proofs of the pricing maths (`cargo kani`, docs/toolchain.md), in the tiers Book of
// Knowledge uses in Pipeline. CBMC turns a division into a fresh quotient tied to its
// operands by a multiplier, and SAT solvers find relating that quotient back to its inputs
// very hard, so:
// - full domain, default: properties that need no such relation, such as the maths never
//   panicking or overflowing for any reserves and amount;
// - bounded, default: properties about the quotient, with the reserves and the amount all
//   below `SMALL`;
// - full domain behind `RUSTFLAGS="--cfg kani_full"`: those same properties for every u64,
//   which may not finish. `proofs/lending_amm_z3.py` proves them for every u64 with Z3
//   (docs/spec/README.md, "Test layers" 2).
// A symbolic fee makes even the bounded tier time out, so each fee is a constant per arm:
// the spec's edges 0, 30 and `MAX_LP_FEE_BPS`.
#[cfg(kani)]
mod proofs {
    use super::*;
    use crate::config::MAX_LP_FEE_BPS;

    /// Bound of the bounded tier, on the reserves and the amount alike.
    const SMALL: u64 = 1 << 4;

    macro_rules! with_edge_fee {
        ($fee:ident => $body:expr) => {{
            match kani::any::<u8>() % 3 {
                0 => {
                    let $fee: u16 = 0;
                    $body
                }
                1 => {
                    let $fee: u16 = 30;
                    $body
                }
                _ => {
                    let $fee: u16 = MAX_LP_FEE_BPS;
                    $body
                }
            }
        }};
    }

    /// For any reserves and amount, the price is computed without panicking.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn exact_in_never_panics() {
        let (reserve_in, reserve_out, amount_in): (u64, u64, u64) = kani::any();
        with_edge_fee!(fee => { let _ = exact_in(reserve_in, reserve_out, amount_in, fee); });
    }

    fn assert_fee_rounds_up(reserve_in: u64, reserve_out: u64, amount_in: u64, fee: u16) {
        if let Ok(t) = exact_in(reserve_in, reserve_out, amount_in, fee) {
            assert!(t.fee as u128 * BPS >= amount_in as u128 * fee as u128);
            assert!(t.fee + t.net == amount_in);
        }
    }

    fn assert_product_never_falls(reserve_in: u64, reserve_out: u64, amount_in: u64, fee: u16) {
        if let Ok(t) = exact_in(reserve_in, reserve_out, amount_in, fee) {
            assert!(t.out < reserve_out);
            let before = reserve_in as u128 * reserve_out as u128;
            let after = (reserve_in as u128 + amount_in as u128) * (reserve_out - t.out) as u128;
            assert!(after >= before);
        }
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_fee_never_rounds_in_the_traders_favour_bounded() {
        let amount_in: u64 = kani::any_where(|&a| a < SMALL);
        with_edge_fee!(fee => assert_fee_rounds_up(SMALL, SMALL, amount_in, fee));
    }

    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_swap_never_lowers_the_product_of_the_reserves_bounded() {
        let reserve_in: u64 = kani::any_where(|&r| r < SMALL);
        let reserve_out: u64 = kani::any_where(|&r| r < SMALL);
        let amount_in: u64 = kani::any_where(|&a| a < SMALL);
        with_edge_fee!(fee => assert_product_never_falls(reserve_in, reserve_out, amount_in, fee));
    }

    fn assert_round_trip_returns_at_most_what_went_in(
        reserve_in: u64,
        reserve_out: u64,
        amount_in: u64,
        fee: u16,
    ) {
        let Some(joined) = reserve_in.checked_add(amount_in) else {
            return;
        };
        if let Ok(there) = exact_in(reserve_in, reserve_out, amount_in, fee) {
            // The output left side o, and the whole input joined side i.
            if let Ok(back) = exact_in(reserve_out - there.out, joined, there.out, fee) {
                assert!(back.out <= amount_in);
            }
        }
    }

    /// A round trip at fixed reserves returns at most what went in (Book of Knowledge PR-3):
    /// bounded, the reserves and the amount below `SMALL`; `proofs/lending_amm_z3.py` for every
    /// u64.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_round_trip_never_returns_more_than_went_in_bounded() {
        let reserve_in: u64 = kani::any_where(|&r| r < SMALL);
        let reserve_out: u64 = kani::any_where(|&r| r < SMALL);
        let amount_in: u64 = kani::any_where(|&a| a < SMALL);
        with_edge_fee!(fee => assert_round_trip_returns_at_most_what_went_in(
            reserve_in, reserve_out, amount_in, fee
        ));
    }

    /// For every output, buffer and payable amount: the shortfall is what the output needs
    /// beyond the buffer, 0 whenever the buffer covers it, and refused exactly when it is more
    /// than Kamino can pay right now.
    #[kani::proof]
    fn the_shortfall_is_the_output_beyond_the_buffer_up_to_what_kamino_can_pay() {
        let (out, buffer, can_pay): (u64, u64, u64) = kani::any();
        match shortfall(out, buffer, can_pay) {
            Ok(s) => {
                assert!(s <= can_pay);
                if out <= buffer {
                    assert!(s == 0);
                } else {
                    assert!(s == out - buffer && buffer + s == out);
                }
            }
            Err(error) => {
                assert!(matches!(error, StrategyError::BeyondBuffer));
                assert!(out > buffer && out - buffer > can_pay);
            }
        }
    }

    /// The lent side's total is the recorded buffer plus the recorded cTokens' value at the
    /// stored rate, or refused; no cTokens add nothing, and tokens sent to the market outside
    /// its instructions never count, since only recorded amounts are read. Bounded: the
    /// cTokens and the reserve's two supplies below 2^4, the buffer any u64, so its overflow is
    /// covered; the valuation itself is proven for every input in `kamino.rs` and
    /// `proofs/kamino_z3.py`.
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn the_lent_total_is_the_buffer_plus_the_recorded_ctokens_value() {
        let mut market = LendingAmmMarket {
            version: 1,
            bump: 0,
            authority_bump: 0,
            lent_index: kani::any_where(|&i| i < 2),
            lp_fee_bps: 0,
            withdraw_mode: false,
            mints: [Pubkey::default(); 2],
            vaults: [Pubkey::default(); 2],
            market_signer: Pubkey::default(),
            lp_mint: Pubkey::default(),
            ctoken_account: Pubkey::default(),
            reserve: Pubkey::default(),
            collateral_mint: Pubkey::default(),
            seeder: Pubkey::default(),
            reserves: [kani::any(), kani::any()],
            ctokens: kani::any_where(|&c| c < SMALL),
            deposited: 0,
            redeemed: 0,
            created_slot: 0,
            created_at: 0,
            exit_seen_slot: 0,
            reserved: [0; crate::state::RESERVED_LEN],
        };
        let reserve = Reserve {
            total_available_amount: kani::any_where(|&a| a < SMALL),
            mint_total_supply: kani::any_where(|&n| n < SMALL),
            ..Reserve::default()
        };
        let buffer = market.reserves[market.lent_side()];
        match (
            lent_total(&market, &reserve),
            reserve.lent_value(market.ctokens),
        ) {
            (Ok(total), Ok(value)) => assert!(total as u128 == buffer as u128 + value as u128),
            (Err(_), Ok(value)) => assert!(buffer as u128 + value as u128 > u64::MAX as u128),
            (Ok(_), Err(_)) => panic!("valued cTokens the reserve cannot value"),
            (Err(_), Err(_)) => {}
        }
        // No cTokens add nothing to the buffer, whatever the reserve holds.
        market.ctokens = 0;
        assert!(lent_total(&market, &reserve).ok() == Some(buffer));
    }

    /// A quote is the one pricing function's answer on the effective reserves `[R, B + V]`:
    /// for a trade `exact_in` and `shortfall` accept, its output is `exact_in`'s and a
    /// lent-side output beyond the buffer carries exactly its shortfall and asks what Kamino can
    /// pay only then. Bounded: amounts and reserves below 2^4, and no cTokens, whose value
    /// `lent_total` adds (proven above). Its refusals are those of `exact_in` and `shortfall`,
    /// proven above, and the exact-out and wrong-sides refusals the unit tests check. Only behind
    /// `kani_full`: even with every refusal assumed away, CBMC encodes the Anchor error values
    /// `quote` can build and ran past 6 minutes, so the default tier proves its parts
    /// (`exact_in`, `lent_total`, `shortfall`) and the fuzzer checks each quote equals its swap.
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(65)]
    #[kani::solver(cadical)]
    fn a_quote_is_exact_in_on_the_effective_reserves_with_its_shortfall() {
        let small = |x: &u64| *x < SMALL;
        let market = LendingAmmMarket {
            version: 1,
            bump: 0,
            authority_bump: 0,
            lent_index: kani::any_where(|&i| i < 2),
            lp_fee_bps: 30,
            withdraw_mode: false,
            mints: [Pubkey::default(); 2],
            vaults: [Pubkey::default(); 2],
            market_signer: Pubkey::default(),
            lp_mint: Pubkey::default(),
            ctoken_account: Pubkey::default(),
            reserve: Pubkey::default(),
            collateral_mint: Pubkey::default(),
            seeder: Pubkey::default(),
            reserves: [kani::any_where(small), kani::any_where(small)],
            ctokens: 0,
            deposited: 0,
            redeemed: 0,
            created_slot: 0,
            created_at: 0,
            exit_seen_slot: 0,
            reserved: [0; crate::state::RESERVED_LEN],
        };
        let reserve = Reserve {
            total_available_amount: kani::any_where(small),
            mint_total_supply: kani::any_where(small),
            ..Reserve::default()
        };
        let input: u8 = kani::any_where(|&i| i < 2);
        let trade = TradeRequest {
            mode: TradeMode::ExactIn,
            input_index: input,
            output_index: 1 - input,
            amount: kani::any_where(small),
            trader: None,
            extra: Vec::new(),
        };
        let can_pay: u64 = kani::any_where(small);
        let (input, output) = (trade.input_index as usize, trade.output_index as usize);
        let lent = market.lent_side();
        let buffer = market.reserves[lent];
        let effective = market.reserves;
        let priced = exact_in(effective[input], effective[output], trade.amount, 30);
        // Only trades the maths accepts, so no Anchor error is ever built.
        kani::assume(market.is_open());
        let Ok(priced) = priced else {
            kani::assume(false);
            return;
        };
        kani::assume(output != lent || priced.out <= buffer || priced.out - buffer <= can_pay);
        let mut asked = false;
        let quoted = quote(&market, &reserve, &trade, || {
            asked = true;
            Ok(can_pay)
        });
        let Ok(q) = quoted else {
            panic!("a trade the maths accepts is quoted");
        };
        assert!(q.amount_out == priced.out);
        assert!(q.amount_in == trade.amount);
        if output == lent && q.amount_out > buffer {
            assert!(asked && q.shortfall == q.amount_out - buffer && q.shortfall <= can_pay);
        } else {
            assert!(!asked && q.shortfall == 0);
        }
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn the_fee_never_rounds_in_the_traders_favour() {
        with_edge_fee!(fee => assert_fee_rounds_up(kani::any(), kani::any(), kani::any(), fee));
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_swap_never_lowers_the_product_of_the_reserves() {
        with_edge_fee!(fee => assert_product_never_falls(kani::any(), kani::any(), kani::any(), fee));
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_round_trip_never_returns_more_than_went_in() {
        with_edge_fee!(fee => assert_round_trip_returns_at_most_what_went_in(
            kani::any(), kani::any(), kani::any(), fee
        ));
    }
}
