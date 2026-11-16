//! After the unlock (docs/spec/containment-hook.md, "After the unlock"): Token-2022 no longer
//! calls the hook, so the token is an ordinary Token-2022 token. Wallets transfer it to each
//! other, swaps in its home market work with stale hook accounts and with none, a second
//! market can be funded with it, and `bind` cannot be called again.

mod support;

use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use support::*;

const AMOUNT: u64 = 1_000_000;

/// A launched token that traded, then unlocked by its deadline.
fn unlocked(env: &mut Env) -> Launched {
    let launched = launch(env);
    let trader = trader(env, &launched, 10 * SOL);
    let bought = buy(env, &launched, &trader, SOL);
    sell(env, &launched, &trader, bought.received / 2);
    let deadline = config(env, &launched.mint).unlock_deadline;
    warp_to(env, deadline);
    unlock(env, &launched).unwrap();
    launched
}

/// Fails unless the transaction ran without the hook.
fn assert_hook_not_called(logs: &[String]) {
    assert_eq!(hook_depths(logs), Vec::<u32>::new(), "{logs:?}");
}

#[test]
fn wallets_transfer_it_to_each_other_with_stale_hook_accounts_and_without() {
    let mut env = hook_env();
    let launched = unlocked(&mut env);
    let owner = launched.seeder.pubkey();
    let other_wallet = Keypair::new();
    let other = token_2022_account(&mut env, &other_wallet.pubkey(), &launched.mint);
    let own = second_token_account(&mut env, &owner, &launched.mint);
    for (to, tail) in [
        (other, hook_tail(&launched.mint)),
        (other, vec![]),
        (own, vec![]),
    ] {
        let before = env.balance(&to);
        let transfer =
            transfer_checked(&launched.mint, &launched.holder, &to, &owner, AMOUNT, tail);
        let meta = env.send_meta(&[transfer], &[&launched.seeder]).unwrap();
        assert_hook_not_called(&meta.logs);
        assert_eq!(env.balance(&to), before + AMOUNT);
    }
    // And onwards from the wallet that received it.
    env.svm.airdrop(&other_wallet.pubkey(), SOL).unwrap();
    let back = transfer_checked(
        &launched.mint,
        &other,
        &launched.holder,
        &other_wallet.pubkey(),
        AMOUNT,
        vec![],
    );
    env.send_meta(&[back], &[&other_wallet]).unwrap();
    assert_eq!(env.balance(&other), AMOUNT);
}

#[test]
fn swaps_work_with_stale_hook_accounts_and_with_none() {
    let mut env = hook_env();
    let launched = unlocked(&mut env);
    let trader = trader(&mut env, &launched, 10 * SOL);
    let holding = contained_account(&launched, &trader.pubkey());
    for without_tail in [false, true] {
        let options = Swap {
            without_tail,
            ..Swap::default()
        };
        let before = env.balance(&holding);
        let meta = swap(
            &mut env,
            &launched,
            &trader,
            (QUOTE, CONTAINED),
            SOL,
            &options,
        )
        .unwrap();
        assert_hook_not_called(&meta.logs);
        let bought = env.balance(&holding) - before;
        assert!(bought > 0);
        let meta = swap(
            &mut env,
            &launched,
            &trader,
            (CONTAINED, QUOTE),
            bought / 2,
            &options,
        )
        .unwrap();
        assert_hook_not_called(&meta.logs);
    }
    // A sell with an integrator fee in the token, which the hook refused while contained.
    let integrator = token_2022_account(&mut env, &Pubkey::new_unique(), &launched.mint);
    let options = Swap {
        integrator: Some(integrator),
        integrator_fee_bps: 50,
        without_tail: true,
        ..Swap::default()
    };
    let amount = env.balance(&holding) / 2;
    swap(
        &mut env,
        &launched,
        &trader,
        (CONTAINED, QUOTE),
        amount,
        &options,
    )
    .unwrap();
    assert!(env.balance(&integrator) > 0);
}

#[test]
fn a_second_market_can_be_funded() {
    let mut env = hook_env();
    let launched = unlocked(&mut env);
    let quote = env.create_mint(&TOKEN);
    let seeder = &launched.seeder;
    let params = quote_taxed_params(&seeder.pubkey(), QUOTE as u8);
    let second = env
        .create_tax_market([(launched.mint, TOKEN_2022), (quote, TOKEN)], &params)
        .unwrap();
    env.write_token_account(&quote, &TOKEN, &seeder.pubkey(), SEED[QUOTE]);
    let seed = [SEED[CONTAINED] / 10, SEED[QUOTE]];
    env.seed_with(&second, seeder, seed, vec![]).unwrap();
    assert_eq!(env.balance(&second.vaults[CONTAINED]), seed[CONTAINED]);
    // And it trades both ways.
    let wallet = env.funded_wallet(&second, 0);
    env.write_token_account(&quote, &TOKEN, &wallet.pubkey(), 10 * SOL);
    let held =
        pipeline_client::pda::associated_token(&wallet.pubkey(), &launched.mint, &TOKEN_2022);
    let before = env.balance_or_zero(&held);
    env.swap(&second, &wallet, (QUOTE, CONTAINED), SOL).unwrap();
    let bought = env.balance(&held) - before;
    assert!(bought > 0);
    env.swap(&second, &wallet, (CONTAINED, QUOTE), bought / 2)
        .unwrap();
}

#[test]
fn bind_cannot_be_called_again() {
    let mut env = hook_env();
    let launched = unlocked(&mut env);
    let bound = env.svm.get_account(&config_pda(&launched.mint)).unwrap();
    let second = home_market(&mut env, launched.mint, CONTAINED);
    let args = BindArgs::new(&env, launched.mint, &second);
    let refused = send_bind(&mut env, &args, &[]).unwrap_err();
    assert!(refused.contains("already in use"), "{refused}");
    assert_eq!(
        env.svm.get_account(&config_pda(&launched.mint)).unwrap(),
        bound
    );
}
