//! `pipeline_seed_liquidity`: Pipeline's optional extension that lets another program, such
//! as a launchpad graduating a token, create, seed and open a buy wall market in one call
//! (docs/spec/pool4-for-solana.md, "Addresses", "Creation parameters", "Creating a market",
//! "The seed"; Pipeline's strategy guide, section 9).
//!
//! The market state lives at the PDA `["seeded", seeder, token_mint, wsol_mint]`, so nobody
//! can create or fund it before the seeder does, a seeder seeds a token once, and another
//! seeder of the same token gets another address. It is created by the same code as a market
//! created through the router ([`NewMarket`]), under every creation rule and mint rule, with
//! the calling program's PDA as its seeder whatever `data` says, and opened by the same code
//! as the `seed` action ([`bring_seed`], [`open_market`]), from the seeder's escrows instead
//! of its wallet's accounts. The caller then records the market with the router's
//! `register_existing_market`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token::{spl_token::native_mint, Token};
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use pipeline_strategy_interface as psi;

use super::init_market::{is_wrapped_sol, MarketBumps, NewMarket};
use super::seed::{bring_seed, check_authorities_removed, open_market, SeedSource};
use crate::config::MARKET_STATE_SIZE;
use crate::errors::StrategyError;
use crate::interface::SeedRequest;
use crate::params::InitParams;
use crate::state::{MarketState, AUTHORITY_SEED, SEEDED_SEED};
use crate::token::token_balance;

/// Pipeline's fixed seed accounts (`psi::seed_accounts`), then mint, escrow and token
/// program for the token (index 0) and for wrapped SOL (index 1), then the buy wall AMM's
/// own, in the order `metadata.json`'s `seed_liquidity.accounts` lists them. The token's
/// transfer-hook accounts follow.
#[derive(Accounts)]
pub struct SeedLiquidity<'info> {
    /// A PDA of the calling program, signing; it owns the escrows and becomes the seeder.
    pub seeder: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = MARKET_STATE_SIZE,
        seeds = [SEEDED_SEED, seeder.key().as_ref(), token_mint.key().as_ref(), wsol_mint.key().as_ref()],
        bump,
    )]
    pub market_state: AccountLoader<'info, MarketState>,
    /// A system account holding the SOL the caller allows for rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: ignored: a buy wall market issues no LP shares.
    pub lp_recipient: UncheckedAccount<'info>,
    /// The token, index 0. Its extensions are checked against the allowlist before the
    /// vaults are created.
    #[account(
        mint::token_program = token_program,
        constraint = !is_wrapped_sol(&token_mint.key()) @ StrategyError::SameMint,
    )]
    pub token_mint: Box<InterfaceAccount<'info, Mint>>,
    /// The seeder's own token account of the token (owned by the seeder, not merely
    /// delegated to it), as the `seed` action requires of the seeder's accounts.
    #[account(mut, token::mint = token_mint, token::authority = seeder, token::token_program = token_program)]
    pub token_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The token's program, SPL Token or Token-2022.
    pub token_program: Interface<'info, TokenInterface>,
    /// Wrapped SOL, index 1.
    #[account(address = native_mint::ID @ StrategyError::WrongAccount, mint::token_program = sol_token_program)]
    pub wsol_mint: Box<InterfaceAccount<'info, Mint>>,
    /// The seeder's own wrapped SOL account.
    #[account(mut, token::mint = wsol_mint, token::authority = seeder, token::token_program = sol_token_program)]
    pub sol_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    /// SPL Token, wrapped SOL's program.
    pub sol_token_program: Program<'info, Token>,
    /// CHECK: the PDA `["authority", market_state]`, which owns both vaults; it holds
    /// nothing itself.
    #[account(seeds = [AUTHORITY_SEED, market_state.key().as_ref()], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    /// CHECK: the token vault, the PDA `["vault", market_state, token_mint]`, created by the
    /// handler (`vaults.rs`).
    #[account(mut, seeds = [b"vault", market_state.key().as_ref(), token_mint.key().as_ref()], bump)]
    pub token_vault: UncheckedAccount<'info>,
    /// CHECK: the SOL vault, the PDA `["vault", market_state, wsol_mint]`, created like the
    /// token vault.
    #[account(mut, seeds = [b"vault", market_state.key().as_ref(), wsol_mint.key().as_ref()], bump)]
    pub sol_vault: UncheckedAccount<'info>,
}

pub fn handle_seed_liquidity<'info>(
    ctx: Context<'info, SeedLiquidity<'info>>,
    request: SeedRequest,
) -> Result<()> {
    let [token_amount, sol_amount] = request.amounts[..] else {
        return err!(StrategyError::BadSeedAmounts);
    };
    let accounts = &ctx.accounts;
    // The calling program's PDA is the seeder, whatever the data says.
    let params = InitParams {
        seeder: accounts.seeder.key(),
        ..InitParams::decode(&request.data)?
    };
    let market_state = accounts.market_state.key();
    let new_market = NewMarket {
        market_state,
        payer: accounts.payer.to_account_info(),
        system_program: accounts.system_program.to_account_info(),
        token_mint: accounts.token_mint.to_account_info(),
        wsol_mint: accounts.wsol_mint.to_account_info(),
        vault_authority: accounts.vault_authority.to_account_info(),
        token_vault: accounts.token_vault.to_account_info(),
        sol_vault: accounts.sol_vault.to_account_info(),
        token_program: accounts.token_program.to_account_info(),
        sol_token_program: accounts.sol_token_program.to_account_info(),
        bumps: MarketBumps {
            authority: ctx.bumps.vault_authority,
            token_vault: ctx.bumps.token_vault,
            sol_vault: ctx.bumps.sol_vault,
        },
    };
    new_market.check(&params)?;
    check_authorities_removed(&accounts.token_mint)?;
    new_market.create_vaults()?;

    // What leaves each escrow, measured, for the caller to check against its own measure.
    let escrows = [
        accounts.token_escrow.to_account_info(),
        accounts.sol_escrow.to_account_info(),
    ];
    let before = [token_balance(&escrows[0])?, token_balance(&escrows[1])?];
    let (x, y) = bring_seed(
        SeedSource {
            seeder: &accounts.seeder.to_account_info(),
            token_from: &escrows[0],
            sol_from: &escrows[1],
            token_vault: &new_market.token_vault,
            sol_vault: &new_market.sol_vault,
            token_mint: &accounts.token_mint,
            wsol_mint: &accounts.wsol_mint,
            token_program: &new_market.token_program,
            sol_token_program: &new_market.sol_token_program,
            hook_accounts: ctx.remaining_accounts,
        },
        token_amount,
        sol_amount,
    )?;
    let mut taken = Vec::with_capacity(2);
    for (escrow, before) in escrows.iter().zip(before) {
        taken.push(
            before
                .checked_sub(token_balance(escrow)?)
                .ok_or(StrategyError::WrongAccount)?,
        );
    }

    let clock = Clock::get()?;
    let mut state = accounts.market_state.load_init()?;
    new_market.record(&mut state, &params, &clock);
    open_market(&mut state, market_state, x, y, &clock)?;

    let result = psi::SeedResult {
        taken,
        lp_amount: 0,
    };
    set_return_data(&crate::borsh_encode(&result)?);
    Ok(())
}
