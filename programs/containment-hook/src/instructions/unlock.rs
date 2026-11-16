//! `unlock`: frees a contained token for good once its home market has collected the unlock
//! goal in tax or its unlock deadline has passed (docs/spec/containment-hook.md, "Unlock").
//!
//! Permissionless: it takes no signer of its own, so whoever sends it pays only the
//! transaction fee. It reads `tax_collected` from the market state recorded at binding,
//! checked by its address and its owner, decides with [`unlock_due`], then, signed by the
//! unlock PDA, calls Token-2022's `TransferHookInstruction::Update` with no program id and
//! `SetAuthority(TransferHookProgramId, None)`, and records the unlock time in the config,
//! the one field `bind` leaves for it. Token-2022 calls no hook for the mint afterwards.
//!
//! A second `unlock` is refused because the config records the first, and would fail anyway
//! because the mint has no hook authority left to sign.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::instruction::AuthorityType;
use anchor_spl::token_2022::{self, SetAuthority, Token2022};
use anchor_spl::token_2022_extensions::transfer_hook::{transfer_hook_update, TransferHookUpdate};

use crate::config::TAX_AMM_PROGRAM_ID;
use crate::errors::HookError;
use crate::state::{Config, CONFIG_SEED, UNLOCK_SEED};
use crate::tax_market;
use crate::terms::{unlock_due, DueBy};

#[derive(Accounts)]
pub struct Unlock<'info> {
    /// The contained mint, whose transfer hook fields Token-2022 clears.
    /// CHECK: it is the config's mint by the config's seeds, and Token-2022 checks the rest.
    #[account(mut)]
    pub mint: UncheckedAccount<'info>,
    /// The mint's config, where the unlock time is recorded.
    #[account(mut, seeds = [CONFIG_SEED, mint.key().as_ref()], bump = config.config_bump)]
    pub config: Account<'info, Config>,
    /// The unlock PDA, the mint's transfer hook authority, which signs both Token-2022 calls.
    /// CHECK: only its address is used, derived from its seeds with the config's bump.
    #[account(seeds = [UNLOCK_SEED, mint.key().as_ref()], bump = config.unlock_bump)]
    pub unlock: UncheckedAccount<'info>,
    /// The tax AMM market state recorded at binding, read for its tax collected.
    /// CHECK: the handler checks its address against the config and its owner.
    pub market_state: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token2022>,
}

pub fn process_unlock(ctx: Context<Unlock>) -> Result<()> {
    let accounts = &ctx.accounts;
    let config = &accounts.config;
    require!(config.unlocked_at.is_none(), HookError::AlreadyUnlocked);
    require_keys_eq!(
        accounts.market_state.key(),
        config.market_state,
        HookError::WrongMarketState
    );
    require_keys_eq!(
        *accounts.market_state.owner,
        TAX_AMM_PROGRAM_ID,
        HookError::NotATaxMarketState
    );
    let tax_collected = tax_market::tax_collected(&accounts.market_state.try_borrow_data()?)
        .ok_or(HookError::NotATaxMarketState)?;

    let now = Clock::get()?.unix_timestamp;
    let due = unlock_due(
        tax_collected,
        config.unlock_goal,
        now,
        config.unlock_deadline,
    )
    .ok_or(HookError::UnlockNotDue)?;
    match due {
        DueBy::Goal => msg!(
            "Unlocked by the goal: {} of {} collected",
            tax_collected,
            config.unlock_goal
        ),
        DueBy::Deadline => msg!("Unlocked by the deadline {}", config.unlock_deadline),
    }

    let mint = accounts.mint.key();
    let seeds: &[&[u8]] = &[UNLOCK_SEED, mint.as_ref(), &[config.unlock_bump]];
    let signer = &[seeds];
    let token_program = accounts.token_program.to_account_info();
    transfer_hook_update(
        CpiContext::new_with_signer(
            token_program.key(),
            TransferHookUpdate {
                token_program_id: token_program.clone(),
                mint: accounts.mint.to_account_info(),
                authority: accounts.unlock.to_account_info(),
            },
            signer,
        ),
        None,
    )?;
    token_2022::set_authority(
        CpiContext::new_with_signer(
            token_program.key(),
            SetAuthority {
                current_authority: accounts.unlock.to_account_info(),
                account_or_mint: accounts.mint.to_account_info(),
            },
            signer,
        ),
        AuthorityType::TransferHookProgramId,
        None,
    )?;

    ctx.accounts.config.unlocked_at = Some(now);
    Ok(())
}
