//! `execute`: the transfer hook interface's `Execute`, which Token-2022 calls on every
//! transfer of a mint whose hook is this program (docs/spec/containment-hook.md, "The allow
//! rule").
//!
//! It fails closed: it refuses the transfer unless all of these hold.
//!
//! 1. The config is this mint's: owned by this program, a config naming the mint being
//!    transferred, at its PDA `["config", mint]` with the bump it stores. A mint that was
//!    never bound has no config, so every transfer of it is refused.
//! 2. The validation account is this mint's: owned by this program, at its PDA
//!    `["extra-account-metas", mint]` with the bump the config stores.
//! 3. The source is a Token-2022 account of the mint with its `transferring` flag set, which
//!    Token-2022 sets only for the length of a transfer, so nobody can call `Execute`
//!    directly.
//! 4. The source or the destination is the home market's vault for the token or the
//!    market's fee account for it, both recorded in the config by `bind`.
//!
//! It makes no CPI, because on a buy it already runs at the last call level the runtime
//! allows (router, strategy, Token-2022, hook), and it never searches for a bump. Minting
//! never calls a hook, so a launcher can mint the supply before and after binding.

use anchor_lang::prelude::*;

use crate::errors::HookError;
use crate::state::{Config, CONFIG_SEED, EXTRA_ACCOUNT_METAS_SEED};
use crate::token_account;

/// `Execute`'s accounts in the transfer hook interface's order, as `test-hook` takes them:
/// the four Token-2022 passes, the validation account, then its one extra account. A caller
/// that leaves the validation account out gets an `Execute` without the config from
/// Token-2022, which Anchor refuses for want of accounts.
#[derive(Accounts)]
pub struct Execute<'info> {
    /// The source token account.
    /// CHECK: the handler checks it is a Token-2022 account of the mint, mid-transfer.
    pub source: UncheckedAccount<'info>,
    /// The mint.
    /// CHECK: the handler checks it is the config's mint and the source's.
    pub mint: UncheckedAccount<'info>,
    /// The destination token account.
    /// CHECK: only its address is compared with the allowed accounts.
    pub destination: UncheckedAccount<'info>,
    /// The source's owner or delegate.
    /// CHECK: not read; who signs is Token-2022's to check.
    pub owner: UncheckedAccount<'info>,
    /// The validation account `["extra-account-metas", mint]`.
    /// CHECK: the handler checks its owner and its address with the config's bump.
    pub extra_account_metas: UncheckedAccount<'info>,
    /// The config `["config", mint]`.
    /// CHECK: the handler checks its owner, its discriminator, its mint and its address.
    pub config: UncheckedAccount<'info>,
}

pub fn process_execute(ctx: Context<Execute>, _amount: u64) -> Result<()> {
    let accounts = &ctx.accounts;
    let mint = accounts.mint.key;
    let config = read_config(&accounts.config, mint)?;
    check_validation_account(&accounts.extra_account_metas, mint, &config)?;
    require!(
        token_account::is_mid_transfer(&accounts.source, mint),
        HookError::NotTransferring
    );
    let allowed = [config.vault, config.fee_account];
    require!(
        allowed.contains(accounts.source.key) || allowed.contains(accounts.destination.key),
        HookError::TransferRefused
    );
    Ok(())
}

/// The mint's config, refused unless it is owned by this program, decodes as a config, names
/// `mint`, and sits at `["config", mint]` with the bump it stores.
fn read_config(account: &UncheckedAccount, mint: &Pubkey) -> Result<Config> {
    require_keys_eq!(*account.owner, crate::ID, HookError::WrongConfig);
    let config = Config::try_deserialize(&mut &account.try_borrow_data()?[..])
        .map_err(|_| error!(HookError::WrongConfig))?;
    require_keys_eq!(config.mint, *mint, HookError::WrongConfig);
    let address = Pubkey::create_program_address(
        &[CONFIG_SEED, mint.as_ref(), &[config.config_bump]],
        &crate::ID,
    )
    .map_err(|_| error!(HookError::WrongConfig))?;
    require_keys_eq!(address, account.key(), HookError::WrongConfig);
    Ok(config)
}

/// Refuses a validation account unless it is owned by this program and sits at
/// `["extra-account-metas", mint]` with the bump the config stores.
fn check_validation_account(
    account: &UncheckedAccount,
    mint: &Pubkey,
    config: &Config,
) -> Result<()> {
    require_keys_eq!(*account.owner, crate::ID, HookError::WrongValidationAccount);
    let address = Pubkey::create_program_address(
        &[
            EXTRA_ACCOUNT_METAS_SEED,
            mint.as_ref(),
            &[config.extra_account_metas_bump],
        ],
        &crate::ID,
    )
    .map_err(|_| error!(HookError::WrongValidationAccount))?;
    require_keys_eq!(address, account.key(), HookError::WrongValidationAccount);
    Ok(())
}
