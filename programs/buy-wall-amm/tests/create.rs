//! Creating a market through the router's `create_market` (docs/spec/pool4-for-solana.md,
//! "Markets"), read back through `pipeline_market_info`.
//!
//! Build first: `scripts/fetch-router.sh` and
//! `cargo build-sbf --manifest-path programs/buy-wall-amm/Cargo.toml` (docs/toolchain.md).

mod common;

use common::*;
use pipeline_client::Pubkey;
use solana_signer::Signer;

#[test]
fn a_market_is_created_through_the_router_and_reports_its_mints() {
    let mut env = Env::new();
    let token = env.create_mint(&TOKEN, 6);
    let seeder = env.admin.pubkey();
    let market = env
        .create_market(token, TOKEN, &launch_params(seeder))
        .unwrap();

    let info = env.market_info(&market.market_state).unwrap();
    assert_eq!(info.mints, vec![token.to_bytes(), WSOL.to_bytes()]);
    assert_eq!(
        info.vaults,
        vec![market.token_vault.to_bytes(), market.sol_vault.to_bytes()]
    );
    assert!(!info.supports_exact_out);

    // The router recorded the same market.
    assert!(env.svm.get_account(&market.market).is_some());
    let state = env.svm.get_account(&market.market_state).unwrap();
    assert_eq!(state.owner, strategy_id());
    assert_eq!(state.data.len(), buy_wall_amm::config::MARKET_STATE_SIZE);
}

#[test]
fn creation_records_the_parameters_the_signer_and_the_clock() {
    use buy_wall_amm::state::MarketState;
    let mut env = Env::new();
    let token = env.create_mint(&TOKEN, 6);
    env.svm.warp_to_slot(1_234);
    let mut clock = env.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    clock.unix_timestamp = 1_800_000_000;
    env.svm.set_sysvar(&clock);
    let params = launch_params(Pubkey::new_unique());
    let market = env.create_market(token, TOKEN, &params).unwrap();

    let data = env.market_state(&market);
    assert_eq!(&data[..8], b"BWMARKET");
    let state: &MarketState = bytemuck::from_bytes(&data[8..]);
    assert_eq!((state.layout_version, state.status), (1, 1));
    assert_eq!(state.market_signer, market.market);
    assert_eq!((state.token_mint, state.wsol_mint), (token, WSOL));
    assert_eq!(
        (state.token_vault, state.sol_vault),
        (market.token_vault, market.sol_vault)
    );
    assert_eq!(state.seeder, params.seeder);
    assert_eq!(state.creation_slot(), 1_234);
    assert_eq!(state.creation_time(), 1_800_000_000);
    assert_eq!(state.fee_bps(), params.fee_bps);
    assert_eq!(state.wall_split_bps(), params.wall_split_bps);
    assert_eq!(state.reward_share_bps(), params.reward_share_bps);
    assert_eq!(state.fee_recipient, params.fee_recipient);
    assert_eq!(state.rewards_recipient, params.rewards_recipient);
    assert_eq!(state.cap_floor_bps(), params.cap_floor_bps);
    assert_eq!(state.cap_decay_bps(), params.cap_decay_bps);
    let program = strategy_id();
    let bump = |seeds: &[&[u8]]| Pubkey::find_program_address(seeds, &program).1;
    let ms = market.market_state;
    assert_eq!(state.authority_bump, bump(&[b"authority", ms.as_ref()]));
    assert_eq!(
        state.token_vault_bump,
        bump(&[b"vault", ms.as_ref(), token.as_ref()])
    );
    assert_eq!(
        state.sol_vault_bump,
        bump(&[b"vault", ms.as_ref(), WSOL.as_ref()])
    );
    // Nothing is seeded yet: every pricing, ledger, cap and guard field is zero, and so is
    // the reserve.
    assert!(data[221..229].iter().all(|&b| b == 0), "seed_time");
    assert!(
        data[359..].iter().all(|&b| b == 0),
        "everything after the parameters"
    );

    // Both vaults exist, owned by the vault authority, and are empty.
    for vault in market.vaults() {
        let account = env.svm.get_account(&vault).unwrap();
        assert_eq!(account.owner, TOKEN);
        assert_eq!(&account.data[32..64], market.vault_authority.as_ref());
        assert_eq!(env.balance(&vault), 0);
    }
}

#[test]
fn every_creation_rule_is_refused_on_the_wrong_side_of_its_boundary() {
    use buy_wall_amm::errors::StrategyError::*;
    let mut env = Env::new();
    let token = env.create_mint(&TOKEN, 6);
    let seeder = env.admin.pubkey();
    let unset = Pubkey::default();
    let wallet = Pubkey::new_unique();

    type Change = fn(&mut buy_wall_amm::InitParams, Pubkey, Pubkey);
    // (what changes, the error when refused, or None when it must be accepted)
    let cases: Vec<(&str, Change, Option<buy_wall_amm::errors::StrategyError>)> = vec![
        ("fee 24", |p, _, _| p.fee_bps = 24, Some(FeeOutOfRange)),
        ("fee 25", |p, _, _| p.fee_bps = 25, None),
        ("fee 300", |p, _, _| p.fee_bps = 300, None),
        ("fee 301", |p, _, _| p.fee_bps = 301, Some(FeeOutOfRange)),
        ("wall split 0", |p, _, _| p.wall_split_bps = 0, None),
        (
            "wall split 10,000",
            |p, _, _| p.wall_split_bps = 10_000,
            None,
        ),
        (
            "wall split 10,001",
            |p, _, _| p.wall_split_bps = 10_001,
            Some(WallSplitOutOfRange),
        ),
        (
            "no fee recipient, wall split 10,000",
            |p, u, _| {
                p.wall_split_bps = 10_000;
                p.fee_recipient = u;
            },
            None,
        ),
        (
            "no fee recipient, wall split 9,999",
            |p, u, _| {
                p.wall_split_bps = 9_999;
                p.fee_recipient = u;
            },
            Some(FeeRecipientRequired),
        ),
        (
            "a fee recipient, wall split 10,000",
            |p, _, w| {
                p.wall_split_bps = 10_000;
                p.fee_recipient = w;
            },
            None,
        ),
        (
            "reward share 3,000",
            |p, _, _| p.reward_share_bps = 3_000,
            None,
        ),
        (
            "reward share 3,001",
            |p, _, _| p.reward_share_bps = 3_001,
            Some(RewardShareOutOfRange),
        ),
        (
            "reward share 0, no rewards recipient",
            |p, u, _| {
                p.reward_share_bps = 0;
                p.rewards_recipient = u;
            },
            None,
        ),
        (
            "reward share 0, a rewards recipient",
            |p, _, w| {
                p.reward_share_bps = 0;
                p.rewards_recipient = w;
            },
            Some(RewardsRecipientMismatch),
        ),
        (
            "reward share 1, no rewards recipient",
            |p, u, _| {
                p.reward_share_bps = 1;
                p.rewards_recipient = u;
            },
            Some(RewardsRecipientMismatch),
        ),
        (
            "reward share 1, a rewards recipient",
            |p, _, w| {
                p.reward_share_bps = 1;
                p.rewards_recipient = w;
            },
            None,
        ),
        (
            "cap floor 9",
            |p, _, _| p.cap_floor_bps = 9,
            Some(CapFloorOutOfRange),
        ),
        ("cap floor 10", |p, _, _| p.cap_floor_bps = 10, None),
        ("cap floor 10,000", |p, _, _| p.cap_floor_bps = 10_000, None),
        (
            "cap floor 10,001",
            |p, _, _| p.cap_floor_bps = 10_001,
            Some(CapFloorOutOfRange),
        ),
        ("cap decay 0", |p, _, _| p.cap_decay_bps = 0, None),
        ("cap decay 10,000", |p, _, _| p.cap_decay_bps = 10_000, None),
        (
            "cap decay 10,001",
            |p, _, _| p.cap_decay_bps = 10_001,
            Some(CapDecayOutOfRange),
        ),
        ("no seeder", |p, u, _| p.seeder = u, Some(SeederRequired)),
        ("a seeder", |p, _, w| p.seeder = w, None),
    ];
    for (name, change, refusal) in cases {
        let mut params = launch_params(seeder);
        change(&mut params, unset, wallet);
        let result = env.create_market(token, TOKEN, &params);
        match refusal {
            Some(error) => {
                println!("{name}: refused with {error:?}");
                assert_refused(result, error);
            }
            None => {
                result.unwrap_or_else(|e| panic!("{name} must be accepted: {e}"));
            }
        }
    }
}

#[test]
fn init_data_that_is_not_exactly_the_parameters_is_refused() {
    use buy_wall_amm::errors::StrategyError::BadInitData;
    let mut env = Env::new();
    let token = env.create_mint(&TOKEN, 6);
    let good = borsh::to_vec(&launch_params(env.admin.pubkey())).unwrap();
    let mut long = good.clone();
    long.push(0);
    for data in [vec![], good[..good.len() - 1].to_vec(), long] {
        let market_state = solana_keypair::Keypair::new();
        let (_, create) = env.create_market_ix(&market_state, token, TOKEN, data);
        assert_refused(env.send(&[create], &[&market_state]), BadInitData);
    }
}
