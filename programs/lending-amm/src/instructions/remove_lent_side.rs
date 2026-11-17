//! `remove_lent_side { lp, min_lent }`: an LP burns `lp` shares and leaves with the lent side's
//! parts alone, giving up the other side's part to the LPs who stay (docs/spec/lending-pool.md,
//! "Removing").
//!
//! The other mint may keep a freeze authority or a transfer hook, which the mint rules allow and
//! Aviary shows. If its authority freezes the market's vault, or its hook refuses transfers out
//! of it, every `remove_liquidity` fails, since it pays the other side first, and would trap the
//! lent side too, the WSOL or USDC LPs count on leaving with (finding H006,
//! docs/security/lending-amm/). This removal moves nothing of the other mint, so neither can stop
//! it: it pays the buffer's part in the lent mint and the cTokens' part as cTokens, in kind,
//! reading no Kamino account, exactly as `remove_liquidity` in kind pays them, and leaves the
//! other side's part `R x lp / N` in the market, recorded, where it raises every remaining share's
//! claim on the other side. Use it only when the other side cannot be paid.
//!
//! Its accounts are `remove_liquidity`'s first nineteen, both mints by mint index as metadata
//! describes them, so a form fills them in the same way; the other mint's accounts are never
//! touched.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint as SplMint, Token, TokenAccount};
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::errors::StrategyError;
use crate::events::LentSideRemoved;
use crate::instructions::remove_liquidity::pay_ctokens_in_kind;
use crate::shares;
use crate::state::{LendingAmmMarket, AUTHORITY_SEED};
use crate::token as tokens;

/// `remove_lent_side` accounts: `remove_liquidity`'s first nineteen, checked the same way. The
/// order is part of `metadata.json`; keep them in step.
#[derive(Accounts)]
pub struct RemoveLentSide<'info> {
    /// The LP, who pays for their cToken account if it is missing.
    #[account(mut)]
    pub lp: Signer<'info>,
    #[account(
        mut,
        has_one = lp_mint @ StrategyError::WrongAccount,
    )]
    pub market_state: Box<Account<'info, LendingAmmMarket>>,
    #[account(mut)]
    pub lp_mint: Box<Account<'info, SplMint>>,
    /// The token account of the LP mint the shares are burned from, which the LP owns.
    #[account(
        mut,
        constraint = lp_shares.mint == lp_mint.key() @ StrategyError::WrongAccount,
        constraint = lp_shares.owner == lp.key() @ StrategyError::WrongAccount,
    )]
    pub lp_shares: Box<Account<'info, TokenAccount>>,
    /// CHECK: the LP's token account for mint 0; only the lent mint's is paid into, and the token
    /// program checks it.
    #[account(mut)]
    pub lp_token_0: UncheckedAccount<'info>,
    /// CHECK: the LP's token account for mint 1, likewise.
    #[account(mut)]
    pub lp_token_1: UncheckedAccount<'info>,
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
    pub mint_0: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        address = market_state.mints[1] @ StrategyError::WrongAccount,
        mint::token_program = token_program_1,
    )]
    pub mint_1: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the vault authority PDA, which signs the payouts.
    #[account(seeds = [AUTHORITY_SEED, market_state.key().as_ref()], bump = market_state.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the market's cToken account.
    #[account(mut, address = market_state.ctoken_account @ StrategyError::WrongAccount)]
    pub ctoken_account: UncheckedAccount<'info>,
    /// The reserve's collateral (cToken) mint, which the market recorded.
    #[account(address = market_state.collateral_mint @ StrategyError::WrongAccount)]
    pub collateral_mint: Box<Account<'info, SplMint>>,
    /// CHECK: the LP's associated token account for the collateral mint, checked by the handler
    /// and created at the LP's expense if missing.
    #[account(mut)]
    pub lp_ctoken: UncheckedAccount<'info>,
    pub token_program_0: Interface<'info, TokenInterface>,
    pub token_program_1: Interface<'info, TokenInterface>,
    /// SPL Token, the program of the LP mint, the lent mint and the cToken mint.
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn remove_lent_side_handler<'info>(
    ctx: Context<'info, RemoveLentSide<'info>>,
    lp: u64,
    min_lent: u64,
) -> Result<()> {
    let accounts = &ctx.accounts;
    let market = &accounts.market_state;
    let (lent_index, other_index) = (market.lent_side(), market.other_index());
    let removal = shares::removal(
        lp,
        accounts.lp_mint.supply,
        market.reserves[other_index],
        market.reserves[lent_index],
        market.ctokens,
    )?;
    // Burning shares for nothing of the lent side would only hand their part to the others.
    require!(
        removal.buffer > 0 || removal.ctokens > 0,
        StrategyError::ZeroRemoval
    );
    require!(removal.buffer >= min_lent, StrategyError::BelowMinLent);

    let vaults = [&accounts.vault_0, &accounts.vault_1];
    let lp_tokens = [&accounts.lp_token_0, &accounts.lp_token_1];
    let mints = [&accounts.mint_0, &accounts.mint_1];
    let token_programs = [&accounts.token_program_0, &accounts.token_program_1];
    let authority = accounts.authority.to_account_info();
    let market_key = market.key();
    let bump = [market.authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_key.as_ref(), &bump];

    // The LP burns their shares, signing for their own account.
    token::burn(
        CpiContext::new(
            accounts.token_program.key(),
            Burn {
                mint: accounts.lp_mint.to_account_info(),
                from: accounts.lp_shares.to_account_info(),
                authority: accounts.lp.to_account_info(),
            },
        ),
        lp,
    )?;
    if removal.buffer > 0 {
        // The lent mint is always SPL Token, with no transfer hook.
        tokens::transfer_checked(
            &token_programs[lent_index].to_account_info(),
            &vaults[lent_index].to_account_info(),
            &mints[lent_index].to_account_info(),
            &lp_tokens[lent_index].to_account_info(),
            &authority,
            &[],
            removal.buffer,
            mints[lent_index].decimals,
            &[authority_seeds],
        )?;
    }
    if removal.ctokens > 0 {
        pay_ctokens_in_kind(
            &accounts.lp,
            &accounts.lp_ctoken,
            &accounts.ctoken_account,
            &accounts.collateral_mint,
            &authority,
            &accounts.token_program,
            &accounts.associated_token_program,
            &accounts.system_program,
            removal.ctokens,
            authority_seeds,
        )?;
    }

    let lp_key = accounts.lp.key();
    let share_count = shares::share_count(
        accounts
            .lp_mint
            .supply
            .checked_sub(lp)
            .ok_or(StrategyError::Overflow)?,
    )?;
    // The buffer and the cTokens lose exactly what left; the other side's part stays recorded.
    let market = &mut ctx.accounts.market_state;
    market.reserves[lent_index] = market.reserves[lent_index]
        .checked_sub(removal.buffer)
        .ok_or(StrategyError::Overflow)?;
    if removal.ctokens > 0 {
        let held = market.ctokens;
        market.ctokens = held
            .checked_sub(removal.ctokens)
            .ok_or(StrategyError::Overflow)?;
        let (deposited, redeemed) =
            shares::totals_after_in_kind(market.deposited, market.redeemed, removal.ctokens, held)?;
        market.deposited = deposited;
        market.redeemed = redeemed;
    }
    emit!(LentSideRemoved {
        market_state: market_key,
        lp: lp_key,
        shares: lp,
        share_count,
        lent: removal.buffer,
        ctokens: removal.ctokens,
        other_left: removal.other,
    });
    Ok(())
}
