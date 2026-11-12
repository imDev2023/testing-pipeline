//! `bind`'s checks on the mint (docs/spec/containment-hook.md, "Checks on the mint"): owned
//! by Token-2022, only allowlisted extensions, no freeze authority, signed by its mint
//! authority, and the hook as its transfer hook with the unlock PDA as hook authority.
//! Each refusal leaves no config behind.

mod support;

use containment_hook::HookError;
use pipeline_client::Pubkey;
use solana_keypair::Keypair;
use solana_signer::Signer;
use spl_token_2022_interface::extension::ExtensionType;
use spl_token_2022_interface::state::Mint;
use support::*;

const ACCOUNT_LEN: usize = 165;

/// Fails unless `result` is refused with `error` and `mint` was left unbound.
fn assert_unbound<T: std::fmt::Debug>(
    env: &Env,
    mint: &Pubkey,
    result: Result<T, String>,
    error: HookError,
) {
    assert_hook_refused(result, error);
    assert!(env.svm.get_account(&config_pda(mint)).is_none());
    assert!(env.svm.get_account(&validation_pda(mint)).is_none());
}

/// Binds a contained mint to its home market after giving the mint one extra
/// extension entry of `extension_type`, zeroed. The tax AMM refuses to create a market of
/// such a mint, so the entry is written into the mint after its market exists: `bind`
/// checks the mint rules itself rather than trusting the market's creation.
fn assert_extension_refused(extension_type: u16, len: usize) {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    edit_account(&mut env, &mint, |account| {
        account
            .data
            .extend_from_slice(&extension_type.to_le_bytes());
        account.data.extend_from_slice(&(len as u16).to_le_bytes());
        account.data.extend(std::iter::repeat_n(0, len));
    });
    let result = bind(&mut env, mint, &market);
    assert!(
        result.as_ref().is_err_and(
            |logs| logs.contains(&format!("carries refused extension {extension_type}"))
        ),
        "{extension_type}: {result:?}"
    );
    assert_unbound(&env, &mint, result, HookError::MintExtensionNotAllowed);
}

fn extension_len(extension_type: ExtensionType) -> usize {
    ExtensionType::try_calculate_account_len::<Mint>(&[extension_type])
        .map(|len| len - (ACCOUNT_LEN + 1 + 4))
        .expect("a fixed-length mint extension")
}

macro_rules! refused_extension_tests {
    ($($test:ident => $extension:ident,)*) => {$(
        #[test]
        fn $test() {
            let extension = ExtensionType::$extension;
            assert_extension_refused(extension as u16, extension_len(extension));
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
fn an_extension_token_2022_has_not_defined_yet_is_refused() {
    assert_extension_refused(ExtensionType::PermissionedBurn as u16 + 1, 32);
}

#[test]
fn a_mint_with_a_freeze_authority_is_refused() {
    let mut env = hook_env();
    let mint = contained_mint_with(
        &mut env,
        MintOptions {
            freeze_authority: true,
            ..MintOptions::default()
        },
    );
    let market = home_market(&mut env, mint, 0);
    let result = bind(&mut env, mint, &market);
    assert_unbound(&env, &mint, result, HookError::FreezeAuthoritySet);
}

#[test]
fn a_signer_that_is_not_the_mint_authority_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let stranger = Keypair::new();
    let mut args = BindArgs::new(&env, mint, &market);
    args.mint_authority = stranger.pubkey();
    let result = send_bind(&mut env, &args, &[&stranger]);
    assert_unbound(&env, &mint, result, HookError::NotMintAuthority);
}

#[test]
fn a_mint_whose_mint_authority_is_revoked_cannot_be_bound() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let admin = env.admin.pubkey();
    let revoke = spl_token_2022_interface::instruction::set_authority(
        &TOKEN_2022,
        &mint,
        None,
        spl_token_2022_interface::instruction::AuthorityType::MintTokens,
        &admin,
        &[],
    )
    .unwrap();
    env.send(&[revoke], &[]).unwrap();
    let result = bind(&mut env, mint, &market);
    assert_unbound(&env, &mint, result, HookError::NotMintAuthority);
}

#[test]
fn a_mint_whose_hook_program_is_not_ours_is_refused() {
    let mut env = hook_env();
    let other_hook = Pubkey::new_unique();
    let mint = env.create_hooked_mint(&other_hook, unlock_pda, MintOptions::default());
    let market = home_market(&mut env, mint, 0);
    let result = bind(&mut env, mint, &market);
    assert_unbound(&env, &mint, result, HookError::WrongHookProgram);
}

#[test]
fn a_mint_whose_hook_authority_is_not_its_unlock_pda_is_refused() {
    let mut env = hook_env();
    let admin = env.admin.pubkey();
    for authority in [admin, Pubkey::new_unique()] {
        let mint = env.create_hooked_mint(&hook_id(), |_| authority, MintOptions::default());
        let market = home_market(&mut env, mint, 0);
        let result = bind(&mut env, mint, &market);
        assert_unbound(&env, &mint, result, HookError::WrongHookAuthority);
    }
    // Another mint's unlock PDA is not this mint's.
    let someone_else = Pubkey::new_unique();
    let mint = env.create_hooked_mint(
        &hook_id(),
        |_| unlock_pda(&someone_else),
        MintOptions::default(),
    );
    let market = home_market(&mut env, mint, 0);
    let result = bind(&mut env, mint, &market);
    assert_unbound(&env, &mint, result, HookError::WrongHookAuthority);
}

#[test]
fn a_mint_without_a_transfer_hook_is_refused() {
    let mut env = hook_env();
    let mint = env.create_mint(&TOKEN_2022);
    let market = home_market(&mut env, mint, 0);
    let result = bind(&mut env, mint, &market);
    assert_unbound(&env, &mint, result, HookError::WrongHookProgram);
}

#[test]
fn a_mint_not_owned_by_token_2022_is_refused() {
    let mut env = hook_env();
    // An SPL Token mint, which the tax AMM accepts and the mint rules allow.
    let mint = env.create_mint(&TOKEN);
    let quote = env.create_mint(&TOKEN);
    let params = quote_taxed_params(&Pubkey::new_unique(), 1);
    let market = env
        .create_tax_market([(mint, TOKEN), (quote, TOKEN)], &params)
        .unwrap();
    let result = bind(&mut env, mint, &market);
    assert_unbound(&env, &mint, result, HookError::MintNotToken2022);

    // A contained mint's exact bytes under another owner.
    let (real, market) = contained_market(&mut env);
    let copy = copy_account(&mut env, &real, &TOKEN);
    let mut args = BindArgs::new(&env, real, &market);
    args.mint = copy;
    let result = send_bind(&mut env, &args, &[]);
    assert_unbound(&env, &copy, result, HookError::MintNotToken2022);
}
