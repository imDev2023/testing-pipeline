//! The market state's byte layout, pinned (docs/spec/tax-amm.md, "Counters for the
//! containment hook"). The containment hook reads the tax side and `tax_collected` straight
//! from a market state's bytes, so they and every field before them must never move. Every
//! field's offset is pinned here, so moving, resizing or reordering any of them fails.

mod common;

use anchor_lang::prelude::Pubkey as AnchorKey;
use anchor_lang::{AccountSerialize, Discriminator};
use common::*;
use pipeline_client::Pubkey;
use tax_amm::state::{layout, MarketStatus, OWED_SLOTS, RESERVED_LEN};
use tax_amm::TaxMarket;

/// A market state whose every field holds a value no other field holds.
fn distinct_market() -> TaxMarket {
    let key = |byte: u8| AnchorKey::new_from_array([byte; 32]);
    TaxMarket {
        version: 0xA1,
        status: MarketStatus::Created,
        tax_side: 0xA2,
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
        virtual_reserve: 0xD1D1_D1D1_D1D1_D1D1,
        reserves: [0xD2D2_D2D2_D2D2_D2D2, 0xD3D3_D3D3_D3D3_D3D3],
        owed: [0xE1, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6].map(|b| u64::from_le_bytes([b; 8])),
        tax_collected: u128::from_le_bytes([0xF1; 16]),
        volume: [
            u128::from_le_bytes([0xF2; 16]),
            u128::from_le_bytes([0xF3; 16]),
        ],
        swap_count: u64::from_le_bytes([0xF4; 8]),
        created_slot: u64::from_le_bytes([0xF5; 8]),
        created_at: i64::from_le_bytes([0xF6; 8]),
        pending_buy_tax_bps: 0xF7F7,
        pending_sell_tax_bps: 0xF8F8,
        pending_from_slot: u64::from_le_bytes([0xF9; 8]),
        reserved: [0; RESERVED_LEN],
    }
}

fn le16(v: u16) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

#[test]
fn the_published_offsets_and_size_are_pinned() {
    assert_eq!(layout::TAX_SIDE, 10);
    assert_eq!(layout::TAX_COLLECTED, 460);
    assert_eq!(layout::LEN, 596);
    assert_eq!(TaxMarket::SPACE, layout::LEN);
    assert_eq!(OWED_SLOTS, 6);
}

#[test]
fn every_field_sits_at_its_pinned_offset() {
    let market = distinct_market();
    let mut bytes = vec![];
    market.try_serialize(&mut bytes).unwrap();
    assert_eq!(bytes.len(), layout::LEN);

    let key = |byte: u8| vec![byte; 32];
    let pinned: Vec<(&str, usize, Vec<u8>)> = vec![
        ("discriminator", 0, TaxMarket::DISCRIMINATOR.to_vec()),
        ("version", 8, vec![0xA1]),
        ("status", 9, vec![0]),
        ("tax_side", layout::TAX_SIDE, vec![0xA2]),
        ("virtual_side", 11, vec![0xA3]),
        ("authority_bump", 12, vec![0xA4]),
        ("tax_authority_renounced", 13, vec![1]),
        ("mints[0]", 14, key(0x01)),
        ("mints[1]", 46, key(0x02)),
        ("vaults[0]", 78, key(0x03)),
        ("vaults[1]", 110, key(0x04)),
        ("market_signer", 142, key(0x05)),
        ("buy_tax_bps", 174, le16(0xB1B1)),
        ("sell_tax_bps", 176, le16(0xB2B2)),
        ("buy_tax_min_bps", 178, le16(0xB3B3)),
        ("buy_tax_max_bps", 180, le16(0xB4B4)),
        ("sell_tax_min_bps", 182, le16(0xB5B5)),
        ("sell_tax_max_bps", 184, le16(0xB6B6)),
        ("tax_authority", 186, key(0x06)),
        ("seeder", 218, key(0x07)),
        ("recipients[0]", 250, key(0x08)),
        ("recipients[1]", 282, key(0x09)),
        ("recipients[2]", 314, key(0x0A)),
        ("recipients[3]", 346, key(0x0B)),
        (
            "shares",
            378,
            [0xC1C1u16, 0xC2C2, 0xC3C3, 0xC4C4]
                .iter()
                .flat_map(|s| le16(*s))
                .collect(),
        ),
        ("burn_share_bps", 386, le16(0xC5C5)),
        ("virtual_reserve", 388, vec![0xD1; 8]),
        ("reserves[0]", 396, vec![0xD2; 8]),
        ("reserves[1]", 404, vec![0xD3; 8]),
        (
            "owed",
            412,
            [0xE1u8, 0xE2, 0xE3, 0xE4, 0xE5, 0xE6]
                .iter()
                .flat_map(|b| vec![*b; 8])
                .collect(),
        ),
        ("tax_collected", layout::TAX_COLLECTED, vec![0xF1; 16]),
        ("volume[0]", 476, vec![0xF2; 16]),
        ("volume[1]", 492, vec![0xF3; 16]),
        ("swap_count", 508, vec![0xF4; 8]),
        ("created_slot", 516, vec![0xF5; 8]),
        ("created_at", 524, vec![0xF6; 8]),
        // Taken from the reserve in #67, so markets created before read zeros: nothing
        // pending.
        ("pending_buy_tax_bps", 532, le16(0xF7F7)),
        ("pending_sell_tax_bps", 534, le16(0xF8F8)),
        ("pending_from_slot", 536, vec![0xF9; 8]),
        ("reserved", 544, vec![0; RESERVED_LEN]),
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
fn a_created_market_state_has_the_pinned_size_and_its_tax_side_at_the_pinned_offset() {
    for tax_side in [0u8, 1] {
        let mut env = Env::new();
        let mints = [
            (env.create_mint(&TOKEN), TOKEN),
            (env.create_mint(&TOKEN), TOKEN),
        ];
        let mut params = valid_params(&Pubkey::new_unique());
        params.tax_side = tax_side;
        let market = env.create_tax_market(mints, &params).unwrap();
        let data = env.svm.get_account(&market.market_state).unwrap().data;
        assert_eq!(data.len(), layout::LEN);
        assert_eq!(data[layout::TAX_SIDE], tax_side);
        let tax_collected = &data[layout::TAX_COLLECTED..layout::TAX_COLLECTED + 16];
        assert_eq!(u128::from_le_bytes(tax_collected.try_into().unwrap()), 0);
    }
}

/// Writes `version` into a market state's version byte, the one after its discriminator.
fn set_version(env: &mut Env, market_state: &Pubkey, version: u8) {
    let mut account = env.svm.get_account(market_state).unwrap();
    account.data[8] = version;
    env.svm.set_account(*market_state, account).unwrap();
}

/// Hardening finding H069 (#67): the version byte was written and never read, so a build
/// rolled back under markets a newer build had written would read their bytes with the
/// older layout's meaning. Every instruction now refuses a market state whose version is
/// newer than the program's own, and accepts its own.
#[test]
fn sos_h069_a_market_state_written_by_a_newer_version_is_refused_by_every_instruction() {
    use common::authority::*;
    use solana_keypair::Keypair;
    use solana_signer::Signer;
    use tax_amm::state::STATE_VERSION;
    use tax_amm::StrategyError::NewerStateVersion;

    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let (authority, seeder) = (Keypair::new(), Keypair::new());
    env.svm.airdrop(&authority.pubkey(), SOL).unwrap();
    let params = tax_amm::InitParams {
        tax_authority: ak(&authority.pubkey()),
        ..valid_params(&seeder.pubkey())
    };
    let newer = STATE_VERSION + 1;

    // The seed of a market created and not yet seeded.
    let created = env.create_tax_market(mints, &params).unwrap();
    env.fund(&seeder.pubkey(), &created, [1_000_000_000, 1_000_000_000]);
    set_version(&mut env, &created.market_state, newer);
    assert_refused(
        env.seed(&created, &seeder, [1_000_000_000, 1_000_000_000]),
        NewerStateVersion,
    );
    set_version(&mut env, &created.market_state, STATE_VERSION);
    env.seed(&created, &seeder, [1_000_000_000, 1_000_000_000])
        .unwrap();

    // Everything else, on the market now open and traded.
    let market = created;
    let trader = env.funded_wallet(&market, 1_000_000_000);
    env.swap(&market, &trader, (0, 1), 10_000_000).unwrap();
    let caller = Keypair::new();
    env.svm.airdrop(&caller.pubkey(), SOL).unwrap();
    set_version(&mut env, &market.market_state, newer);
    assert_refused(
        env.quote(&market, &exact_in(0, 1, 1_000)),
        NewerStateVersion,
    );
    assert_refused(
        env.market_info_meta(&market.market_state),
        NewerStateVersion,
    );
    assert_refused(env.swap(&market, &trader, (0, 1), 1_000), NewerStateVersion);
    assert_refused(env.distribute(&market, &caller, 0), NewerStateVersion);
    let state = market.market_state;
    let who = authority.pubkey();
    for action in [
        set_taxes_instruction(&state, &who, 100, 100),
        renounce_instruction(&state, &who),
    ] {
        assert_refused(env.send_signed(action, &authority), NewerStateVersion);
    }
    // Its own version passes again.
    set_version(&mut env, &market.market_state, STATE_VERSION);
    env.quote(&market, &exact_in(0, 1, 1_000)).unwrap();
    env.distribute(&market, &caller, 0).unwrap();
}

/// Hardening finding H041 (#67): the market state's discriminator was only ever compared
/// with itself (the IDL's is built from the same code), so renaming the account type would
/// pass every test while every live market and the containment hook's check of its bytes
/// stopped matching. It is pinned here as the bytes live markets carry: the first eight of
/// `sha256("account:TaxMarket")`.
#[test]
fn sos_h041_the_market_states_discriminator_is_the_one_live_markets_carry() {
    assert_eq!(
        TaxMarket::DISCRIMINATOR,
        [160, 70, 114, 42, 147, 206, 67, 97]
    );
}
