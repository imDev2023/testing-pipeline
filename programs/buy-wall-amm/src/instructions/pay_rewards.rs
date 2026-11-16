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
use crate::recipient::{ensure, RecipientAccounts};
use crate::state::{check_vault_accounts, is_market_state, MarketState, AUTHORITY_SEED};
use crate::token::{transfer_checked, Transfer};

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
    let market_state = accounts.market_state.key();
    let (owed, amount, authority_bump) = {
        let state = accounts.market_state.load()?;
        let authority_bump = check_vault_accounts(
            &state,
            &market_state,
            0,
            &accounts.token_vault.key(),
            &accounts.token_mint.key(),
            &accounts.vault_authority.key(),
        )?;
        let (owed, amount) = state
            .owed()
            .pay_rewards(&state.rewards_recipient)
            .map_err(|refusal| error!(StrategyError::from(refusal)))?;
        require_keys_eq!(
            accounts.rewards_recipient.key(),
            state.rewards_recipient,
            StrategyError::WrongAccount
        );
        (owed, amount, authority_bump)
    };

    ensure(RecipientAccounts {
        payer: &accounts.payer.to_account_info(),
        recipient: &accounts.rewards_recipient.to_account_info(),
        token_account: &accounts.recipient_token_account.to_account_info(),
        mint: &accounts.token_mint.to_account_info(),
        token_program: &accounts.token_program.to_account_info(),
        associated_token_program: &accounts.associated_token_program.to_account_info(),
        system_program: &accounts.system_program.to_account_info(),
    })?;
    let bump = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_state.as_ref(), &bump];
    transfer_checked(
        Transfer {
            token_program: &accounts.token_program.to_account_info(),
            from: &accounts.token_vault.to_account_info(),
            mint: &accounts.token_mint.to_account_info(),
            to: &accounts.recipient_token_account.to_account_info(),
            authority: &accounts.vault_authority.to_account_info(),
            hook_accounts: ctx.remaining_accounts,
        },
        amount,
        accounts.token_mint.decimals,
        &[authority_seeds],
    )?;

    accounts.market_state.load_mut()?.set_owed(&owed);
    emit!(RewardsPaid {
        market_state,
        recipient: accounts.rewards_recipient.key(),
        token_account: accounts.recipient_token_account.key(),
        amount,
        rewards_paid: owed.rewards_paid,
    });
    Ok(())
}
