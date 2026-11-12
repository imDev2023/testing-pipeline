//! The mint rules at market creation, through the real router (docs/spec/tax-amm.md, "Mint
//! rules"): SPL Token and Token-2022 mints make markets, a Token-2022 mint may carry only
//! the allowlisted extensions, and every other extension, unknown ones included, is refused
//! before any vault exists.

mod common;

use common::*;
use pipeline_client::Pubkey;
use spl_token_2022_interface::extension::ExtensionType;
use spl_token_2022_interface::state::Mint;
use tax_amm::StrategyError;

const ACCOUNT_LEN: usize = 165;

/// Tries to create a market of `mint` (index 0, Token-2022) against a plain SPL Token mint.
fn try_market(env: &mut Env, mint: Pubkey) -> Result<Market, String> {
    let other = env.create_mint(&TOKEN);
    let params = valid_params(&Pubkey::new_unique());
    env.create_tax_market([(mint, TOKEN_2022), (other, TOKEN)], &params)
}

/// Fails unless a market of a mint carrying `extension_type` is refused, by its number.
fn assert_extension_refused(extension_type: ExtensionType) {
    let mut env = Env::new();
    let len = ExtensionType::try_calculate_account_len::<Mint>(&[extension_type])
        .map(|len| len - (ACCOUNT_LEN + 1 + 4))
        .expect("a fixed-length mint extension");
    let mint = env.write_mint_with_extensions(&[(extension_type as u16, len)]);
    let result = try_market(&mut env, mint);
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
    // The next number Token-2022 may give a new extension.
    let unknown = ExtensionType::PermissionedBurn as u16 + 1;
    let mut env = Env::new();
    let mint = env.write_mint_with_extensions(&[(unknown, 32)]);
    let result = try_market(&mut env, mint);
    assert!(result
        .as_ref()
        .is_err_and(|logs| logs.contains(&format!("carries refused extension {unknown}"))));
    assert_refused(result, StrategyError::MintExtensionNotAllowed);
}

#[test]
fn mints_token_2022_set_up_itself_with_a_refused_extension_are_refused() {
    let mut env = Env::new();
    let fee = env.create_mint_with(
        &TOKEN_2022,
        MintOptions {
            transfer_fee_bps: Some(100),
            ..MintOptions::default()
        },
    );
    assert_refused(
        try_market(&mut env, fee),
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
        try_market(&mut env, delegate),
        StrategyError::MintExtensionNotAllowed,
    );
}

#[test]
fn a_token_2022_market_is_created() {
    let mut env = Env::new();
    let mint_0 = env.create_mint(&TOKEN_2022);
    let mint_1 = env.create_mint(&TOKEN_2022);
    let params = valid_params(&Pubkey::new_unique());
    let market = env
        .create_tax_market([(mint_0, TOKEN_2022), (mint_1, TOKEN_2022)], &params)
        .unwrap();
    assert_eq!(env.tax_market(&market.market_state).params(), params);
    for vault in market.vaults {
        assert_eq!(env.svm.get_account(&vault).unwrap().owner, TOKEN_2022);
    }
}

#[test]
fn a_mint_with_a_transfer_hook_is_accepted() {
    let mut env = Env::new();
    let hook_program = Pubkey::new_unique();
    let hooked = env.create_mint_with(
        &TOKEN_2022,
        MintOptions {
            transfer_hook: Some(hook_program),
            ..MintOptions::default()
        },
    );
    let market = try_market(&mut env, hooked).unwrap();
    // Token-2022 sized the hooked mint's vault for its transfer-hook account extension.
    let vault = env.svm.get_account(&market.vaults[0]).unwrap();
    assert_eq!(vault.owner, TOKEN_2022);
    assert!(vault.data.len() > ACCOUNT_LEN);
    assert_eq!(&vault.data[32..64], market.authority.as_ref());
}

#[test]
fn a_mint_with_a_mint_and_a_freeze_authority_is_accepted() {
    for token_program in [TOKEN, TOKEN_2022] {
        let mut env = Env::new();
        let mint = env.create_mint_with(
            &token_program,
            MintOptions {
                freeze_authority: true,
                ..MintOptions::default()
            },
        );
        let data = env.svm.get_account(&mint).unwrap().data;
        assert_eq!(&data[..4], &[1, 0, 0, 0], "a mint authority");
        assert_eq!(&data[46..50], &[1, 0, 0, 0], "a freeze authority");
        let other = env.create_mint(&TOKEN);
        let params = valid_params(&Pubkey::new_unique());
        env.create_tax_market([(mint, token_program), (other, TOKEN)], &params)
            .unwrap();
    }
}

#[test]
fn a_mint_passed_with_the_other_token_program_is_refused() {
    let mut env = Env::new();
    let mint = env.create_mint(&TOKEN_2022);
    let other = env.create_mint(&TOKEN);
    let params = valid_params(&Pubkey::new_unique());
    assert_refused(
        env.create_tax_market([(mint, TOKEN), (other, TOKEN)], &params),
        StrategyError::WrongTokenProgram,
    );
}

#[test]
fn an_account_that_is_not_a_mint_is_refused() {
    let mut env = Env::new();
    let mint = env.create_mint(&TOKEN);
    let other = env.create_mint(&TOKEN);
    let params = valid_params(&Pubkey::new_unique());

    // A token account, owned by SPL Token but not a mint.
    let token_account =
        write_token_account(&mut env.svm, &mint, &TOKEN, &Pubkey::new_unique(), 5).unwrap();
    assert_refused(
        env.create_tax_market([(token_account, TOKEN), (other, TOKEN)], &params),
        StrategyError::NotAMint,
    );

    // A wallet, owned by the system program, is not any token program's.
    let wallet = Pubkey::new_unique();
    env.svm.airdrop(&wallet, SOL).unwrap();
    assert_refused(
        env.create_tax_market([(wallet, TOKEN), (other, TOKEN)], &params),
        StrategyError::WrongTokenProgram,
    );
}
