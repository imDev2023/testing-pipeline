//! `bind`'s checks on the home market and on the unlock terms (docs/spec/containment-hook.md,
//! "Checks on the home market" and "Binding"): a router `Market` at its PDA, on the tax AMM,
//! trading the mint, with the market state it records, owned by the tax AMM and taking its
//! tax in the quote mint; a goal above zero and a deadline later than now and at most 90
//! days away. Each refusal leaves no config behind.

mod support;

use containment_hook::config::MAX_UNLOCK_DEADLINE_SECS;
use containment_hook::HookError;
use pipeline_client::{self as client, Pubkey};
use support::*;

fn assert_unbound<T: std::fmt::Debug>(
    env: &Env,
    mint: &Pubkey,
    result: Result<T, String>,
    error: HookError,
) {
    assert_hook_refused(result, error);
    assert!(env.svm.get_account(&config_pda(mint)).is_none());
}

/// Binds `mint` with `args` changed by `change`.
fn bind_with(
    env: &mut Env,
    mint: Pubkey,
    market: &Market,
    change: impl FnOnce(&mut BindArgs),
) -> Result<(), String> {
    let mut args = BindArgs::new(env, mint, market);
    change(&mut args);
    send_bind(env, &args, &[]).map(|_| ())
}

#[test]
fn a_market_the_router_does_not_own_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    // The real Market's bytes, owned by another program.
    let fake = copy_account(&mut env, &market.market, &Pubkey::new_unique());
    let result = bind_with(&mut env, mint, &market, |args| args.market = fake);
    assert_unbound(&env, &mint, result, HookError::NotARouterMarket);
    // The tax AMM's market state passed as the market.
    let state = market.market_state;
    let result = bind_with(&mut env, mint, &market, |args| args.market = state);
    assert_unbound(&env, &mint, result, HookError::NotARouterMarket);
}

#[test]
fn a_router_account_that_is_not_a_market_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let router_config = client::pda::config();
    let result = bind_with(&mut env, mint, &market, |args| args.market = router_config);
    assert_unbound(&env, &mint, result, HookError::NotARouterMarket);
}

#[test]
fn a_market_that_is_not_at_its_pda_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    // The real Market's bytes, owned by the router, at an address that is not its PDA.
    let copy = copy_account(&mut env, &market.market, &client::PROGRAM_ID);
    let result = bind_with(&mut env, mint, &market, |args| args.market = copy);
    assert_unbound(&env, &mint, result, HookError::MarketNotAtItsAddress);
}

#[test]
fn a_market_on_another_strategy_is_refused() {
    let mut env = hook_env();
    let mint = contained_mint(&mut env);
    let quote = env.create_mint(&TOKEN);
    let market = cp_market(&mut env, [(mint, TOKEN_2022), (quote, TOKEN)]);
    assert_eq!(
        env.router_market(&market.market).strategy_program,
        cp_strategy_id()
    );
    let result = bind(&mut env, mint, &market);
    assert_unbound(&env, &mint, result, HookError::NotATaxMarket);
}

#[test]
fn a_market_that_does_not_hold_the_mint_is_refused() {
    let mut env = hook_env();
    let mint = contained_mint(&mut env);
    let other = contained_mint(&mut env);
    let market = home_market(&mut env, other, 0);
    let result = bind(&mut env, mint, &market);
    assert_unbound(&env, &mint, result, HookError::MarketDoesNotHoldMint);
}

#[test]
fn a_market_state_the_market_does_not_record_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    // A real tax AMM market state of another home market of the same mint.
    let other = home_market(&mut env, mint, 0);
    let result = bind_with(&mut env, mint, &market, |args| {
        args.market_state = other.market_state
    });
    assert_unbound(&env, &mint, result, HookError::WrongMarketState);
}

#[test]
fn a_market_state_the_tax_amm_does_not_own_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    // The recorded market state, its bytes unchanged, under another owner.
    let owner = Pubkey::new_unique();
    edit_account(&mut env, &market.market_state, |account| {
        account.owner = owner
    });
    let result = bind(&mut env, mint, &market);
    assert_unbound(&env, &mint, result, HookError::NotATaxMarketState);
}

#[test]
fn a_tax_side_on_the_contained_token_is_refused() {
    for contained_index in [0usize, 1] {
        let mut env = hook_env();
        let mint = contained_mint(&mut env);
        let quote = (env.create_mint(&TOKEN), TOKEN);
        let mut mints = [quote, quote];
        mints[contained_index] = (mint, TOKEN_2022);
        let params = quote_taxed_params(&Pubkey::new_unique(), contained_index as u8);
        let market = env.create_tax_market(mints, &params).unwrap();
        let result = bind(&mut env, mint, &market);
        assert_unbound(&env, &mint, result, HookError::TaxSideNotQuote);
    }
}

#[test]
fn a_zero_goal_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let result = bind_with(&mut env, mint, &market, |args| args.unlock_goal = 0);
    assert_unbound(&env, &mint, result, HookError::ZeroGoal);
}

#[test]
fn a_deadline_in_the_past_or_now_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let now = now(&env);
    for deadline in [now - DAY, now - 1, now, 0, i64::MIN] {
        let result = bind_with(&mut env, mint, &market, |args| {
            args.unlock_deadline = deadline
        });
        assert_unbound(&env, &mint, result, HookError::DeadlineNotInFuture);
    }
}

#[test]
fn a_deadline_more_than_90_days_away_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let now = now(&env);
    for deadline in [now + MAX_UNLOCK_DEADLINE_SECS + 1, now + 91 * DAY, i64::MAX] {
        let result = bind_with(&mut env, mint, &market, |args| {
            args.unlock_deadline = deadline
        });
        assert_unbound(&env, &mint, result, HookError::DeadlineTooFar);
    }
}
