//! The market state's final layout, pinned (docs/spec/lending-pool.md; ticket "Every
//! lending AMM program ticket": no field moves, resizes or disappears after this ticket,
//! and a new field goes into the reserved space, with a zeroed value meaning the old
//! behaviour). Every field's offset is pinned here, so moving, resizing or reordering any of
//! them fails.

mod common;

use anchor_lang::prelude::Pubkey as AnchorKey;
use anchor_lang::{AccountSerialize, Discriminator};
use common::*;
use lending_amm::state::{layout, RESERVED_LEN, STATE_VERSION};
use lending_amm::LendingAmmMarket;

/// A market state whose every field holds a value no other field holds.
fn distinct_market() -> LendingAmmMarket {
    let key = |byte: u8| AnchorKey::new_from_array([byte; 32]);
    LendingAmmMarket {
        version: 0xA1,
        bump: 0xA2,
        authority_bump: 0xA3,
        lent_index: 0xA4,
        lp_fee_bps: 0xB1B2,
        withdraw_mode: true,
        mints: [key(0x01), key(0x02)],
        vaults: [key(0x03), key(0x04)],
        market_signer: key(0x05),
        lp_mint: key(0x06),
        ctoken_account: key(0x07),
        reserve: key(0x08),
        collateral_mint: key(0x09),
        seeder: key(0x0A),
        reserves: [u64::from_le_bytes([0xC1; 8]), u64::from_le_bytes([0xC2; 8])],
        ctokens: u64::from_le_bytes([0xC3; 8]),
        deposited: u128::from_le_bytes([0xD1; 16]),
        redeemed: u128::from_le_bytes([0xD2; 16]),
        created_slot: u64::from_le_bytes([0xE1; 8]),
        created_at: i64::from_le_bytes([0xE2; 8]),
        reserved: [0; RESERVED_LEN],
    }
}

#[test]
fn the_published_offsets_and_size_are_pinned() {
    assert_eq!(STATE_VERSION, 1);
    assert_eq!(layout::VERSION, 8);
    assert_eq!(layout::LENT_INDEX, 11);
    assert_eq!(layout::LP_FEE_BPS, 12);
    assert_eq!(layout::WITHDRAW_MODE, 14);
    assert_eq!(layout::MINTS, 15);
    assert_eq!(layout::RESERVES, 335);
    assert_eq!(layout::CTOKENS, 351);
    assert_eq!(layout::DEPOSITED, 359);
    assert_eq!(layout::REDEEMED, 375);
    assert_eq!(layout::RESERVED, 407);
    assert_eq!(RESERVED_LEN, 256);
    assert_eq!(layout::LEN, 663);
    assert_eq!(LendingAmmMarket::SPACE, layout::LEN);
}

#[test]
fn every_field_sits_at_its_pinned_offset() {
    let mut bytes = vec![];
    distinct_market().try_serialize(&mut bytes).unwrap();
    assert_eq!(bytes.len(), layout::LEN);

    let key = |byte: u8| vec![byte; 32];
    let pinned: Vec<(&str, usize, Vec<u8>)> = vec![
        ("discriminator", 0, LendingAmmMarket::DISCRIMINATOR.to_vec()),
        ("version", layout::VERSION, vec![0xA1]),
        ("bump", 9, vec![0xA2]),
        ("authority_bump", 10, vec![0xA3]),
        ("lent_index", layout::LENT_INDEX, vec![0xA4]),
        (
            "lp_fee_bps",
            layout::LP_FEE_BPS,
            0xB1B2u16.to_le_bytes().to_vec(),
        ),
        ("withdraw_mode", layout::WITHDRAW_MODE, vec![1]),
        ("mints[0]", layout::MINTS, key(0x01)),
        ("mints[1]", 47, key(0x02)),
        ("vaults[0]", 79, key(0x03)),
        ("vaults[1]", 111, key(0x04)),
        ("market_signer", 143, key(0x05)),
        ("lp_mint", 175, key(0x06)),
        ("ctoken_account", 207, key(0x07)),
        ("reserve", 239, key(0x08)),
        ("collateral_mint", 271, key(0x09)),
        ("seeder", 303, key(0x0A)),
        ("reserves[0]", layout::RESERVES, vec![0xC1; 8]),
        ("reserves[1]", 343, vec![0xC2; 8]),
        ("ctokens", layout::CTOKENS, vec![0xC3; 8]),
        ("deposited", layout::DEPOSITED, vec![0xD1; 16]),
        ("redeemed", layout::REDEEMED, vec![0xD2; 16]),
        ("created_slot", 391, vec![0xE1; 8]),
        ("created_at", 399, vec![0xE2; 8]),
        ("reserved", layout::RESERVED, vec![0; RESERVED_LEN]),
    ];
    let mut next = 0;
    for (name, offset, expected) in &pinned {
        assert_eq!(
            *offset, next,
            "{name} must follow the field before it with no gap"
        );
        assert_eq!(
            &bytes[*offset..*offset + expected.len()],
            expected.as_slice(),
            "{name}"
        );
        next = offset + expected.len();
    }
    assert_eq!(next, layout::LEN);
}

#[test]
fn a_created_market_state_has_the_pinned_size_a_zeroed_reserve_and_its_fields_in_place() {
    let mut env = Env::new();
    let spec = env.wsol_market_spec(30);
    let (market, _) = env.create_funded_market(&spec, [3 * SOL, 5 * SOL]).unwrap();
    let data = env.svm.get_account(&market.market_state).unwrap().data;
    assert_eq!(data.len(), layout::LEN);
    assert_eq!(data[layout::VERSION], STATE_VERSION);
    assert_eq!(data[layout::LENT_INDEX], 1);
    assert_eq!(
        &data[layout::LP_FEE_BPS..layout::LP_FEE_BPS + 2],
        &30u16.to_le_bytes()
    );
    assert_eq!(
        &data[layout::MINTS..layout::MINTS + 32],
        spec.mints[0].0.as_ref()
    );
    let reserve = |i: usize| {
        let at = layout::RESERVES + 8 * i;
        u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
    };
    assert_eq!([reserve(0), reserve(1)], [3 * SOL, 5 * SOL]);
    assert!(data[layout::RESERVED..].iter().all(|&b| b == 0));
}
