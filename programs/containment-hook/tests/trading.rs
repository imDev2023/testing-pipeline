//! A contained token trading in its tax AMM home market through the real router, with the
//! hook tail every caller passes (docs/spec/containment-hook.md, "What this allows", "Hook
//! accounts callers must pass"): the tax AMM's `seed` (in [`launch`]), buys, sells, the
//! Pipeline fee on a sell paid into the fee account, `sweep_fees` to Pipeline's treasury and
//! the tax AMM's `distribute`. A buy may deliver the token to any account, which can then
//! only sell it back into the home market, and a sell with an integrator fee above zero is
//! refused.

mod support;

use containment_hook::HookError;
use pipeline_client::Pubkey;
use solana_signer::Signer;
use support::*;

/// What a buy spends, in the quote mint.
const BUY: u64 = 1_000_000_000;

#[test]
fn the_seed_moves_the_supply_into_the_home_vault_through_the_hook() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let state = env.tax_market(&launched.market.market_state);
    assert_eq!(state.reserves, SEED);
    assert_eq!(env.balance(&launched.holder), SUPPLY - SEED[CONTAINED]);
}

#[test]
fn a_buy_takes_the_token_out_of_the_home_vault() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let trader = trader(&mut env, &launched, 10 * BUY);
    let quote = env
        .quote(&launched.market, &exact_in(QUOTE, CONTAINED, BUY))
        .unwrap();
    let meta = swap(
        &mut env,
        &launched,
        &trader,
        (QUOTE, CONTAINED),
        BUY,
        &Swap::default(),
    )
    .unwrap();
    // Once, inside the tax AMM's transfer out of the vault: router, tax AMM, Token-2022,
    // hook.
    assert_eq!(hook_depths(&meta.logs), vec![4]);
    let received = env.balance(&contained_account(&launched, &trader.pubkey()));
    assert!(received > 0);
    assert_eq!(received, quote.amount_out);
}

#[test]
fn a_sell_pays_the_token_into_the_home_vault_and_pipelines_fee_into_the_fee_account() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let trader = trader(&mut env, &launched, 10 * BUY);
    let bought = buy(&mut env, &launched, &trader, BUY).received;
    let fees = fee_account(&launched.market, &launched.mint);
    let vault = launched.market.vaults[CONTAINED];
    let (fees_before, vault_before) = (env.balance(&fees), env.balance(&vault));
    let quote_before = env.balance(&pipeline_client::pda::associated_token(
        &trader.pubkey(),
        &launched.quote,
        &TOKEN,
    ));
    // The router takes Pipeline's fee on top of what goes into the vault, so sell half.
    let sold = bought / 2;
    let meta = swap(
        &mut env,
        &launched,
        &trader,
        (CONTAINED, QUOTE),
        sold,
        &Swap::default(),
    )
    .unwrap();
    // The trader's input into the vault, then Pipeline's fee into the fee account, each in
    // a transfer the router makes.
    assert_eq!(hook_depths(&meta.logs), vec![3, 3]);
    let result: pipeline_client::SwapResult = borsh::from_slice(&meta.return_data.data).unwrap();
    assert!(result.pipeline_fee > 0);
    assert_eq!(env.balance(&fees), fees_before + result.pipeline_fee);
    assert_eq!(result.net_sent, sold);
    assert_eq!(env.balance(&vault), vault_before + sold);
    assert_eq!(
        env.balance(&contained_account(&launched, &trader.pubkey())),
        bought - sold - result.pipeline_fee
    );
    let quote_after = env.balance(&pipeline_client::pda::associated_token(
        &trader.pubkey(),
        &launched.quote,
        &TOKEN,
    ));
    assert_eq!(quote_after, quote_before + result.received);
}

#[test]
fn sweep_fees_moves_the_fee_account_to_pipelines_treasury() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let trader = trader(&mut env, &launched, 10 * BUY);
    let bought = buy(&mut env, &launched, &trader, BUY).received;
    sell(&mut env, &launched, &trader, bought / 2);
    let fees = fee_account(&launched.market, &launched.mint);
    let swept = env.balance(&fees);
    assert!(swept > 0);
    let owner = treasury_owner(&env);
    let treasury = token_2022_account(&mut env, &owner, &launched.mint);

    // Without the tail, Token-2022 cannot call the hook and refuses.
    let bare = sweep_fees_instruction(&launched, &owner, vec![]);
    assert!(env.send(&[bare], &[]).is_err());

    let sweep = sweep_fees_instruction(&launched, &owner, hook_tail(&launched.mint));
    let meta = env.send_meta(&[sweep], &[]).unwrap();
    assert_eq!(hook_depths(&meta.logs), vec![3]);
    assert_eq!(env.balance(&fees), 0);
    assert_eq!(env.balance(&treasury), swept);
}

#[test]
fn distribute_pays_the_tax_out_of_a_home_market() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let trader = trader(&mut env, &launched, 10 * BUY);
    let bought = buy(&mut env, &launched, &trader, BUY).received;
    sell(&mut env, &launched, &trader, bought / 2);
    let vault = launched.market.vaults[CONTAINED];
    let vault_before = env.balance(&vault);
    let state = env.tax_market(&launched.market.market_state);
    assert!(state.tax_collected > 0);
    let caller = solana_keypair::Keypair::new();
    env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
    let wallet = slot_wallet(&state, 0);
    let paid_to = pipeline_client::pda::associated_token(&wallet, &launched.quote, &TOKEN);
    let owed = state.owed[0];
    assert!(owed > 0);
    env.distribute(&launched.market, &caller, 0).unwrap();
    // The tax is on the quote mint, so the payout never moves the contained token.
    assert_eq!(env.balance(&paid_to), owed);
    assert_eq!(env.balance(&vault), vault_before);
    assert_eq!(env.tax_market(&launched.market.market_state).owed[0], 0);
}

#[test]
fn a_buy_may_deliver_to_any_account_which_can_then_only_sell_back_into_the_home_market() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let trader = trader(&mut env, &launched, 10 * BUY);
    let friend = trader_wallet_without_quote(&mut env, &launched);
    let friend_account = contained_account(&launched, &friend.pubkey());
    let gift = Swap {
        output_to: Some(friend_account),
        ..Swap::default()
    };
    swap(&mut env, &launched, &trader, (QUOTE, CONTAINED), BUY, &gift).unwrap();
    let received = env.balance(&friend_account);
    assert!(received > 0);

    // The account cannot pass it on to another wallet...
    let elsewhere = token_2022_account(&mut env, &Pubkey::new_unique(), &launched.mint);
    let transfer = transfer_checked(
        &launched.mint,
        &friend_account,
        &elsewhere,
        &friend.pubkey(),
        received,
        hook_tail(&launched.mint),
    );
    assert_hook_refused(
        env.send(&[transfer], &[&friend]),
        HookError::TransferRefused,
    );

    // ...but it can sell it back into the home market.
    env.write_token_account(&launched.quote, &TOKEN, &friend.pubkey(), 0);
    let sold = sell(&mut env, &launched, &friend, received / 2);
    assert!(sold.received > 0);
    assert_eq!(
        env.balance(&friend_account),
        received - received / 2 - sold.pipeline_fee
    );
}

/// A wallet with SOL and an empty contained-token account, and no quote-mint account.
fn trader_wallet_without_quote(env: &mut Env, launched: &Launched) -> solana_keypair::Keypair {
    let wallet = solana_keypair::Keypair::new();
    env.svm.airdrop(&wallet.pubkey(), SOL).unwrap();
    token_2022_account(env, &wallet.pubkey(), &launched.mint);
    wallet
}

#[test]
fn a_sell_with_an_integrator_fee_above_zero_is_refused_and_a_buy_with_one_passes() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let trader = trader(&mut env, &launched, 10 * BUY);
    let bought = buy(&mut env, &launched, &trader, BUY).received;
    let integrator = Pubkey::new_unique();
    let integrator_token = token_2022_account(&mut env, &integrator, &launched.mint);
    let sell_with_fee = Swap {
        integrator: Some(integrator_token),
        integrator_fee_bps: 50,
        ..Swap::default()
    };
    assert_hook_refused(
        swap(
            &mut env,
            &launched,
            &trader,
            (CONTAINED, QUOTE),
            bought / 2,
            &sell_with_fee,
        ),
        HookError::TransferRefused,
    );
    assert_eq!(env.balance(&integrator_token), 0);
    assert_eq!(
        env.balance(&contained_account(&launched, &trader.pubkey())),
        bought
    );

    // At zero the router makes no integrator transfer, so the sell passes.
    let sell_without_fee = Swap {
        integrator: Some(integrator_token),
        integrator_fee_bps: 0,
        ..Swap::default()
    };
    swap(
        &mut env,
        &launched,
        &trader,
        (CONTAINED, QUOTE),
        bought / 2,
        &sell_without_fee,
    )
    .unwrap();

    // A buy pays its integrator fee in the quote mint, which the hook never sees.
    let integrator_quote = env.write_token_account(&launched.quote, &TOKEN, &integrator, 0);
    let buy_with_fee = Swap {
        integrator: Some(integrator_quote),
        integrator_fee_bps: 50,
        ..Swap::default()
    };
    swap(
        &mut env,
        &launched,
        &trader,
        (QUOTE, CONTAINED),
        BUY,
        &buy_with_fee,
    )
    .unwrap();
    assert!(env.balance(&integrator_quote) > 0);
}

#[test]
fn a_swap_that_leaves_the_tail_out_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let trader = trader(&mut env, &launched, 10 * BUY);
    let bare = Swap {
        without_tail: true,
        ..Swap::default()
    };
    assert!(swap(&mut env, &launched, &trader, (QUOTE, CONTAINED), BUY, &bare).is_err());
    let bought = buy(&mut env, &launched, &trader, BUY).received;
    assert!(swap(
        &mut env,
        &launched,
        &trader,
        (CONTAINED, QUOTE),
        bought / 2,
        &bare
    )
    .is_err());
    assert_eq!(
        env.balance(&contained_account(&launched, &trader.pubkey())),
        bought
    );
}
