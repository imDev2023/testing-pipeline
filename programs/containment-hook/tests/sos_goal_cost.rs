//! What the cheapest party pays to reach a home market's unlock goal, through the router in
//! LiteSVM: the Book of Knowledge's proposal EC-3 of #74, on hardening finding H023
//! (docs/spec/containment-hook.md, "Unlock goal"; `HOOK-49`).
//!
//! A tax authority that makes itself the sole recipient gets back everything its market
//! taxes but the suite share, so it reaches a goal for `cost / goal = 1 - 0.9a + f(2 - t)/t`,
//! with `a = 1` its share of the creator's part, `t = 1 - (1 - b)(1 - s)` the round trip's
//! tax at buy tax `b` and sell tax `s`, and `f` Pipeline's 0.25%. On a market quoted in
//! wrapped SOL Pipeline takes its fee in SOL on both legs, so the pool's depth and the number
//! of round trips drop out: 12.38% of the goal at 10% and 10%, the spec's figure, which the
//! Book of Knowledge's exact-integer model `.bok/models/t04_wash_unlock.py` gives as well.
//! On another quote the sell's fee is paid in the token, whose price in the quote moves with
//! the trips, so the spec quotes that case for one round trip only (11.43%); this test washes
//! from working capital, so it quotes in wrapped SOL, as the fuzzer's wrapped SOL shapes do.

mod support;

use pipeline_client::interface::fees::amount_for_budget;
use pipeline_client::{pda, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use support::*;
use tax_amm::config::{MAX_RECIPIENTS, MAX_TAX_BPS, RATE_CHANGE_DELAY_SLOTS, SUITE_SHARE_BPS};
use tax_amm::params::NATIVE_MINTS;

/// The unlock goal, as the spec's example, and working capital of half of it, so the goal
/// takes many round trips (12 on this pool) rather than one.
const GOAL_SOL: u64 = 100;
const CAPITAL_SOL: u64 = 50;
/// The rounding each round trip may leave beyond the closed form, in lamports: Pipeline's
/// two fees and the two taxes round up, the curve and the tax split round down, each by
/// under a lamport.
const TOLERANCE_PER_TRIP: f64 = 10.0;

/// The closed form's cost of booking `tax` of tax at buy and sell tax `b` and `s` (in basis
/// points), for a sole recipient on a market quoted in wrapped SOL.
fn closed_form(tax: f64, b: u16, s: u16) -> f64 {
    let (b, s) = (b as f64 / 10_000.0, s as f64 / 10_000.0);
    let t = 1.0 - (1.0 - b) * (1.0 - s);
    let f = pipeline_client::interface::PIPELINE_FEE_BPS as f64 / 10_000.0;
    let kept_share = 1.0 - SUITE_SHARE_BPS as f64 / 10_000.0;
    tax * ((1.0 - kept_share) + f * (2.0 - t) / t)
}

#[test]
fn sos_h023_sole_recipient_washes_to_the_goal_and_unlocks() {
    let goal = GOAL_SOL * SOL;
    let (buy_tax, sell_tax) = (MAX_TAX_BPS, MAX_TAX_BPS);
    let mut env = hook_env();
    let authority = Keypair::new();
    env.svm.airdrop(&authority.pubkey(), SOL).unwrap();

    // A launch quoted in wrapped SOL whose tax authority is the launcher's own key, with
    // tax ranges up to the cap; no burn, which a wrapped SOL tax side refuses.
    let mint = contained_mint(&mut env);
    let quote = env.write_native_mint(&NATIVE_MINTS[0], &TOKEN);
    let seeder = Keypair::new();
    env.svm.airdrop(&seeder.pubkey(), SOL).unwrap();
    let mut params = quote_taxed_params(&seeder.pubkey(), QUOTE as u8);
    params.tax_authority = ak(&authority.pubkey());
    params.buy_tax_min_bps = 0;
    params.buy_tax_max_bps = MAX_TAX_BPS;
    params.sell_tax_min_bps = 0;
    params.sell_tax_max_bps = MAX_TAX_BPS;
    params.shares[0] += params.burn_share_bps;
    params.burn_share_bps = 0;
    let market = env
        .create_tax_market([(mint, TOKEN_2022), (quote, TOKEN)], &params)
        .unwrap();
    let mut bind = BindArgs::new(&env, mint, &market);
    bind.unlock_goal = goal;
    send_bind(&mut env, &bind, &[]).unwrap();
    let holder = token_2022_account(&mut env, &seeder.pubkey(), &mint);
    mint_to(&mut env, &mint, &holder, SUPPLY).unwrap();
    revoke_mint_authority(&mut env, &mint);
    env.write_token_account(&quote, &TOKEN, &seeder.pubkey(), SEED[QUOTE]);
    env.seed_with(&market, &seeder, SEED, hook_tail(&mint))
        .unwrap();

    // The tax authority makes itself the sole recipient and sets both taxes to the cap,
    // which take effect after the rate change delay (hardening of #67).
    let mut recipients = [Pubkey::default(); MAX_RECIPIENTS];
    recipients[0] = authority.pubkey();
    let mut shares = [0; MAX_RECIPIENTS];
    shares[0] = 10_000;
    let split = authority::Split {
        recipients,
        shares,
        burn_share_bps: 0,
    };
    let state = market.market_state;
    for instruction in [
        authority::set_recipients_instruction(&state, &authority.pubkey(), &split),
        authority::set_taxes_instruction(&state, &authority.pubkey(), buy_tax, sell_tax),
    ] {
        env.send_signed(instruction, &authority).unwrap();
    }
    assert_ne!(
        env.tax_market(&state).rates_at(env.slot()),
        [buy_tax, sell_tax]
    );
    env.warp_slots(RATE_CHANGE_DELAY_SLOTS);
    assert_eq!(
        env.tax_market(&state).rates_at(env.slot()),
        [buy_tax, sell_tax]
    );

    // Round trips from working capital: a buy with everything it holds, Pipeline's fee on
    // top, then a sell of everything bought, the fee out of the SOL, then the permissionless
    // `distribute` paying the round trip's tax back but the suite share; the last buy sized
    // to land on the goal.
    let wsol = env.write_token_account(&quote, &TOKEN, &authority.pubkey(), CAPITAL_SOL * SOL);
    let tokens = token_2022_account(&mut env, &authority.pubkey(), &mint);
    let start = env.balance(&wsol);
    let round_trip_tax = 1.0 - (1.0 - buy_tax as f64 / 1e4) * (1.0 - sell_tax as f64 / 1e4);
    let mut trips = 0u32;
    loop {
        let collected = env.tax_market(&state).tax_collected;
        if collected >= goal as u128 {
            break;
        }
        let needed = ((goal as u128 - collected) as f64 / round_trip_tax) as u64 + 1_000;
        let leg = amount_for_budget(env.balance(&wsol), 0).min(needed);
        env.swap_with(
            &market,
            &authority,
            (QUOTE, CONTAINED),
            leg,
            &SwapOptions::default(),
        )
        .unwrap();
        let bought = env.balance(&tokens);
        env.swap_with(
            &market,
            &authority,
            (CONTAINED, QUOTE),
            bought,
            &SwapOptions::default(),
        )
        .unwrap();
        assert_eq!(
            env.balance(&tokens),
            0,
            "a sell into wrapped SOL sells it all"
        );
        env.distribute(&market, &authority, 0).unwrap();
        trips += 1;
        assert!(trips <= 20, "the goal is out of reach of the capital");
    }
    let tax = env.tax_market(&state).tax_collected as u64;
    assert!(
        trips > 1,
        "the goal took one round trip, not working capital"
    );

    // Unlock by the goal, before the deadline.
    let caller = stranger(&mut env);
    let unlocked = send_as(
        &mut env,
        &caller,
        &[unlock_instruction(&mint, &market.market_state)],
    )
    .unwrap();
    assert!(
        unlocked
            .logs
            .iter()
            .any(|line| line.contains("Unlocked by the goal")),
        "{:?}",
        unlocked.logs
    );
    assert!(now(&env) < bind.unlock_deadline);
    assert_eq!(
        mint_hook(&env, &mint).map(|hook| hook.program),
        Some(None),
        "the hook is cleared"
    );

    // Every tax came back to the authority but the suite share.
    let state_now = env.tax_market(&state);
    assert_eq!(
        state_now.owed[0], 0,
        "distribute paid the authority all it was owed"
    );
    let suite = state_now.owed[tax_amm::state::SUITE_SLOT as usize];
    let cost = start - env.balance(&wsol);
    assert_eq!(
        pda::associated_token(&authority.pubkey(), &quote, &TOKEN),
        wsol
    );

    let expected = closed_form(tax as f64, buy_tax, sell_tax);
    let tolerance = TOLERANCE_PER_TRIP * trips as f64;
    println!(
        "{trips} round trips booked {tax} of tax for a goal of {goal}, {suite} of it the suite's; \
         cost {cost} lamports = {:.4}% of the goal, the closed form {expected:.0} = {:.4}%",
        100.0 * cost as f64 / goal as f64,
        100.0 * expected / goal as f64,
    );
    assert!(
        (cost as f64 - expected).abs() <= tolerance,
        "cost {cost}, the closed form {expected:.0}, beyond {tolerance} lamports of rounding"
    );
    // The spec's figure for a sole recipient at 10% and 10%, to its two decimals.
    assert_eq!(format!("{:.2}", 100.0 * cost as f64 / goal as f64), "12.38");
    let spec = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../docs/spec/containment-hook.md"),
    )
    .unwrap();
    assert!(
        spec.contains("| 10% and 10% | 12.38% |"),
        "the spec's table no longer gives 12.38% for a sole recipient at 10% and 10%"
    );
}
