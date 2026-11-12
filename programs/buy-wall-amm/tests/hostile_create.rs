//! Hostile cases at creation (docs/spec/README.md, "Test layers" 1): a wrong or missing
//! market signer, substituted or aliased mints and vaults, and a second initialisation of
//! the same market state are all refused; lamports sent ahead to a vault's address never
//! block a market.

mod common;

use buy_wall_amm::errors::StrategyError::*;
use common::*;
use pipeline_client::{self as client, AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;

/// `pipeline_init_market` called directly, not through the router, with `market_signer`
/// signing in the router's place.
fn direct_init(
    env: &Env,
    market_signer: &Pubkey,
    signer_signs: bool,
    market_state: &Keypair,
    accounts: Vec<AccountMeta>,
) -> Instruction {
    let mut metas = vec![
        AccountMeta::new_readonly(*market_signer, signer_signs),
        AccountMeta::new(market_state.pubkey(), true),
        AccountMeta::new(env.admin.pubkey(), true),
        AccountMeta::new_readonly(client::SYSTEM_PROGRAM_ID, false),
    ];
    metas.extend(accounts);
    let data = borsh::to_vec(&launch_params(env.admin.pubkey())).unwrap();
    strategy_call(client::interface::discriminator::INIT_MARKET, &data, metas)
}

#[test]
fn only_the_routers_market_signer_may_create_a_market() {
    let mut env = Env::new();
    let token = env.create_mint(&TOKEN, 6);
    let market_state = Keypair::new();
    let market = Market::addresses(market_state.pubkey(), token, TOKEN);

    // Anyone signing as the market signer, calling the strategy directly.
    let impostor = Keypair::new();
    let ix = direct_init(
        &env,
        &impostor.pubkey(),
        true,
        &market_state,
        market.init_accounts(),
    );
    assert_refused(env.send(&[ix], &[&market_state, &impostor]), NotPipeline);

    // The right address, but without its signature (only the router can sign as it).
    let ix = direct_init(
        &env,
        &market.market,
        false,
        &market_state,
        market.init_accounts(),
    );
    assert_fails(env.send(&[ix], &[&market_state]));

    // Through the router it works.
    env.create_market(token, TOKEN, &launch_params(env.admin.pubkey()))
        .unwrap();
}

#[test]
fn substituted_or_aliased_mints_and_vaults_are_refused() {
    let mut env = Env::new();
    let token = env.create_mint(&TOKEN, 6);
    let other = env.create_mint(&TOKEN, 6);
    let params = borsh::to_vec(&launch_params(env.admin.pubkey())).unwrap();

    let attempt = |env: &mut Env, change: &dyn Fn(&Market, &mut Vec<AccountMeta>)| {
        let market_state = Keypair::new();
        let (market, mut create) =
            env.create_market_ix(&market_state, token, TOKEN, params.clone());
        // The strategy's accounts follow the router's fixed ones in `create_market`.
        let first = create.accounts.len() - market.init_accounts().len();
        let mut strategy_accounts = create.accounts.split_off(first);
        change(&market, &mut strategy_accounts);
        create.accounts.extend(strategy_accounts);
        env.send(&[create], &[&market_state])
    };
    let set = |accounts: &mut Vec<AccountMeta>, index: usize, key: Pubkey| {
        accounts[index].pubkey = key;
    };

    // Index: 0 token mint, 1 wrapped SOL, 2 vault authority, 3 token vault, 4 SOL vault,
    // 5 token program, 6 SPL Token.
    // Wrapped SOL replaced by another mint.
    assert_refused(attempt(&mut env, &|_, a| set(a, 1, other)), WrongAccount);
    // The token aliased to wrapped SOL.
    assert_refused(
        attempt(&mut env, &|m, a| {
            set(a, 0, WSOL);
            set(a, 3, m.sol_vault);
        }),
        SameMint,
    );
    // The vaults swapped, aliased, or replaced by the creator's own token account.
    assert_fails(attempt(&mut env, &|m, a| {
        set(a, 3, m.sol_vault);
        set(a, 4, m.token_vault);
    }));
    assert_fails(attempt(&mut env, &|m, a| set(a, 4, m.token_vault)));
    let ata = client::pda::associated_token(&env.admin.pubkey(), &token, &TOKEN);
    assert_fails(attempt(&mut env, &|_, a| set(a, 3, ata)));
    // A vault authority other than the market's PDA.
    assert_fails(attempt(&mut env, &|_, a| set(a, 2, Pubkey::new_unique())));
    // The wrong token program for the mint, and a fake one for wrapped SOL.
    assert_fails(attempt(&mut env, &|_, a| set(a, 5, TOKEN_2022)));
    assert_fails(attempt(&mut env, &|_, a| set(a, 6, TOKEN_2022)));
    // Vaults derived for another mint than the one passed.
    assert_fails(attempt(&mut env, &|_, a| {
        let other_market = Market::addresses(Pubkey::new_unique(), other, TOKEN);
        set(a, 3, other_market.token_vault);
    }));

    // Unchanged, the same transaction works.
    attempt(&mut env, &|_, _| {}).unwrap();
}

#[test]
fn a_market_state_is_initialised_once() {
    let mut env = Env::new();
    let token = env.create_mint(&TOKEN, 6);
    let market_state = Keypair::new();
    let data = borsh::to_vec(&launch_params(env.admin.pubkey())).unwrap();
    let (market, create) = env.create_market_ix(&market_state, token, TOKEN, data.clone());
    env.send(&[create], &[&market_state]).unwrap();
    let before = env.market_state(&market);

    // Again through the router.
    let (_, again) = env.create_market_ix(&market_state, token, TOKEN, data);
    assert_fails(env.send(&[again], &[&market_state]));
    // Again directly, signing as the market state, with any market signer.
    let impostor = Keypair::new();
    let ix = direct_init(
        &env,
        &impostor.pubkey(),
        true,
        &market_state,
        market.init_accounts(),
    );
    assert_fails(env.send(&[ix], &[&market_state, &impostor]));

    assert_eq!(env.market_state(&market), before);
}

#[test]
fn lamports_sent_ahead_to_the_vaults_never_block_a_market() {
    let mut env = Env::new();
    let token = env.create_mint(&TOKEN, 6);
    let market_state = Keypair::new();
    let data = borsh::to_vec(&launch_params(env.admin.pubkey())).unwrap();
    let (market, create) = env.create_market_ix(&market_state, token, TOKEN, data);
    // Anyone can compute the vaults' addresses and fund them first, one with less than
    // rent and one with more.
    let below_rent = env.svm.minimum_balance_for_rent_exemption(0);
    assert!(below_rent < env.svm.minimum_balance_for_rent_exemption(165));
    env.svm.airdrop(&market.token_vault, below_rent).unwrap();
    env.svm.airdrop(&market.sol_vault, SOL).unwrap();
    env.send(&[create], &[&market_state]).unwrap();
    for vault in market.vaults() {
        let account = env.svm.get_account(&vault).unwrap();
        assert_eq!(account.owner, TOKEN);
        assert_eq!(&account.data[32..64], market.vault_authority.as_ref());
    }
    env.market_info(&market.market_state).unwrap();
}

#[test]
fn token_2022s_wrapped_sol_is_refused_as_the_token() {
    // Token-2022's native mint is wrapped SOL too: a market of it against SPL Token's
    // wrapped SOL would pair SOL with SOL.
    let mut env = Env::new();
    let native_2022 = client::pubkey!("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP");
    let mut data = vec![0u8; 82];
    data[44] = 9;
    data[45] = 1;
    let lamports = env.svm.minimum_balance_for_rent_exemption(82);
    env.svm
        .set_account(native_2022, solana_account(lamports, data, TOKEN_2022))
        .unwrap();
    let params = launch_params(env.admin.pubkey());
    assert_refused(
        env.create_market(native_2022, TOKEN_2022, &params),
        SameMint,
    );
}
