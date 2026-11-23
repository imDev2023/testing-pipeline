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
//! 5. A destination other than those two is a Token-2022 account of the mint whose owner can
//!    never change (the immutable owner extension, which every associated token account of
//!    Token-2022 carries). Otherwise a buy could deliver into an account its owner then hands
//!    to another wallet with `SetAuthority(AccountOwner)`, which moves no tokens and calls no
//!    hook, so the token would leave the home market without a transfer.
//!
//! It makes no CPI: on a direct buy it runs at the fourth of the runtime's five call levels
//! (router, strategy, Token-2022, hook), so one program wrapping the router still fits. It
//! never searches for a bump, and it writes nothing, so nothing relies on what a direct call
//! of it returns. Minting never calls a hook, so a launcher can mint the supply before and
//! after binding.

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
    /// CHECK: its address is compared with the allowed accounts, and any other destination
    /// is checked to be a Token-2022 account of the mint whose owner can never change.
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
    let into_the_market = allowed.contains(accounts.destination.key);
    require!(
        allowed.contains(accounts.source.key) || into_the_market,
        HookError::TransferRefused
    );
    require!(
        into_the_market || token_account::owner_is_immutable(&accounts.destination, mint),
        HookError::DestinationOwnerCanChange
    );
    Ok(())
}

/// The mint's config, refused unless it decodes as a config, names `mint`, and is owned by
/// this program at `["config", mint]` with the bump it stores.
fn read_config(account: &UncheckedAccount, mint: &Pubkey) -> Result<Config> {
    let config = Config::try_deserialize(&mut &account.try_borrow_data()?[..])
        .map_err(|_| error!(HookError::WrongConfig))?;
    require_keys_eq!(config.mint, *mint, HookError::WrongConfig);
    require_mint_pda(
        account,
        CONFIG_SEED,
        mint,
        config.config_bump,
        HookError::WrongConfig,
    )?;
    Ok(config)
}

/// Refuses a validation account unless it is owned by this program at
/// `["extra-account-metas", mint]` with the bump the config stores.
fn check_validation_account(
    account: &UncheckedAccount,
    mint: &Pubkey,
    config: &Config,
) -> Result<()> {
    require_mint_pda(
        account,
        EXTRA_ACCOUNT_METAS_SEED,
        mint,
        config.extra_account_metas_bump,
        HookError::WrongValidationAccount,
    )
}

/// Refuses `account`, with `error`, unless it is owned by this program and sits at its PDA
/// `[seed, mint]` with `bump`: the one check every account `bind` created for a mint passes.
/// Token-2022 itself passes these accounts at their derived addresses; the hook checks them
/// again so that no identity check it makes rests on the caller (`HOOK-45`).
fn require_mint_pda(
    account: &UncheckedAccount,
    seed: &[u8],
    mint: &Pubkey,
    bump: u8,
    error: HookError,
) -> Result<()> {
    require_keys_eq!(*account.owner, crate::ID, error);
    let address = Pubkey::create_program_address(&[seed, mint.as_ref(), &[bump]], &crate::ID)
        .map_err(|_| error!(error))?;
    require_keys_eq!(address, account.key(), error);
    Ok(())
}
