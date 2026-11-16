//! `sweep_fees { slot }`: the permissionless keeper job that pays one fee ledger out
//! (docs/spec/pool4-for-solana.md, "`sweep_fees { slot }`"). Slot 0 is `fees_recipient` to the
//! fee recipient, slot 1 `fees_designer` to `DESIGNER_RECIPIENT`, slot 2 `fees_suite` to
//! `SUITE_TREASURY`, each paid whole in wrapped SOL to the wallet's associated token account,
//! created at the caller's expense if missing; slot 1 is refused while `DESIGNER_RECIPIENT`
//! is unset, the SOL waiting in the vault; no tip.
//!
//! Each slot is paid separately, so one broken account never holds up the others.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::Token;
use anchor_spl::token_interface::Mint;

use crate::errors::StrategyError;
use crate::events::FeesSwept;
use crate::recipient::{ensure, RecipientAccounts};
use crate::state::{check_vault_accounts, is_market_state, MarketState, AUTHORITY_SEED};
use crate::token::{transfer_checked, Transfer};

/// The order is part of `metadata.json`'s `sweep_fees` action; keep them in step.
#[derive(Accounts)]
pub struct SweepFees<'info> {
    /// Anyone; pays for the recipient's token account if it is missing.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// CHECK: compared with the market state's SOL vault.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    #[account(mint::token_program = sol_token_program)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: compared with the slot's wallet.
    pub recipient: UncheckedAccount<'info>,
    /// CHECK: the slot wallet's associated wrapped SOL account, checked and created if
    /// missing (`recipient::ensure`).
    #[account(mut)]
    pub recipient_token_account: UncheckedAccount<'info>,
    /// CHECK: compared with the vault authority from the stored bump.
    pub vault_authority: UncheckedAccount<'info>,
    pub sol_token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_sweep_fees(ctx: Context<SweepFees>, slot: u8) -> Result<()> {
    let accounts = &ctx.accounts;
    let market_state = accounts.market_state.key();
    let (owed, wallet, amount, authority_bump) = {
        let state = accounts.market_state.load()?;
        let authority_bump = check_vault_accounts(
            &state,
            &market_state,
            1,
            &accounts.sol_vault.key(),
            &accounts.wsol_mint.key(),
            &accounts.vault_authority.key(),
        )?;
        let (owed, wallet, amount) = state
            .owed()
            .sweep(slot, &state.fee_recipient)
            .map_err(|refusal| error!(StrategyError::from(refusal)))?;
        (owed, wallet, amount, authority_bump)
    };
    require_keys_eq!(
        accounts.recipient.key(),
        wallet,
        StrategyError::WrongAccount
    );

    ensure(RecipientAccounts {
        payer: &accounts.payer.to_account_info(),
        recipient: &accounts.recipient.to_account_info(),
        token_account: &accounts.recipient_token_account.to_account_info(),
        mint: &accounts.wsol_mint.to_account_info(),
        token_program: &accounts.sol_token_program.to_account_info(),
        associated_token_program: &accounts.associated_token_program.to_account_info(),
        system_program: &accounts.system_program.to_account_info(),
    })?;
    let bump = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_state.as_ref(), &bump];
    transfer_checked(
        Transfer {
            token_program: &accounts.sol_token_program.to_account_info(),
            from: &accounts.sol_vault.to_account_info(),
            mint: &accounts.wsol_mint.to_account_info(),
            to: &accounts.recipient_token_account.to_account_info(),
            authority: &accounts.vault_authority.to_account_info(),
            hook_accounts: &[],
        },
        amount,
        accounts.wsol_mint.decimals,
        &[authority_seeds],
    )?;

    accounts.market_state.load_mut()?.set_owed(&owed);
    emit!(FeesSwept {
        market_state,
        slot,
        recipient: wallet,
        token_account: accounts.recipient_token_account.key(),
        amount,
    });
    Ok(())
}
