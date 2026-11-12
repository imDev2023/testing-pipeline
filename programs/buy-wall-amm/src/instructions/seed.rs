//! `seed { token_amount, sol_amount }`: the custom action that opens a market
//! (docs/spec/pool4-for-solana.md, "The seed"). Signed by the market's seeder, from token
//! accounts the seeder owns, allowed once.
//!
//! It records what actually arrived in each vault, `x` token units and `y` lamports, so
//! anything sent to a vault earlier stays a donation, and opens the market from them
//! (`opening::open`).

use anchor_lang::prelude::*;
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::errors::StrategyError;
use crate::events::MarketSeeded;
use crate::opening;
use crate::state::{is_market_state, MarketState, STATUS_CREATED, STATUS_OPEN};
use crate::token::{transfer_measured, Transfer};

/// The order is part of `metadata.json`'s `seed` action; keep them in step. Remaining
/// accounts are the token's transfer-hook accounts.
#[derive(Accounts)]
pub struct Seed<'info> {
    /// The market's stored seeder; checked in the handler.
    pub seeder: Signer<'info>,
    #[account(mut, constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// The seeder's own token account (owned by the seeder, not merely delegated to them).
    #[account(mut, token::mint = token_mint, token::authority = seeder, token::token_program = token_program)]
    pub seeder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The seeder's own wrapped SOL account.
    #[account(mut, token::mint = wsol_mint, token::authority = seeder, token::token_program = sol_token_program)]
    pub seeder_sol: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: compared with the market state's token vault.
    #[account(mut)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: compared with the market state's SOL vault.
    #[account(mut)]
    pub sol_vault: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = sol_token_program)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub sol_token_program: Program<'info, Token>,
}

pub fn handle_seed<'info>(
    ctx: Context<'info, Seed<'info>>,
    token_amount: u64,
    sol_amount: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let (cap_floor_bps, cap_decay_bps) = {
        let state = accounts.market_state.load()?;
        require!(state.status == STATUS_CREATED, StrategyError::AlreadySeeded);
        require_keys_eq!(
            accounts.seeder.key(),
            state.seeder,
            StrategyError::NotSeeder
        );
        require_keys_eq!(
            accounts.token_vault.key(),
            state.token_vault,
            StrategyError::WrongAccount
        );
        require_keys_eq!(
            accounts.sol_vault.key(),
            state.sol_vault,
            StrategyError::WrongAccount
        );
        require_keys_eq!(
            accounts.token_mint.key(),
            state.token_mint,
            StrategyError::WrongAccount
        );
        require_keys_eq!(
            accounts.wsol_mint.key(),
            state.wsol_mint,
            StrategyError::WrongAccount
        );
        (state.cap_floor_bps(), state.cap_decay_bps())
    };
    // A live mint authority could mint and sell into the curve and the wall, and a live
    // freeze authority could freeze the vault (the spec's "Mint rules").
    require!(
        accounts.token_mint.mint_authority.is_none(),
        StrategyError::MintAuthorityLive
    );
    require!(
        accounts.token_mint.freeze_authority.is_none(),
        StrategyError::FreezeAuthorityLive
    );

    let seeder = accounts.seeder.to_account_info();
    let x = transfer_measured(
        Transfer {
            token_program: &accounts.token_program.to_account_info(),
            from: &accounts.seeder_token.to_account_info(),
            mint: &accounts.token_mint.to_account_info(),
            to: &accounts.token_vault.to_account_info(),
            authority: &seeder,
            hook_accounts: ctx.remaining_accounts,
        },
        token_amount,
        accounts.token_mint.decimals,
    )?;
    let y = transfer_measured(
        Transfer {
            token_program: &accounts.sol_token_program.to_account_info(),
            from: &accounts.seeder_sol.to_account_info(),
            mint: &accounts.wsol_mint.to_account_info(),
            to: &accounts.sol_vault.to_account_info(),
            authority: &seeder,
            hook_accounts: &[],
        },
        sol_amount,
        accounts.wsol_mint.decimals,
    )?;

    let opened = opening::open(x, y, cap_floor_bps, cap_decay_bps).map_err(StrategyError::from)?;
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let mut state = accounts.market_state.load_mut()?;
    state.status = STATUS_OPEN;
    state.set_seed_time(now);
    state.set_seeded_tokens(x);
    state.set_cap_floor(opened.cap_floor);
    state.set_cap_decay_per_day(opened.cap_decay_per_day);
    state.set_sqrt_price(opened.sqrt_price);
    state.set_liquidity(opened.liquidity);
    state.set_pool_tokens(x);
    state.set_pool_sol(y);
    state.set_cap(opened.cap);
    state.set_decay_time(now);
    // The wall guard starts at the opening price, and every clock field at now.
    state.set_reference(opened.sqrt_price);
    state.set_ref_time(now);
    state.set_floor(opened.sqrt_price);
    state.set_floor_time(now);
    state.set_last_slot(clock.slot);
    state.set_last_close(opened.sqrt_price);

    emit!(MarketSeeded {
        market_state: accounts.market_state.key(),
        token_amount: x,
        sol_amount: y,
        sqrt_price: opened.sqrt_price,
        liquidity: opened.liquidity,
        cap: opened.cap,
        cap_floor: opened.cap_floor,
        cap_decay_per_day: opened.cap_decay_per_day,
        seed_time: now,
    });
    Ok(())
}
