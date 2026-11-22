//! Creating a tax market through the real router (docs/spec/tax-amm.md, "Markets"): a valid
//! market is created with exactly the parameters its creator sent, and the strategy refuses
//! every market that breaks a rule, so no tax market can exist with a tax above the cap,
//! a mint that could drain it, or parameters nobody chose.
//!
//! Build first: `scripts/fetch-router.sh` and
//! `cargo build-sbf --manifest-path programs/tax-amm/Cargo.toml` (docs/toolchain.md).

mod common;

use common::*;
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use tax_amm::state::{MarketStatus, STATE_VERSION};

/// Checks every field of a newly created market state against what its creator sent.
fn assert_created_as_sent(env: &Env, market: &Market, params: &tax_amm::InitParams) {
    let state = env.tax_market(&market.market_state);
    assert_eq!(state.version, STATE_VERSION);
    assert_eq!(state.status, MarketStatus::Created);
    assert_eq!(state.mints.map(|m| ck(&m)), market.mints);
    assert_eq!(state.vaults.map(|v| ck(&v)), market.vaults);
    assert_eq!(state.params(), *params);
    assert_eq!(ck(&state.market_signer), market.market);
    assert_eq!(state.reserves, [0, 0]);
    assert_eq!(state.owed, [0; tax_amm::state::OWED_SLOTS]);
    assert_eq!(state.tax_collected, 0);
    assert_eq!(state.volume, [0, 0]);
    assert_eq!(state.swap_count, 0);
    assert!(!state.tax_authority_renounced);
    let clock: solana_clock::Clock = env.svm.get_sysvar();
    assert_eq!(state.created_slot, clock.slot);
    assert_eq!(state.created_at, clock.unix_timestamp);
}

#[test]
fn a_valid_spl_token_market_is_created_with_exactly_what_was_sent() {
    let mut env = Env::new();
    let mint_0 = env.create_mint(&TOKEN);
    let mint_1 = env.create_mint(&TOKEN);
    let seeder = Pubkey::new_unique();
    let params = valid_params(&seeder);
    let market = env
        .create_tax_market([(mint_0, TOKEN), (mint_1, TOKEN)], &params)
        .unwrap();

    assert_created_as_sent(&env, &market, &params);

    // The router recorded the mints in the creator's order, with the vaults at the PDAs.
    let recorded = env.router_market(&market.market);
    assert_eq!(recorded.mints(), &market.mints);
    assert_eq!(&recorded.vaults[..2], &market.vaults);
    assert!(!recorded.supports_exact_out);

    // Each vault is a token account of its mint, owned by the vault authority, and empty.
    for i in 0..2 {
        let vault = env.svm.get_account(&market.vaults[i]).unwrap();
        assert_eq!(vault.owner, TOKEN);
        assert_eq!(&vault.data[..32], market.mints[i].as_ref());
        assert_eq!(&vault.data[32..64], market.authority.as_ref());
        assert_eq!(env.balance(&market.vaults[i]), 0);
    }

    // One market-created event, carrying the parameters.
    let events = market_created_events(&market.created.logs);
    assert_eq!(events.len(), 1);
    assert_eq!(ck(&events[0].market_state), market.market_state);
    assert_eq!(events[0].mints.map(|m| ck(&m)), market.mints);
    assert_eq!(events[0].vaults.map(|v| ck(&v)), market.vaults);
    assert_eq!(events[0].params, params);
}

#[test]
fn a_market_state_keypair_signs_once() {
    // The same keypair can't make a second market: its account exists.
    let mut env = Env::new();
    let mint_0 = env.create_mint(&TOKEN);
    let mint_1 = env.create_mint(&TOKEN);
    let params = valid_params(&Pubkey::new_unique());
    let state = Keypair::new();
    let mints = [(mint_0, TOKEN), (mint_1, TOKEN)];
    env.create_tax_market_with(&state, mints, init_data(&params))
        .unwrap();
    assert!(env
        .create_tax_market_with(&state, mints, init_data(&params))
        .is_err());
    assert_eq!(env.tax_market(&state.pubkey()).params(), params);
}

/// A fresh env with two SPL Token mints, and a function that tries to create a market on
/// them with parameters changed from valid ones by `change`.
fn try_with(change: impl FnOnce(&mut tax_amm::InitParams)) -> Result<Market, String> {
    let mut env = Env::new();
    let mint_0 = env.create_mint(&TOKEN);
    let mint_1 = env.create_mint(&TOKEN);
    let mut params = valid_params(&Pubkey::new_unique());
    change(&mut params);
    env.create_tax_market([(mint_0, TOKEN), (mint_1, TOKEN)], &params)
}

use anchor_lang::prelude::Pubkey as AnchorKey;
use tax_amm::config::MAX_TAX_BPS;
use tax_amm::StrategyError as E;

#[test]
fn the_valid_parameters_pass() {
    try_with(|_| {}).unwrap();
}

#[test]
fn a_tax_range_above_max_tax_bps_is_refused() {
    assert_refused(
        try_with(|p| p.buy_tax_max_bps = MAX_TAX_BPS + 1),
        E::TaxAboveCap,
    );
    assert_refused(
        try_with(|p| p.sell_tax_max_bps = MAX_TAX_BPS + 1),
        E::TaxAboveCap,
    );
    // A rate above the cap can only sit inside a range above the cap.
    assert_refused(
        try_with(|p| {
            p.sell_tax_bps = u16::MAX;
            p.sell_tax_max_bps = u16::MAX;
        }),
        E::TaxAboveCap,
    );
    // The cap itself is allowed, for both rates.
    try_with(|p| {
        p.buy_tax_bps = MAX_TAX_BPS;
        p.buy_tax_max_bps = MAX_TAX_BPS;
        p.sell_tax_bps = MAX_TAX_BPS;
        p.sell_tax_max_bps = MAX_TAX_BPS;
    })
    .unwrap();
}

#[test]
fn a_rate_outside_its_range_is_refused() {
    // Valid ranges: buy [100, 800], sell [0, 1000].
    assert_refused(try_with(|p| p.buy_tax_bps = 99), E::RateOutsideRange);
    assert_refused(try_with(|p| p.buy_tax_bps = 801), E::RateOutsideRange);
    assert_refused(
        try_with(|p| {
            p.sell_tax_min_bps = 600;
            p.sell_tax_bps = 599;
        }),
        E::RateOutsideRange,
    );
    assert_refused(
        try_with(|p| {
            p.sell_tax_max_bps = 400;
            p.sell_tax_bps = 401;
        }),
        E::RateOutsideRange,
    );
    // Both ends of a range are inside it, and a range may be a single rate.
    try_with(|p| p.buy_tax_bps = 100).unwrap();
    try_with(|p| p.buy_tax_bps = 800).unwrap();
    try_with(|p| {
        p.sell_tax_bps = 0;
        p.sell_tax_max_bps = 0;
    })
    .unwrap();
}

#[test]
fn a_range_with_its_minimum_above_its_maximum_is_refused() {
    assert_refused(
        try_with(|p| {
            p.buy_tax_min_bps = 500;
            p.buy_tax_max_bps = 400;
            p.buy_tax_bps = 450;
        }),
        E::RangeInverted,
    );
    assert_refused(
        try_with(|p| {
            p.sell_tax_min_bps = 1;
            p.sell_tax_max_bps = 0;
            p.sell_tax_bps = 0;
        }),
        E::RangeInverted,
    );
}

#[test]
fn equal_mints_are_refused() {
    let mut env = Env::new();
    let mint = env.create_mint(&TOKEN);
    let params = valid_params(&Pubkey::new_unique());
    // Both vaults derive to the same address, which the router would reject as a duplicate
    // writable account if the strategy didn't refuse first; either way nothing is created.
    let result = env.create_tax_market([(mint, TOKEN), (mint, TOKEN)], &params);
    assert_refused(result, E::EqualMints);
}

#[test]
fn a_bad_tax_side_or_virtual_side_is_refused() {
    assert_refused(try_with(|p| p.tax_side = 2), E::BadTaxSide);
    assert_refused(try_with(|p| p.tax_side = u8::MAX), E::BadTaxSide);
    assert_refused(try_with(|p| p.virtual_side = 2), E::BadVirtualSide);
    try_with(|p| p.tax_side = 0).unwrap();
    try_with(|p| {
        p.virtual_side = 1;
        p.virtual_reserve = 1_000_000;
    })
    .unwrap();
}

#[test]
fn a_default_key_seeder_is_refused() {
    assert_refused(try_with(|p| p.seeder = AnchorKey::default()), E::NoSeeder);
}

#[test]
fn a_market_without_a_tax_authority_is_allowed() {
    try_with(|p| p.tax_authority = AnchorKey::default()).unwrap();
}

#[test]
fn no_recipient_is_refused() {
    assert_refused(
        try_with(|p| {
            p.recipients = [AnchorKey::default(); 4];
            p.shares = [0; 4];
            p.burn_share_bps = 10_000;
        }),
        E::NoRecipient,
    );
}

#[test]
fn a_used_slot_after_an_unused_one_is_refused() {
    assert_refused(
        try_with(|p| {
            p.recipients[2] = p.recipients[1];
            p.recipients[1] = AnchorKey::default();
            p.shares = [6_000, 0, 3_000, 0];
        }),
        E::RecipientsOutOfOrder,
    );
}

#[test]
fn a_used_slot_with_a_zero_share_is_refused() {
    assert_refused(
        try_with(|p| {
            p.shares = [9_000, 0, 0, 0];
        }),
        E::ZeroShare,
    );
}

#[test]
fn an_unused_slot_with_a_share_is_refused() {
    assert_refused(
        try_with(|p| {
            p.shares = [6_000, 2_000, 1_000, 0];
            p.burn_share_bps = 1_000;
        }),
        E::ShareWithoutRecipient,
    );
}

#[test]
fn shares_and_burn_not_summing_to_10000_are_refused() {
    assert_refused(try_with(|p| p.burn_share_bps = 999), E::SharesNotWhole);
    assert_refused(try_with(|p| p.burn_share_bps = 1_001), E::SharesNotWhole);
    // u16 shares can't wrap the sum around to 10,000.
    assert_refused(
        try_with(|p| {
            p.recipients = [p.recipients[0]; 4];
            p.shares = [u16::MAX; 4];
            p.burn_share_bps = u16::MAX;
        }),
        E::SharesNotWhole,
    );
    // Four recipients and no burn, and one recipient taking everything, are whole.
    try_with(|p| {
        p.recipients = [
            p.recipients[0],
            p.recipients[1],
            p.recipients[0],
            p.recipients[1],
        ];
        p.shares = [2_500; 4];
        p.burn_share_bps = 0;
    })
    .unwrap();
    try_with(|p| {
        p.recipients[1] = AnchorKey::default();
        p.shares = [10_000, 0, 0, 0];
        p.burn_share_bps = 0;
    })
    .unwrap();
}

#[test]
fn init_data_that_does_not_decode_is_refused() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let valid = init_data(&valid_params(&Pubkey::new_unique()));
    for data in [
        vec![],
        valid[..valid.len() - 1].to_vec(),
        [valid.clone(), vec![0]].concat(),
    ] {
        assert_refused(
            env.create_tax_market_with(&Keypair::new(), mints, data),
            E::BadInitData,
        );
    }
}

/// The market's own addresses and the programs it runs on, none of which can ever spend a
/// token sent to its associated token account (hardening finding H024, #67).
fn own_addresses(state: &Pubkey, mints: [Pubkey; 2]) -> Vec<Pubkey> {
    let (authority, vaults) = tax_market_addresses(state, mints);
    let signer = ck(&tax_amm::instructions::pipeline_market_signer(&ak(state)));
    vec![
        *state,
        authority,
        vaults[0],
        vaults[1],
        mints[0],
        mints[1],
        strategy_id(),
        signer,
        pipeline_client::PROGRAM_ID,
        TOKEN,
        TOKEN_2022,
        pipeline_client::ASSOCIATED_TOKEN_PROGRAM_ID,
        // The containment hook, which never moves a token it is paid (round 2, #67).
        containment_hook_id(),
    ]
}

/// Hardening finding H024 (#67): nothing refused a tax recipient that is one of the
/// market's own addresses, whose associated token account nobody can ever move tokens out
/// of, so `distribute` would strand its tax there while the payout event reads as paid.
#[test]
fn sos_h024_a_market_whose_tax_recipient_is_one_of_its_own_addresses_is_refused() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let state = Keypair::new();
    let own = own_addresses(&state.pubkey(), [mints[0].0, mints[1].0]);
    for (slot, address) in own.iter().enumerate().map(|(i, a)| (i % 2, a)) {
        let mut params = valid_params(&Pubkey::new_unique());
        params.recipients[slot] = ak(address);
        assert_refused(
            env.create_tax_market_with(&state, mints, init_data(&params)),
            E::NotAWallet,
        );
    }
    // The same market with wallets for recipients is created.
    env.create_tax_market_with(
        &state,
        mints,
        init_data(&valid_params(&Pubkey::new_unique())),
    )
    .unwrap();
}
