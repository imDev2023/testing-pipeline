//! The market state's layout is the one in the spec, for good
//! (docs/spec/pool4-for-solana.md, "Market state", "Byte offsets").
//!
//! The test reads the spec's byte offset table, writes a distinct value into every field
//! through the program's own setters, and reads each value back from the raw account bytes
//! at the offset, size and type the table states. So the table, the struct and the bytes on
//! chain can never disagree.

use anchor_lang::prelude::Pubkey;
use anchor_lang::Discriminator;
use buy_wall_amm::config::MARKET_STATE_SIZE;
use buy_wall_amm::state::{
    MarketState, DEPLOYED_LAYOUT_VERSIONS, LAYOUT_VERSION, MARKET_STATE_DISCRIMINATOR, RESERVE_LEN,
    STATUS_CREATED, STATUS_OPEN,
};

const SPEC: &str = include_str!("../../../docs/spec/pool4-for-solana.md");

struct Row {
    field: String,
    offset: usize,
    size: usize,
    kind: String,
}

/// The rows of the spec's "Byte offsets" table.
fn spec_rows() -> Vec<Row> {
    let section = SPEC
        .split("### Byte offsets")
        .nth(1)
        .expect("the spec has a Byte offsets section");
    let section = section.split("\n#").next().unwrap();
    section
        .lines()
        .filter(|line| line.starts_with("| `"))
        .map(|line| {
            let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
            assert_eq!(
                cells.len(),
                4,
                "a row has field, offset, size and type: {line}"
            );
            Row {
                field: cells[0].trim_matches('`').to_string(),
                offset: cells[1].parse().unwrap(),
                size: cells[2].parse().unwrap(),
                kind: cells[3].to_string(),
            }
        })
        .collect()
}

/// A value for field number `i`, distinct from every other field's and with no two equal
/// bytes in a row, so a field read at the wrong offset, size or byte order cannot match.
fn pattern(i: usize, size: usize) -> Vec<u8> {
    (0..size).map(|j| (i * 37 + j * 11 + 1) as u8).collect()
}

/// Writes `value` (little-endian bytes of the row's type) into `field` through the
/// program's setter for it.
fn set(state: &mut MarketState, field: &str, value: &[u8]) {
    let u8_ = || value[0];
    let u16_ = || u16::from_le_bytes(value.try_into().unwrap());
    let u64_ = || u64::from_le_bytes(value.try_into().unwrap());
    let i64_ = || i64::from_le_bytes(value.try_into().unwrap());
    let u128_ = || u128::from_le_bytes(value.try_into().unwrap());
    let key = || Pubkey::new_from_array(value.try_into().unwrap());
    match field {
        "layout_version" => state.layout_version = u8_(),
        "status" => state.status = u8_(),
        "authority_bump" => state.authority_bump = u8_(),
        "token_vault_bump" => state.token_vault_bump = u8_(),
        "sol_vault_bump" => state.sol_vault_bump = u8_(),
        "market_signer" => state.market_signer = key(),
        "token_mint" => state.token_mint = key(),
        "wsol_mint" => state.wsol_mint = key(),
        "token_vault" => state.token_vault = key(),
        "sol_vault" => state.sol_vault = key(),
        "seeder" => state.seeder = key(),
        "creation_slot" => state.set_creation_slot(u64_()),
        "creation_time" => state.set_creation_time(i64_()),
        "seed_time" => state.set_seed_time(i64_()),
        "volume[0]" => state.set_volume(0, u128_()).unwrap(),
        "volume[1]" => state.set_volume(1, u128_()).unwrap(),
        "fees_collected" => state.set_fees_collected(u128_()),
        "swap_count" => state.set_swap_count(u64_()),
        "fee_bps" => state.set_fee_bps(u16_()),
        "wall_split_bps" => state.set_wall_split_bps(u16_()),
        "reward_share_bps" => state.set_reward_share_bps(u16_()),
        "fee_recipient" => state.fee_recipient = key(),
        "rewards_recipient" => state.rewards_recipient = key(),
        "cap_floor_bps" => state.set_cap_floor_bps(u16_()),
        "cap_decay_bps" => state.set_cap_decay_bps(u16_()),
        "cap_floor" => state.set_cap_floor(u64_()),
        "cap_decay_per_day" => state.set_cap_decay_per_day(u64_()),
        "seeded_tokens" => state.set_seeded_tokens(u64_()),
        "sqrt_price" => state.set_sqrt_price(u128_()),
        "liquidity" => state.set_liquidity(u128_()),
        "wall_liquidity" => state.set_wall_liquidity(u128_()),
        "wall_top" => state.set_wall_top(u128_()),
        "wall_sol_placed" => state.set_wall_sol_placed(u64_()),
        "pool_tokens" => state.set_pool_tokens(u64_()),
        "pool_sol" => state.set_pool_sol(u64_()),
        "retired_tokens" => state.set_retired_tokens(u64_()),
        "rewards_owed" => state.set_rewards_owed(u64_()),
        "idle_sol" => state.set_idle_sol(u64_()),
        "fees_recipient" => state.set_fees_recipient(u64_()),
        "fees_designer" => state.set_fees_designer(u64_()),
        "fees_suite" => state.set_fees_suite(u64_()),
        "cap" => state.set_cap(u64_()),
        "decay_credit" => state.set_decay_credit(u128_()),
        "decay_time" => state.set_decay_time(i64_()),
        "ref" => state.set_reference(u128_()),
        "ref_time" => state.set_ref_time(i64_()),
        "floor" => state.set_floor(u128_()),
        "floor_time" => state.set_floor_time(i64_()),
        "last_slot" => state.set_last_slot(u64_()),
        "last_close" => state.set_last_close(u128_()),
        "tokens_trimmed" => state.set_tokens_trimmed(u128_()),
        "sol_trimmed" => state.set_sol_trimmed(u128_()),
        "wall_tokens_bought" => state.set_wall_tokens_bought(u128_()),
        "tokens_burned" => state.set_tokens_burned(u128_()),
        "rewards_paid" => state.set_rewards_paid(u128_()),
        "tips_paid" => state.set_tips_paid(u128_()),
        "cap_fall_unmatched" => state.set_cap_fall_unmatched(u64_()),
        "retired_rewardable" => state.set_retired_rewardable(u64_()),
        other => panic!("the spec names a field the program has no setter for: {other}"),
    }
}

/// The account bytes of `state`: the discriminator, then the struct.
fn account_bytes(state: &MarketState) -> Vec<u8> {
    let mut bytes = MarketState::DISCRIMINATOR.to_vec();
    bytes.extend_from_slice(bytemuck::bytes_of(state));
    bytes
}

#[test]
fn the_offset_table_covers_the_whole_account_with_no_gap_or_overlap() {
    let rows = spec_rows();
    let mut next = 0;
    for row in &rows {
        assert_eq!(
            row.offset, next,
            "{} starts at {}, not {next}",
            row.field, row.offset
        );
        let expected_size = match row.kind.as_str() {
            "u8" => Some(1),
            "u16" => Some(2),
            "u64" | "i64" => Some(8),
            "u128" => Some(16),
            "pubkey" => Some(32),
            "bytes" => None,
            other => panic!("unknown type {other} for {}", row.field),
        };
        if let Some(size) = expected_size {
            assert_eq!(
                row.size, size,
                "{} is a {} of {} bytes",
                row.field, row.kind, row.size
            );
        }
        next += row.size;
    }
    assert_eq!(next, MARKET_STATE_SIZE);
    assert_eq!(rows.first().unwrap().field, "discriminator");
    let reserve = rows.last().unwrap();
    assert_eq!(
        (reserve.field.as_str(), reserve.size),
        ("reserve", RESERVE_LEN)
    );
    let zeroed: MarketState = bytemuck::Zeroable::zeroed();
    assert_eq!(account_bytes(&zeroed).len(), MARKET_STATE_SIZE);
}

#[test]
fn every_field_is_at_its_stated_offset() {
    let rows = spec_rows();
    let mut state: MarketState = bytemuck::Zeroable::zeroed();
    let mut written = vec![];
    for (i, row) in rows.iter().enumerate() {
        if row.kind == "bytes" {
            continue; // the discriminator and the reserve; checked below
        }
        let value = pattern(i, row.size);
        set(&mut state, &row.field, &value);
        written.push((row, value));
    }
    let bytes = account_bytes(&state);
    for (row, value) in &written {
        assert_eq!(
            &bytes[row.offset..row.offset + row.size],
            &value[..],
            "{} read back from offset {}",
            row.field,
            row.offset
        );
    }
    // Every byte outside the discriminator and the fields is the reserve, still zeroed.
    let reserve = rows.last().unwrap();
    assert!(bytes[reserve.offset..].iter().all(|&b| b == 0));
    assert_eq!(&bytes[..8], b"BWMARKET");
}

#[test]
fn the_discriminator_is_fixed_bytes_never_derived_from_a_name() {
    // The published value (docs/spec/pool4-for-solana.md, "Byte offsets"; POOL4-21, POOL4-22).
    assert_eq!(
        MARKET_STATE_DISCRIMINATOR,
        &[0x42, 0x57, 0x4d, 0x41, 0x52, 0x4b, 0x45, 0x54]
    );
    // What Anchor reads and writes as the account's discriminator is exactly that.
    assert_eq!(MarketState::DISCRIMINATOR, b"BWMARKET");
}

#[test]
fn layout_version_one_is_the_only_deployed_layout() {
    assert_eq!(LAYOUT_VERSION, 1);
    assert_eq!(DEPLOYED_LAYOUT_VERSIONS, &[1]);
    assert_eq!((STATUS_CREATED, STATUS_OPEN), (1, 2));
}
