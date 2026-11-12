//! Creating a lending AMM market through the real router (docs/spec/lending-pool.md,
//! "Markets"): `create_market` with the Borsh-encoded creation parameters, at the PDA of
//! its mints, lent side and fee, with both vaults, the cToken account and the LP mint.

mod common;

use common::*;
use lending_amm::config::{LENT_MINTS, LP_DECIMALS, MAX_LP_FEE_BPS};
use lending_amm::state::STATE_VERSION;
use lending_amm::{InitParams, StrategyError};
use pipeline_client::{self as client, pda, Pubkey};
use solana_signer::Signer;

#[test]
fn a_wsol_lent_market_is_created_at_its_pda_and_recorded_by_the_router() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let market = env.create_market(&spec).unwrap();
    let other = spec.mints[0].0;

    // The market state is the PDA ["market", other_mint, lent_mint, lp_fee_bps LE].
    let (expected, _) = Pubkey::find_program_address(
        &[
            b"market",
            other.as_ref(),
            wsol().as_ref(),
            &30u16.to_le_bytes(),
        ],
        &strategy_id(),
    );
    assert_eq!(market.market_state, expected);

    // The router recorded the mints in the creator's order, with the vaults.
    let recorded = env.router_market(&market.market);
    assert_eq!(recorded.mints[..2], [other, wsol()]);
    assert_eq!(recorded.vaults[..2], market.vaults);

    let state = env.market_state(&market.market_state);
    assert_eq!(state.version, STATE_VERSION);
    assert_eq!(state.lent_index, 1);
    assert_eq!(state.lp_fee_bps, 30);
    assert_eq!(state.mints, [ak(&other), ak(&wsol())]);
    assert_eq!(state.vaults, market.vaults.map(|v| ak(&v)));
    assert_eq!(
        state.market_signer,
        ak(&pda::market(&strategy_id(), &market.market_state))
    );
    assert_eq!(state.lp_mint, ak(&market.addresses.lp_mint));
    assert_eq!(state.ctoken_account, ak(&market.addresses.ctoken_account));
    assert_eq!(state.reserve, LENT_MINTS[0].reserve);
    assert_eq!(state.collateral_mint, LENT_MINTS[0].collateral_mint);
    assert_eq!(state.seeder, Default::default());
    assert_eq!(state.reserves, [0, 0]);
    assert_eq!(state.ctokens, 0);
    assert_eq!((state.deposited, state.redeemed), (0, 0));
    assert!(!state.withdraw_mode);
    let clock: solana_clock::Clock = env.svm.get_sysvar();
    assert_eq!(state.created_slot, clock.slot);
    assert_eq!(state.created_at, clock.unix_timestamp);
}

#[test]
fn creation_makes_both_vaults_the_ctoken_account_and_the_lp_mint() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let market = env.create_market(&spec).unwrap();
    let a = market.addresses;
    let token_account = |address: &Pubkey| {
        let account = env.svm.get_account(address).expect("token account");
        assert_eq!(account.owner, TOKEN);
        let mint = Pubkey::try_from(&account.data[..32]).unwrap();
        let owner = Pubkey::try_from(&account.data[32..64]).unwrap();
        (mint, owner)
    };
    assert_eq!(token_account(&a.vaults[0]), (market.mints[0], a.authority));
    assert_eq!(token_account(&a.vaults[1]), (market.mints[1], a.authority));
    assert_eq!(token_account(&a.ctoken_account), (lent(0).1, a.authority));

    // The LP mint: SPL Token, LP_DECIMALS, the vault authority mints, nobody freezes.
    let lp_mint = env.svm.get_account(&a.lp_mint).unwrap();
    assert_eq!(lp_mint.owner, TOKEN);
    assert_eq!(&lp_mint.data[..4], &[1, 0, 0, 0]);
    assert_eq!(&lp_mint.data[4..36], a.authority.as_ref());
    assert_eq!(lp_mint.data[44], LP_DECIMALS);
    assert_eq!(lp_mint.data[45], 1);
    assert_eq!(&lp_mint.data[46..50], &[0, 0, 0, 0]);
    assert_eq!(env.mint_supply(&a.lp_mint), 0);
}

#[test]
fn the_creation_emits_market_created() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let market = env.create_market(&spec).unwrap();
    let created: Vec<lending_amm::events::MarketCreated> = events(&market.created.logs);
    assert_eq!(created.len(), 1);
    let event = &created[0];
    assert_eq!(event.market_state, ak(&market.market_state));
    assert_eq!(event.mints, market.mints.map(|m| ak(&m)));
    assert_eq!(event.params, spec.params);
    assert_eq!(event.reserve, LENT_MINTS[0].reserve);
}

#[test]
fn a_usdc_lent_market_and_a_market_lending_at_index_0_are_created() {
    let mut env = Env::new();
    let usdc = lent(1).0;
    let other = env.create_mint(&TOKEN);
    let spec = MarketSpec {
        mints: [(usdc, TOKEN), (other, TOKEN)],
        params: InitParams {
            lent_index: 0,
            lp_fee_bps: 0,
        },
    };
    let market = env.create_market(&spec).unwrap();
    let state = env.market_state(&market.market_state);
    assert_eq!(state.lent_index, 0);
    assert_eq!(state.reserve, LENT_MINTS[1].reserve);
    assert_eq!(state.collateral_mint, LENT_MINTS[1].collateral_mint);
    assert_eq!(
        market.market_state,
        market_state_address([usdc, other], 0, 0)
    );
}

#[test]
fn a_sol_and_usdc_market_lends_the_side_lent_index_names() {
    // Both mints are on the list; the creator's lent_index decides which one is lent.
    for lent_index in [0u8, 1] {
        let mut env = Env::new();
        let spec = MarketSpec {
            mints: [(wsol(), TOKEN), (lent(1).0, TOKEN)],
            params: InitParams {
                lent_index,
                lp_fee_bps: 30,
            },
        };
        let market = env.create_market(&spec).unwrap();
        let state = env.market_state(&market.market_state);
        assert_eq!(state.reserve, LENT_MINTS[lent_index as usize].reserve);
    }
}

#[test]
fn the_lp_fee_is_refused_above_max_lp_fee_bps_and_accepted_at_it() {
    let mut env = Env::new();
    let mut spec = env.wsol_market_spec(MAX_LP_FEE_BPS);
    env.create_market(&spec).unwrap();
    spec.params.lp_fee_bps = MAX_LP_FEE_BPS + 1;
    assert_refused(env.create_market(&spec), StrategyError::LpFeeAboveCap);
}

#[test]
fn lent_index_is_refused_outside_0_and_1() {
    let mut env = Env::new();
    let mut spec = env.wsol_market_spec(30);
    spec.params.lent_index = 2;
    assert_refused(env.create_market(&spec), StrategyError::BadLentIndex);
    // 1 (WSOL) works, and 0 names the other mint, which is not on the list.
    spec.params.lent_index = 0;
    assert_refused(env.create_market(&spec), StrategyError::LentMintNotListed);
    spec.params.lent_index = 1;
    env.create_market(&spec).unwrap();
}

#[test]
fn a_lent_mint_not_on_the_list_is_refused() {
    let mut env = Env::new();
    let a = env.create_mint(&TOKEN);
    let b = env.create_mint(&TOKEN);
    let spec = MarketSpec {
        mints: [(a, TOKEN), (b, TOKEN)],
        params: InitParams {
            lent_index: 1,
            lp_fee_bps: 30,
        },
    };
    assert_refused(env.create_market(&spec), StrategyError::LentMintNotListed);
    // A listed mint's collateral mint is not itself lendable.
    let spec = MarketSpec {
        mints: [(a, TOKEN), (lent(0).1, TOKEN)],
        ..spec
    };
    assert_refused(env.create_market(&spec), StrategyError::LentMintNotListed);
}

#[test]
fn a_listed_lent_mint_not_owned_by_spl_token_is_refused() {
    // The WSOL address, but as a Token-2022 mint.
    let mut env = Env::new();
    env.write_mint(&wsol(), &TOKEN_2022, 9, None);
    let other = env.create_mint(&TOKEN);
    let spec = MarketSpec {
        mints: [(other, TOKEN), (wsol(), TOKEN_2022)],
        params: InitParams {
            lent_index: 1,
            lp_fee_bps: 30,
        },
    };
    assert_refused(env.create_market(&spec), StrategyError::LentMintNotSplToken);
}

#[test]
fn two_equal_mints_are_refused() {
    let mut env = Env::new();
    let spec = MarketSpec {
        mints: [(wsol(), TOKEN), (wsol(), TOKEN)],
        params: InitParams {
            lent_index: 1,
            lp_fee_bps: 30,
        },
    };
    assert_refused(env.create_market(&spec), StrategyError::EqualMints);
}

#[test]
fn init_data_that_is_not_the_creation_parameters_is_refused() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    for data in [vec![], vec![1], vec![1, 30, 0, 0]] {
        assert_refused(
            env.create_market_with(&spec, data, |_| {}, vec![], &[]),
            StrategyError::BadInitData,
        );
    }
}

#[test]
fn the_market_state_must_be_the_pda_of_the_creation_parameters() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    // The PDA of another fee, with this fee's init data: a market can't sit at the address
    // of other parameters.
    let wrong = market_state_address([spec.mints[0].0, wsol()], 1, 31);
    let addresses = addresses_of(&wrong, [spec.mints[0].0, wsol()]);
    let accounts = init_accounts(
        &addresses,
        [spec.mints[0].0, wsol()],
        [TOKEN, TOKEN],
        lent(0).1,
    );
    let create = create_market_instruction(
        &env.admin.pubkey(),
        &wrong,
        init_data(&spec.params),
        accounts,
    );
    assert_refused(env.send(&[create], &[]), StrategyError::WrongMarketState);
}

#[test]
fn the_collateral_mint_must_be_the_reserves() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    // The USDC reserve's collateral mint for a WSOL market.
    let wrong = lent(1).1;
    assert_refused(
        env.create_market_with(
            &spec,
            init_data(&spec.params),
            |a| a[5].pubkey = wrong,
            vec![],
            &[],
        ),
        StrategyError::WrongCollateralMint,
    );
}

#[test]
fn each_market_exists_once_per_pair_lent_side_and_fee() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    env.create_market(&spec).unwrap();
    // The router's market account for that state exists, so a second creation fails.
    assert!(env.create_market(&spec).is_err());
    // Another fee is another market.
    let mut other_fee = spec.clone();
    other_fee.params.lp_fee_bps = 31;
    env.create_market(&other_fee).unwrap();
    let _ = client::PROGRAM_ID;
}
