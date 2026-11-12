//! `seed`: the seeder funds a tax market once, before any swap, and opens it
//! (docs/spec/tax-amm.md, "The seed"). Liquidity is locked for good from then on: no
//! instruction takes it out.
//!
//! The market records each side's real reserve from what actually arrived in its vault,
//! so tokens anyone sent to a vault beforehand stay out of the price as donations.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::errors::StrategyError;
use crate::events::Seeded;
use crate::state::{MarketStatus, TaxMarket};
use crate::token::{token_balance, token_owner, transfer_checked};

/// The order is `metadata.json`'s `seed` action; keep them in step. Transfer-hook
/// accounts follow, for either mint.
#[derive(Accounts)]
pub struct Seed<'info> {
    pub seeder: Signer<'info>,
    #[account(mut, has_one = seeder @ StrategyError::NotSeeder)]
    pub market_state: Account<'info, TaxMarket>,
    /// CHECK: the seeder's own token account of mint 0: the handler checks its owner, and
    /// the token program the rest.
    #[account(mut)]
    pub seeder_token_0: UncheckedAccount<'info>,
    /// CHECK: the seeder's token account of mint 1, checked by the token program.
    #[account(mut)]
    pub seeder_token_1: UncheckedAccount<'info>,
    /// CHECK: the market's vault for mint 0.
    #[account(mut, address = market_state.vaults[0] @ StrategyError::WrongAccount)]
    pub vault_0: UncheckedAccount<'info>,
    /// CHECK: the market's vault for mint 1.
    #[account(mut, address = market_state.vaults[1] @ StrategyError::WrongAccount)]
    pub vault_1: UncheckedAccount<'info>,
    #[account(
        address = market_state.mints[0] @ StrategyError::WrongAccount,
        mint::token_program = token_program_0,
    )]
    pub mint_0: InterfaceAccount<'info, Mint>,
    #[account(
        address = market_state.mints[1] @ StrategyError::WrongAccount,
        mint::token_program = token_program_1,
    )]
    pub mint_1: InterfaceAccount<'info, Mint>,
    pub token_program_0: Interface<'info, TokenInterface>,
    pub token_program_1: Interface<'info, TokenInterface>,
}

pub fn seed_market<'info>(
    ctx: Context<'info, Seed<'info>>,
    amount_0: u64,
    amount_1: u64,
) -> Result<()> {
    let market = &ctx.accounts.market_state;
    require!(
        market.status == MarketStatus::Created,
        StrategyError::AlreadySeeded
    );
    let amounts = [amount_0, amount_1];
    // A side may be seeded with nothing only when its virtual reserve prices it.
    let may_be_empty = |i: usize| market.virtual_side as usize == i && market.virtual_reserve > 0;

    let accounts = &ctx.accounts;
    let sides = [
        (
            &accounts.seeder_token_0,
            &accounts.vault_0,
            &accounts.mint_0,
            &accounts.token_program_0,
        ),
        (
            &accounts.seeder_token_1,
            &accounts.vault_1,
            &accounts.mint_1,
            &accounts.token_program_1,
        ),
    ];
    let mut arrived = [0u64; 2];
    for (i, (from, vault, mint, token_program)) in sides.into_iter().enumerate() {
        if amounts[i] > 0 {
            // From token accounts the seeder owns, never one it is only a delegate of.
            require_keys_eq!(
                token_owner(&from.to_account_info())?,
                accounts.seeder.key(),
                StrategyError::WrongAccount
            );
            let before = token_balance(&vault.to_account_info())?;
            transfer_checked(
                &token_program.to_account_info(),
                &from.to_account_info(),
                &mint.to_account_info(),
                &vault.to_account_info(),
                &accounts.seeder.to_account_info(),
                ctx.remaining_accounts,
                amounts[i],
                mint.decimals,
                &[],
            )?;
            arrived[i] = token_balance(&vault.to_account_info())?
                .checked_sub(before)
                .ok_or(StrategyError::Overflow)?;
        }
        require!(arrived[i] > 0 || may_be_empty(i), StrategyError::ZeroSeed);
    }

    let market_state = ctx.accounts.market_state.key();
    let state = &mut ctx.accounts.market_state;
    state.reserves = arrived;
    state.status = MarketStatus::Open;
    emit!(Seeded {
        market_state,
        seeder: state.seeder,
        amounts: arrived,
    });
    Ok(())
}
