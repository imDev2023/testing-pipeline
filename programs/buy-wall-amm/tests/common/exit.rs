//! The shared invariant "every holder can exit" (docs/spec/README.md, "Test layers" 3), as
//! the buy wall AMM defines it at a price bound (docs/spec/pool4-for-solana.md, "Invariants
//! for test layer 3", `POOL4-36`).

use buy_wall_amm::config::MIN_SQRT_PRICE;
use buy_wall_amm::errors::StrategyError;
use buy_wall_amm::interface::{TradeMode as StrategyMode, TradeRequest as StrategyRequest};
use buy_wall_amm::pricing::Priced;
use buy_wall_amm::state::MarketState;
use pipeline_client::TradeMode;

use super::{trade, Env, Market};

/// Whether a holder of `held` token units of `market` can exit, and why not:
///
/// - their whole holding sells; or
/// - it is refused because it pays nothing (`ZeroOutput`), so it is worth less than one
///   lamport; or
/// - it is refused because it is more than the curve can take before its price bound
///   (`PriceBoundReached`), and then the most the curve can take sells, landing the price
///   exactly on `MIN_SQRT_PRICE`, or pays nothing, and one token unit more is refused for
///   the bound.
///
/// Sells are quoted with the strategy's `pipeline_quote`, as an integrator's quoter asks
/// it, for the amount that reaches the strategy (Pipeline's fee is charged on top). The
/// most the curve can take is searched for with `pricing::settle`, the function
/// `pipeline_quote` runs, and checked against the bound independently of that search: a
/// sell that takes all the curve can take ends on the bound, so a refusal of a holding the
/// curve could have taken would show as a price above it.
pub fn can_exit(env: &Env, market: &Market, held: u64) -> Result<(), String> {
    if held == 0 {
        return Ok(());
    }
    let error = match quote(env, market, held) {
        Ok(()) => return Ok(()),
        Err(error) if refused_for(&error, StrategyError::ZeroOutput) => return Ok(()),
        Err(error) if refused_for(&error, StrategyError::PriceBoundReached) => error,
        Err(error) => return Err(format!("a holder of {held} cannot exit: {error}")),
    };
    let refused = |why: String| {
        Err(format!(
            "a holder of {held} is refused at the price bound ({error}), and {why}"
        ))
    };
    let most = most_the_curve_takes(env, market, held);
    if most > 0 {
        match quote(env, market, most) {
            Ok(()) => {
                let landed = settle(&env.state(market), most)
                    .map(|priced| priced.sqrt_price)
                    .map_err(|e| e.to_string());
                if landed != Ok(MIN_SQRT_PRICE) {
                    return refused(format!(
                        "selling the {most} the curve can take leaves the price at {landed:?}, \
                         not on the bound"
                    ));
                }
            }
            Err(partial) if refused_for(&partial, StrategyError::ZeroOutput) => {}
            Err(partial) => {
                return refused(format!(
                    "the {most} the curve can take does not sell: {partial}"
                ))
            }
        }
    }
    match quote(env, market, most + 1) {
        Err(beyond) if refused_for(&beyond, StrategyError::PriceBoundReached) => Ok(()),
        beyond => refused(format!("{} is not: {beyond:?}", most + 1)),
    }
}

/// The largest sell below `held` the market's pricing does not refuse for its price bound.
/// A larger sell only moves the price further, so the refusal is monotonic in the amount;
/// a binary search keeps this right whichever steps a sell takes (the curve's, and the
/// wall's once it is placed).
fn most_the_curve_takes(env: &Env, market: &Market, held: u64) -> u64 {
    let state = env.state(market);
    let bound = u32::from(StrategyError::PriceBoundReached);
    let reaches_bound = |amount: u64| {
        matches!(
            settle(&state, amount),
            Err(anchor_lang::error::Error::AnchorError(error))
                if error.error_code_number == bound
        )
    };
    // `lo` never reaches the bound (a sell of 0 is refused for its input), `hi` does.
    let (mut lo, mut hi) = (0, held);
    while hi - lo > 1 {
        let mid = lo + (hi - lo) / 2;
        if reaches_bound(mid) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    lo
}

/// A sell of `amount` token units, priced and booked by `pricing::settle` on `state`.
fn settle(state: &MarketState, amount: u64) -> anchor_lang::Result<Priced> {
    let request = StrategyRequest {
        mode: StrategyMode::ExactIn,
        input_index: 0,
        output_index: 1,
        amount,
        trader: None,
        extra: vec![],
    };
    buy_wall_amm::pricing::settle(state, &request).map(|settled| settled.priced)
}

/// A sell of `amount` token units quoted by the strategy's `pipeline_quote`.
fn quote(env: &Env, market: &Market, amount: u64) -> Result<(), String> {
    env.quote(market, &trade(TradeMode::ExactIn, 0, 1, amount))
        .map(|_| ())
}

/// Whether a failed transaction's `error` is the strategy refusing with `refusal`.
fn refused_for(error: &str, refusal: StrategyError) -> bool {
    let code: u32 = refusal.into();
    error.contains(&format!("Custom({code})"))
}
