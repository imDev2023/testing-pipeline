//! `bind` through the real router with a tax AMM home market (docs/spec/containment-hook.md,
//! "Binding"): a valid binding writes the config and the validation account once and for
//! good, it reads the vault and the fee account itself, and a second `bind` is refused.

mod support;

use anchor_lang::prelude::Pubkey as AnchorKey;
use containment_hook::config::MAX_UNLOCK_DEADLINE_SECS;
use containment_hook::state::{CONFIG_VERSION, VALIDATION_DATA};
use containment_hook::Config;
use pipeline_client::{AccountMeta, Pubkey};
use support::*;

/// The config a valid binding of `mint` to `market` must hold.
fn expected_config(env: &Env, mint: &Pubkey, market: &Market, args: &BindArgs) -> Config {
    let contained = market.mints.iter().position(|m| m == mint).unwrap();
    let bump = |address: Pubkey, seed: &[u8]| {
        let (found, bump) = Pubkey::find_program_address(&[seed, mint.as_ref()], &hook_id());
        assert_eq!(found, address);
        bump
    };
    Config {
        version: CONFIG_VERSION,
        mint: ak(mint),
        market: ak(&market.market),
        market_state: ak(&market.market_state),
        vault: ak(&market.vaults[contained]),
        fee_account: ak(&fee_account(market, mint)),
        quote_mint: ak(&market.mints[1 - contained]),
        unlock_goal: args.unlock_goal,
        unlock_deadline: args.unlock_deadline,
        bound_at: now(env),
        config_bump: bump(config_pda(mint), b"config"),
        extra_account_metas_bump: bump(validation_pda(mint), b"extra-account-metas"),
        unlock_bump: bump(unlock_pda(mint), b"unlock"),
        unlocked_at: None,
    }
}

#[test]
fn a_valid_mint_and_market_are_bound() {
    for contained_index in [0, 1] {
        let mut env = hook_env();
        let mint = contained_mint(&mut env);
        let market = home_market(&mut env, mint, contained_index);
        let args = BindArgs::new(&env, mint, &market);
        send_bind(&mut env, &args, &[]).unwrap();

        assert_eq!(
            config(&env, &mint),
            expected_config(&env, &mint, &market, &args),
            "contained mint at index {contained_index}"
        );
        // The vault and the fee account are the router's own records of them.
        let router = env.router_market(&market.market);
        assert_eq!(
            config(&env, &mint).vault,
            ak(&router.vault_for(&mint).unwrap())
        );
        assert!(env.svm.get_account(&fee_account(&market, &mint)).is_some());

        let config_account = env.svm.get_account(&config_pda(&mint)).unwrap();
        assert_eq!(config_account.owner, hook_id());
        assert_eq!(config_account.data.len(), Config::SPACE);
        let validation = env.svm.get_account(&validation_pda(&mint)).unwrap();
        assert_eq!(validation.owner, hook_id());
        assert_eq!(validation.data, VALIDATION_DATA);
    }
}

#[test]
fn the_longest_deadline_is_accepted() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let mut args = BindArgs::new(&env, mint, &market);
    args.unlock_deadline = now(&env) + MAX_UNLOCK_DEADLINE_SECS;
    args.unlock_goal = 1;
    send_bind(&mut env, &args, &[]).unwrap();
    assert_eq!(config(&env, &mint).unlock_deadline, args.unlock_deadline);
    assert_eq!(config(&env, &mint).unlock_goal, 1);
}

#[test]
fn a_payer_other_than_the_mint_authority_may_pay() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let payer = solana_keypair::Keypair::new();
    env.svm
        .airdrop(&solana_signer::Signer::pubkey(&payer), SOL)
        .unwrap();
    let mut args = BindArgs::new(&env, mint, &market);
    args.payer = solana_signer::Signer::pubkey(&payer);
    send_bind(&mut env, &args, &[&payer]).unwrap();
    assert_eq!(config(&env, &mint).market, ak(&market.market));
}

#[test]
fn a_second_bind_is_refused_and_changes_nothing() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    bind(&mut env, mint, &market).unwrap();
    let before = env.svm.get_account(&config_pda(&mint)).unwrap();
    let validation_before = env.svm.get_account(&validation_pda(&mint)).unwrap();

    // Another market of the same mint, and other terms: still refused.
    let other = home_market(&mut env, mint, 1);
    let mut args = BindArgs::new(&env, mint, &other);
    args.unlock_goal = 1;
    args.unlock_deadline = now(&env) + 1;
    let result = send_bind(&mut env, &args, &[]);
    assert!(
        result
            .as_ref()
            .is_err_and(|logs| logs.contains("already in use")),
        "{result:?}"
    );
    // The same binding again: refused too.
    assert!(bind(&mut env, mint, &market).is_err());

    assert_eq!(env.svm.get_account(&config_pda(&mint)).unwrap(), before);
    assert_eq!(
        env.svm.get_account(&validation_pda(&mint)).unwrap(),
        validation_before
    );
}

#[test]
fn a_caller_cannot_steer_the_vault_or_the_fee_account() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);

    // A token account the caller controls, offered where a vault or fee account might go,
    // after bind's own accounts and in place of every account bind does not take.
    let attacker = Pubkey::new_unique();
    let fake = token_2022_account(&mut env, &attacker, &mint);
    let mut args = BindArgs::new(&env, mint, &market);
    args.extra = vec![
        AccountMeta::new(fake, false),
        AccountMeta::new_readonly(attacker, false),
    ];
    send_bind(&mut env, &args, &[]).unwrap();

    let bound = config(&env, &mint);
    assert_eq!(bound.vault, ak(&market.vaults[0]));
    assert_eq!(bound.fee_account, ak(&fee_account(&market, &mint)));
    assert_ne!(bound.vault, ak(&fake));
    assert_ne!(bound.fee_account, ak(&fake));
}

#[test]
fn a_market_state_naming_another_vault_cannot_steer_it_either() {
    // The vault comes from the router's Market, not from the market state: a market state
    // whose bytes name another vault changes nothing the hook records.
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let fake_vault = Pubkey::new_unique();
    edit_account(&mut env, &market.market_state, |account| {
        // `vaults[0]` in the tax AMM's layout (tax-amm/tests/layout.rs).
        account.data[78..110].copy_from_slice(fake_vault.as_ref());
    });
    bind(&mut env, mint, &market).unwrap();
    assert_eq!(config(&env, &mint).vault, ak(&market.vaults[0]));
    assert_ne!(
        config(&env, &mint).vault,
        AnchorKey::new_from_array(fake_vault.to_bytes())
    );
}
