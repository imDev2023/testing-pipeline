//! The inventory cap through the real router (docs/spec/pool4-for-solana.md, "After pricing"
//! steps 5 and 6, "Counters", "Done means"): after each swap the decay credit builds up in
//! token-seconds, at most one day's worth; a swap that leaves the curve holding less than
//! the cap lowers the cap by the room it opened, within the credit and never below the cap
//! floor; and one that leaves it holding more is trimmed, its excess tokens retired and the
//! proportional SOL moved to idle SOL, without moving the price, unless `MIN_LIQUIDITY`
//! stops it. A swap that lowers the cap or trims emits an event, and the market keeps the
//! lifetime totals of tokens and SOL trimmed.

mod common;

use buy_wall_amm::config::{DECAY_CREDIT_WINDOW, MIN_LIQUIDITY};
use buy_wall_amm::events::{CapLowered, Trimmed};
use buy_wall_amm::math::{Q, U256};
use buy_wall_amm::params::InitParams;
use buy_wall_amm::state::MarketState;
use common::*;
use pipeline_client::TradeMode;
use solana_keypair::Keypair;
use solana_signer::Signer;

const TOKENS: u64 = 1_000_000_000_000;
const LAMPORTS: u64 = 10 * SOL;
const BUY: (usize, usize) = (1, 0);
const SELL: (usize, usize) = (0, 1);
const DAY: i64 = 86_400;

/// What the curve holds at its price: `floor(L × Q / s)`, as the spec's step 6 writes it,
/// computed here on its own.
fn held(state: &MarketState) -> u128 {
    U256::times_q(state.liquidity())
        .div_floor(U256::from(state.sqrt_price()))
        .and_then(U256::to_u128)
        .unwrap()
}

/// Every vault holds exactly the sum of its ledgers: a trim only moves value between the
/// ledgers of one vault.
fn assert_vaults_match_ledgers(env: &Env, market: &Market) {
    let state = env.state(market);
    assert_eq!(
        env.balance(&market.token_vault) as u128,
        state.pool_tokens() as u128 + state.retired_tokens() as u128 + state.rewards_owed() as u128
    );
    assert_eq!(
        env.balance(&market.sol_vault) as u128,
        state.pool_sol() as u128
            + state.idle_sol() as u128
            + state.fees_recipient() as u128
            + state.fees_designer() as u128
            + state.fees_suite() as u128
    );
}

/// The pool ledgers cover the curve: `L × Q / s <= pool_tokens` and `L × s / Q <= pool_sol`.
fn assert_ledgers_cover_the_curve(state: &MarketState) {
    let (s, l) = (state.sqrt_price(), state.liquidity());
    assert!(U256::mul(l, Q).unwrap() <= U256::mul(state.pool_tokens() as u128, s).unwrap());
    assert!(U256::mul(l, s).unwrap() <= U256::mul(state.pool_sol() as u128, Q).unwrap());
}

fn params(env: &Env, cap_floor_bps: u16, cap_decay_bps: u16) -> InitParams {
    let mut params = launch_params(env.admin.pubkey());
    params.fee_bps = 100;
    params.wall_split_bps = 5_000;
    params.cap_floor_bps = cap_floor_bps;
    params.cap_decay_bps = cap_decay_bps;
    params
}

fn seeded(env: &mut Env, params: &InitParams, tokens: u64, lamports: u64) -> Market {
    let token = env.seedable_token(&TOKEN);
    env.create_and_seed(token, TOKEN, params, tokens, lamports)
        .unwrap()
        .0
}

/// Moves the clock `seconds` on, with slots to match.
fn later(env: &mut Env, seconds: i64) {
    let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    env.set_clock(
        clock.slot + seconds as u64 * 5 / 2 + 1,
        clock.unix_timestamp + seconds,
    );
}

fn now(env: &Env) -> i64 {
    env.svm
        .get_sysvar::<anchor_lang::prelude::Clock>()
        .unix_timestamp
}

/// A swap through the router, returning what the trader received and the logs.
fn swap(
    env: &mut Env,
    market: &Market,
    trader: &Keypair,
    direction: (usize, usize),
    amount: u64,
) -> (u64, Vec<String>) {
    let (result, logs) = env
        .swap_logged(market, trader, direction, TradeMode::ExactIn, amount, 0)
        .unwrap();
    (result.received, logs)
}

/// The price the pricing function gives a trade on the market as it was before it, which
/// is where the swap must leave the price whether or not it trims.
fn priced_sqrt_price(state: &MarketState, direction: (usize, usize), amount: u64) -> u128 {
    let request = buy_wall_amm::interface::TradeRequest {
        mode: buy_wall_amm::interface::TradeMode::ExactIn,
        input_index: direction.0 as u8,
        output_index: direction.1 as u8,
        amount,
        trader: None,
        extra: vec![],
    };
    buy_wall_amm::pricing::quote(state, &request)
        .unwrap()
        .sqrt_price
}

#[test]
fn the_worked_examples_cap_numbers_are_reproduced_through_the_router() {
    // Seeded with 1,000,000 tokens of 6 decimals and 10 SOL, fee 100, wall split 5,000,
    // cap floor 2,000 and cap decay 2,000 (docs/spec/pool4-for-solana.md, "Worked example").
    let mut env = Env::new();
    let params = params(&env, 2_000, 2_000);
    let market = seeded(&mut env, &params, TOKENS, LAMPORTS);
    let trader = env.trader(&market, 1_000_000_000, 2 * SOL);
    let opened = env.state(&market);
    assert_eq!(opened.cap(), TOKENS);
    assert_eq!(opened.cap_floor(), 200_000_000_000);
    assert_eq!(opened.cap_decay_per_day(), 200_000_000_000);
    assert_eq!(opened.decay_credit(), 0);
    assert_eq!(opened.decay_time(), now(&env));

    // One hour later, a buy of 1 SOL: the cap falls by one hour's allowance.
    later(&mut env, 3_600);
    let (out, logs) = swap(&mut env, &market, &trader, BUY, SOL);
    assert_eq!(out, 90_081_892_629);
    let bought = env.state(&market);
    assert_eq!(bought.cap(), 991_666_666_667);
    // 200,000,000,000 × 3,600 token-seconds built up; 8,333,333,333 units × 86,400 spent.
    assert_eq!(
        bought.decay_credit(),
        720_000_000_000_000 - 8_333_333_333 * 86_400
    );
    assert_eq!(bought.decay_credit(), 28_800);
    assert_eq!(bought.decay_time(), now(&env));
    assert_eq!(bought.liquidity(), opened.liquidity());
    assert_eq!(
        events::<CapLowered>(&logs),
        vec![CapLowered {
            market_state: market.market_state,
            cap: 991_666_666_667,
            lowered_by: 8_333_333_333,
            held: held(&bought) as u64,
            decay_credit: 28_800,
        }]
    );
    assert!(events::<Trimmed>(&logs).is_empty());
    assert_eq!((bought.tokens_trimmed(), bought.sol_trimmed()), (0, 0));

    // 60 seconds later, a sell of those units: the trim, at the price the sell left.
    later(&mut env, 60);
    let price = priced_sqrt_price(&bought, SELL, 90_081_892_629);
    let (out, logs) = swap(&mut env, &market, &trader, SELL, 90_081_892_629);
    assert_eq!(out, 980_099_999);
    let sold = env.state(&market);
    assert_eq!(sold.sqrt_price(), 1_844_674_407_372_029_099);
    assert_eq!(sold.sqrt_price(), price);
    assert_eq!(sold.last_close(), price);
    assert_eq!(sold.liquidity(), 99_166_666_666);
    assert_eq!(sold.pool_tokens(), 991_666_666_671);
    assert_eq!(sold.pool_sol(), 9_916_666_669);
    assert_eq!(sold.idle_sol(), 91_293_332);
    assert_eq!(sold.retired_tokens(), 8_333_333_329);
    assert_eq!(
        (sold.tokens_trimmed(), sold.sol_trimmed()),
        (8_333_333_329, 83_333_332)
    );
    // A sell leaves the cap where it was, and the credit keeps building.
    assert_eq!(sold.cap(), 991_666_666_667);
    assert_eq!(sold.decay_credit(), 28_800 + 200_000_000_000 * 60);
    assert!(held(&sold) <= sold.cap() as u128);
    assert_eq!(
        events::<Trimmed>(&logs),
        vec![Trimmed {
            market_state: market.market_state,
            tokens: 8_333_333_329,
            sol: 83_333_332,
            liquidity: 99_166_666_666,
            cap: 991_666_666_667,
        }]
    );
    assert!(events::<CapLowered>(&logs).is_empty());
    assert_ledgers_cover_the_curve(&sold);
    assert_vaults_match_ledgers(&env, &market);
}

#[test]
fn a_trim_never_moves_the_price() {
    for (cap_decay_bps, wait, buy, sell) in [
        (2_000, 3_600, SOL, 120_000_000_000),
        (0, 0, 3 * SOL, 400_000_000_000),
        (10_000, DAY, 25 * SOL, 900_000_000_000),
    ] {
        let mut env = Env::new();
        let params = params(&env, 1_000, cap_decay_bps);
        let market = seeded(&mut env, &params, TOKENS, LAMPORTS);
        let trader = env.trader(&market, 1_000_000_000_000, 30 * SOL);
        later(&mut env, wait);
        swap(&mut env, &market, &trader, BUY, buy);
        later(&mut env, 1);
        let before = env.state(&market);
        let price = priced_sqrt_price(&before, SELL, sell);
        let (_, logs) = swap(&mut env, &market, &trader, SELL, sell);
        let after = env.state(&market);
        let trims = events::<Trimmed>(&logs);
        assert_eq!(trims.len(), 1, "decay {cap_decay_bps}: the sell trims");
        assert!(after.liquidity() < before.liquidity());
        assert_eq!(after.sqrt_price(), price, "decay {cap_decay_bps}");
        assert_eq!(after.last_close(), price);
        assert_eq!(
            after.retired_tokens() - before.retired_tokens(),
            trims[0].tokens
        );
        assert!(held(&after) <= after.cap() as u128);
        assert_ledgers_cover_the_curve(&after);
        assert_vaults_match_ledgers(&env, &market);
    }
}

#[test]
fn min_liquidity_stops_a_trim() {
    // A thin market: 20,000 units against 0.1 SOL, its curve's liquidity about 1,414,213,
    // with the cap floor at all the seeded tokens and no decay, so the cap stays at 20,000.
    let mut env = Env::new();
    let params = params(&env, 10_000, 0);
    let market = seeded(&mut env, &params, 20_000, SOL / 10);
    let trader = env.trader(&market, 100_000, SOL);
    let opened = env.state(&market);
    assert!(opened.liquidity() > MIN_LIQUIDITY);

    // A sell that halves the price would trim the curve to below MIN_LIQUIDITY: it trims
    // to MIN_LIQUIDITY and no further, leaving the curve above the cap.
    let price = priced_sqrt_price(&opened, SELL, 20_000);
    let (_, logs) = swap(&mut env, &market, &trader, SELL, 20_000);
    let sold = env.state(&market);
    assert_eq!(sold.sqrt_price(), price);
    assert_eq!(sold.liquidity(), MIN_LIQUIDITY);
    assert_eq!(sold.cap(), 20_000);
    assert!(held(&sold) > sold.cap() as u128);
    let trims = events::<Trimmed>(&logs);
    assert_eq!(trims.len(), 1);
    assert_eq!(trims[0].liquidity, MIN_LIQUIDITY);
    assert!(trims[0].tokens > 0 && trims[0].sol > 0);
    assert_ledgers_cover_the_curve(&sold);

    // Another sell finds the curve at MIN_LIQUIDITY: nothing is trimmed at all.
    later(&mut env, 60);
    let price = priced_sqrt_price(&sold, SELL, 1_000);
    let (_, logs) = swap(&mut env, &market, &trader, SELL, 1_000);
    let again = env.state(&market);
    assert_eq!(again.sqrt_price(), price);
    assert_eq!(again.liquidity(), MIN_LIQUIDITY);
    assert!(held(&again) > again.cap() as u128);
    assert!(events::<Trimmed>(&logs).is_empty());
    assert_eq!(again.retired_tokens(), sold.retired_tokens());
    assert_eq!(again.tokens_trimmed(), sold.tokens_trimmed());
    assert_vaults_match_ledgers(&env, &market);
}

#[test]
fn the_decay_credit_builds_up_to_one_day_and_no_further() {
    // 200,000,000,000 units a day of decay; the cap floor out of the way at 1%.
    let mut env = Env::new();
    let params = params(&env, 100, 2_000);
    let market = seeded(&mut env, &params, TOKENS, LAMPORTS);
    let per_day = 200_000_000_000u64;
    let trader = env.trader(&market, 0, 100 * SOL);

    // Three idle days build up one day's allowance, no more: a buy that opens far more
    // room lowers the cap by exactly one day's decay and spends the whole credit.
    later(&mut env, 3 * DAY);
    let (_, logs) = swap(&mut env, &market, &trader, BUY, 30 * SOL);
    let state = env.state(&market);
    assert!(held(&state) < (TOKENS - per_day) as u128);
    assert_eq!(state.cap(), TOKENS - per_day);
    assert_eq!(state.decay_credit(), 0);
    assert_eq!(events::<CapLowered>(&logs)[0].lowered_by, per_day);

    // In the same second there is no credit, so another buy leaves the cap alone.
    let (_, logs) = swap(&mut env, &market, &trader, BUY, SOL);
    let state = env.state(&market);
    assert_eq!(state.cap(), TOKENS - per_day);
    assert!(events::<CapLowered>(&logs).is_empty());

    // An hour builds up an hour's credit, in token-seconds, and the cap falls by it.
    later(&mut env, 3_600);
    swap(&mut env, &market, &trader, BUY, SOL);
    let state = env.state(&market);
    let credit = per_day as u128 * 3_600;
    let fell = (credit / 86_400) as u64;
    assert_eq!(state.cap(), TOKENS - per_day - fell);
    assert_eq!(state.decay_credit(), credit - fell as u128 * 86_400);
    assert_eq!(
        DECAY_CREDIT_WINDOW, DAY,
        "the window this test counts in days"
    );
}

#[test]
fn a_buy_lowers_the_cap_by_the_room_it_opens_but_never_below_the_cap_floor() {
    // Decay of all the seeded tokens a day, so a day's credit never limits the fall; cap
    // floor 20%.
    for (buy, at_floor) in [(10 * SOL, false), (60 * SOL, true)] {
        let mut env = Env::new();
        let params = params(&env, 2_000, 10_000);
        let market = seeded(&mut env, &params, TOKENS, LAMPORTS);
        let opened = env.state(&market);
        let trader = env.trader(&market, 0, 200 * SOL);
        later(&mut env, DAY);
        let (_, logs) = swap(&mut env, &market, &trader, BUY, buy);
        let state = env.state(&market);
        let floor = 200_000_000_000u64;
        if at_floor {
            // The curve holds less than the floor, and the cap stops at the floor.
            assert!(held(&state) < floor as u128);
            assert_eq!(state.cap(), floor);
        } else {
            // The cap falls to what the curve holds: all the room the buy opened.
            assert!(held(&state) > floor as u128);
            assert_eq!(state.cap() as u128, held(&state));
        }
        let fell = TOKENS - state.cap();
        assert_eq!(
            state.decay_credit(),
            TOKENS as u128 * 86_400 - fell as u128 * 86_400
        );
        assert_eq!(
            events::<CapLowered>(&logs),
            vec![CapLowered {
                market_state: market.market_state,
                cap: state.cap(),
                lowered_by: fell,
                held: held(&state) as u64,
                decay_credit: state.decay_credit(),
            }]
        );
        // A buy never trims.
        assert_eq!(state.liquidity(), opened.liquidity());

        // Later buys can never take the cap below the floor.
        later(&mut env, 3 * DAY);
        swap(&mut env, &market, &trader, BUY, 60 * SOL);
        assert_eq!(env.state(&market).cap(), floor);
    }
}

#[test]
fn a_market_with_cap_decay_0_never_lowers_its_cap() {
    let mut env = Env::new();
    let params = params(&env, 2_000, 0);
    let market = seeded(&mut env, &params, TOKENS, LAMPORTS);
    let trader = env.trader(&market, 0, 100 * SOL);
    for wait in [0, 3_600, DAY, 30 * DAY] {
        later(&mut env, wait);
        let (_, logs) = swap(&mut env, &market, &trader, BUY, 5 * SOL);
        let state = env.state(&market);
        assert_eq!(state.cap(), TOKENS);
        assert_eq!(state.decay_credit(), 0);
        assert!(held(&state) < TOKENS as u128);
        assert!(events::<CapLowered>(&logs).is_empty());
    }
}

#[test]
fn the_trimmed_totals_add_up_over_every_trim() {
    let mut env = Env::new();
    let params = params(&env, 2_000, 2_000);
    let market = seeded(&mut env, &params, TOKENS, LAMPORTS);
    let trader = env.trader(&market, 500_000_000_000, 50 * SOL);
    let (mut tokens, mut sol) = (0u128, 0u128);
    for round in 0..4 {
        later(&mut env, 3_600);
        let (bought, _) = swap(&mut env, &market, &trader, BUY, 5 * SOL);
        later(&mut env, 60);
        let before = env.state(&market);
        // Selling back more than the buy took leaves the curve above the cap.
        let (_, logs) = swap(&mut env, &market, &trader, SELL, bought + 20_000_000_000);
        let after = env.state(&market);
        assert_eq!(events::<Trimmed>(&logs).len(), 1, "round {round}");
        for trim in events::<Trimmed>(&logs) {
            tokens += trim.tokens as u128;
            sol += trim.sol as u128;
        }
        assert_eq!(
            (after.tokens_trimmed(), after.sol_trimmed()),
            (tokens, sol),
            "round {round}"
        );
        assert_eq!(after.retired_tokens() as u128, tokens);
        assert!(after.idle_sol() > before.idle_sol());
        assert_vaults_match_ledgers(&env, &market);
    }
    assert!(tokens > 0 && sol > 0);
}
