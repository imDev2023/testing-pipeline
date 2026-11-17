//! Conformance (docs/spec/README.md, "Test layers" 4; docs/spec/pool4-for-solana.md,
//! "Accepted `pipeline-check` warnings"): Pipeline's `check_market` reports zero Fail and
//! zero Warn on seeded buy wall markets, with `exact_out_refund` skipped because exact-out
//! is refused by design; every other check runs and passes, including on a market whose
//! inventory cap is falling and whose sells are trimmed, and on a market with a placed buy
//! wall, at its top, above it and inside it, with trades crossing it.

mod common;

use buy_wall_amm::config::{MAX_FEE_BPS, MIN_FEE_BPS};
use common::*;
use pipeline_check::{check_market, CheckOptions, Status};
use pipeline_client::TradeMode;
use solana_signer::Signer;

/// The price the program's own pricing gives a trade on `market`'s current state.
fn quoted_sqrt_price(env: &Env, market: &Market, input: u8, amount: u64) -> Option<u128> {
    buy_wall_amm::pricing::quote(
        &env.state(market),
        &buy_wall_amm::interface::TradeRequest {
            mode: buy_wall_amm::interface::TradeMode::ExactIn,
            input_index: input,
            output_index: 1 - input,
            amount,
            trader: None,
            extra: vec![],
        },
    )
    .ok()
    .map(|priced| priced.sqrt_price)
}

fn check(env: &Env, market: &Market, what: &str) {
    let report = check_market(&env.svm, market.market, &CheckOptions::default());
    println!("{what}:\n{}", report.to_text());
    let worse: Vec<String> = report
        .checks
        .iter()
        .filter(|check| matches!(check.status, Status::Fail | Status::Warn))
        .map(|check| format!("{} ({:?}): {}", check.id, check.status, check.message))
        .collect();
    assert!(worse.is_empty(), "{what}: {worse:#?}");
    assert_eq!(
        report.status("exact_out_refund"),
        Some(Status::Skip),
        "{what}"
    );
    for check in report
        .checks
        .iter()
        .filter(|check| check.id != "exact_out_refund")
    {
        assert_eq!(check.status, Status::Pass, "{what}: {}", check.id);
    }
    assert_eq!(
        report.checks.len(),
        pipeline_check::CHECKS.len(),
        "{what}: every check of pipeline-check"
    );
}

#[test]
fn seeded_markets_pass_every_check() {
    for (what, program, fee_bps, wall_split_bps, tokens, lamports) in [
        (
            "SPL Token, IMD's launch values",
            TOKEN,
            100,
            5_000,
            1_000_000_000_000,
            10 * SOL,
        ),
        (
            "Token-2022, the lowest fee, no wall split",
            TOKEN_2022,
            MIN_FEE_BPS,
            0,
            1_000_000_000_000,
            10 * SOL,
        ),
        (
            "SPL Token, the highest fee, all to the wall, a small seed",
            TOKEN,
            MAX_FEE_BPS,
            10_000,
            50_000_000_000,
            buy_wall_amm::config::MIN_SEED_LAMPORTS,
        ),
    ] {
        let mut env = Env::new();
        let token = env.seedable_token(&program);
        let mut params = launch_params(env.admin.pubkey());
        params.fee_bps = fee_bps;
        params.wall_split_bps = wall_split_bps;
        let (market, _) = env
            .create_and_seed(token, program, &params, tokens, lamports)
            .unwrap();
        check(&env, &market, what);
    }
}

#[test]
fn a_seeded_market_of_a_token_whose_transfer_hook_was_cleared_passes_every_check() {
    let mut env = Env::new();
    let token = env.seedable_hooked_token();
    let market = env
        .create_and_seed_hooked(
            token,
            &launch_params(env.admin.pubkey()),
            1_000_000_000_000,
            10 * SOL,
        )
        .unwrap();
    check(&env, &market, "a token whose transfer hook was cleared");
}

#[test]
fn a_market_with_a_placed_wall_passes_every_check_at_above_and_inside_it() {
    // The worked example's market through `place_wall`: the wall sits at the price, so the
    // checker's sells go through the curve and the wall together.
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(
            token,
            TOKEN,
            &launch_params(env.admin.pubkey()),
            1_000_000_000_000,
            10 * SOL,
        )
        .unwrap();
    let trader = env.trader(&market, 500_000_000_000, 20 * SOL);
    let keeper = env.keeper();
    let advance = |env: &mut Env, seconds: i64| {
        let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
        env.set_clock(
            clock.slot + seconds as u64 * 5 / 2 + 1,
            clock.unix_timestamp + seconds,
        );
    };
    let swap = |env: &mut Env, direction: (usize, usize), amount: u64| {
        env.swap(&market, &trader, direction, TradeMode::ExactIn, amount)
            .unwrap()
            .received
    };
    advance(&mut env, 3_600);
    let bought = swap(&mut env, (1, 0), SOL);
    advance(&mut env, 60);
    swap(&mut env, (0, 1), bought);
    env.next_slot();
    env.place_wall(&market, &keeper).unwrap();
    let top = env.state(&market).wall_top();
    assert!(env.state(&market).wall_liquidity() > 0);
    assert_eq!(env.state(&market).sqrt_price(), top);
    check(&env, &market, "a market at its wall's top");

    // A small buy lifts the price just above the wall, so every sell the checker makes
    // crosses into it, in two steps.
    advance(&mut env, 60);
    swap(&mut env, (1, 0), SOL / 1_000);
    assert!(env.state(&market).sqrt_price() > top);
    let smallest_sell = 1_000_000_000;
    assert!(
        quoted_sqrt_price(&env, &market, 0, smallest_sell).unwrap() < top,
        "even a sell of {smallest_sell} units crosses"
    );
    check(&env, &market, "a market above its wall");

    // The least sell that crosses into the wall leaves the price just below its top, so
    // every buy the checker makes crosses out of it, in two steps.
    advance(&mut env, 60);
    let (mut lo, mut hi) = (1u64, smallest_sell);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if quoted_sqrt_price(&env, &market, 0, mid).is_some_and(|price| price < top) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    swap(&mut env, (0, 1), lo);
    let state = env.state(&market);
    assert!(state.sqrt_price() < top, "inside the wall");
    let smallest_buy = 1_000;
    assert!(
        quoted_sqrt_price(&env, &market, 1, smallest_buy).unwrap() > top,
        "even a buy of {smallest_buy} lamports crosses"
    );
    check(&env, &market, "a market inside its wall");
}

#[test]
fn a_market_whose_cap_is_falling_and_trimming_passes_every_check() {
    // The worked example's market after its buy and a sell of more than it bought: the cap
    // has fallen, the curve has been trimmed, and a day later a full day's decay credit is
    // waiting, so the checker's own buys lower the cap further and its sells are trimmed.
    let mut env = Env::new();
    let token = env.seedable_token(&TOKEN);
    let (market, _) = env
        .create_and_seed(
            token,
            TOKEN,
            &launch_params(env.admin.pubkey()),
            1_000_000_000_000,
            10 * SOL,
        )
        .unwrap();
    let trader = env.trader(&market, 100_000_000_000, 2 * SOL);
    let advance = |env: &mut Env, seconds: i64| {
        let clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
        env.set_clock(
            clock.slot + seconds as u64 * 5 / 2 + 1,
            clock.unix_timestamp + seconds,
        );
    };
    advance(&mut env, 3_600);
    let bought = env
        .swap(&market, &trader, (1, 0), TradeMode::ExactIn, SOL)
        .unwrap();
    advance(&mut env, 60);
    env.swap(
        &market,
        &trader,
        (0, 1),
        TradeMode::ExactIn,
        bought.received + 50_000_000_000,
    )
    .unwrap();
    advance(&mut env, 86_400);
    let state = env.state(&market);
    assert!(state.cap() < state.seeded_tokens(), "the cap has fallen");
    assert!(
        state.tokens_trimmed() > 0 && state.sol_trimmed() > 0,
        "sells were trimmed"
    );
    assert!(state.retired_tokens() > 0 && state.idle_sol() > 0);
    check(&env, &market, "a market whose cap is falling and trimming");

    // At this state a buy lowers the cap to what the curve then holds (a full day's credit
    // covers the room it opens), so selling it straight back is trimmed: the checker's
    // round trips from this state ran through both steps, as this one does.
    let (bought, logs) = env
        .swap_logged(&market, &trader, (1, 0), TradeMode::ExactIn, SOL / 2, 0)
        .unwrap();
    let lowered = events::<buy_wall_amm::events::CapLowered>(&logs);
    assert_eq!(lowered.len(), 1);
    assert_eq!(lowered[0].cap, lowered[0].held);
    let (_, logs) = env
        .swap_logged(
            &market,
            &trader,
            (0, 1),
            TradeMode::ExactIn,
            bought.received,
            0,
        )
        .unwrap();
    assert_eq!(events::<buy_wall_amm::events::Trimmed>(&logs).len(), 1);
}

#[test]
fn markets_seeded_by_another_program_pass_every_check() {
    for (what, hooked) in [
        (
            "seeded by the stand-in launchpad through pipeline_seed_liquidity",
            false,
        ),
        (
            "a token whose transfer hook was cleared, seeded by the stand-in launchpad",
            true,
        ),
    ] {
        let mut env = Env::new();
        let (token, program) = if hooked {
            (env.seedable_hooked_token(), TOKEN_2022)
        } else {
            (env.seedable_token(&TOKEN), TOKEN)
        };
        let launch = env.launch(token, program, 1_000_000_000_000, 10 * SOL);
        let graduated = env
            .graduate(
                &launch,
                &launch_params(pipeline_client::Pubkey::new_unique()),
                1_000_000_000_000,
                10 * SOL,
            )
            .unwrap();
        check(&env, &graduated.market, what);
    }
}
