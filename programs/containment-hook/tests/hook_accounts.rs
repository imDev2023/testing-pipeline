//! The hook tail (docs/spec/containment-hook.md, "Hook accounts callers must pass", "The
//! allow rule"): every transfer of a contained token passes the hook program, the validation
//! account and the config. A transfer that leaves any of them out, or substitutes one
//! (another mint's config, another mint's validation account, a look-alike account owned by
//! another program), is refused: by Token-2022 where it resolves the accounts itself, and by
//! the hook's own checks everywhere else, which these tests also reach directly with a
//! source the test marks as mid-transfer.

mod support;

use containment_hook::HookError;
use pipeline_client::{AccountMeta, Pubkey};
use solana_signer::Signer;
use support::*;

const AMOUNT: u64 = 1_000_000;

/// The legitimate transfer every case departs from: the holder sends into the home vault,
/// which the allow rule passes with the whole tail.
fn into_the_vault(launched: &Launched, tail: Vec<AccountMeta>) -> pipeline_client::Instruction {
    transfer_checked(
        &launched.mint,
        &launched.holder,
        &launched.market.vaults[CONTAINED],
        &launched.seeder.pubkey(),
        AMOUNT,
        tail,
    )
}

fn hook_ran(logs: &str) -> bool {
    logs.contains(&format!("Program {} invoke", hook_id()))
}

#[test]
fn the_whole_tail_passes() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let transfer = into_the_vault(&launched, hook_tail(&launched.mint));
    let meta = env.send_meta(&[transfer], &[&launched.seeder]).unwrap();
    assert_eq!(hook_depths(&meta.logs), vec![2]);
}

#[test]
fn a_transfer_that_leaves_a_hook_account_out_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let tail = hook_tail(&launched.mint);
    let names = ["the hook program", "the validation account", "the config"];
    for (left_out, name) in names.iter().enumerate() {
        let mut partial = tail.clone();
        partial.remove(left_out);
        let result = env.send(&[into_the_vault(&launched, partial)], &[&launched.seeder]);
        let logs = result.expect_err(&format!("a transfer without {name} passed"));
        if left_out == 1 {
            // Token-2022 calls a hook without its extra accounts when the validation account
            // is missing, and the hook refuses for want of them: it fails closed.
            assert!(hook_ran(&logs), "{name}: {logs}");
            assert!(logs.contains("AccountNotEnoughKeys"), "{name}: {logs}");
        }
    }
    let result = env.send(&[into_the_vault(&launched, vec![])], &[&launched.seeder]);
    assert!(result.is_err(), "a transfer without the tail passed");
    assert_eq!(
        env.balance(&launched.market.vaults[CONTAINED]),
        SEED[CONTAINED]
    );
}

#[test]
fn a_transfer_that_substitutes_another_mints_hook_account_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    // A second contained token, bound to its own home market in the same VM.
    let other = launch(&mut env);
    let tail = hook_tail(&launched.mint);

    // Another mint's config in place of this one's: Token-2022 derives the config from
    // the validation account and does not find it.
    let mut substituted = tail.clone();
    substituted[2] = AccountMeta::new_readonly(config_pda(&other.mint), false);
    assert!(env
        .send(
            &[into_the_vault(&launched, substituted)],
            &[&launched.seeder]
        )
        .is_err());

    // Another mint's validation account in place of this one's: Token-2022 finds no
    // validation account for this mint and calls the hook without its extra accounts.
    let mut substituted = tail.clone();
    substituted[1] = AccountMeta::new_readonly(validation_pda(&other.mint), false);
    let logs = env
        .send(
            &[into_the_vault(&launched, substituted)],
            &[&launched.seeder],
        )
        .expect_err("another mint's validation account passed");
    assert!(
        hook_ran(&logs) && logs.contains("AccountNotEnoughKeys"),
        "{logs}"
    );

    // Another mint's config written over this one's, at its address and owned by the hook:
    // it names the other mint, so the hook refuses it.
    let other_config = env.svm.get_account(&config_pda(&other.mint)).unwrap();
    edit_account(&mut env, &config_pda(&launched.mint), |account| {
        account.data = other_config.data.clone();
    });
    assert_hook_refused(
        env.send(&[into_the_vault(&launched, tail)], &[&launched.seeder]),
        HookError::WrongConfig,
    );
}

#[test]
fn a_look_alike_config_owned_by_another_program_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    // A look-alike at the config's address, naming an attacker's wallet as the home vault:
    // were the hook to trust it, the wallet-to-wallet transfer below would pass.
    let attacker = token_2022_account(&mut env, &Pubkey::new_unique(), &launched.mint);
    let mut config = config(&env, &launched.mint);
    config.vault = ak(&attacker);
    let mut data = vec![];
    anchor_lang::AccountSerialize::try_serialize(&config, &mut data).unwrap();
    let impostor = Pubkey::new_unique();
    edit_account(&mut env, &config_pda(&launched.mint), |account| {
        account.data[..data.len()].copy_from_slice(&data);
        account.owner = impostor;
    });
    let transfer = transfer_checked(
        &launched.mint,
        &launched.holder,
        &attacker,
        &launched.seeder.pubkey(),
        AMOUNT,
        hook_tail(&launched.mint),
    );
    assert_hook_refused(
        env.send(&[transfer], &[&launched.seeder]),
        HookError::WrongConfig,
    );
    assert_eq!(env.balance(&attacker), 0);
}

#[test]
fn a_look_alike_validation_account_owned_by_another_program_is_refused() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    edit_account(&mut env, &validation_pda(&launched.mint), |account| {
        account.owner = Pubkey::new_unique();
    });
    assert_hook_refused(
        env.send(
            &[into_the_vault(&launched, hook_tail(&launched.mint))],
            &[&launched.seeder],
        ),
        HookError::WrongValidationAccount,
    );
}

/// A copy of `account`, a Token-2022 token account of a hooked mint, at a new address with
/// its transfer hook account extension's `transferring` flag set, as Token-2022 sets it for
/// the length of a transfer: how these tests reach the hook's own checks directly.
fn mid_transfer_copy(env: &mut Env, account: &Pubkey, owner: &Pubkey) -> Pubkey {
    let copy = copy_account(env, account, owner);
    edit_account(env, &copy, |account| {
        let at = transferring_flag(&account.data);
        account.data[at] = 1;
    });
    copy
}

/// The offset of the `transferring` flag in a Token-2022 token account's data: the value of
/// its transfer hook account extension, in the entries after the account type, with the
/// layout constants the shared mint-rules crate publishes.
fn transferring_flag(data: &[u8]) -> usize {
    let mut at = mint_rules::ACCOUNT_LEN + 1;
    loop {
        let kind = u16::from_le_bytes([data[at], data[at + 1]]);
        let len = u16::from_le_bytes([data[at + 2], data[at + 3]]) as usize;
        if kind == mint_rules::account_extension::TRANSFER_HOOK_ACCOUNT {
            assert_eq!(len, 1);
            return at + 4;
        }
        at += 4 + len;
    }
}

#[test]
fn the_hooks_own_checks_refuse_each_substitution_inside_a_transfer() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    // A second contained token, bound to its own home market in the same VM.
    let other = launch(&mut env);
    let mint = launched.mint;
    let vault = launched.market.vaults[CONTAINED];
    let owner = launched.seeder.pubkey();
    let source = mid_transfer_copy(&mut env, &launched.holder, &TOKEN_2022);
    let execute = |source, mint, validation, config| {
        execute_instruction(source, mint, vault, owner, validation, config)
    };

    // With the right accounts, the hook passes a transfer into the home vault.
    let right = execute(source, mint, validation_pda(&mint), config_pda(&mint));
    env.send(&[right], &[]).unwrap();

    let other_source = mid_transfer_copy(&mut env, &other.holder, &TOKEN_2022);
    let impostor = Pubkey::new_unique();
    let config_elsewhere = copy_account(&mut env, &config_pda(&mint), &hook_id());
    let config_not_ours = copy_account(&mut env, &config_pda(&mint), &impostor);
    let validation_elsewhere = copy_account(&mut env, &validation_pda(&mint), &hook_id());
    let source_not_token_2022 = mid_transfer_copy(&mut env, &launched.holder, &impostor);
    let cases = [
        (
            "another mint's config",
            execute(source, mint, validation_pda(&mint), config_pda(&other.mint)),
            HookError::WrongConfig,
        ),
        (
            "this config's bytes away from its address",
            execute(source, mint, validation_pda(&mint), config_elsewhere),
            HookError::WrongConfig,
        ),
        (
            "this config's bytes owned by another program",
            execute(source, mint, validation_pda(&mint), config_not_ours),
            HookError::WrongConfig,
        ),
        (
            "another mint, with this mint's config",
            execute(source, other.mint, validation_pda(&mint), config_pda(&mint)),
            HookError::WrongConfig,
        ),
        (
            "another mint's validation account",
            execute(source, mint, validation_pda(&other.mint), config_pda(&mint)),
            HookError::WrongValidationAccount,
        ),
        (
            "this validation account's bytes away from its address",
            execute(source, mint, validation_elsewhere, config_pda(&mint)),
            HookError::WrongValidationAccount,
        ),
        (
            "a source of another mint",
            execute(other_source, mint, validation_pda(&mint), config_pda(&mint)),
            HookError::NotTransferring,
        ),
        (
            "a source owned by another program",
            execute(
                source_not_token_2022,
                mint,
                validation_pda(&mint),
                config_pda(&mint),
            ),
            HookError::NotTransferring,
        ),
    ];
    for (name, instruction, error) in cases {
        println!("{name}");
        assert_hook_refused(env.send(&[instruction], &[]), error);
    }
}
