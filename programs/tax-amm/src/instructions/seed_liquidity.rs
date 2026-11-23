//! `pipeline_seed_liquidity`: Pipeline's optional extension that lets another program, such
//! as a launchpad graduating a token, create and fund a tax market in one call
//! (docs/spec/tax-amm.md, "Addresses", "Creation parameters", "The seed"; Pipeline's strategy
//! guide, section 9).
//!
//! The market state lives at the PDA `["seeded", seeder, mint_0, mint_1]`, so nobody can
//! create or fund it before the seeder does, and a seeder seeds a pair of mints once. It is
//! created by the same code as a market created through the router ([`NewMarket`]), under
//! every creation rule and mint rule, with the calling program's PDA as its seeder whatever
//! `data` says. The seed is taken as the `seed` action takes it ([`take_seed`]), at most
//! `amounts[i]` from each escrow, and the market opens in the same call. The caller then
//! records the market with the router's `register_existing_market`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use anchor_spl::token_interface::TokenInterface;
use pipeline_strategy_interface as psi;

use super::init_market::{pipeline_market_signer, NewMarket};
use super::seed::{take_seed, SeedSide};
use crate::errors::StrategyError;
use crate::events::Seeded;
use crate::interface::SeedRequest;
use crate::params::InitParams;
use crate::state::{MarketStatus, TaxMarket, AUTHORITY_SEED, SEEDED_SEED, VAULT_SEED};
use crate::token::{mint_decimals, token_balance};

/// Pipeline's fixed seed accounts (`psi::seed_accounts`), three per mint, then the tax AMM's
/// own, in the order `metadata.json`'s `seed_liquidity.accounts` lists them. Transfer-hook
/// accounts follow.
#[derive(Accounts)]
pub struct SeedLiquidity<'info> {
    /// A PDA of the calling program, signing; it owns the escrows and becomes the seeder.
    pub seeder: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = TaxMarket::SPACE,
        seeds = [SEEDED_SEED, seeder.key().as_ref(), mint_0.key().as_ref(), mint_1.key().as_ref()],
        bump,
    )]
    pub market_state: Account<'info, TaxMarket>,
    /// A system account holding the SOL the caller allows for rent.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: ignored: a tax market issues no LP shares.
    pub lp_recipient: UncheckedAccount<'info>,
    /// CHECK: checked against the mint rules, before any vault exists.
    pub mint_0: UncheckedAccount<'info>,
    /// CHECK: the seeder's escrow of mint 0: the seed checks its owner, and the token
    /// program the rest.
    #[account(mut)]
    pub escrow_0: UncheckedAccount<'info>,
    pub token_program_0: Interface<'info, TokenInterface>,
    /// CHECK: checked against the mint rules, before any vault exists.
    pub mint_1: UncheckedAccount<'info>,
    /// CHECK: the seeder's escrow of mint 1, checked as `escrow_0` is.
    #[account(mut)]
    pub escrow_1: UncheckedAccount<'info>,
    pub token_program_1: Interface<'info, TokenInterface>,
    /// CHECK: the vault authority PDA, which owns both vaults; it holds no data.
    #[account(seeds = [AUTHORITY_SEED, market_state.key().as_ref()], bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the vault PDA for mint 0, created by the handler.
    #[account(mut, seeds = [VAULT_SEED, market_state.key().as_ref(), mint_0.key().as_ref()], bump)]
    pub vault_0: UncheckedAccount<'info>,
    /// CHECK: the vault PDA for mint 1, created by the handler.
    #[account(mut, seeds = [VAULT_SEED, market_state.key().as_ref(), mint_1.key().as_ref()], bump)]
    pub vault_1: UncheckedAccount<'info>,
}

pub fn seed_liquidity<'info>(
    ctx: Context<'info, SeedLiquidity<'info>>,
    request: SeedRequest,
) -> Result<()> {
    let [amount_0, amount_1] = request.amounts[..] else {
        return err!(StrategyError::BadSeedAmounts);
    };
    let params =
        InitParams::try_from_slice(&request.data).map_err(|_| StrategyError::BadInitData)?;
    let seeder = ctx.accounts.seeder.key();
    // The calling program's PDA is the seeder, whatever the data says.
    let params = InitParams { seeder, ..params };

    let market_state = ctx.accounts.market_state.key();
    let accounts = &ctx.accounts;
    let mut market = NewMarket {
        market_state,
        market_signer: pipeline_market_signer(&market_state),
        payer: &accounts.payer,
        system_program: &accounts.system_program,
        mints: [&accounts.mint_0, &accounts.mint_1],
        token_programs: [&accounts.token_program_0, &accounts.token_program_1],
        authority: &accounts.authority,
        authority_bump: ctx.bumps.authority,
        vaults: [&accounts.vault_0, &accounts.vault_1],
        vault_bumps: [ctx.bumps.vault_0, ctx.bumps.vault_1],
    }
    .create(&params)?;

    let sides = [
        SeedSide {
            from: accounts.escrow_0.to_account_info(),
            vault: accounts.vault_0.to_account_info(),
            mint: accounts.mint_0.to_account_info(),
            decimals: mint_decimals(&accounts.mint_0)?,
            token_program: accounts.token_program_0.to_account_info(),
        },
        SeedSide {
            from: accounts.escrow_1.to_account_info(),
            vault: accounts.vault_1.to_account_info(),
            mint: accounts.mint_1.to_account_info(),
            decimals: mint_decimals(&accounts.mint_1)?,
            token_program: accounts.token_program_1.to_account_info(),
        },
    ];
    // What leaves each escrow, measured, for the caller to check against its own measurement.
    let escrows = [&accounts.escrow_0, &accounts.escrow_1];
    let mut escrowed = [0u64; 2];
    for i in 0..2 {
        if request.amounts[i] > 0 {
            escrowed[i] = token_balance(&escrows[i].to_account_info())?;
        }
    }
    let arrived = take_seed(
        &market,
        &accounts.seeder.to_account_info(),
        sides,
        [amount_0, amount_1],
        ctx.remaining_accounts,
    )?;
    let mut taken = vec![0u64; 2];
    for i in 0..2 {
        // A side of 0 is never transferred, so nothing left its escrow.
        if request.amounts[i] > 0 {
            taken[i] = escrowed[i]
                .checked_sub(token_balance(&escrows[i].to_account_info())?)
                .ok_or(StrategyError::Underflow)?;
        }
    }

    market.reserves = arrived;
    market.status = MarketStatus::Open;
    ctx.accounts.market_state.set_inner(market);
    emit!(Seeded {
        market_state,
        seeder,
        amounts: arrived,
    });
    let result = psi::SeedResult {
        taken,
        lp_amount: 0,
    };
    set_return_data(&crate::borsh_encode(&result)?);
    Ok(())
}
