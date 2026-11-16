//! Plain transfers of a contained mint through the real Token-2022
//! (docs/spec/containment-hook.md, "Lifecycle", "The allow rule"): before `bind` every
//! transfer is refused; after it, a transfer passes the hook only into or out of the home
//! market's vault or its fee account, so every wallet-to-wallet transfer is refused,
//! between one holder's own accounts included, and so are `Execute` called directly and the
//! deprecated `Transfer` without a mint. Minting never calls the hook.

mod support;

use containment_hook::HookError;
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use solana_signer::Signer;
use support::*;

const AMOUNT: u64 = 1_000_000;

/// Fails unless `result` is a transfer the hook ran on and refused with `error`.
fn assert_hook_ran_and_refused<T: std::fmt::Debug>(result: Result<T, String>, error: HookError) {
    if let Err(logs) = &result {
        assert!(
            logs.contains(&format!("Program {} invoke", hook_id())),
            "the hook never ran:\n{logs}"
        );
    }
    assert_hook_refused(result, error);
}

#[test]
fn before_bind_every_transfer_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let admin = env.admin.pubkey();
    let holder = token_2022_account(&mut env, &admin, &mint);
    mint_to(&mut env, &mint, &holder, SUPPLY).unwrap();
    assert!(env.svm.get_account(&validation_pda(&mint)).is_none());
    let wallet = token_2022_account(&mut env, &Pubkey::new_unique(), &mint);
    for destination in [market.vaults[0], fee_account(&market, &mint), wallet] {
        for tail in [hook_tail(&mint), vec![]] {
            let transfer = transfer_checked(&mint, &holder, &destination, &admin, AMOUNT, tail);
            assert!(env.send(&[transfer], &[]).is_err());
        }
    }
    assert_eq!(env.balance(&holder), SUPPLY);
}

#[test]
fn a_transfer_between_two_wallets_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let owner = launched.seeder.pubkey();
    let other = token_2022_account(&mut env, &Pubkey::new_unique(), &launched.mint);
    let transfer = transfer_checked(
        &launched.mint,
        &launched.holder,
        &other,
        &owner,
        AMOUNT,
        hook_tail(&launched.mint),
    );
    assert_hook_ran_and_refused(
        env.send(&[transfer], &[&launched.seeder]),
        HookError::TransferRefused,
    );
    assert_eq!(env.balance(&other), 0);
}

#[test]
fn a_transfer_between_one_holders_own_accounts_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let owner = launched.seeder.pubkey();
    let own = second_token_account(&mut env, &owner, &launched.mint);
    mint_to(&mut env, &launched.mint, &own, AMOUNT).unwrap();
    for (from, to) in [(launched.holder, own), (own, launched.holder)] {
        let transfer = transfer_checked(
            &launched.mint,
            &from,
            &to,
            &owner,
            AMOUNT,
            hook_tail(&launched.mint),
        );
        assert_hook_ran_and_refused(
            env.send(&[transfer], &[&launched.seeder]),
            HookError::TransferRefused,
        );
    }
    assert_eq!(env.balance(&own), AMOUNT);
}

#[test]
fn a_transfer_into_the_home_vault_or_fee_account_passes_the_hook() {
    // The allow rule is symmetric: the hook does not ask who sends into the two allowed
    // accounts. Sending there is a donation the tax AMM keeps out of its price (and the
    // router sweeps to Pipeline's treasury), never a way out.
    let mut env = hook_env();
    let launched = launch(&mut env);
    let owner = launched.seeder.pubkey();
    let fees = fee_account(&launched.market, &launched.mint);
    for destination in [launched.market.vaults[CONTAINED], fees] {
        let before = env.balance(&destination);
        let transfer = transfer_checked(
            &launched.mint,
            &launched.holder,
            &destination,
            &owner,
            AMOUNT,
            hook_tail(&launched.mint),
        );
        let meta = env.send_meta(&[transfer], &[&launched.seeder]).unwrap();
        assert_eq!(hook_depths(&meta.logs), vec![2]);
        assert_eq!(env.balance(&destination), before + AMOUNT);
    }
}

#[test]
fn minting_after_the_binding_never_calls_the_hook() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let admin = env.admin.pubkey();
    let account = token_2022_account(&mut env, &admin, &launched.mint);
    mint_to(&mut env, &launched.mint, &account, AMOUNT).unwrap();
    assert_eq!(env.balance(&account), AMOUNT);
}

#[test]
fn execute_called_directly_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let mint = launched.mint;
    // Even naming the home vault as the destination, a call outside a Token-2022 transfer
    // finds the source's `transferring` flag clear.
    let call = execute_instruction(
        launched.holder,
        mint,
        launched.market.vaults[CONTAINED],
        launched.seeder.pubkey(),
        validation_pda(&mint),
        config_pda(&mint),
    );
    assert_hook_refused(env.send(&[call], &[]), HookError::NotTransferring);
}

#[test]
fn the_deprecated_transfer_without_a_mint_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let owner = launched.seeder.pubkey();
    // Token-2022's `Transfer` (tag 3), into the home vault, where `transfer_checked` passes.
    let mut data = vec![3u8];
    data.extend_from_slice(&AMOUNT.to_le_bytes());
    let mut accounts = vec![
        AccountMeta::new(launched.holder, false),
        AccountMeta::new(launched.market.vaults[CONTAINED], false),
        AccountMeta::new_readonly(owner, true),
    ];
    accounts.extend(hook_tail(&launched.mint));
    let transfer = Instruction::new_with_bytes(TOKEN_2022, &data, accounts);
    let result = env.send(&[transfer], &[&launched.seeder]);
    let logs = result.expect_err("the deprecated Transfer passed");
    assert!(
        !logs.contains(&format!("Program {} invoke", hook_id())),
        "Token-2022 refuses it before any hook runs:\n{logs}"
    );
    assert_eq!(env.balance(&launched.holder), SUPPLY - SEED[CONTAINED]);
}
