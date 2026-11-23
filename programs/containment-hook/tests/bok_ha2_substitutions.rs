//! Book of Knowledge HA-2 (#74, T01): every way of substituting a hook account, each case on
//! its own, reporting every case that passes instead of stopping at the first. Written for
//! the mutation run that asks which of `Execute`'s checks each case depends on (the two
//! `create_program_address` checks, the two owner checks); on the real program every case is
//! refused.
//!
//! Two kinds of case:
//! - through Token-2022 (`transfer_checked` into the home vault): the only way the hook runs
//!   on chain, where Token-2022 derives the validation account and resolves the config itself;
//! - `Execute` called directly with a source the test marks as mid-transfer, which on chain
//!   only Token-2022 can do, inside a transfer; these reach the hook's own checks with
//!   accounts LiteSVM lets a test create (a hook-owned account away from its PDA, another
//!   program's account at the hook's PDA) that no transaction can create on chain.

mod support;

use containment_hook::HookError;
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use solana_signer::Signer;
use support::*;

const AMOUNT: u64 = 1_000_000;

fn transfer_to(launched: &Launched, destination: &Pubkey, tail: Vec<AccountMeta>) -> Instruction {
    transfer_checked(
        &launched.mint,
        &launched.holder,
        destination,
        &launched.seeder.pubkey(),
        AMOUNT,
        tail,
    )
}

/// A copy of a token account at a new address with its `transferring` flag set.
fn mid_transfer_copy(env: &mut Env, account: &Pubkey, owner: &Pubkey) -> Pubkey {
    let copy = copy_account(env, account, owner);
    edit_account(env, &copy, |account| {
        let mut at = 166;
        loop {
            let kind = u16::from_le_bytes([account.data[at], account.data[at + 1]]);
            let len = u16::from_le_bytes([account.data[at + 2], account.data[at + 3]]) as usize;
            if kind == 15 {
                account.data[at + 4] = 1;
                return;
            }
            at += 4 + len;
        }
    });
    copy
}

/// What a case came to: refused (with the error, if it was the hook's), or passed.
fn outcome(result: Result<Vec<u8>, String>) -> Option<String> {
    match result {
        Ok(_) => None,
        Err(failure) => Some(
            failure
                .split("Error Code: ")
                .nth(1)
                .and_then(|rest| rest.split('.').next())
                .map(|name| format!("hook {name}"))
                .unwrap_or_else(|| {
                    if failure.contains("AccountNotEnoughKeys") {
                        "hook AccountNotEnoughKeys (Anchor)".into()
                    } else {
                        "Token-2022 or the runtime".into()
                    }
                }),
        ),
    }
}

/// The cases through Token-2022, each in a fresh VM.
fn through_token_2022() -> Vec<(&'static str, Option<String>)> {
    let mut results = vec![];
    // Each case gives the tail and, if not the home vault, the destination.
    type Prepare = dyn Fn(&mut Env, &Launched, &Launched) -> (Vec<AccountMeta>, Option<Pubkey>);
    let mut case = |name: &'static str, prepare: &Prepare| {
        let mut env = hook_env();
        let launched = launch(&mut env);
        let other = launch(&mut env);
        let (tail, destination) = prepare(&mut env, &launched, &other);
        let destination = destination.unwrap_or(launched.market.vaults[CONTAINED]);
        let result = env.send(
            &[transfer_to(&launched, &destination, tail)],
            &[&launched.seeder],
        );
        results.push((name, outcome(result)));
    };
    case(
        "T1 tail with another mint's config",
        &|_, launched, other| {
            let mut tail = hook_tail(&launched.mint);
            tail[2] = AccountMeta::new_readonly(config_pda(&other.mint), false);
            (tail, None)
        },
    );
    case(
        "T2 tail with another mint's validation account",
        &|_, launched, other| {
            let mut tail = hook_tail(&launched.mint);
            tail[1] = AccountMeta::new_readonly(validation_pda(&other.mint), false);
            (tail, None)
        },
    );
    case("T3 no hook accounts", &|_, _, _| (vec![], None));
    case(
        "T4 another mint's config written at this config's address",
        &|env, launched, other| {
            let data = env.svm.get_account(&config_pda(&other.mint)).unwrap().data;
            edit_account(env, &config_pda(&launched.mint), |account| {
                account.data = data.clone()
            });
            (hook_tail(&launched.mint), None)
        },
    );
    case(
        "T5 a look-alike config at this config's address, owned by another program, naming an attacker's vault",
        &|env, launched, _| {
            let attacker = token_2022_account(env, &Pubkey::new_unique(), &launched.mint);
            let mut config = config(env, &launched.mint);
            config.vault = ak(&attacker);
            let mut data = vec![];
            anchor_lang::AccountSerialize::try_serialize(&config, &mut data).unwrap();
            let impostor = Pubkey::new_unique();
            edit_account(env, &config_pda(&launched.mint), |account| {
                account.data[..data.len()].copy_from_slice(&data);
                account.owner = impostor;
            });
            // Into the attacker's account: only the look-alike allows it.
            (hook_tail(&launched.mint), Some(attacker))
        },
    );
    case(
        "T6 the validation account owned by another program",
        &|env, launched, _| {
            edit_account(env, &validation_pda(&launched.mint), |account| {
                account.owner = Pubkey::new_unique();
            });
            (hook_tail(&launched.mint), None)
        },
    );
    results
}

/// The direct `Execute` cases, as `hook_accounts.rs` builds them, each evaluated.
fn direct_execute() -> Vec<(&'static str, Option<String>)> {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let other = launch(&mut env);
    let mint = launched.mint;
    let vault = launched.market.vaults[CONTAINED];
    let owner = launched.seeder.pubkey();
    let source = mid_transfer_copy(&mut env, &launched.holder, &TOKEN_2022);
    let execute = |source, mint, validation, config| {
        execute_instruction(source, mint, vault, owner, validation, config)
    };
    let attacker = token_2022_account(&mut env, &Pubkey::new_unique(), &mint);
    let other_source = mid_transfer_copy(&mut env, &other.holder, &TOKEN_2022);
    let impostor = Pubkey::new_unique();
    let config_elsewhere = copy_account(&mut env, &config_pda(&mint), &hook_id());
    let config_not_ours = copy_account(&mut env, &config_pda(&mint), &impostor);
    // A forged config owned by another program, naming an attacker's account as the vault:
    // the one substitution anyone could create on chain.
    let forged = copy_account(&mut env, &config_pda(&mint), &impostor);
    {
        let mut config = config(&env, &mint);
        config.vault = ak(&attacker);
        let mut data = vec![];
        anchor_lang::AccountSerialize::try_serialize(&config, &mut data).unwrap();
        edit_account(&mut env, &forged, |account| {
            account.data[..data.len()].copy_from_slice(&data)
        });
    }
    let validation_elsewhere = copy_account(&mut env, &validation_pda(&mint), &hook_id());
    let validation_not_ours = copy_account(&mut env, &validation_pda(&mint), &impostor);
    let source_not_token_2022 = mid_transfer_copy(&mut env, &launched.holder, &impostor);
    let to_attacker =
        execute_instruction(source, mint, attacker, owner, validation_pda(&mint), forged);
    let cases: Vec<(&'static str, Instruction)> = vec![
        (
            "D0 the right accounts (must pass)",
            execute(source, mint, validation_pda(&mint), config_pda(&mint)),
        ),
        (
            "D1 another mint's config",
            execute(source, mint, validation_pda(&mint), config_pda(&other.mint)),
        ),
        (
            "D2 this config's bytes away from its address, hook-owned",
            execute(source, mint, validation_pda(&mint), config_elsewhere),
        ),
        (
            "D3 this config's bytes away from its address, owned by another program",
            execute(source, mint, validation_pda(&mint), config_not_ours),
        ),
        (
            "D4 a forged config owned by another program, sending to an attacker",
            to_attacker,
        ),
        (
            "D5 another mint, with this mint's config",
            execute(source, other.mint, validation_pda(&mint), config_pda(&mint)),
        ),
        (
            "D6 another mint's validation account",
            execute(source, mint, validation_pda(&other.mint), config_pda(&mint)),
        ),
        (
            "D7 this validation account's bytes away from its address, hook-owned",
            execute(source, mint, validation_elsewhere, config_pda(&mint)),
        ),
        (
            "D8 this validation account's bytes away from its address, owned by another program",
            execute(source, mint, validation_not_ours, config_pda(&mint)),
        ),
        (
            "D9 a source of another mint",
            execute(other_source, mint, validation_pda(&mint), config_pda(&mint)),
        ),
        (
            "D10 a source owned by another program",
            execute(
                source_not_token_2022,
                mint,
                validation_pda(&mint),
                config_pda(&mint),
            ),
        ),
    ];
    cases
        .into_iter()
        .map(|(name, instruction)| (name, outcome(env.send(&[instruction], &[]))))
        .collect()
}

#[test]
fn every_substituted_hook_account_is_refused_case_by_case() {
    let mut passed = vec![];
    for (name, result) in through_token_2022().into_iter().chain(direct_execute()) {
        let shown = result.clone().unwrap_or_else(|| "PASSED".into());
        println!("BOK-HA2 | {name} | {shown}");
        let must_pass = name.starts_with("D0");
        if result.is_none() != must_pass {
            passed.push(name);
        }
    }
    assert!(
        passed.is_empty(),
        "cases with the wrong outcome: {passed:#?}"
    );
    let _ = HookError::WrongConfig;
}
