//! `pay_rewards`: the permissionless keeper job that pays the reward share out
//! (docs/spec/pool4-for-solana.md, "`pay_rewards`"). All of `rewards_owed` goes to the rewards
//! recipient's associated token account for the token, created at the caller's expense if
//! missing, forwarding the token's transfer-hook accounts; refused when nothing is owed; no
//! tip.
//!
//! It is separate from `settle`, so burns never wait on a transfer that a hook or a broken
//! recipient account might refuse; a refused payout changes nothing, and the rewards wait.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::errors::StrategyError;
use crate::events::RewardsPaid;
use crate::recipient::{pay_out, PayoutAccounts};
use crate::state::{is_market_state, MarketState, VaultSide};

/// The order is part of `metadata.json`'s `pay_rewards` action; keep them in step. The
/// token's transfer-hook accounts follow these.
#[derive(Accounts)]
pub struct PayRewards<'info> {
    /// Anyone; pays for the recipient's token account if it is missing.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// CHECK: compared with the market state's token vault.
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: compared with the market's rewards recipient.
    pub rewards_recipient: UncheckedAccount<'info>,
    /// CHECK: the rewards recipient's associated token account, checked and created if
    /// missing (`recipient::ensure`).
    #[account(mut)]
    pub recipient_token_account: UncheckedAccount<'info>,
    /// CHECK: compared with the vault authority from the stored bump.
    pub vault_authority: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_pay_rewards<'info>(ctx: Context<'info, PayRewards<'info>>) -> Result<()> {
    let accounts = &ctx.accounts;
    let paid = pay_out(
        PayoutAccounts {
            payer: &accounts.payer.to_account_info(),
            market_state: &accounts.market_state,
            vault: &accounts.token_vault.to_account_info(),
            mint: &accounts.token_mint.to_account_info(),
            recipient: &accounts.rewards_recipient.to_account_info(),
            token_account: &accounts.recipient_token_account.to_account_info(),
            vault_authority: &accounts.vault_authority.to_account_info(),
            token_program: &accounts.token_program.to_account_info(),
            associated_token_program: &accounts.associated_token_program.to_account_info(),
            system_program: &accounts.system_program.to_account_info(),
            hook_accounts: ctx.remaining_accounts,
        },
        VaultSide::Token,
        accounts.token_mint.decimals,
        |state| {
            let (owed, amount) = state.owed().pay_rewards(&state.rewards_recipient)?;
            Ok((owed, state.rewards_recipient, amount))
        },
    )?;
    emit!(RewardsPaid {
        market_state: accounts.market_state.key(),
        recipient: paid.wallet,
        token_account: accounts.recipient_token_account.key(),
        amount: paid.amount,
        rewards_paid: paid.owed.rewards_paid,
    });
    Ok(())
}
