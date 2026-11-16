//! `rebalance {}`: the permissionless keeper job that moves a market's buffer back to its
//! target (docs/spec/lending-pool.md, "The rule" and "When it runs").
//!
//! Anyone may call it at any time. Inside the band it fails with `WithinBand` and changes
//! nothing, so a keeper's simulation shows there is nothing to do; above the band it deposits
//! the surplus into Kamino with `deposit_reserve_liquidity`, and below it redeems the shortfall
//! with `redeem_reserve_collateral`, capped at what Kamino can pay right now; a move smaller
//! than the lent mint's `MIN_REBALANCE` is skipped ([`crate::buffer::plan`]). Both Kamino calls
//! are signed by the market's vault authority, which owns the buffer vault and the cToken
//! account.
//!
//! The market then measures what actually moved, at its buffer vault and its cToken account,
//! and records exactly that, with the running totals deposited into and redeemed from Kamino.
//! It creates no account and pays nothing, so the caller pays only the transaction fee.
//! A call Kamino refuses fails whole; withdraw mode and Kamino's other states come with
//! [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83).

use anchor_lang::prelude::*;

use crate::buffer::{self, Move};
use crate::errors::StrategyError;
use crate::events::{RebalanceDirection, Rebalanced};
use crate::kamino::KaminoAccounts;
use crate::state::{LendingAmmMarket, AUTHORITY_SEED};
use crate::token;

/// `rebalance` accounts. The order is part of `metadata.json`; keep them in step. The Kamino
/// accounts are those of the market's lent mint, and are checked against its entry in
/// `LENT_MINTS` before any is passed to klend ([`KaminoAccounts::check`]).
#[derive(Accounts)]
pub struct Rebalance<'info> {
    /// Anyone. Read-only, so nothing can be taken from it beyond the transaction fee.
    pub caller: Signer<'info>,
    #[account(mut)]
    pub market_state: Account<'info, LendingAmmMarket>,
    /// CHECK: the vault authority PDA, which signs both Kamino calls as the depositor.
    #[account(seeds = [AUTHORITY_SEED, market_state.key().as_ref()], bump = market_state.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the market's vault for the lent mint, which holds the buffer.
    #[account(
        mut,
        address = market_state.vaults[market_state.lent_side()] @ StrategyError::WrongAccount,
    )]
    pub buffer_vault: UncheckedAccount<'info>,
    /// CHECK: the market's cToken account.
    #[account(mut, address = market_state.ctoken_account @ StrategyError::WrongAccount)]
    pub ctoken_account: UncheckedAccount<'info>,
    /// CHECK: the lent mint, checked against the reserve's.
    pub lent_mint: UncheckedAccount<'info>,
    /// CHECK: the Kamino reserve the lent mint lends to, checked before it is read.
    #[account(mut)]
    pub reserve: UncheckedAccount<'info>,
    /// CHECK: the reserve's lending market, checked.
    pub lending_market: UncheckedAccount<'info>,
    /// CHECK: the lending market's authority PDA, checked.
    pub lending_market_authority: UncheckedAccount<'info>,
    /// CHECK: the reserve's liquidity supply, checked against the reserve.
    #[account(mut)]
    pub reserve_liquidity_supply: UncheckedAccount<'info>,
    /// CHECK: the reserve's collateral (cToken) mint, checked.
    #[account(mut)]
    pub collateral_mint: UncheckedAccount<'info>,
    /// CHECK: SPL Token, checked.
    pub token_program: UncheckedAccount<'info>,
    /// CHECK: Kamino Lend, checked.
    pub klend_program: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar klend takes, checked.
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn rebalance_handler<'info>(ctx: Context<'info, Rebalance<'info>>) -> Result<()> {
    let accounts = &ctx.accounts;
    let market = &accounts.market_state;
    require!(market.is_open(), StrategyError::MarketNotOpen);
    let lent_side = market.lent_side();
    let lent =
        crate::config::lent_mint(&market.lent_mint()).ok_or(StrategyError::LentMintNotListed)?;
    let kamino = KaminoAccounts {
        klend_program: &accounts.klend_program,
        reserve: &accounts.reserve,
        lending_market: &accounts.lending_market,
        lending_market_authority: &accounts.lending_market_authority,
        liquidity_mint: &accounts.lent_mint,
        liquidity_supply: &accounts.reserve_liquidity_supply,
        collateral_mint: &accounts.collateral_mint,
        token_program: &accounts.token_program,
        instructions_sysvar: &accounts.instructions_sysvar,
    };
    let (reserve, lending_market) = kamino.check(lent)?;

    let held = market.ctokens;
    let buffer = market.reserves[lent_side];
    let lent_total = buffer
        .checked_add(reserve.lent_value(held)?)
        .ok_or(StrategyError::Overflow)?;
    let can_pay = reserve.can_pay_planned(&lending_market, held, Clock::get()?.unix_timestamp);
    let planned = buffer::plan(buffer, lent_total, can_pay, lent.min_rebalance)?;

    let market_key = market.key();
    let bump = [market.authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_key.as_ref(), &bump];
    let vault = accounts.buffer_vault.to_account_info();
    let ctoken_account = accounts.ctoken_account.to_account_info();
    let authority = accounts.authority.to_account_info();
    let vault_before = token::token_balance(&vault)?;
    let ctokens_before = token::token_balance(&ctoken_account)?;
    match planned {
        Move::Deposit(liquidity) => kamino.deposit(
            &authority,
            &vault,
            &ctoken_account,
            liquidity,
            &[authority_seeds],
        )?,
        Move::Redeem(liquidity) => kamino.redeem(
            &authority,
            &ctoken_account,
            &vault,
            reserve.ctokens_to_redeem(liquidity, held)?,
            &[authority_seeds],
        )?,
    }
    let vault_after = token::token_balance(&vault)?;
    let ctokens_after = token::token_balance(&ctoken_account)?;

    // Record exactly what moved, as measured, never what was asked for.
    let market = &mut ctx.accounts.market_state;
    let (direction, liquidity, ctokens) = match planned {
        Move::Deposit(_) => {
            let liquidity = vault_before
                .checked_sub(vault_after)
                .ok_or(StrategyError::Overflow)?;
            let minted = ctokens_after
                .checked_sub(ctokens_before)
                .ok_or(StrategyError::Overflow)?;
            market.reserves[lent_side] = market.reserves[lent_side]
                .checked_sub(liquidity)
                .ok_or(StrategyError::Overflow)?;
            market.ctokens = market
                .ctokens
                .checked_add(minted)
                .ok_or(StrategyError::Overflow)?;
            market.deposited = market
                .deposited
                .checked_add(liquidity as u128)
                .ok_or(StrategyError::Overflow)?;
            (RebalanceDirection::Deposit, liquidity, minted)
        }
        Move::Redeem(_) => {
            let liquidity = vault_after
                .checked_sub(vault_before)
                .ok_or(StrategyError::Overflow)?;
            let burned = ctokens_before
                .checked_sub(ctokens_after)
                .ok_or(StrategyError::Overflow)?;
            market.reserves[lent_side] = market.reserves[lent_side]
                .checked_add(liquidity)
                .ok_or(StrategyError::Overflow)?;
            market.ctokens = market
                .ctokens
                .checked_sub(burned)
                .ok_or(StrategyError::Overflow)?;
            market.redeemed = market
                .redeemed
                .checked_add(liquidity as u128)
                .ok_or(StrategyError::Overflow)?;
            (RebalanceDirection::Redeem, liquidity, burned)
        }
    };
    emit!(Rebalanced {
        market_state: market_key,
        direction,
        liquidity,
        ctokens,
        buffer: market.reserves[lent_side],
        ctokens_held: market.ctokens,
        deposited: market.deposited,
        redeemed: market.redeemed,
    });
    Ok(())
}
