//! `unlock` through the real router and the tax AMM (docs/spec/containment-hook.md,
//! "Unlock"): anyone may unlock a contained token once its home market has collected the
//! unlock goal in tax, or once its unlock deadline has passed, and not before; the unlock
//! clears the mint's transfer hook program and hook authority, records its time in the
//! config once, and a second unlock is refused.

mod support;

use containment_hook::HookError;
use solana_signer::Signer;
use support::*;

/// Fails unless the mint's transfer hook extension is still there with both of its fields
/// unset, as graduated Meteora DBC mints carry it.
fn assert_hook_cleared(env: &Env, mint: &pipeline_client::Pubkey) {
    let hook = mint_hook(env, mint).expect("the mint keeps its transfer hook extension");
    assert_eq!(hook.program, None, "the hook program is unset");
    assert_eq!(hook.authority, None, "the hook authority is unset");
}

#[test]
fn the_deadline_unlocks_at_its_exact_second() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let deadline = config(&env, &launched.mint).unlock_deadline;

    warp_to(&mut env, deadline - 1);
    assert_hook_refused(unlock(&mut env, &launched), HookError::UnlockNotDue);

    warp_to(&mut env, deadline);
    unlock(&mut env, &launched).unwrap();
    assert_hook_cleared(&env, &launched.mint);
    assert_eq!(config(&env, &launched.mint).unlocked_at, Some(deadline));
}

/// Launches a contained token with `goal`, then buys with 1 SOL of the quote mint and sells
/// half of what was bought through the router: the tax those two swaps collect is the same
/// on every launch, since it depends only on the seed and the amounts.
fn launch_and_trade(goal: u64) -> (Env, Launched) {
    let mut env = hook_env();
    let launched = launch_with(
        &mut env,
        LaunchOptions {
            unlock_goal: goal,
            ..LaunchOptions::default()
        },
    );
    let trader = trader(&mut env, &launched, 10 * SOL);
    let bought = buy(&mut env, &launched, &trader, SOL);
    sell(&mut env, &launched, &trader, bought.received / 2);
    (env, launched)
}

fn tax_collected(env: &Env, launched: &Launched) -> u128 {
    env.tax_market(&launched.market.market_state).tax_collected
}

#[test]
fn the_goal_unlocks_at_its_exact_unit() {
    // What the two swaps collect, measured on a launch whose goal they cannot reach.
    let (env, launched) = launch_and_trade(GOAL);
    let collected = tax_collected(&env, &launched);
    assert!(collected > 0 && collected < GOAL as u128);
    let collected = collected as u64;

    // One unit short: the same swaps on a launch whose goal is one unit more.
    let (mut env, launched) = launch_and_trade(collected + 1);
    assert_eq!(tax_collected(&env, &launched), collected as u128);
    assert!(now(&env) < config(&env, &launched.mint).unlock_deadline);
    assert_hook_refused(unlock(&mut env, &launched), HookError::UnlockNotDue);
    assert_eq!(
        mint_hook(&env, &launched.mint).unwrap().program,
        Some(hook_id().to_bytes())
    );

    // At the goal.
    let (mut env, launched) = launch_and_trade(collected);
    assert_eq!(tax_collected(&env, &launched), collected as u128);
    let meta = unlock(&mut env, &launched).unwrap();
    assert!(
        meta.logs
            .iter()
            .any(|line| line.contains(&format!("Unlocked by the goal: {collected} of {collected}"))),
        "{:?}",
        meta.logs
    );
    assert_hook_cleared(&env, &launched.mint);
    assert_eq!(config(&env, &launched.mint).unlocked_at, Some(now(&env)));
}

#[test]
fn before_either_the_unlock_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let before = env.svm.get_account(&launched.mint).unwrap();
    // Just launched: nothing collected, and the deadline 30 days away.
    assert_eq!(tax_collected(&env, &launched), 0);
    assert_hook_refused(unlock(&mut env, &launched), HookError::UnlockNotDue);
    // After trades that collect less than the goal, a day before the deadline.
    let trader = trader(&mut env, &launched, 10 * SOL);
    let bought = buy(&mut env, &launched, &trader, SOL);
    sell(&mut env, &launched, &trader, bought.received / 2);
    assert!(tax_collected(&env, &launched) < GOAL as u128);
    let deadline = config(&env, &launched.mint).unlock_deadline;
    warp_to(&mut env, deadline - DAY);
    assert_hook_refused(unlock(&mut env, &launched), HookError::UnlockNotDue);
    assert_eq!(env.svm.get_account(&launched.mint).unwrap(), before);
    assert_eq!(config(&env, &launched.mint).unlocked_at, None);
}

#[test]
fn a_wallet_with_no_tie_to_the_token_unlocks_it() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let deadline = config(&env, &launched.mint).unlock_deadline;
    warp_to(&mut env, deadline);
    let caller = stranger(&mut env);
    let caller_key = caller.pubkey();
    let config_before = config(&env, &launched.mint);
    let state = env.tax_market(&launched.market.market_state);
    // The caller is not the launcher and mint authority (the admin, who also created the
    // market), the seeder, the tax authority or any recipient, and holds no account of the
    // token.
    for tied in [
        env.admin.pubkey(),
        launched.seeder.pubkey(),
        ck(&state.tax_authority),
        ck(&state.seeder),
    ]
    .into_iter()
    .chain(state.recipients.iter().map(ck))
    {
        assert_ne!(caller_key, tied);
    }
    assert!(env
        .svm
        .get_account(&contained_account(&launched, &caller_key))
        .is_none());
    let balance = env.svm.get_balance(&caller_key).unwrap();
    let meta = send_as(
        &mut env,
        &caller,
        &[unlock_instruction(
            &launched.mint,
            &launched.market.market_state,
        )],
    )
    .unwrap();
    assert_hook_cleared(&env, &launched.mint);
    assert_eq!(config(&env, &launched.mint).mint, config_before.mint);
    // The caller paid the transaction fee and nothing else.
    assert_eq!(
        balance - env.svm.get_balance(&caller_key).unwrap(),
        meta.fee
    );
}

#[test]
fn a_second_unlock_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let deadline = config(&env, &launched.mint).unlock_deadline;
    warp_to(&mut env, deadline);
    unlock(&mut env, &launched).unwrap();
    let mint_after = env.svm.get_account(&launched.mint).unwrap();
    warp_to(&mut env, deadline + DAY);
    assert_hook_refused(unlock(&mut env, &launched), HookError::AlreadyUnlocked);
    assert_eq!(env.svm.get_account(&launched.mint).unwrap(), mint_after);
    assert_eq!(config(&env, &launched.mint).unlocked_at, Some(deadline));
}

#[test]
fn the_unlock_records_its_time_once_and_changes_nothing_else_in_the_config() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let config_address = config_pda(&launched.mint);
    let before = env.svm.get_account(&config_address).unwrap();
    let bound = config(&env, &launched.mint);
    assert_eq!(bound.unlocked_at, None);

    let at = bound.unlock_deadline + 17;
    warp_to(&mut env, at);
    unlock(&mut env, &launched).unwrap();
    let after = env.svm.get_account(&config_address).unwrap();
    let unlocked = config(&env, &launched.mint);
    assert_eq!(
        unlocked,
        containment_hook::Config {
            unlocked_at: Some(at),
            ..bound
        }
    );
    // The account itself: same owner, size and rent, and only the bytes of `unlocked_at`
    // changed, which sit at its end.
    assert_eq!(after.owner, before.owner);
    assert_eq!(after.lamports, before.lamports);
    assert_eq!(after.data.len(), before.data.len());
    let tail = 1 + 8;
    let end = before.data.len() - tail;
    assert_eq!(after.data[..end], before.data[..end]);

    // A later attempt leaves it as it is.
    warp_to(&mut env, at + DAY);
    unlock(&mut env, &launched).unwrap_err();
    assert_eq!(env.svm.get_account(&config_address).unwrap(), after);
}

/// A launch whose goal is 1 unit: a single taxed swap in any market would reach it, but its
/// own home market has collected nothing.
fn launch_with_goal_of_one(env: &mut Env) -> Launched {
    launch_with(
        env,
        LaunchOptions {
            unlock_goal: 1,
            ..LaunchOptions::default()
        },
    )
}

#[test]
fn a_market_state_other_than_the_one_recorded_is_refused() {
    let mut env = hook_env();
    let launched = launch_with_goal_of_one(&mut env);
    // Another contained token's home market, a real tax AMM market state that has
    // collected tax.
    let other = launch(&mut env);
    let trader = trader(&mut env, &other, 10 * SOL);
    buy(&mut env, &other, &trader, SOL);
    assert!(tax_collected(&env, &other) > 1);
    let caller = stranger(&mut env);
    let with_other = unlock_instruction(&launched.mint, &other.market.market_state);
    assert_hook_refused(
        send_as(&mut env, &caller, &[with_other]),
        HookError::WrongMarketState,
    );

    // A copy of the real market state, owned by the tax AMM, that claims the goal.
    let copy = copy_account(&mut env, &launched.market.market_state, &strategy_id());
    edit_account(&mut env, &copy, |account| {
        let at = tax_amm::state::layout::TAX_COLLECTED;
        account.data[at..at + 16].copy_from_slice(&u128::MAX.to_le_bytes());
    });
    assert_hook_refused(
        send_as(
            &mut env,
            &caller,
            &[unlock_instruction(&launched.mint, &copy)],
        ),
        HookError::WrongMarketState,
    );

    assert_eq!(
        mint_hook(&env, &launched.mint).unwrap().program,
        Some(hook_id().to_bytes())
    );
    assert_eq!(config(&env, &launched.mint).unlocked_at, None);
}

#[test]
fn a_market_state_the_tax_amm_does_not_own_is_refused() {
    let mut env = hook_env();
    let launched = launch_with_goal_of_one(&mut env);
    let state = launched.market.market_state;
    let at = tax_amm::state::layout::TAX_COLLECTED;
    let real = env.svm.get_account(&state).unwrap();
    // The recorded address, holding a market state that claims the goal, owned by another
    // program: the hook, the system program and the router in turn.
    for owner in [
        hook_id(),
        pipeline_client::SYSTEM_PROGRAM_ID,
        pipeline_client::PROGRAM_ID,
    ] {
        edit_account(&mut env, &state, |account| {
            account.owner = owner;
            account.data[at..at + 16].copy_from_slice(&u128::MAX.to_le_bytes());
        });
        assert_hook_refused(unlock(&mut env, &launched), HookError::NotATaxMarketState);
    }
    // Owned by the tax AMM, but not a whole market state.
    env.svm.set_account(state, real.clone()).unwrap();
    edit_account(&mut env, &state, |account| account.data[0] ^= 1);
    assert_hook_refused(unlock(&mut env, &launched), HookError::NotATaxMarketState);

    env.svm.set_account(state, real).unwrap();
    assert_hook_refused(unlock(&mut env, &launched), HookError::UnlockNotDue);
    assert_eq!(config(&env, &launched.mint).unlocked_at, None);
}

#[test]
fn another_mints_config_or_unlock_pda_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let other = launch(&mut env);
    let latest = [launched.mint, other.mint]
        .map(|mint| config(&env, &mint).unlock_deadline)
        .into_iter()
        .max()
        .unwrap();
    warp_to(&mut env, latest);
    let caller = stranger(&mut env);
    for (account, replacement) in [(1, config_pda(&other.mint)), (2, unlock_pda(&other.mint))] {
        let mut instruction = unlock_instruction(&launched.mint, &launched.market.market_state);
        instruction.accounts[account].pubkey = replacement;
        let refused = send_as(&mut env, &caller, &[instruction]).unwrap_err();
        assert!(refused.contains("ConstraintSeeds"), "{refused}");
    }
    // The other mint with its own config, and this mint's market state.
    let instruction = unlock_instruction(&other.mint, &launched.market.market_state);
    assert_hook_refused(
        send_as(&mut env, &caller, &[instruction]),
        HookError::WrongMarketState,
    );
    for mint in [launched.mint, other.mint] {
        assert_eq!(config(&env, &mint).unlocked_at, None);
    }
}
