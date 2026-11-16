//! Only router swaps bring the unlock goal closer (docs/spec/containment-hook.md, "Unlock
//! goal"; ADR 0006): on a contained token's home market, tokens sent to its vaults or its fee
//! accounts, every custom action of the tax AMM (`seed`, `distribute` and its `burn`,
//! `set_taxes`, `set_recipients`, `renounce_tax_authority`) and its read-only calls leave
//! `tax_collected` where it is, so the unlock stays refused one unit short of the goal until
//! the next swap.

mod support;

use solana_keypair::Keypair;
use solana_signer::Signer;
use support::common::authority::each_action;
use support::*;
use tax_amm::state::OWED_SLOTS;

/// A token launched with `goal`, whose tax authority is a wallet the test holds, after one
/// buy of 1 SOL.
fn launch_and_buy(goal: u64) -> (Env, Launched, Keypair, Keypair) {
    let mut env = hook_env();
    let authority = Keypair::new();
    env.svm.airdrop(&authority.pubkey(), SOL).unwrap();
    let launched = launch_with(
        &mut env,
        LaunchOptions {
            unlock_goal: goal,
            tax_authority: Some(authority.pubkey()),
            ..LaunchOptions::default()
        },
    );
    let trader = trader(&mut env, &launched, 10 * SOL);
    buy(&mut env, &launched, &trader, SOL);
    (env, launched, authority, trader)
}

fn tax_collected(env: &Env, launched: &Launched) -> u128 {
    env.tax_market(&launched.market.market_state).tax_collected
}

#[test]
fn only_router_swaps_bring_the_goal_closer() {
    // What one buy collects, so the real launch can set its goal one unit beyond it.
    let (env, launched, _, _) = launch_and_buy(GOAL);
    let one_buy = tax_collected(&env, &launched) as u64;
    assert!(one_buy > 0);

    let (mut env, launched, authority, trader) = launch_and_buy(one_buy + 1);
    let market = &launched.market;
    assert_eq!(tax_collected(&env, &launched), one_buy as u128);
    let unchanged = |env: &Env, what: &str| {
        assert_eq!(
            tax_collected(env, &launched),
            one_buy as u128,
            "{what} changed tax_collected"
        );
    };

    // Tokens sent to the vaults and the fee accounts, the contained token through the hook.
    let fee_accounts = [
        fee_account(market, &launched.mint),
        pipeline_client::pda::fee_account(&market.market, &launched.quote, &TOKEN),
    ];
    for side in [CONTAINED, QUOTE] {
        for to in [market.vaults[side], fee_accounts[side]] {
            let before = env.balance(&to);
            env.transfer(market, &trader, side, to, 1_000).unwrap();
            assert_eq!(env.balance(&to), before + 1_000);
            unchanged(&env, "a transfer into a vault or a fee account");
        }
    }

    // The read-only calls.
    env.quote(market, &exact_in(QUOTE, CONTAINED, SOL)).unwrap();
    env.resolve_accounts(market, &exact_in(CONTAINED, QUOTE, SOL))
        .unwrap();
    env.market_info_meta(&market.market_state).unwrap();
    unchanged(&env, "a read-only call");

    // `seed` a second time, refused.
    let seeder = Keypair::new();
    env.seed_with(market, &seeder, [1, 1], hook_tail(&launched.mint))
        .unwrap_err();
    env.seed_with(market, &launched.seeder, [1, 1], hook_tail(&launched.mint))
        .unwrap_err();
    unchanged(&env, "seed");

    // `distribute` every slot, the burn included, by a wallet with no tie to the market.
    let caller = stranger(&mut env);
    let owed_before = env.tax_market(&market.market_state).owed;
    assert!(owed_before.iter().any(|owed| *owed > 0));
    for slot in 0..OWED_SLOTS as u8 {
        // A slot with nothing owed or no wallet is refused; either way the counter stays.
        let _ = env.distribute(market, &caller, slot);
    }
    let owed_after = env.tax_market(&market.market_state).owed;
    assert_ne!(owed_after, owed_before, "distribute paid something out");
    unchanged(&env, "distribute");

    // The tax authority's three actions.
    let state = env.tax_market(&market.market_state);
    for (name, instruction) in each_action(&market.market_state, &authority.pubkey(), &state) {
        env.send_signed(instruction, &authority)
            .unwrap_or_else(|e| panic!("{name}: {e}"));
        unchanged(&env, name);
    }
    assert!(env.tax_market(&market.market_state).tax_authority_renounced);

    // Still one unit short: the unlock is refused.
    assert_hook_refused(
        unlock(&mut env, &launched),
        containment_hook::HookError::UnlockNotDue,
    );

    // `set_taxes` moved the sell tax to the bottom of its range, 0%, so a sell now collects
    // nothing and brings the goal no closer (docs/spec/containment-hook.md, "Unlock goal").
    let held = contained_account(&launched, &trader.pubkey());
    let amount = env.balance(&held) / 4;
    sell(&mut env, &launched, &trader, amount);
    unchanged(&env, "a sell at a 0% tax");
    assert_hook_refused(
        unlock(&mut env, &launched),
        containment_hook::HookError::UnlockNotDue,
    );

    // A buy, taxed at the top of its range, collects tax, and the unlock goes through.
    buy(&mut env, &launched, &trader, SOL);
    assert!(tax_collected(&env, &launched) > one_buy as u128);
    unlock(&mut env, &launched).unwrap();
    assert_eq!(mint_hook(&env, &launched.mint).unwrap().program, None);
}
