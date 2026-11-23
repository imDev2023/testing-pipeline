//! The hook reads three other programs' accounts straight from their bytes. Each reading is
//! checked here against the owning program's own definition, so they can never drift apart
//! unnoticed:
//!
//! - the tax AMM's market state, through the offsets its crate publishes and pins
//!   (`tax-amm/tests/layout.rs`): the tax side the hook reads is the one the tax AMM wrote;
//! - the router's `Market`, against `pipeline-client`'s decoder, on markets the real router
//!   created;
//! - a Token-2022 mint and a Token-2022 token account, against Token-2022's own state code.

mod support;

use anchor_lang::prelude::Pubkey as AnchorKey;
use anchor_lang::{AccountSerialize, Discriminator};
use containment_hook::{mint, router, tax_market, token_account};
use pipeline_client::Pubkey;
use support::*;
use tax_amm::state::{layout, MarketStatus, RESERVED_LEN};
use tax_amm::TaxMarket;

/// A market state whose every field holds a value no other field holds, with `tax_side`.
fn distinct_market(tax_side: u8) -> TaxMarket {
    let key = |byte: u8| AnchorKey::new_from_array([byte; 32]);
    TaxMarket {
        // The one version the hook reads (a newer one reads as unreadable).
        version: tax_amm::state::STATE_VERSION,
        status: MarketStatus::Created,
        tax_side,
        virtual_side: 0xA3,
        authority_bump: 0xA4,
        tax_authority_renounced: true,
        mints: [key(0x01), key(0x02)],
        vaults: [key(0x03), key(0x04)],
        market_signer: key(0x05),
        buy_tax_bps: 0xB1B1,
        sell_tax_bps: 0xB2B2,
        buy_tax_min_bps: 0xB3B3,
        buy_tax_max_bps: 0xB4B4,
        sell_tax_min_bps: 0xB5B5,
        sell_tax_max_bps: 0xB6B6,
        tax_authority: key(0x06),
        seeder: key(0x07),
        recipients: [key(0x08), key(0x09), key(0x0A), key(0x0B)],
        shares: [0xC1C1, 0xC2C2, 0xC3C3, 0xC4C4],
        burn_share_bps: 0xC5C5,
        virtual_reserve: u64::MAX,
        reserves: [u64::MAX - 1, u64::MAX - 2],
        owed: [0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6].map(|b| u64::from_le_bytes([b; 8])),
        tax_collected: u128::from_le_bytes([0xF1; 16]),
        volume: [u128::MAX, u128::MAX - 1],
        swap_count: u64::MAX,
        created_slot: u64::MAX,
        created_at: i64::MIN,
        pending_buy_tax_bps: u16::MAX,
        pending_sell_tax_bps: u16::MAX,
        pending_from_slot: u64::MAX,
        reserved: [0xFF; RESERVED_LEN],
    }
}

#[test]
fn the_hook_reads_the_tax_side_the_tax_amm_wrote() {
    for tax_side in [0u8, 1, 0xA2] {
        let mut bytes = vec![];
        distinct_market(tax_side).try_serialize(&mut bytes).unwrap();
        assert_eq!(tax_market::tax_side(&bytes), Some(tax_side));
    }
}

#[test]
fn the_hook_reads_only_whole_tax_amm_market_states() {
    let mut bytes = vec![];
    distinct_market(1).try_serialize(&mut bytes).unwrap();
    assert_eq!(bytes.len(), layout::LEN);
    let mut short = bytes.clone();
    short.pop();
    assert_eq!(tax_market::tax_side(&short), None);
    let mut long = bytes.clone();
    long.push(0);
    assert_eq!(tax_market::tax_side(&long), None);
    let mut other = bytes.clone();
    other[0] ^= 1;
    assert_eq!(tax_market::tax_side(&other), None);
    assert_eq!(&bytes[..8], TaxMarket::DISCRIMINATOR);
}

#[test]
fn the_hook_reads_the_tax_collected_the_tax_amm_wrote() {
    for tax_collected in [0u128, 1, u64::MAX as u128, u64::MAX as u128 + 1, u128::MAX] {
        let mut market = distinct_market(1);
        market.tax_collected = tax_collected;
        let mut bytes = vec![];
        market.try_serialize(&mut bytes).unwrap();
        assert_eq!(tax_market::tax_collected(&bytes), Some(tax_collected));
    }
    let mut bytes = vec![];
    distinct_market(1).try_serialize(&mut bytes).unwrap();
    assert_eq!(
        tax_market::tax_collected(&bytes),
        Some(u128::from_le_bytes([0xF1; 16]))
    );
    for broken in [
        bytes[..bytes.len() - 1].to_vec(),
        [bytes.as_slice(), &[0]].concat(),
        {
            let mut other = bytes.clone();
            other[0] ^= 1;
            other
        },
    ] {
        assert_eq!(tax_market::tax_collected(&broken), None);
    }
}

#[test]
fn the_hook_reads_the_tax_collected_of_a_real_market_after_trades() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let trader = trader(&mut env, &launched, 10 * SOL);
    let bought = buy(&mut env, &launched, &trader, SOL);
    sell(&mut env, &launched, &trader, bought.received / 2);
    let state = env.tax_market(&launched.market.market_state);
    assert!(state.tax_collected > 0);
    let data = env
        .svm
        .get_account(&launched.market.market_state)
        .unwrap()
        .data;
    assert_eq!(tax_market::tax_collected(&data), Some(state.tax_collected));
}

#[test]
fn the_hook_reads_the_tax_side_of_real_markets() {
    let mut env = hook_env();
    for tax_side in [0u8, 1] {
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN), TOKEN),
        ];
        let params = quote_taxed_params(&Pubkey::new_unique(), tax_side);
        let market = env.create_tax_market(mints, &params).unwrap();
        let data = env.svm.get_account(&market.market_state).unwrap().data;
        assert_eq!(
            tax_market::tax_side(&data),
            Some(env.tax_market(&market.market_state).tax_side)
        );
        assert_eq!(tax_market::tax_side(&data), Some(tax_side));
    }
}

#[test]
fn the_hook_reads_the_router_market_as_pipeline_client_does() {
    let mut env = hook_env();
    let (mint, tax) = contained_market(&mut env);
    let other = contained_mint(&mut env);
    let quote = env.create_mint(&TOKEN);
    let cp = cp_market(&mut env, [(other, TOKEN_2022), (quote, TOKEN)]);
    for market in [&tax, &cp] {
        let data = env.svm.get_account(&market.market).unwrap().data;
        let theirs = env.router_market(&market.market);
        let ours = router::read_market(&data).expect("a router Market");
        assert_eq!(ck(&ours.strategy), theirs.strategy_program);
        assert_eq!(ck(&ours.market_state), theirs.market_state);
        assert_eq!(ours.mint_count, theirs.mint_count);
        assert_eq!(ours.mints.map(|m| ck(&m)), theirs.mints);
        assert_eq!(ours.vaults.map(|v| ck(&v)), theirs.vaults);
        assert_eq!(ours.bump, theirs.bump);
        assert_eq!(ours.fee_authority_bump, theirs.fee_authority_bump);
        assert_eq!(
            router::market_address(&ours).map(|a| ck(&a)),
            Some(market.market)
        );
        // The fee account the hook derives is the one the router's init_fee_account made.
        for (i, mint) in market.mints.iter().enumerate() {
            if market.token_programs[i] == TOKEN_2022 {
                let derived = router::fee_account(&ak(&market.market), &ours, &ak(mint)).unwrap();
                assert_eq!(ck(&derived), fee_account(market, mint));
                assert!(env.svm.get_account(&ck(&derived)).is_some());
            }
        }
    }
    assert_eq!(
        router::MARKET_DISCRIMINATOR,
        pipeline_client::account_discriminator("Market")
    );
    assert_eq!(
        router::ROUTER_PROGRAM_ID.to_bytes(),
        pipeline_client::PROGRAM_ID.to_bytes()
    );
    let _ = mint;
}

#[test]
fn the_hook_reads_mints_as_token_2022_lays_them_out() {
    use spl_token_2022_interface::extension::{
        transfer_hook::TransferHook, BaseStateWithExtensions, StateWithExtensions,
    };
    use spl_token_2022_interface::state::Mint;

    let mut env = hook_env();
    let plain = env.create_mint(&TOKEN_2022);
    let contained = contained_mint(&mut env);
    let frozen = contained_mint_with(
        &mut env,
        MintOptions {
            freeze_authority: true,
            ..MintOptions::default()
        },
    );
    let spl = env.create_mint(&TOKEN);
    for address in [plain, contained, frozen, spl] {
        let data = env.svm.get_account(&address).unwrap().data;
        let facts = mint::read_mint(&data).expect("a mint");
        let theirs = StateWithExtensions::<Mint>::unpack(&data).unwrap();
        let bytes = |key: Option<Pubkey>| key.map(|k| k.to_bytes());
        assert_eq!(
            facts.mint_authority,
            bytes(theirs.base.mint_authority.into())
        );
        assert_eq!(
            facts.freeze_authority,
            bytes(theirs.base.freeze_authority.into())
        );
        match theirs.get_extension::<TransferHook>() {
            Ok(hook) => {
                let ours = facts.transfer_hook.expect("the hook extension");
                assert_eq!(ours.authority, bytes(hook.authority.into()));
                assert_eq!(ours.program, bytes(hook.program_id.into()));
            }
            Err(_) => assert_eq!(facts.transfer_hook, None),
        }
    }
    let data = env.svm.get_account(&contained).unwrap().data;
    let hook = mint::read_mint(&data).unwrap().transfer_hook.unwrap();
    assert_eq!(hook.program, Some(hook_id().to_bytes()));
    assert_eq!(hook.authority, Some(unlock_pda(&contained).to_bytes()));
}

#[test]
fn the_hook_reads_the_transferring_flag_as_token_2022_lays_it_out() {
    use spl_token_2022_interface::extension::{
        transfer_hook::TransferHookAccount, BaseStateWithExtensionsMut, StateWithExtensionsMut,
    };
    use spl_token_2022_interface::state::Account;

    let mut env = hook_env();
    let contained = contained_mint(&mut env);
    let other = contained_mint(&mut env);
    let owner = Pubkey::new_unique();
    let address = token_2022_account(&mut env, &owner, &contained);
    let second = second_token_account(&mut env, &owner, &contained);
    for address in [address, second] {
        let mut data = env.svm.get_account(&address).unwrap().data;
        let ours =
            |data: &[u8], mint: &Pubkey| token_account::is_mid_transfer_data(data, &ak(mint));
        assert!(!ours(&data, &contained), "an account at rest");
        // Token-2022's own code sets the flag, as it does for the length of a transfer.
        StateWithExtensionsMut::<Account>::unpack(&mut data)
            .unwrap()
            .get_extension_mut::<TransferHookAccount>()
            .unwrap()
            .transferring = true.into();
        assert!(ours(&data, &contained), "an account mid-transfer");
        assert!(!ours(&data, &other), "another mint's");
        // A mint's bytes are never a token account's, whatever follows its account type.
        let mint = env.svm.get_account(&contained).unwrap().data;
        assert!(!ours(&mint, &contained));
    }
}
