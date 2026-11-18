//! `lock_lp { amount }`: an LP moves `amount` of their LP shares into the market's lock account
//! for good (docs/spec/lending-pool.md, "Locking").
//!
//! The lock account is the vault authority's associated token account for the LP mint, created
//! here at the LP's expense when missing. No instruction ever moves shares out of it: the vault
//! authority signs only transfers out of the market's own vaults and cToken account, its LP
//! mint's mints and its Kamino calls, each from an account the program checks. Locked shares
//! still count in the share count `N`, so they keep earning the LP fee and the lending yield,
//! which stay in the market as depth for traders: protocol-owned liquidity. The event lets
//! indexers show how much of a market's liquidity is locked.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::{self, get_associated_token_address, AssociatedToken};
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::config::LP_DECIMALS;
use crate::errors::StrategyError;
use crate::events::SharesLocked;
use crate::shares;
use crate::state::{LendingAmmMarket, AUTHORITY_SEED};
use crate::token as tokens;

/// `lock_lp` accounts. The order is part of `metadata.json`; keep them in step.
#[derive(Accounts)]
pub struct LockLp<'info> {
    /// The LP, who pays for the lock account if it is missing.
    #[account(mut)]
    pub lp: Signer<'info>,
    #[account(has_one = lp_mint @ StrategyError::WrongAccount)]
    pub market_state: Box<Account<'info, LendingAmmMarket>>,
    pub lp_mint: Box<Account<'info, Mint>>,
    /// The token account of the LP mint the shares come from, which the LP owns.
    #[account(
        mut,
        constraint = lp_shares.mint == lp_mint.key() @ StrategyError::WrongAccount,
        constraint = lp_shares.owner == lp.key() @ StrategyError::WrongAccount,
    )]
    pub lp_shares: Box<Account<'info, TokenAccount>>,
    /// CHECK: the lock account, the vault authority's associated token account for the LP
    /// mint; created here if missing.
    #[account(
        mut,
        address = get_associated_token_address(&authority.key(), &lp_mint.key())
            @ StrategyError::WrongAccount,
    )]
    pub lock_account: UncheckedAccount<'info>,
    /// CHECK: the vault authority PDA, the lock account's owner.
    #[account(seeds = [AUTHORITY_SEED, market_state.key().as_ref()], bump = market_state.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// SPL Token, the LP mint's program.
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn lock_lp_handler(ctx: Context<LockLp>, amount: u64) -> Result<()> {
    require!(amount > 0, StrategyError::ZeroLock);
    let accounts = &ctx.accounts;
    let lock_account = accounts.lock_account.to_account_info();
    // Only the associated token program can create an account at that address, and only as the
    // vault authority's token account for the LP mint, which nobody can close, since only the
    // authority could; so an account with data there is the lock account.
    if lock_account.data_is_empty() {
        associated_token::create_idempotent(CpiContext::new(
            accounts.associated_token_program.key(),
            associated_token::Create {
                payer: accounts.lp.to_account_info(),
                associated_token: lock_account.clone(),
                authority: accounts.authority.to_account_info(),
                mint: accounts.lp_mint.to_account_info(),
                system_program: accounts.system_program.to_account_info(),
                token_program: accounts.token_program.to_account_info(),
            },
        ))?;
    }
    tokens::transfer_checked(
        &accounts.token_program.to_account_info(),
        &accounts.lp_shares.to_account_info(),
        &accounts.lp_mint.to_account_info(),
        &lock_account,
        &accounts.lp.to_account_info(),
        &[],
        amount,
        LP_DECIMALS,
        &[],
    )?;
    emit!(SharesLocked {
        market_state: accounts.market_state.key(),
        lp: accounts.lp.key(),
        amount,
        locked: tokens::token_balance(&lock_account)?,
        share_count: shares::share_count(accounts.lp_mint.supply)?,
    });
    Ok(())
}
