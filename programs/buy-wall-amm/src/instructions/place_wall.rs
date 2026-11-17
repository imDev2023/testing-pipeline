//! `place_wall`: the permissionless keeper job that turns idle SOL into the buy wall
//! (docs/spec/pool4-for-solana.md, "`place_wall`"). Anyone may call it once `idle_sol`, or the
//! SOL the placed wall has spent, reaches `WALL_THRESHOLD`, in a slot no swap has run in yet
//! (`SwapThisSlot` otherwise, `POOL4-50`); our keeper runner does.
//!
//! It brings the floor up to date as a swap's first update in the slot would, without marking
//! the slot, closes the old wall at the current price, sweeps the pool's rounding dust, tips
//! the caller at most `KEEPER_TIP_CAP` and never more than the fee the market earned on the
//! work, in wrapped SOL to a token account the caller names, and places the new wall with
//! everything left at `min(price, floor)` (`wall::place_in_slot`). It never moves the price.

use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::errors::StrategyError;
use crate::events::WallPlaced;
use crate::state::{is_market_state, vault_authority, MarketState, AUTHORITY_SEED, STATUS_OPEN};
use crate::token::{transfer_checked, Transfer};
use crate::wall;

/// The order is part of `metadata.json`'s `place_wall` action; keep them in step.
#[derive(Accounts)]
pub struct PlaceWall<'info> {
    /// Anyone; named in the event.
    pub caller: Signer<'info>,
    #[account(mut, constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// CHECK: compared with the market state's SOL vault.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    /// Any wrapped SOL account, for the tip; never the SOL vault itself.
    #[account(mut, token::mint = wsol_mint, token::token_program = sol_token_program)]
    pub tip_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = sol_token_program)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: compared with the vault authority from the stored bump.
    pub vault_authority: UncheckedAccount<'info>,
    pub sol_token_program: Program<'info, Token>,
}

pub fn handle_place_wall(ctx: Context<PlaceWall>) -> Result<()> {
    let accounts = &ctx.accounts;
    let market_state = accounts.market_state.key();
    let (placed, placement, guard, authority_bump) = {
        let state = accounts.market_state.load()?;
        require!(state.status == STATUS_OPEN, StrategyError::MarketNotOpen);
        require_keys_eq!(
            accounts.wsol_mint.key(),
            state.wsol_mint,
            StrategyError::WrongAccount
        );
        require_keys_eq!(
            accounts.sol_vault.key(),
            state.sol_vault,
            StrategyError::WrongAccount
        );
        // Paying the vault itself would move nothing while the market booked a tip.
        require_keys_neq!(
            accounts.tip_account.key(),
            state.sol_vault,
            StrategyError::WrongAccount
        );
        let authority = vault_authority(&market_state, state.authority_bump)
            .ok_or(StrategyError::WrongAccount)?;
        require_keys_eq!(
            accounts.vault_authority.key(),
            authority,
            StrategyError::WrongAccount
        );
        // Only in a slot no swap has run in, under the floor brought up to date for it
        // (`POOL4-50`).
        let clock = Clock::get()?;
        let (placed, placement, guard) = wall::place_in_slot(
            state.wall_books(),
            state.wall_at(),
            state.guard(),
            clock.slot,
            clock.unix_timestamp,
        )
        .map_err(|refusal| error!(StrategyError::from(refusal)))?;
        (placed, placement, guard, state.authority_bump)
    };

    if placement.tip > 0 {
        let bump = [authority_bump];
        let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_state.as_ref(), &bump];
        transfer_checked(
            Transfer {
                token_program: &accounts.sol_token_program.to_account_info(),
                from: &accounts.sol_vault.to_account_info(),
                mint: &accounts.wsol_mint.to_account_info(),
                to: &accounts.tip_account.to_account_info(),
                authority: &accounts.vault_authority.to_account_info(),
                hook_accounts: &[],
            },
            placement.tip,
            accounts.wsol_mint.decimals,
            &[authority_seeds],
        )?;
    }

    let mut state = accounts.market_state.load_mut()?;
    state.set_wall_books(&placed);
    state.set_guard(&guard);
    drop(state);
    emit!(WallPlaced {
        market_state,
        caller: accounts.caller.key(),
        tip_account: accounts.tip_account.key(),
        converted: placement.converted,
        closed_sol: placement.closed_sol,
        closed_tokens: placement.closed_tokens,
        dust_sol: placement.dust_sol,
        dust_tokens: placement.dust_tokens,
        tip: placement.tip,
        wall_top: placed.wall.top,
        wall_liquidity: placed.wall.liquidity,
        wall_sol_placed: placed.wall_sol_placed,
    });
    Ok(())
}
