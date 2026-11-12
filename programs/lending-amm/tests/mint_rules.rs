//! The other side's mint rules at market creation, through the real router
//! (docs/spec/lending-pool.md, "Mint rules"): the other side follows the tax AMM's rules,
//! applied by the shared `mint-rules` crate, so every extension outside the allowlist is
//! refused before anything is created, and allowlisted ones, a transfer hook included, are
//! accepted.

mod common;

use common::*;
use lending_amm::{InitParams, StrategyError};
use pipeline_client::Pubkey;
use spl_token_2022_interface::extension::ExtensionType;
use spl_token_2022_interface::state::Mint;

const ACCOUNT_LEN: usize = 165;

/// Tries to create a WSOL-lent market whose other side, at index 0, is `mint` of
/// `token_program`.
fn try_market(env: &mut Env, mint: Pubkey, token_program: Pubkey) -> Result<Market, String> {
    let spec = MarketSpec {
        mints: [(mint, token_program), (wsol(), TOKEN)],
        params: InitParams {
            lent_index: 1,
            lp_fee_bps: 30,
        },
    };
    env.create_market(&spec)
}

/// Fails unless a market whose other side carries `extension_type` is refused, by its
/// number.
fn assert_extension_refused(extension_type: ExtensionType) {
    let mut env = Env::new();
    let len = ExtensionType::try_calculate_account_len::<Mint>(&[extension_type])
        .map(|len| len - (ACCOUNT_LEN + 1 + 4))
        .expect("a fixed-length mint extension");
    let mint = env.write_mint_with_extensions(&[(extension_type as u16, len)]);
    let result = try_market(&mut env, mint, TOKEN_2022);
    let line = format!("carries refused extension {}", extension_type as u16);
    assert!(
        result.as_ref().is_err_and(|logs| logs.contains(&line)),
        "{extension_type:?}: {result:?}"
    );
    assert_refused(result, StrategyError::MintExtensionNotAllowed);
}

macro_rules! refused_extension_tests {
    ($($test:ident => $extension:ident,)*) => {$(
        #[test]
        fn $test() {
            assert_extension_refused(ExtensionType::$extension);
        }
    )*};
}

// Every mint extension Token-2022 defines outside the allowlist, one test each.
refused_extension_tests! {
    a_transfer_fee_mint_is_refused => TransferFeeConfig,
    a_mint_close_authority_mint_is_refused => MintCloseAuthority,
    a_confidential_transfer_mint_is_refused => ConfidentialTransferMint,
    a_default_account_state_mint_is_refused => DefaultAccountState,
    a_non_transferable_mint_is_refused => NonTransferable,
    an_interest_bearing_mint_is_refused => InterestBearingConfig,
    a_permanent_delegate_mint_is_refused => PermanentDelegate,
    a_confidential_transfer_fee_mint_is_refused => ConfidentialTransferFeeConfig,
    a_confidential_mint_burn_mint_is_refused => ConfidentialMintBurn,
    a_scaled_ui_amount_mint_is_refused => ScaledUiAmount,
    a_pausable_mint_is_refused => Pausable,
    a_permissioned_burn_mint_is_refused => PermissionedBurn,
}

#[test]
fn an_extension_the_program_does_not_recognise_is_refused() {
    let unknown = ExtensionType::PermissionedBurn as u16 + 1;
    let mut env = Env::new();
    let mint = env.write_mint_with_extensions(&[(unknown, 32)]);
    let result = try_market(&mut env, mint, TOKEN_2022);
    assert!(result
        .as_ref()
        .is_err_and(|logs| logs.contains(&format!("carries refused extension {unknown}"))));
    assert_refused(result, StrategyError::MintExtensionNotAllowed);
}

#[test]
fn transfer_fee_and_permanent_delegate_mints_token_2022_set_up_itself_are_refused() {
    // The bar's hostile case, a transfer fee, and a permanent delegate.
    let mut env = Env::new();
    let fee = env.create_mint_with(
        &TOKEN_2022,
        MintOptions {
            transfer_fee_bps: Some(100),
            ..MintOptions::default()
        },
    );
    assert_refused(
        try_market(&mut env, fee, TOKEN_2022),
        StrategyError::MintExtensionNotAllowed,
    );
    let delegate = env.create_mint_with(
        &TOKEN_2022,
        MintOptions {
            permanent_delegate: true,
            ..MintOptions::default()
        },
    );
    assert_refused(
        try_market(&mut env, delegate, TOKEN_2022),
        StrategyError::MintExtensionNotAllowed,
    );
}

#[test]
fn every_allowlisted_extension_is_accepted() {
    use mint_rules::extension::*;
    let mut env = Env::new();
    for extension in [
        METADATA_POINTER,
        TOKEN_METADATA,
        GROUP_POINTER,
        TOKEN_GROUP,
        GROUP_MEMBER_POINTER,
        TOKEN_GROUP_MEMBER,
    ] {
        let mint = env.write_mint_with_extensions(&[(extension, 64)]);
        try_market(&mut env, mint, TOKEN_2022)
            .unwrap_or_else(|e| panic!("extension {extension}: {e}"));
    }
}

#[test]
fn a_mint_with_pipelines_test_hook_is_accepted() {
    let mut env = Env::new();
    let (hooked, _) = env.create_hooked_mint();
    let market = try_market(&mut env, hooked, TOKEN_2022).unwrap();
    // Token-2022 sized the hooked mint's vault for its transfer-hook account extension.
    let vault = env.svm.get_account(&market.vaults[0]).unwrap();
    assert_eq!(vault.owner, TOKEN_2022);
    assert!(vault.data.len() > ACCOUNT_LEN);
    assert_eq!(&vault.data[32..64], market.addresses.authority.as_ref());
}

#[test]
fn a_plain_token_2022_mint_and_a_mint_with_a_freeze_authority_are_accepted() {
    let mut env = Env::new();
    let plain = env.create_mint(&TOKEN_2022);
    try_market(&mut env, plain, TOKEN_2022).unwrap();
    for token_program in [TOKEN, TOKEN_2022] {
        let frozen = env.create_mint_with(
            &token_program,
            MintOptions {
                freeze_authority: true,
                ..MintOptions::default()
            },
        );
        try_market(&mut env, frozen, token_program).unwrap();
    }
}

#[test]
fn the_check_is_the_shared_crates_not_a_second_copy() {
    let program = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/instructions/init_market.rs"),
    )
    .unwrap();
    assert!(program.contains("mint_rules::check_mint("));
    assert!(!program.contains("ALLOWED_MINT_EXTENSIONS"));
}

#[test]
fn a_mint_passed_with_the_other_token_program_is_refused() {
    let mut env = Env::new();
    let mint = env.create_mint(&TOKEN_2022);
    assert_refused(
        try_market(&mut env, mint, TOKEN),
        StrategyError::WrongTokenProgram,
    );
}

#[test]
fn an_account_that_is_not_a_mint_is_refused() {
    let mut env = Env::new();
    let mint = env.create_mint(&TOKEN);
    let token_account =
        write_token_account(&mut env.svm, &mint, &TOKEN, &Pubkey::new_unique(), 5).unwrap();
    assert_refused(
        try_market(&mut env, token_account, TOKEN),
        StrategyError::NotAMint,
    );
    let wallet = Pubkey::new_unique();
    env.svm.airdrop(&wallet, SOL).unwrap();
    assert_refused(
        try_market(&mut env, wallet, TOKEN),
        StrategyError::WrongTokenProgram,
    );
}
