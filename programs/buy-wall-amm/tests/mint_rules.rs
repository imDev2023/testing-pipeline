//! The mint rules at creation (docs/spec/pool4-for-solana.md, "Mint rules"): SPL Token and
//! Token-2022 tokens are accepted, but a Token-2022 token may carry only the tax AMM's
//! allowlist of mint extensions; every other extension is refused, including one the
//! program does not recognise.

mod common;

use buy_wall_amm::errors::StrategyError::MintExtensionNotAllowed;
use common::*;
use solana_signer::Signer;
use spl_token_2022_interface::extension::ExtensionType;
use spl_token_2022_interface::state::Mint;

/// The data length of a fixed-size extension, as Token-2022 lays it out.
fn data_len(extension: ExtensionType) -> u16 {
    let with = ExtensionType::try_calculate_account_len::<Mint>(&[extension]).unwrap();
    let without = ExtensionType::try_calculate_account_len::<Mint>(&[]).unwrap();
    // `without` is the bare 82-byte mint; with an extension the account is padded to the
    // account type byte at 165, then 4 bytes of type and length come before the data.
    (with - without.max(166) - 4) as u16
}

const ALLOWLIST: [ExtensionType; 7] = [
    ExtensionType::TransferHook,
    ExtensionType::MetadataPointer,
    ExtensionType::TokenMetadata,
    ExtensionType::GroupPointer,
    ExtensionType::GroupMemberPointer,
    ExtensionType::TokenGroup,
    ExtensionType::TokenGroupMember,
];

#[test]
fn spl_token_and_plain_token_2022_tokens_are_accepted() {
    let mut env = Env::new();
    let seeder = env.admin.pubkey();
    for program in [TOKEN, TOKEN_2022] {
        let token = env.create_mint(&program, 6);
        env.create_market(token, program, &launch_params(seeder))
            .unwrap_or_else(|e| panic!("{program}: {e}"));
    }
}

#[test]
fn a_transfer_fee_token_is_refused() {
    // The bar's hostile case, set up with Token-2022's own instructions.
    let mut env = Env::new();
    let token = env.create_mint_with(
        &TOKEN_2022,
        6,
        &[RealExtension::TransferFee { bps: 100 }],
        false,
    );
    let seeder = env.admin.pubkey();
    assert_refused(
        env.create_market(token, TOKEN_2022, &launch_params(seeder)),
        MintExtensionNotAllowed,
    );
}

#[test]
fn every_other_extension_outside_the_allowlist_is_refused() {
    let mut env = Env::new();
    let seeder = env.admin.pubkey();
    let mut refused = vec![];
    for number in 1..=28u16 {
        let extension = ExtensionType::try_from(number).unwrap();
        if ALLOWLIST.contains(&extension) {
            continue;
        }
        let token = env.plant_token_2022_mint(number, data_len(extension));
        let result = env.create_market(token, TOKEN_2022, &launch_params(seeder));
        assert!(result.is_err(), "{extension:?} was accepted");
        assert_refused(result, MintExtensionNotAllowed);
        refused.push(extension);
    }
    println!("refused: {refused:?}");
    assert_eq!(refused.len(), 28 - ALLOWLIST.len());
}

#[test]
fn an_extension_the_program_does_not_recognise_is_refused() {
    let mut env = Env::new();
    let seeder = env.admin.pubkey();
    for number in [29u16, 0x7fff, u16::MAX] {
        assert!(
            ExtensionType::try_from(number).is_err(),
            "{number} is a known type"
        );
        let token = env.plant_token_2022_mint(number, 8);
        assert_refused(
            env.create_market(token, TOKEN_2022, &launch_params(seeder)),
            MintExtensionNotAllowed,
        );
    }
}

#[test]
fn every_allowlisted_extension_is_accepted() {
    let mut env = Env::new();
    let seeder = env.admin.pubkey();
    // A transfer hook set up with Token-2022's own instructions, naming Pipeline's
    // `test-hook`: accepted at creation, while the seed refuses it until the hook is cleared
    // (`POOL4-48`, tests/seed.rs).
    let hooked = env.create_mint_with(
        &TOKEN_2022,
        6,
        &[RealExtension::TransferHook {
            program: TEST_HOOK_PROGRAM,
        }],
        false,
    );
    let market = env
        .create_market(hooked, TOKEN_2022, &launch_params(seeder))
        .unwrap();
    // Its vault carries the transfer-hook account extension Token-2022 requires.
    assert!(env.svm.get_account(&market.token_vault).unwrap().data.len() > 165);
    for extension in ALLOWLIST.iter().skip(1) {
        let len = if *extension == ExtensionType::TokenMetadata {
            0
        } else {
            data_len(*extension)
        };
        let token = env.plant_token_2022_mint(u16::from(*extension), len);
        env.create_market(token, TOKEN_2022, &launch_params(seeder))
            .unwrap_or_else(|e| panic!("{extension:?}: {e}"));
    }
}
