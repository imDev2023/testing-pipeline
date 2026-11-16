//! Every holder can exit, at a price bound (#152, `POOL4-32`): the fuzzer's counterexample
//! after the inventory cap, from minimal steps. A small market dumped on is trimmed down to
//! `MIN_LIQUIDITY` near `MIN_SQRT_PRICE`, where its curve can take fewer tokens before the
//! bound than a holder holds, so the whole holding is refused with `PriceBoundReached`
//! (docs/spec/pool4-for-solana.md, "Rules for both"). The holder still exits as the spec's
//! "Invariants for test layer 3" defines it: the most the curve can take sells, for what
//! the curve holds above the bound, or that is worth less than a lamport.

mod common;

use buy_wall_amm::config::{MIN_LIQUIDITY, MIN_SQRT_PRICE};
use buy_wall_amm::errors::StrategyError;
use buy_wall_amm::math::{Q, U256};
use buy_wall_amm::state::MarketState;
use common::*;
use pipeline_client::TradeMode;
use solana_signer::Signer;

/// The counterexample's market: graduated with these amounts and parameters.
const TOKENS: u64 = 76_946_843;
const LAMPORTS: u64 = 100_000_000;
/// The counterexample's sell, which takes the price close to `MIN_SQRT_PRICE` and trims
/// the curve down to `MIN_LIQUIDITY`.
const DUMP: u64 = 188_297_481_985_116_634;
/// The holding the fuzzer found stuck.
const HELD: u64 = 2_585_842_305_224_786;

/// The counterexample's market, opened and then sold `dump` token units.
fn dumped_on(env: &mut Env, dump: u64) -> Market {
    let mut params = launch_params(env.admin.pubkey());
    params.fee_bps = 25;
    params.wall_split_bps = 0;
    params.reward_share_bps = 1;
    params.cap_floor_bps = 114;
    params.cap_decay_bps = 0;
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(token, TOKEN, &params, TOKENS, LAMPORTS)
        .unwrap();
    let seller = env.trader(&market, dump + dump / 300 + 1, 0);
    env.swap(&market, &seller, (0, 1), TradeMode::ExactIn, dump)
        .unwrap();
    market
}

/// The most the curve can take before `MIN_SQRT_PRICE`, by the spec's "A sell" with no
/// wall placed: `ceil(L × Q × (s - MIN) / (s × MIN))`.
fn most_the_curve_takes(state: &MarketState) -> u64 {
    let (s, l) = (state.sqrt_price(), state.liquidity());
    U256::times_q(l)
        .mul_u128(s - MIN_SQRT_PRICE)
        .unwrap()
        .div_ceil(U256::mul(s, MIN_SQRT_PRICE).unwrap())
        .and_then(U256::to_u64)
        .unwrap()
}

/// The lamports the curve frees between its price and `MIN_SQRT_PRICE`:
/// `floor(L × (s - MIN) / Q)`.
fn above_the_bound(state: &MarketState) -> u64 {
    let (s, l) = (state.sqrt_price(), state.liquidity());
    U256::mul(l, s - MIN_SQRT_PRICE)
        .unwrap()
        .div_floor(U256::from(Q))
        .and_then(U256::to_u64)
        .unwrap()
}

#[test]
fn a_holding_beyond_the_price_bound_is_worth_less_than_a_lamport() {
    let mut env = Env::new();
    let market = dumped_on(&mut env, DUMP);
    let state = env.state(&market);
    assert_eq!(state.liquidity(), MIN_LIQUIDITY);

    // The whole holding is more than the curve can take before its price bound.
    assert!(HELD > most_the_curve_takes(&state));
    let whole = env.quote(&market, &trade(TradeMode::ExactIn, 0, 1, HELD));
    assert_refused(whole, StrategyError::PriceBoundReached);
    // And what the curve holds above the bound pays nothing.
    assert_eq!(above_the_bound(&state), 0);

    exit::can_exit(&env, &market, HELD).unwrap();
}

#[test]
fn a_holding_beyond_the_price_bound_sells_what_the_curve_can_take() {
    let mut env = Env::new();
    // A smaller dump leaves the trimmed curve a few lamports above the bound.
    let market = dumped_on(&mut env, 16_000_000_000_000);
    let state = env.state(&market);
    assert_eq!(state.liquidity(), MIN_LIQUIDITY);
    let most = most_the_curve_takes(&state);
    let held = most + most / 10;
    let worth = above_the_bound(&state);
    assert!(
        worth > 1,
        "the curve holds {worth} lamports above the bound"
    );

    // The spec's closed form agrees with the program: one token unit more than the most
    // the curve can take is refused for the bound.
    let beyond = env.quote(&market, &trade(TradeMode::ExactIn, 0, 1, most + 1));
    assert_refused(beyond, StrategyError::PriceBoundReached);
    exit::can_exit(&env, &market, held).unwrap();

    // The holder sells the most the curve can take, through the router, and is paid what
    // the curve held above the bound, less the market's fee.
    let holder = env.trader(&market, held, 0);
    let whole = env.quote(&market, &trade(TradeMode::ExactIn, 0, 1, held));
    assert_refused(whole, StrategyError::PriceBoundReached);
    let sold = env
        .swap(&market, &holder, (0, 1), TradeMode::ExactIn, most)
        .unwrap();
    let fee = (worth * state.fee_bps() as u64).div_ceil(10_000);
    assert_eq!(sold.received, worth - fee);
    assert_eq!(env.state(&market).sqrt_price(), MIN_SQRT_PRICE);

    // What is left can only sell below the bound, and still counts as an exit.
    let left = env.balance(&pipeline_client::pda::associated_token(
        &holder.pubkey(),
        &market.token_mint,
        &market.token_program,
    ));
    assert_eq!(left, held - most - sold.pipeline_fee);
    exit::can_exit(&env, &market, left).unwrap();
}
