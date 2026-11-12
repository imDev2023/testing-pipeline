//! `check_mint` against mints laid out exactly as SPL Token and Token-2022 lay them out.
//!
//! Every mint here is built by `mint_bytes`, and every Token-2022 one is first read back by
//! Token-2022's own state code (`spl-token-2022-interface`), so the tests know the bytes are
//! a real mint's before asking what the rules make of them.

use mint_rules::{check_mint, extension, MintRefusal, ALLOWED_MINT_EXTENSIONS};
use spl_token_2022_interface::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use spl_token_2022_interface::state::Mint;

const TOKEN: [u8; 32] = mint_rules::TOKEN_PROGRAM_ID;
const TOKEN_2022: [u8; 32] = mint_rules::TOKEN_2022_PROGRAM_ID;

/// Token-2022 lays every extended mint out as the 82-byte mint, zero padding up to an
/// account's 165 bytes, the account type (1 for a mint), then type-length-value entries.
const ACCOUNT_LEN: usize = 165;
const ACCOUNT_TYPE_MINT: u8 = 1;

/// An initialized mint with a mint and a freeze authority, followed by one zeroed
/// extension entry per `(type, value length)`.
fn mint_bytes(extensions: &[(u16, usize)]) -> Vec<u8> {
    // The 82-byte mint: mint authority (a 4-byte option tag, then the key), supply,
    // decimals, `is_initialized`, freeze authority.
    let some_authority = [[1u8, 0, 0, 0].as_slice(), &[7u8; 32]].concat();
    let mut data = some_authority.clone();
    data.extend_from_slice(&1_000u64.to_le_bytes());
    data.push(6);
    data.push(1);
    data.extend_from_slice(&some_authority);
    assert_eq!(data.len(), 82);
    let base = StateWithExtensions::<Mint>::unpack(&data)
        .expect("a valid mint")
        .base;
    assert!(base.mint_authority.is_some() && base.freeze_authority.is_some());
    if extensions.is_empty() {
        return data;
    }
    data.resize(ACCOUNT_LEN, 0);
    data.push(ACCOUNT_TYPE_MINT);
    for &(extension_type, len) in extensions {
        data.extend_from_slice(&extension_type.to_le_bytes());
        data.extend_from_slice(&(len as u16).to_le_bytes());
        data.extend(std::iter::repeat_n(0, len));
    }
    data
}

/// The value length Token-2022 gives an extension: the length of a mint carrying only it,
/// less the base, padding, account type and entry header. A variable-length one (token
/// metadata) gets a few bytes.
fn value_len(extension_type: ExtensionType) -> usize {
    ExtensionType::try_calculate_account_len::<Mint>(&[extension_type])
        .map(|len| len - (ACCOUNT_LEN + 1 + 4))
        .unwrap_or(8)
}

/// A mint carrying exactly `extension_type`, checked to be one Token-2022 reads as such.
fn mint_with(extension_type: ExtensionType) -> Vec<u8> {
    let data = mint_bytes(&[(extension_type as u16, value_len(extension_type))]);
    let state = StateWithExtensions::<Mint>::unpack(&data).expect("a valid Token-2022 mint");
    assert_eq!(state.get_extension_types().unwrap(), vec![extension_type]);
    data
}

/// Every mint extension Token-2022 knows that the rules refuse (docs/spec/tax-amm.md,
/// "Mint rules"), by its name in `spl-token-2022-interface`.
const REFUSED: [ExtensionType; 12] = [
    ExtensionType::TransferFeeConfig,
    ExtensionType::MintCloseAuthority,
    ExtensionType::ConfidentialTransferMint,
    ExtensionType::DefaultAccountState,
    ExtensionType::NonTransferable,
    ExtensionType::InterestBearingConfig,
    ExtensionType::PermanentDelegate,
    ExtensionType::ConfidentialTransferFeeConfig,
    ExtensionType::ConfidentialMintBurn,
    ExtensionType::ScaledUiAmount,
    ExtensionType::Pausable,
    ExtensionType::PermissionedBurn,
];

const ALLOWED: [ExtensionType; 7] = [
    ExtensionType::TransferHook,
    ExtensionType::MetadataPointer,
    ExtensionType::TokenMetadata,
    ExtensionType::GroupPointer,
    ExtensionType::TokenGroup,
    ExtensionType::GroupMemberPointer,
    ExtensionType::TokenGroupMember,
];

#[test]
fn the_program_ids_are_spl_token_and_token_2022() {
    assert_eq!(TOKEN_2022, spl_token_2022_interface::ID.to_bytes());
    // SPL Token's id, TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA, as Token-2022 knows it.
    assert_eq!(
        TOKEN,
        spl_token_2022_interface::inline_spl_token::ID.to_bytes()
    );
}

#[test]
fn the_allowlist_is_the_seven_extensions_the_spec_names_by_token_2022s_numbers() {
    let numbers: Vec<u16> = ALLOWED.iter().map(|&e| e as u16).collect();
    assert_eq!(ALLOWED_MINT_EXTENSIONS.to_vec(), numbers);
    assert_eq!(extension::TRANSFER_HOOK, ExtensionType::TransferHook as u16);
    assert_eq!(
        extension::METADATA_POINTER,
        ExtensionType::MetadataPointer as u16
    );
    assert_eq!(
        extension::TOKEN_METADATA,
        ExtensionType::TokenMetadata as u16
    );
    assert_eq!(extension::GROUP_POINTER, ExtensionType::GroupPointer as u16);
    assert_eq!(extension::TOKEN_GROUP, ExtensionType::TokenGroup as u16);
    assert_eq!(
        extension::GROUP_MEMBER_POINTER,
        ExtensionType::GroupMemberPointer as u16
    );
    assert_eq!(
        extension::TOKEN_GROUP_MEMBER,
        ExtensionType::TokenGroupMember as u16
    );
}

#[test]
fn a_plain_mint_of_either_program_is_accepted_with_its_authorities() {
    let plain = mint_bytes(&[]);
    assert_eq!(check_mint(&TOKEN, &plain), Ok(()));
    assert_eq!(check_mint(&TOKEN_2022, &plain), Ok(()));
}

#[test]
fn each_allowed_extension_is_accepted() {
    for extension_type in ALLOWED {
        assert_eq!(
            check_mint(&TOKEN_2022, &mint_with(extension_type)),
            Ok(()),
            "{extension_type:?}"
        );
    }
}

#[test]
fn all_allowed_extensions_together_are_accepted() {
    let all: Vec<(u16, usize)> = ALLOWED.iter().map(|&e| (e as u16, value_len(e))).collect();
    let data = mint_bytes(&all);
    let state = StateWithExtensions::<Mint>::unpack(&data).unwrap();
    assert_eq!(state.get_extension_types().unwrap(), ALLOWED.to_vec());
    assert_eq!(check_mint(&TOKEN_2022, &data), Ok(()));
}

#[test]
fn each_refused_extension_is_refused_by_its_number() {
    for extension_type in REFUSED {
        assert_eq!(
            check_mint(&TOKEN_2022, &mint_with(extension_type)),
            Err(MintRefusal::ExtensionNotAllowed(extension_type as u16)),
            "{extension_type:?}"
        );
    }
}

#[test]
fn a_refused_extension_after_allowed_ones_is_refused() {
    let hook = ExtensionType::TransferHook;
    let delegate = ExtensionType::PermanentDelegate;
    let data = mint_bytes(&[
        (hook as u16, value_len(hook)),
        (delegate as u16, value_len(delegate)),
    ]);
    assert_eq!(
        check_mint(&TOKEN_2022, &data),
        Err(MintRefusal::ExtensionNotAllowed(delegate as u16))
    );
}

#[test]
fn an_extension_token_2022_has_not_defined_yet_is_refused() {
    // The next numbers Token-2022 may give a new extension, and the highest.
    for unknown in [ExtensionType::PermissionedBurn as u16 + 1, 100, u16::MAX] {
        let data = mint_bytes(&[(unknown, 16)]);
        assert_eq!(
            check_mint(&TOKEN_2022, &data),
            Err(MintRefusal::ExtensionNotAllowed(unknown))
        );
    }
}

#[test]
fn an_account_extension_on_a_mint_is_refused() {
    let immutable_owner = ExtensionType::ImmutableOwner as u16;
    let data = mint_bytes(&[(immutable_owner, 0)]);
    assert_eq!(
        check_mint(&TOKEN_2022, &data),
        Err(MintRefusal::ExtensionNotAllowed(immutable_owner))
    );
}

#[test]
fn spl_token_mints_never_have_extensions() {
    let hooked = mint_with(ExtensionType::TransferHook);
    assert_eq!(check_mint(&TOKEN, &hooked), Err(MintRefusal::NotAMint));
}

#[test]
fn an_account_another_program_owns_is_refused() {
    assert_eq!(
        check_mint(&[9u8; 32], &mint_bytes(&[])),
        Err(MintRefusal::NotATokenProgram)
    );
}

#[test]
fn what_is_not_an_initialized_mint_is_refused() {
    let mut uninitialized = mint_bytes(&[]);
    uninitialized[45] = 0; // `is_initialized`
    assert_eq!(
        check_mint(&TOKEN, &uninitialized),
        Err(MintRefusal::NotAMint)
    );

    // A token account (165 bytes), a multisig (355 bytes) and too few bytes.
    for len in [0, 81, 83, ACCOUNT_LEN, 355] {
        let mut data = mint_bytes(&[]);
        data.resize(len, 0);
        assert_eq!(
            check_mint(&TOKEN_2022, &data),
            Err(MintRefusal::NotAMint),
            "{len} bytes"
        );
    }

    // Padding that is not zero, or an account type that is not a mint's.
    let mut padded = mint_with(ExtensionType::TransferHook);
    padded[100] = 1;
    assert_eq!(check_mint(&TOKEN_2022, &padded), Err(MintRefusal::NotAMint));
    let mut account_type = mint_with(ExtensionType::TransferHook);
    account_type[ACCOUNT_LEN] = 2;
    assert_eq!(
        check_mint(&TOKEN_2022, &account_type),
        Err(MintRefusal::NotAMint)
    );
}

#[test]
fn malformed_extension_entries_are_refused() {
    // A length running past the end of the account.
    let mut data = mint_with(ExtensionType::TransferHook);
    let len_at = ACCOUNT_LEN + 1 + 2;
    data[len_at..len_at + 2].copy_from_slice(&1_000u16.to_le_bytes());
    assert_eq!(check_mint(&TOKEN_2022, &data), Err(MintRefusal::NotAMint));

    // A type with no room for its length.
    let mut data = mint_bytes(&[]);
    data.resize(ACCOUNT_LEN, 0);
    data.push(ACCOUNT_TYPE_MINT);
    data.extend_from_slice(&extension::TRANSFER_HOOK.to_le_bytes());
    data.push(0);
    assert_eq!(check_mint(&TOKEN_2022, &data), Err(MintRefusal::NotAMint));
}

#[test]
fn trailing_space_after_the_last_extension_ends_the_list_as_token_2022_reads_it() {
    // Zeroed space (an uninitialized entry) and a lone trailing byte both end the list.
    let hook = ExtensionType::TransferHook;
    let mut zeroed = mint_bytes(&[(hook as u16, value_len(hook))]);
    zeroed.extend_from_slice(&[0; 12]);
    let mut one_byte = mint_bytes(&[(hook as u16, value_len(hook))]);
    one_byte.push(0xFF);
    for data in [zeroed, one_byte] {
        let state = StateWithExtensions::<Mint>::unpack(&data).unwrap();
        assert_eq!(state.get_extension_types().unwrap(), vec![hook]);
        assert_eq!(check_mint(&TOKEN_2022, &data), Ok(()));
    }
}
