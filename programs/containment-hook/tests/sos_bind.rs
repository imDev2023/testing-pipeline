//! `bind`'s checks added by the hook's internal adversarial review (#74), each pinned by a test
//! named after the finding (docs/security/containment-hook/round-1.md).

mod support;

use containment_hook::HookError;
use pipeline_client::{AccountMeta, Instruction, Pubkey};
use solana_keypair::Keypair;
use solana_signer::Signer;
use support::*;

/// Writes `tax_collected` into a tax AMM market state, as a market that already traded
/// would hold it.
fn set_tax_collected(env: &mut Env, market_state: &Pubkey, tax_collected: u128) {
    let at = tax_amm::state::layout::TAX_COLLECTED;
    edit_account(env, market_state, |account| {
        account.data[at..at + 16].copy_from_slice(&tax_collected.to_le_bytes());
    });
}

/// H020, H025: the goal counts the tax collected under containment, so `bind` refuses a home
/// market that has already collected tax. Otherwise a launcher could trade a market under
/// another hook, point the mint at this one and bind with the goal already met.
#[test]
fn sos_h020_a_market_that_already_collected_tax_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    set_tax_collected(&mut env, &market.market_state, 1);
    assert_hook_refused(
        bind(&mut env, mint, &market),
        HookError::MarketAlreadyCollectedTax,
    );
    assert!(env.svm.get_account(&config_pda(&mint)).is_none());
}

#[test]
fn sos_h020_a_market_that_collected_no_tax_binds() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    set_tax_collected(&mut env, &market.market_state, 0);
    bind(&mut env, mint, &market).unwrap();
}

/// Writes the version byte of a tax AMM market state, the first byte after its
/// discriminator, as a later tax AMM build would write its own.
fn set_state_version(env: &mut Env, market_state: &Pubkey, version: u8) {
    edit_account(env, market_state, |account| account.data[8] = version);
}

/// The byte [`set_state_version`] writes is the tax AMM's own `version` field.
#[test]
fn sos_h009_the_version_byte_is_the_tax_amms_version_field() {
    let mut env = hook_env();
    let (_, market) = contained_market(&mut env);
    assert_eq!(
        env.tax_market(&market.market_state).version,
        tax_amm::state::STATE_VERSION
    );
    set_state_version(&mut env, &market.market_state, 7);
    assert_eq!(env.tax_market(&market.market_state).version, 7);
}

/// H009, H015, H057: the hook reads a market state only at the version it knows, so a later
/// tax AMM build that kept the length but moved what the hook reads cannot be misread:
/// `bind` refuses a market state of a newer version.
#[test]
fn sos_h009_bind_refuses_a_market_state_of_a_newer_version() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    set_state_version(
        &mut env,
        &market.market_state,
        tax_amm::state::STATE_VERSION + 1,
    );
    assert_hook_refused(bind(&mut env, mint, &market), HookError::NotATaxMarketState);
    assert!(env.svm.get_account(&config_pda(&mint)).is_none());
}

/// A Token-2022 multisig account at a fresh keypair's address, needing one of `signers`, with
/// the keypair returned: whoever kept it can sign as the multisig's address.
fn multisig(env: &mut Env, signers: &[&Pubkey]) -> Keypair {
    let account = Keypair::new();
    // A Token-2022 multisig's length.
    let space = 355;
    let mut create = 0u32.to_le_bytes().to_vec();
    create.extend_from_slice(
        &env.svm
            .minimum_balance_for_rent_exemption(space)
            .to_le_bytes(),
    );
    create.extend_from_slice(&(space as u64).to_le_bytes());
    create.extend_from_slice(TOKEN_2022.as_ref());
    let create = Instruction::new_with_bytes(
        pipeline_client::SYSTEM_PROGRAM_ID,
        &create,
        vec![
            AccountMeta::new(env.admin.pubkey(), true),
            AccountMeta::new(account.pubkey(), true),
        ],
    );
    let initialize = spl_token_2022_interface::instruction::initialize_multisig2(
        &TOKEN_2022,
        &account.pubkey(),
        signers,
        1,
    )
    .unwrap();
    env.send(&[create, initialize], &[&account]).unwrap();
    account
}

/// H008: `bind` checks one signer, so a mint authority that is a Token-2022 multisig would be
/// bound by whoever kept the keypair its account was created at, without its other signers.
/// `bind` refuses a mint authority owned by Token-2022.
#[test]
fn sos_h008_a_multisig_mint_authority_signed_by_its_creation_key_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let admin = env.admin.pubkey();
    let cosigner = Pubkey::new_unique();
    let multisig = multisig(&mut env, &[&admin, &cosigner]);
    let to_multisig = spl_token_2022_interface::instruction::set_authority(
        &TOKEN_2022,
        &mint,
        Some(&multisig.pubkey()),
        spl_token_2022_interface::instruction::AuthorityType::MintTokens,
        &admin,
        &[],
    )
    .unwrap();
    env.send(&[to_multisig], &[]).unwrap();

    let mut args = BindArgs::new(&env, mint, &market);
    args.mint_authority = multisig.pubkey();
    assert_hook_refused(
        send_bind(&mut env, &args, &[&multisig]),
        HookError::MintAuthorityIsMultisig,
    );
    assert!(env.svm.get_account(&config_pda(&mint)).is_none());
}

/// A contained mint and a home market for it quoted in `quote`, an existing mint of
/// `quote_program`, with the tax on the quote.
fn market_quoted_in(env: &mut Env, quote: Pubkey, quote_program: Pubkey) -> (Pubkey, Market) {
    let mint = contained_mint(env);
    let params = quote_taxed_params(&Pubkey::new_unique(), QUOTE as u8);
    let market = env
        .create_tax_market([(mint, TOKEN_2022), (quote, quote_program)], &params)
        .unwrap();
    (mint, market)
}

/// H014, H030, H051 (answer 3a): a quote mint whose issuer could freeze the home market's quote
/// vault, or mint into it, could stop every sell and trap every holder until the deadline, so
/// `bind` refuses one unless it is on the tax AMM's quote list.
#[test]
fn sos_h014_a_quote_mint_with_a_freeze_or_mint_authority_is_refused() {
    for options in [
        MintOptions {
            freeze_authority: true,
            ..MintOptions::default()
        },
        MintOptions {
            mint_authority: true,
            ..MintOptions::default()
        },
    ] {
        let mut env = hook_env();
        let quote = env.create_mint_with(&TOKEN, options);
        let (mint, market) = market_quoted_in(&mut env, quote, TOKEN);
        assert_hook_refused(
            bind(&mut env, mint, &market),
            HookError::QuoteMintHasAuthority,
        );
        assert!(env.svm.get_account(&config_pda(&mint)).is_none());
    }
}

/// H014, H051 (answer 3a): a quote mint with a live transfer hook, any program's, ours included,
/// could refuse every sell's payout, so `bind` refuses it; a hook cleared for good is allowed.
#[test]
fn sos_h014_a_quote_mint_with_a_transfer_hook_is_refused_and_a_cleared_one_passes() {
    let mut env = hook_env();
    // Another contained mint, its hook this program's with its unlock PDA as authority.
    let hooked_quote = contained_mint(&mut env);
    let (mint, market) = market_quoted_in(&mut env, hooked_quote, TOKEN_2022);
    assert_hook_refused(bind(&mut env, mint, &market), HookError::QuoteMintHooked);

    // A hook cleared for good, as an unlock leaves one: set, then both fields cleared.
    let cleared_quote = env.create_mint_with(
        &TOKEN_2022,
        MintOptions {
            transfer_hook: Some(Pubkey::new_unique()),
            ..MintOptions::default()
        },
    );
    let admin = env.admin.pubkey();
    let clear_program = spl_token_2022_interface::extension::transfer_hook::instruction::update(
        &TOKEN_2022,
        &cleared_quote,
        &admin,
        &[],
        None,
    )
    .unwrap();
    let clear_authority = spl_token_2022_interface::instruction::set_authority(
        &TOKEN_2022,
        &cleared_quote,
        None,
        spl_token_2022_interface::instruction::AuthorityType::TransferHookProgramId,
        &admin,
        &[],
    )
    .unwrap();
    env.send(&[clear_program, clear_authority], &[]).unwrap();
    let (mint, market) = market_quoted_in(&mut env, cleared_quote, TOKEN_2022);
    bind(&mut env, mint, &market).unwrap();
}

/// Answer 3a: a mint on the tax AMM's quote list (both native SOL mints and the cluster's USDC)
/// may keep its authorities, as USDC's issuer does, the one list the tax AMM's seed reads too.
#[test]
fn sos_h014_a_quote_list_mint_may_keep_its_authorities() {
    let mut env = hook_env();
    let usdc = ck(&tax_amm::config::QUOTE_MINTS[2]);
    let with_authorities = env.create_mint_with(
        &TOKEN,
        MintOptions {
            mint_authority: true,
            freeze_authority: true,
            ..MintOptions::default()
        },
    );
    let mut account = env.svm.get_account(&with_authorities).unwrap();
    account.rent_epoch = 0;
    env.svm.set_account(usdc, account).unwrap();
    let (mint, market) = market_quoted_in(&mut env, usdc, TOKEN);
    bind(&mut env, mint, &market).unwrap();
}

/// Answer 3a: the quote mint `bind` checks is the market's own other mint, never one the caller
/// picks.
#[test]
fn sos_h014_a_quote_mint_other_than_the_markets_is_refused() {
    let mut env = hook_env();
    let (mint, market) = contained_market(&mut env);
    let mut args = BindArgs::new(&env, mint, &market);
    args.quote_mint = env.create_mint(&TOKEN);
    assert_hook_refused(
        send_bind(&mut env, &args, &[]),
        HookError::QuoteMintNotTheMarkets,
    );
}
