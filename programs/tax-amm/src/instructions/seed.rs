//! `seed`: the seeder funds a tax market once, before any swap, and opens it
//! (docs/spec/tax-amm.md, "The seed"). Liquidity is locked for good from then on: no
//! instruction takes it out.
//!
//! The market records each side's real reserve from what actually arrived in its vault,
//! so tokens anyone sent to a vault beforehand stay out of the price as donations.
//!
//! The seeder names the terms it agreed to by their hash, and a market whose terms as stored
//! hash otherwise is refused before anything moves (`crate::terms`; hardening finding H019,
//! #67), so a seeder handed a look-alike market can't be made to fund it.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::errors::StrategyError;
use crate::events::Seeded;
use crate::state::{MarketStatus, TaxMarket, STATE_VERSION};
use crate::token::{token_balance, token_owner, transfer_checked};

/// The order is `metadata.json`'s `seed` action; keep them in step. Transfer-hook
/// accounts follow, for either mint.
#[derive(Accounts)]
pub struct Seed<'info> {
    pub seeder: Signer<'info>,
    #[account(
        mut,
        has_one = seeder @ StrategyError::NotSeeder,
        constraint = market_state.version <= STATE_VERSION @ StrategyError::NewerStateVersion
    )]
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
    expected_terms: [u8; 32],
) -> Result<()> {
    let market = &ctx.accounts.market_state;
    require!(
        market.status == MarketStatus::Created,
        StrategyError::AlreadySeeded
    );
    require!(
        crate::terms::terms_hash(market)? == expected_terms,
        StrategyError::TermsChanged
    );
    let accounts = &ctx.accounts;
    let sides = [
        SeedSide {
            from: accounts.seeder_token_0.to_account_info(),
            vault: accounts.vault_0.to_account_info(),
            mint: accounts.mint_0.to_account_info(),
            decimals: accounts.mint_0.decimals,
            token_program: accounts.token_program_0.to_account_info(),
        },
        SeedSide {
            from: accounts.seeder_token_1.to_account_info(),
            vault: accounts.vault_1.to_account_info(),
            mint: accounts.mint_1.to_account_info(),
            decimals: accounts.mint_1.decimals,
            token_program: accounts.token_program_1.to_account_info(),
        },
    ];
    let arrived = take_seed(
        market,
        &accounts.seeder.to_account_info(),
        sides,
        [amount_0, amount_1],
        ctx.remaining_accounts,
    )?;

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

/// One side of a seed: the seeder's token account it comes from and the vault it goes to.
pub(crate) struct SeedSide<'info> {
    pub from: AccountInfo<'info>,
    pub vault: AccountInfo<'info>,
    pub mint: AccountInfo<'info>,
    pub decimals: u8,
    pub token_program: AccountInfo<'info>,
}

/// Moves each side's amount from a token account the seeder owns into the market's vault, as
/// the `seed` action and `pipeline_seed_liquidity` both do, and returns what arrived in each
/// vault, in mint order, which the market records as its real reserves. Each side's real
/// amount must be above 0, except the virtual side's when the market has a virtual reserve,
/// and neither mint may keep a lever the seed refuses (the transfer hook and the authorities,
/// [`crate::mint_levers`]).
pub(crate) fn take_seed<'info>(
    market: &TaxMarket,
    seeder: &AccountInfo<'info>,
    sides: [SeedSide<'info>; 2],
    amounts: [u64; 2],
    hook_accounts: &[AccountInfo<'info>],
) -> Result<[u64; 2]> {
    // A side may be seeded with nothing only when its virtual reserve prices it.
    let may_be_empty = |i: usize| market.virtual_side as usize == i && market.virtual_reserve > 0;
    let mut arrived = [0u64; 2];
    for (i, side) in sides.into_iter().enumerate() {
        // No lever over either mint survives the opening (`crate::mint_levers`): the hook is
        // checked again, for a market an earlier build created before the hook rule existed
        // (hardening round 2, R01, #67), and the authorities for the first time.
        {
            let data = side.mint.try_borrow_data()?;
            crate::mint_levers::check_transfer_hook(side.mint.key, &data)
                .and_then(|()| crate::mint_levers::check_authorities(side.mint.key, &data))
                .map_err(|refusal| {
                    msg!(
                        "Mint {} keeps a lever a market refuses at its seed",
                        side.mint.key
                    );
                    error!(refusal)
                })?;
        }
        if amounts[i] > 0 {
            // From token accounts the seeder owns, never one it is only a delegate of.
            require_keys_eq!(
                token_owner(&side.from)?,
                seeder.key(),
                StrategyError::WrongAccount
            );
            let vault_before = token_balance(&side.vault)?;
            transfer_checked(
                &side.token_program,
                &side.from,
                &side.mint,
                &side.vault,
                seeder,
                hook_accounts,
                amounts[i],
                side.decimals,
                &[],
            )?;
            arrived[i] = token_balance(&side.vault)?
                .checked_sub(vault_before)
                .ok_or(StrategyError::Underflow)?;
        }
        require!(arrived[i] > 0 || may_be_empty(i), StrategyError::ZeroSeed);
    }
    Ok(arrived)
}
