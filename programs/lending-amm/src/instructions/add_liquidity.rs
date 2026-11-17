//! `add_liquidity { max_0, max_1, min_lp }`: adds both mints to a market for LP shares,
//! signed by the LP (docs/spec/lending-pool.md, "Adding"). The maximums are by mint index,
//! like the accounts, so a form can show each with its own mint's decimals whichever side
//! is lent.
//!
//! The first deposit takes both amounts in full and sets the price; later deposits take both
//! mints at the current ratio, with the lent side valued at its total, and only what the
//! minted shares are worth. The lent-side deposit joins the buffer: adding never calls
//! Kamino. Shares go to the LP's shares account, a token account of the LP mint owned by the
//! LP at the PDA `["lp_shares", market_state, lp]`, which this creates if it is missing, so
//! the first deposit fits in the transaction that creates the market. (A PDA rather than the
//! LP's associated token account, because metadata can't describe the associated token
//! account of a mint that is itself a PDA.) The lent side is valued from the Kamino reserve,
//! which every deposit, the first included, checks before reading, so adding is refused while
//! the reserve fails the check, and while it is deprecated after a total write-off. Remaining accounts are the other side's transfer-hook
//! accounts, forwarded to its transfer in; the lent mint has none.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, MintTo, Token};
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::errors::StrategyError;
use crate::events::LiquidityAdded;
use crate::kamino;
use crate::pricing;
use crate::shares;
use crate::state::{LendingAmmMarket, AUTHORITY_SEED, LP_SHARES_SEED};
use crate::token as tokens;

/// `add_liquidity` accounts. The order is part of `metadata.json`; keep them in step.
#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    /// The LP, who pays for their shares account if it is missing.
    #[account(mut)]
    pub lp: Signer<'info>,
    #[account(
        mut,
        has_one = lp_mint @ StrategyError::WrongAccount,
    )]
    pub market_state: Account<'info, LendingAmmMarket>,
    /// CHECK: the LP's token account for mint 0; the token program checks it and the LP's
    /// authority.
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
    pub mint_0: InterfaceAccount<'info, Mint>,
    #[account(
        address = market_state.mints[1] @ StrategyError::WrongAccount,
        mint::token_program = token_program_1,
    )]
    pub mint_1: InterfaceAccount<'info, Mint>,
    #[account(mut)]
    pub lp_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: the LP's shares account PDA; created here if missing.
    #[account(
        mut,
        seeds = [LP_SHARES_SEED, market_state.key().as_ref(), lp.key().as_ref()],
        bump,
    )]
    pub lp_shares: UncheckedAccount<'info>,
    /// CHECK: the vault authority PDA, the LP mint's mint authority.
    #[account(seeds = [AUTHORITY_SEED, market_state.key().as_ref()], bump = market_state.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub token_program_0: Interface<'info, TokenInterface>,
    pub token_program_1: Interface<'info, TokenInterface>,
    /// SPL Token, the LP mint's program.
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// The Kamino reserve the lent mint lends to, read-only, from which the lent side is valued.
    /// CHECK: checked by `kamino::reserve_of` against the lent mint's entry in `LENT_MINTS`.
    pub reserve: UncheckedAccount<'info>,
}

pub fn add_liquidity_handler<'info>(
    ctx: Context<'info, AddLiquidity<'info>>,
    max_0: u64,
    max_1: u64,
    min_lp: u64,
) -> Result<()> {
    let market = &ctx.accounts.market_state;
    let lent_index = market.lent_side();
    let other_index = market.other_index();
    let max = [max_0, max_1];
    let (max_other, max_lent) = (max[other_index], max[lent_index]);
    let reserve = kamino::reserve_of(&market.lent_mint(), &ctx.accounts.reserve.to_account_info())?;
    // A deprecated reserve never redeems again, so the market takes no new liquidity it would lend
    // there or price against it (docs/spec/lending-pool.md, "When Kamino can't pay").
    require!(!reserve.deprecated(), StrategyError::ReserveDeprecated);
    let first = !market.is_open();
    let deposit = if first {
        shares::first_deposit(max_other, max_lent)?
    } else {
        let lent_total = pricing::lent_total(market, &reserve)?;
        let share_count = shares::share_count(ctx.accounts.lp_mint.supply)?;
        shares::later_deposit(
            max_other,
            max_lent,
            market.reserves[other_index],
            lent_total,
            share_count,
        )?
    };
    require!(deposit.shares >= min_lp, StrategyError::BelowMinLp);

    let mut amounts = [0u64; 2];
    amounts[other_index] = deposit.other;
    amounts[lent_index] = deposit.lent;

    let accounts = &ctx.accounts;
    let sides = [
        (
            &accounts.lp_token_0,
            &accounts.mint_0,
            &accounts.vault_0,
            &accounts.token_program_0,
        ),
        (
            &accounts.lp_token_1,
            &accounts.mint_1,
            &accounts.vault_1,
            &accounts.token_program_1,
        ),
    ];
    // Exactly the amounts the shares are worth move in; neither side's mint can charge a
    // transfer fee (the mint rules refuse it), so what is sent is what arrives. Only the other
    // side can have a transfer hook: the lent mint is always SPL Token.
    for (i, (from, mint, vault, token_program)) in sides.into_iter().enumerate() {
        let hook_accounts: &[AccountInfo<'info>] = if i == other_index {
            ctx.remaining_accounts
        } else {
            &[]
        };
        tokens::transfer_checked(
            &token_program.to_account_info(),
            &from.to_account_info(),
            &mint.to_account_info(),
            &vault.to_account_info(),
            &accounts.lp.to_account_info(),
            hook_accounts,
            amounts[i],
            mint.decimals,
            &[],
        )?;
    }

    let market_key = accounts.market_state.key();
    if accounts.lp_shares.data_is_empty() {
        let lp = accounts.lp.key();
        let bump = [ctx.bumps.lp_shares];
        tokens::create_token_account(
            &accounts.lp.to_account_info(),
            &accounts.system_program.to_account_info(),
            &accounts.lp_shares.to_account_info(),
            &accounts.lp_mint.to_account_info(),
            &accounts.lp.to_account_info(),
            &accounts.token_program.to_account_info(),
            &[LP_SHARES_SEED, market_key.as_ref(), lp.as_ref(), &bump],
        )?;
    }

    let bump = [accounts.market_state.authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_key.as_ref(), &bump];
    token::mint_to(
        CpiContext::new_with_signer(
            accounts.token_program.key(),
            MintTo {
                mint: accounts.lp_mint.to_account_info(),
                to: accounts.lp_shares.to_account_info(),
                authority: accounts.authority.to_account_info(),
            },
            &[authority_seeds],
        ),
        deposit.shares,
    )?;

    let share_count = shares::share_count(
        accounts
            .lp_mint
            .supply
            .checked_add(deposit.shares)
            .ok_or(StrategyError::Overflow)?,
    )?;
    let lp = accounts.lp.key();
    let market = &mut ctx.accounts.market_state;
    for (reserve, amount) in market.reserves.iter_mut().zip(amounts) {
        *reserve = reserve.checked_add(amount).ok_or(StrategyError::Overflow)?;
    }
    emit!(LiquidityAdded {
        market_state: market_key,
        lp,
        amounts,
        shares: deposit.shares,
        share_count,
        first,
    });
    Ok(())
}
