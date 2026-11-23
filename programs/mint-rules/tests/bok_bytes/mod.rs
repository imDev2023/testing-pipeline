//! Book of Knowledge byte generators (#74), shared by `mint-rules/tests/bok_tlv.rs` and
//! `containment-hook/tests/bok_readers.rs` (by `#[path]`): bytes that start as a valid
//! Token-2022 mint or token account, then carry any padding byte, any account type and any
//! list of entries, well formed or not; and `run_paired`, the tax AMM's convention for
//! properties that say something only on some cases.
#![allow(dead_code)]

use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use std::sync::atomic::{AtomicU32, Ordering};

pub const CASES: u32 = 10_000;
/// Properties that say something only on bytes Token-2022 unpacks: four times the cases,
/// and the test fails unless at least `CASES` of them were such bytes.
pub const PAIRED_CASES: u32 = 4 * CASES;
pub const ACCOUNT_LEN: usize = 165;
pub const MINT_LEN: usize = 82;

pub fn run_paired<S: Strategy>(
    strategy: S,
    property: impl Fn(S::Value) -> Result<bool, TestCaseError>,
) where
    S::Value: std::fmt::Debug,
{
    let exercised = AtomicU32::new(0);
    let mut runner = TestRunner::new(Config::with_cases(PAIRED_CASES));
    runner
        .run(&strategy, |value| {
            if property(value)? {
                exercised.fetch_add(1, Ordering::Relaxed);
            }
            Ok(())
        })
        .unwrap();
    let exercised = exercised.into_inner();
    assert!(
        exercised >= CASES,
        "only {exercised} of {PAIRED_CASES} cases exercised the property"
    );
}

/// A `COption<Pubkey>` as SPL Token and Token-2022 lay it out.
pub fn option_key(key: Option<[u8; 32]>) -> Vec<u8> {
    match key {
        Some(key) => [[1u8, 0, 0, 0].as_slice(), &key].concat(),
        None => [0u8; 36].to_vec(),
    }
}

/// A valid 82-byte mint base.
pub fn mint_base() -> impl Strategy<Value = Vec<u8>> {
    (
        proptest::option::of(any::<[u8; 32]>()),
        any::<u64>(),
        any::<u8>(),
        proptest::option::of(any::<[u8; 32]>()),
    )
        .prop_map(|(authority, supply, decimals, freeze)| {
            let mut data = option_key(authority);
            data.extend_from_slice(&supply.to_le_bytes());
            data.push(decimals);
            data.push(1);
            data.extend(option_key(freeze));
            assert_eq!(data.len(), MINT_LEN);
            data
        })
}

/// A valid 165-byte token account base of `mint`, initialized.
pub fn account_base(mint: [u8; 32]) -> impl Strategy<Value = Vec<u8>> {
    (
        any::<[u8; 32]>(),
        any::<u64>(),
        proptest::option::of(any::<[u8; 32]>()),
        prop_oneof![Just(1u8), Just(2u8)],
        proptest::option::of(any::<u64>()),
        any::<u64>(),
        proptest::option::of(any::<[u8; 32]>()),
    )
        .prop_map(
            move |(owner, amount, delegate, state, native, delegated, close)| {
                let mut data = mint.to_vec();
                data.extend_from_slice(&owner);
                data.extend_from_slice(&amount.to_le_bytes());
                data.extend(option_key(delegate));
                data.push(state);
                match native {
                    Some(rent) => {
                        data.extend_from_slice(&[1, 0, 0, 0]);
                        data.extend_from_slice(&rent.to_le_bytes());
                    }
                    None => data.extend_from_slice(&[0; 12]),
                }
                data.extend_from_slice(&delegated.to_le_bytes());
                data.extend(option_key(close));
                assert_eq!(data.len(), ACCOUNT_LEN);
                data
            },
        )
}

/// One entry: its type (the hook's two, others allowed, refused ones, unknown ones, and the
/// `Uninitialized` 0 that ends a list), its length (usually its value's, sometimes any), and
/// its value.
pub fn entry() -> impl Strategy<Value = Vec<u8>> {
    let extension_type = prop_oneof![
        3 => Just(14u16),
        3 => Just(15u16),
        2 => prop_oneof![Just(18u16), Just(19), Just(20), Just(21), Just(22), Just(23)],
        1 => Just(0u16),
        1 => 1u16..30,
        1 => any::<u16>(),
    ];
    let half = || prop_oneof![Just([0u8; 32]), any::<[u8; 32]>()];
    let value = prop_oneof![
        3 => (half(), half()).prop_map(|(a, b)| [a, b].concat()),
        2 => proptest::collection::vec(prop_oneof![Just(0u8), Just(1u8), any::<u8>()], 1),
        2 => proptest::collection::vec(any::<u8>(), 0..80),
    ];
    let length = prop_oneof![8 => Just(None), 1 => any::<u16>().prop_map(Some), 1 => (0u16..90).prop_map(Some)];
    (extension_type, value, length).prop_map(|(extension_type, value, length)| {
        let len = length.unwrap_or(value.len() as u16);
        let mut bytes = extension_type.to_le_bytes().to_vec();
        bytes.extend_from_slice(&len.to_le_bytes());
        bytes.extend(value);
        bytes
    })
}

/// After a base: the padding up to 165 bytes (a mint's; usually zeros), the account type
/// (usually the base's own), entries, trailing bytes, and sometimes one byte overwritten
/// anywhere after the base.
pub fn extended(
    base: impl Strategy<Value = Vec<u8>>,
    own_type: u8,
) -> impl Strategy<Value = Vec<u8>> {
    (
        base,
        prop_oneof![9 => Just(None), 1 => (any::<usize>(), 1u8..=255).prop_map(Some)],
        prop_oneof![8 => Just(own_type), 1 => 0u8..4, 1 => any::<u8>()],
        proptest::collection::vec(entry(), 0..5),
        proptest::collection::vec(any::<u8>(), 0..5),
        prop_oneof![3 => Just(None), 1 => (any::<usize>(), any::<u8>()).prop_map(Some)],
        prop_oneof![9 => Just(true), 1 => Just(false)],
    )
        .prop_map(
            |(mut data, padding, account_type, entries, trailing, overwrite, with_type)| {
                if data.len() < ACCOUNT_LEN {
                    data.resize(ACCOUNT_LEN, 0);
                    if let Some((at, byte)) = padding {
                        let at = MINT_LEN + at % (ACCOUNT_LEN - MINT_LEN);
                        data[at] = byte;
                    }
                }
                if !with_type {
                    return data;
                }
                data.push(account_type);
                for entry in entries {
                    data.extend(entry);
                }
                data.extend(trailing);
                if let Some((at, byte)) = overwrite {
                    let at = ACCOUNT_LEN + at % (data.len() - ACCOUNT_LEN);
                    data[at] = byte;
                }
                data
            },
        )
}

pub fn mint_bytes() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![1 => mint_base(), 12 => extended(mint_base(), 1)]
}

pub fn account_bytes() -> impl Strategy<Value = ([u8; 32], Vec<u8>)> {
    any::<[u8; 32]>().prop_flat_map(|mint| {
        prop_oneof![1 => account_base(mint), 12 => extended(account_base(mint), 2)]
            .prop_map(move |data| (mint, data))
    })
}

/// Mint-shaped bytes whose base may also be one Token-2022 refuses: an option tag other than
/// 0 or 1 on either authority, or an `is_initialized` byte other than 1.
pub fn loose_mint_bytes() -> impl Strategy<Value = Vec<u8>> {
    let tag = || {
        prop_oneof![
            6 => Just(None),
            1 => Just(Some([2u8, 0, 0, 0])),
            1 => Just(Some([1u8, 0, 0, 1])),
            1 => any::<[u8; 4]>().prop_map(Some),
        ]
    };
    (
        mint_bytes(),
        tag(),
        tag(),
        prop_oneof![6 => Just(None), 1 => Just(Some(0u8)), 1 => Just(Some(2u8))],
    )
        .prop_map(|(mut data, mint_tag, freeze_tag, initialized)| {
            if let Some(tag) = mint_tag {
                data[0..4].copy_from_slice(&tag);
            }
            if let Some(tag) = freeze_tag {
                data[46..50].copy_from_slice(&tag);
            }
            if let Some(byte) = initialized {
                data[45] = byte;
            }
            data
        })
}
