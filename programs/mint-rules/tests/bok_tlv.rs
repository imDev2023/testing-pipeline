//! Book of Knowledge properties of the type-length-value walk (#74), against Token-2022's own
//! state code (`spl-token-2022-interface`, the version in `programs/Cargo.lock`), on bytes
//! that start as a valid Token-2022 mint or token account and then carry any padding byte,
//! any account type and any list of entries, well formed or not:
//!
//! - TLV-1: the walk never panics, and every value it finds lies inside the account right
//!   after its own entry's header (the Kani harnesses in `src/lib.rs` prove it for short
//!   tails; this covers long and structured ones);
//! - TLV-2: `find_extension` returns exactly the bytes Token-2022's `get_extension_bytes`
//!   returns, on every mint and token account Token-2022 unpacks;
//! - TLV-3: `check_mint` accepts a Token-2022 mint exactly when Token-2022 unpacks it and
//!   lists only allowed extensions.

use mint_rules::{check_mint, find_extension, ALLOWED_MINT_EXTENSIONS, TOKEN_2022_PROGRAM_ID};
use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use std::sync::atomic::{AtomicU32, Ordering};

mod bok_bytes;
use bok_bytes::*;
use spl_token_2022_interface::extension::group_pointer::GroupPointer;
use spl_token_2022_interface::extension::metadata_pointer::MetadataPointer;
use spl_token_2022_interface::extension::transfer_hook::{TransferHook, TransferHookAccount};
use spl_token_2022_interface::extension::{BaseStateWithExtensions, StateWithExtensions};
use spl_token_2022_interface::state::{Account, Mint};

/// Where `value` starts inside `data`.
fn offset_in(data: &[u8], value: &[u8]) -> usize {
    value.as_ptr() as usize - data.as_ptr() as usize
}

/// TLV-1 on one byte string, for one wanted type.
fn found_inside_after_its_header(data: &[u8], wanted: u16) -> Result<(), TestCaseError> {
    if let Some(value) = find_extension(data, wanted) {
        let start = offset_in(data, value);
        prop_assert_ne!(wanted, 0);
        prop_assert!(start >= ACCOUNT_LEN + 1 + 4);
        prop_assert!(start + value.len() <= data.len());
        prop_assert_eq!(&data[start - 4..start - 2], &wanted.to_le_bytes()[..]);
        prop_assert_eq!(
            &data[start - 2..start],
            &(value.len() as u16).to_le_bytes()[..]
        );
    }
    Ok(())
}

#[test]
fn the_generators_make_bytes_token_2022_unpacks() {
    let mut runner = TestRunner::new(Config::with_cases(200));
    runner
        .run(&mint_base(), |data| {
            prop_assert!(StateWithExtensions::<Mint>::unpack(&data).is_ok());
            Ok(())
        })
        .unwrap();
    runner
        .run(&account_base([5; 32]), |data| {
            prop_assert!(StateWithExtensions::<Account>::unpack(&data).is_ok());
            Ok(())
        })
        .unwrap();
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    /// TLV-1 on any bytes at all.
    #[test]
    fn tlv_1_the_walk_never_panics_on_any_bytes(
        data in proptest::collection::vec(any::<u8>(), 0..420),
        wanted in prop_oneof![Just(14u16), Just(15u16), any::<u16>()],
    ) {
        found_inside_after_its_header(&data, wanted)?;
        let _ = check_mint(&TOKEN_2022_PROGRAM_ID, &data);
        let _ = check_mint(&mint_rules::TOKEN_PROGRAM_ID, &data);
    }

    /// TLV-1 on mint- and account-shaped bytes, where the walk goes deep.
    #[test]
    fn tlv_1_the_walk_never_panics_on_structured_bytes(
        data in prop_oneof![mint_bytes(), account_bytes().prop_map(|(_, data)| data)],
        wanted in prop_oneof![Just(14u16), Just(15u16), Just(18u16), any::<u16>()],
    ) {
        found_inside_after_its_header(&data, wanted)?;
        let _ = check_mint(&TOKEN_2022_PROGRAM_ID, &data);
    }
}

/// TLV-2 on mints: the transfer hook and two other allowed extensions.
#[test]
fn tlv_2_find_extension_reads_what_token_2022_reads_on_mints() {
    let found = AtomicU32::new(0);
    run_paired(mint_bytes(), |data| {
        let Ok(state) = StateWithExtensions::<Mint>::unpack(&data) else {
            return Ok(false);
        };
        if state.get_extension_bytes::<TransferHook>().is_ok() {
            found.fetch_add(1, Ordering::Relaxed);
        }
        prop_assert_eq!(
            find_extension(&data, 14),
            state.get_extension_bytes::<TransferHook>().ok()
        );
        prop_assert_eq!(
            find_extension(&data, 18),
            state.get_extension_bytes::<MetadataPointer>().ok()
        );
        prop_assert_eq!(
            find_extension(&data, 20),
            state.get_extension_bytes::<GroupPointer>().ok()
        );
        Ok(true)
    });
    let found = found.into_inner();
    assert!(
        found >= CASES / 4,
        "a transfer hook was found in only {found} mints"
    );
}

/// TLV-2 on token accounts: the transfer hook account extension, whose value is the
/// `transferring` flag `Execute` reads.
#[test]
fn tlv_2_find_extension_reads_what_token_2022_reads_on_accounts() {
    let found = AtomicU32::new(0);
    run_paired(account_bytes(), |(_, data)| {
        let Ok(state) = StateWithExtensions::<Account>::unpack(&data) else {
            return Ok(false);
        };
        if state.get_extension_bytes::<TransferHookAccount>().is_ok() {
            found.fetch_add(1, Ordering::Relaxed);
        }
        prop_assert_eq!(
            find_extension(&data, 15),
            state.get_extension_bytes::<TransferHookAccount>().ok()
        );
        Ok(true)
    });
    let found = found.into_inner();
    assert!(
        found >= CASES / 4,
        "a transfer hook account extension was found in only {found} accounts"
    );
}

/// TLV-3: on bytes whose base is a valid mint, `check_mint` accepts exactly what Token-2022
/// unpacks as a mint whose extensions it can list and which are all allowed.
#[test]
fn tlv_3_check_mint_accepts_exactly_token_2022_mints_with_allowed_extensions() {
    let (accepted, refused) = (AtomicU32::new(0), AtomicU32::new(0));
    run_paired(mint_bytes(), |data| {
        let ours = check_mint(&TOKEN_2022_PROGRAM_ID, &data).is_ok();
        if ours {
            accepted.fetch_add(1, Ordering::Relaxed);
        } else {
            refused.fetch_add(1, Ordering::Relaxed);
        }
        let theirs = StateWithExtensions::<Mint>::unpack(&data)
            .ok()
            .and_then(|state| {
                state.get_extension_types().ok().map(|types| {
                    types
                        .iter()
                        .all(|t| ALLOWED_MINT_EXTENSIONS.contains(&u16::from(*t)))
                })
            });
        prop_assert_eq!(
            ours,
            theirs == Some(true),
            "check_mint {} but Token-2022 {:?}",
            ours,
            theirs
        );
        Ok(theirs.is_some())
    });
    let (accepted, refused) = (accepted.into_inner(), refused.into_inner());
    assert!(
        accepted >= CASES / 4 && refused >= CASES / 4,
        "only {accepted} accepted and {refused} refused"
    );
}
