//! Hostile market creation (docs/spec/README.md, "Test layers" 1): a wrong or missing
//! market signer, substituted and aliased mints, vaults, cToken account and LP mint,
//! accounts someone funded beforehand, and a second initialisation of the same market
//! state.

mod common;

use common::*;
use lending_amm::StrategyError;
use pipeline_client::{self as client, pda, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Anchor's own errors, by number.
const ACCOUNT_NOT_SIGNER: u32 = 3010;
const CONSTRAINT_SEEDS: u32 = 2006;
const INVALID_PROGRAM_ID: u32 = 3008;

// Indices of `init_accounts`.
const MINT_0: usize = 0;
const MINT_1: usize = 1;
const AUTHORITY: usize = 2;
const VAULT_0: usize = 3;
const VAULT_1: usize = 4;
const COLLATERAL_MINT: usize = 5;
const CTOKEN: usize = 6;
const LP_MINT: usize = 7;
const TOKEN_PROGRAM_0: usize = 8;
const SPL_TOKEN: usize = 10;

fn setup() -> (Env, MarketSpec) {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    (env, spec)
}

fn create_with(
    env: &mut Env,
    spec: &MarketSpec,
    change: impl FnOnce(&mut Vec<AccountMeta>),
) -> Result<Market, String> {
    env.create_market_with(spec, init_data(&spec.params), change, vec![], &[])
}

/// `pipeline_init_market` called directly, not through the router, with `signer` in the
/// market signer's place.
fn call_directly(
    env: &mut Env,
    spec: &MarketSpec,
    signer: &Pubkey,
    signs: bool,
    extra: &[&Keypair],
) -> Result<Vec<u8>, String> {
    let (create, addresses) = env.create_instruction(spec, init_data(&spec.params), |_| {});
    let mut data = client::interface::discriminator::INIT_MARKET.to_vec();
    data.extend(borsh::to_vec(&init_data(&spec.params)).unwrap());
    let mut accounts = vec![
        AccountMeta::new_readonly(*signer, signs),
        AccountMeta::new(addresses.market_state, false),
        AccountMeta::new(env.admin.pubkey(), true),
        AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
    ];
    // The strategy accounts are the create_market instruction's last eleven.
    let strategy_accounts = &create.accounts[create.accounts.len() - 11..];
    accounts.extend(strategy_accounts.iter().cloned());
    let call = Instruction::new_with_bytes(strategy_id(), &data, accounts);
    env.send(&[call], extra)
}

#[test]
fn a_direct_call_with_any_other_market_signer_is_refused() {
    let (mut env, spec) = setup();
    let impostor = Keypair::new();
    assert_refused(
        call_directly(&mut env, &spec, &impostor.pubkey(), true, &[&impostor]),
        StrategyError::NotPipeline,
    );
    // The admin, who pays and could sign anything here, isn't the router's PDA either.
    let admin = env.admin.pubkey();
    assert_refused(
        call_directly(&mut env, &spec, &admin, true, &[]),
        StrategyError::NotPipeline,
    );
}

#[test]
fn a_market_signer_that_does_not_sign_is_refused() {
    // The right address, but only the router can make it sign.
    let (mut env, spec) = setup();
    let state = market_state_address([spec.mints[0].0, wsol()], 1, 30);
    let market = pda::market(&strategy_id(), &state);
    assert_anchor_error(
        call_directly(&mut env, &spec, &market, false, &[]),
        ACCOUNT_NOT_SIGNER,
    );
}

#[test]
fn substituted_vaults_ctoken_account_lp_mint_and_authority_are_refused() {
    let (mut env, spec) = setup();
    let other_state = Pubkey::new_unique();
    let mints = [spec.mints[0].0, wsol()];
    let elsewhere = addresses_of(&other_state, mints);
    for (index, wrong) in [
        (VAULT_0, elsewhere.vaults[0]),
        (
            VAULT_1,
            pda::associated_token(&elsewhere.authority, &mints[1], &TOKEN),
        ),
        (CTOKEN, elsewhere.ctoken_account),
        (LP_MINT, elsewhere.lp_mint),
        (AUTHORITY, elsewhere.authority),
    ] {
        assert_anchor_error(
            create_with(&mut env, &spec, |a| a[index].pubkey = wrong),
            CONSTRAINT_SEEDS,
        );
    }
    // The two vaults swapped.
    assert_anchor_error(
        create_with(&mut env, &spec, |a| a.swap(VAULT_0, VAULT_1)),
        CONSTRAINT_SEEDS,
    );
}

#[test]
fn aliased_accounts_are_refused() {
    let (mut env, spec) = setup();
    let state = market_state_address([spec.mints[0].0, wsol()], 1, 30);
    let addresses = addresses_of(&state, [spec.mints[0].0, wsol()]);
    // The market state as a vault, the LP mint as the cToken account, the vault as the LP
    // mint: each breaks its seeds.
    for (index, alias) in [
        (VAULT_1, state),
        (CTOKEN, addresses.lp_mint),
        (LP_MINT, addresses.vaults[0]),
    ] {
        assert_anchor_error(
            create_with(&mut env, &spec, |a| a[index].pubkey = alias),
            CONSTRAINT_SEEDS,
        );
    }
    // The LP mint as the collateral mint, the other mint as the collateral mint.
    for alias in [addresses.lp_mint, spec.mints[0].0] {
        assert_refused(
            create_with(&mut env, &spec, |a| a[COLLATERAL_MINT].pubkey = alias),
            StrategyError::WrongCollateralMint,
        );
    }
    // A mint as a token program.
    assert_anchor_error(
        create_with(&mut env, &spec, |a| {
            a[TOKEN_PROGRAM_0].pubkey = spec.mints[0].0
        }),
        INVALID_PROGRAM_ID,
    );
    // Token-2022 where only SPL Token may own the LP mint and the cToken account.
    assert_anchor_error(
        create_with(&mut env, &spec, |a| a[SPL_TOKEN].pubkey = TOKEN_2022),
        INVALID_PROGRAM_ID,
    );
}

#[test]
fn substituted_mints_move_the_market_state_and_are_refused() {
    // The init data names the lent side at index 1. Swapping the mints' order (with each
    // vault still derived from its mint) makes the other mint the lent one; another lent
    // mint (USDC) in WSOL's place changes the PDA the market state must be. Either way the
    // market state given is not the PDA of what is being created.
    let (mut env, spec) = setup();
    let other = spec.mints[0].0;
    let state = market_state_address([other, wsol()], 1, 30);
    assert_refused(
        create_with(&mut env, &spec, |a| {
            a.swap(MINT_0, MINT_1);
            a.swap(VAULT_0, VAULT_1);
        }),
        StrategyError::WrongMarketState,
    );
    let usdc = lent(1).0;
    let usdc_vault = addresses_of(&state, [other, usdc]).vaults[1];
    assert_refused(
        create_with(&mut env, &spec, |a| {
            a[MINT_1].pubkey = usdc;
            a[VAULT_1].pubkey = usdc_vault;
        }),
        StrategyError::WrongMarketState,
    );
}

#[test]
fn pre_funded_addresses_do_not_block_the_creation() {
    // Every address is known before creation; lamports sent to any of them are kept and
    // creation goes ahead (docs/spec/lending-pool.md, "Addresses"). Only lamports can be
    // sent: each is a PDA only this program can allocate or assign.
    let (mut env, spec) = setup();
    let state = market_state_address([spec.mints[0].0, wsol()], 1, 30);
    let a = addresses_of(&state, [spec.mints[0].0, wsol()]);
    let least = env.svm.minimum_balance_for_rent_exemption(0);
    for (address, lamports) in [
        (state, 10_000_000),
        (a.vaults[0], least),
        (a.ctoken_account, least),
        (a.lp_mint, 50_000_000),
        (a.authority, least),
    ] {
        env.svm.airdrop(&address, lamports).unwrap();
    }
    let market = env.create_market(&spec).unwrap();
    assert_eq!(env.market_state(&market.market_state).reserves, [0, 0]);
    assert_eq!(env.svm.get_account(&state).unwrap().owner, strategy_id());
    assert_eq!(env.mint_supply(&a.lp_mint), 0);
}

#[test]
fn a_pre_funded_wsol_vault_opens_with_a_donation_the_market_never_counts() {
    // Lamports sent to the WSOL vault's address become wrapped SOL when SPL Token
    // initializes the vault: a donation, which the market never records.
    let (mut env, spec) = setup();
    let state = market_state_address([spec.mints[0].0, wsol()], 1, 30);
    let a = addresses_of(&state, [spec.mints[0].0, wsol()]);
    env.svm.airdrop(&a.vaults[1], 5 * SOL).unwrap();
    let market = env.create_market(&spec).unwrap();
    let vault = env.svm.get_account(&market.vaults[1]).unwrap();
    let rent = env.svm.minimum_balance_for_rent_exemption(vault.data.len());
    assert_eq!(env.balance(&market.vaults[1]), 5 * SOL - rent);
    assert_eq!(env.market_state(&market.market_state).reserves, [0, 0]);
}

#[test]
fn a_second_initialisation_of_the_same_market_state_fails() {
    let (mut env, spec) = setup();
    let market = env.create_market(&spec).unwrap();
    let before = env.svm.get_account(&market.market_state).unwrap();
    // Through the router: its Market account for the state exists already.
    assert!(env.create_market(&spec).is_err());
    // Directly, with the router's PDA as the signer: it can't sign, so nobody can call it
    // as the router.
    let signer = pda::market(&strategy_id(), &market.market_state);
    assert_anchor_error(
        call_directly(&mut env, &spec, &signer, false, &[]),
        ACCOUNT_NOT_SIGNER,
    );
    assert_eq!(env.svm.get_account(&market.market_state).unwrap(), before);
}

#[test]
fn market_info_reports_the_mints_in_the_creators_order_without_exact_out() {
    let (mut env, spec) = setup();
    let market = env.create_market(&spec).unwrap();
    let data = env
        .market_info_meta(&market.market_state)
        .unwrap()
        .return_data
        .data;
    let info: pipeline_client::interface::MarketInfo = borsh::from_slice(&data).unwrap();
    assert_eq!(
        info.mints,
        vec![spec.mints[0].0.to_bytes(), wsol().to_bytes()]
    );
    assert_eq!(info.vaults, market.vaults.map(|v| v.to_bytes()).to_vec());
    assert!(!info.supports_exact_out);
}

#[test]
fn market_info_refuses_an_account_that_is_not_a_lending_amm_market() {
    // Anchor's errors: owned by another program, and the wrong discriminator.
    const ACCOUNT_OWNED_BY_WRONG_PROGRAM: u32 = 3007;
    const ACCOUNT_DISCRIMINATOR_MISMATCH: u32 = 3002;
    let (mut env, spec) = setup();
    let market = env.create_market(&spec).unwrap();
    assert_anchor_error(
        env.market_info_meta(&market.vaults[0]),
        ACCOUNT_OWNED_BY_WRONG_PROGRAM,
    );
    // An account this program owns, of the market state's size, without its discriminator:
    // what `register_existing_market` could be pointed at.
    let mut fake = env.svm.get_account(&market.market_state).unwrap();
    fake.data[0] ^= 0xff;
    let address = Pubkey::new_unique();
    env.svm.set_account(address, fake).unwrap();
    assert_anchor_error(
        env.market_info_meta(&address),
        ACCOUNT_DISCRIMINATOR_MISMATCH,
    );
    // And the router refuses to record it.
    let register =
        client::register_existing_market(&env.admin.pubkey(), &strategy_id(), &address, vec![]);
    assert_anchor_error(env.send(&[register], &[]), ACCOUNT_DISCRIMINATOR_MISMATCH);
}
