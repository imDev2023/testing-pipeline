//! `rebalance {}`: the permissionless keeper job that moves a market's buffer back to its
//! target, and puts the market into withdraw mode and out of it (docs/spec/lending-pool.md, "The
//! rule", "Withdraw mode", "When it runs" and "When Kamino can't pay").
//!
//! Anyone may call it at any time. It reads Kamino's state at each call and does what
//! [`crate::withdraw_mode::decide`] says: it refuses while Kamino redeems nothing (either
//! emergency mode, or a deprecated reserve); below `WITHDRAW_MODE_ENTER` times the market's
//! exposure of freely available liquidity it enters withdraw mode, where it redeems everything
//! Kamino can pay and deposits nothing, and above `WITHDRAW_MODE_EXIT` times it leaves; outside
//! withdraw mode, inside the band it fails with `WithinBand` and changes nothing, above it it
//! deposits the surplus into Kamino with `deposit_reserve_liquidity` (unless Kamino blocks cToken
//! deposits), and below it redeems the shortfall with `redeem_reserve_collateral`, capped at what
//! Kamino can pay right now; a move smaller than the lent mint's `MIN_REBALANCE` is skipped
//! ([`crate::buffer::plan`]). Both Kamino calls are signed by the market's vault authority, which
//! owns the buffer vault and the cToken account.
//!
//! The market then measures what actually moved, at its buffer vault and its cToken account,
//! and records exactly that, with the running totals deposited into and redeemed from Kamino,
//! and the mode it is in. It creates no account and pays nothing, so the caller pays only the
//! transaction fee. A call Kamino refuses fails whole. It must be called directly, beside nothing
//! but compute budget instructions and klend's `refresh_reserve`, and once per transaction
//! ([`require_alone`]), so nothing in its transaction can move Kamino's free liquidity around it.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{get_stack_height, TRANSACTION_LEVEL_STACK_HEIGHT};
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

/// The compute budget program, whose instructions may share a transaction with `rebalance`.
const COMPUTE_BUDGET: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");

use crate::buffer::Move;
use crate::config::KLEND_PROGRAM;
use crate::errors::StrategyError;
use crate::events::{RebalanceDirection, Rebalanced, WithdrawModeEntered, WithdrawModeLeft};
use crate::kamino::{KaminoAccounts, INSTRUCTIONS_SYSVAR, REFRESH_RESERVE};
use crate::state::{LendingAmmMarket, AUTHORITY_SEED};
use crate::token;
use crate::withdraw_mode::{self, Kamino};

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

/// Whether an instruction of `program` with `data` may share a transaction with `rebalance`:
/// compute budget instructions, and klend's `refresh_reserve`, which a keeper puts first when the
/// reserve's stored rate is stale. Never another `rebalance`, on this market or another: one
/// market's deposit before a second market's call and a third's redeem after it would move
/// Kamino's free liquidity around the second as klend's own instructions would (finding H003,
/// docs/security/lending-amm/).
pub fn allowed_beside_rebalance(program: &Pubkey, data: &[u8]) -> bool {
    *program == COMPUTE_BUDGET
        || (*program == KLEND_PROGRAM && data.get(..8) == Some(&REFRESH_RESERVE[..]))
}

/// Refuses with `RebalanceNotAlone` unless `rebalance` is called directly, at the transaction's
/// level, beside nothing [`allowed_beside_rebalance`] refuses, as the instructions sysvar shows.
///
/// Withdraw mode measures Kamino's free liquidity at the moment `rebalance` runs, so anything else
/// in its transaction could move it there and back: a deposit before it and a redeem after it, by
/// klend's instructions or by another program calling klend, to force a market out of withdraw
/// mode and lend into a crunch, or a flash loan around it to force one in
/// (docs/spec/lending-pool.md, "Withdraw mode").
fn require_alone(instructions: &AccountInfo) -> Result<()> {
    require!(
        get_stack_height() == TRANSACTION_LEVEL_STACK_HEIGHT,
        StrategyError::RebalanceNotAlone
    );
    require_keys_eq!(
        *instructions.key,
        INSTRUCTIONS_SYSVAR,
        StrategyError::KaminoAccountWrong
    );
    let count = {
        let data = instructions.try_borrow_data()?;
        let bytes = data.get(..2).ok_or(StrategyError::KaminoAccountWrong)?;
        u16::from_le_bytes([bytes[0], bytes[1]])
    };
    let current = load_current_index_checked(instructions)?;
    for index in (0..count).filter(|index| *index != current) {
        let instruction = load_instruction_at_checked(index as usize, instructions)?;
        require!(
            allowed_beside_rebalance(&instruction.program_id, &instruction.data),
            StrategyError::RebalanceNotAlone
        );
    }
    Ok(())
}

pub fn rebalance_handler<'info>(ctx: Context<'info, Rebalance<'info>>) -> Result<()> {
    require_alone(&ctx.accounts.instructions_sysvar)?;
    let accounts = &ctx.accounts;
    let market = &accounts.market_state;
    require!(market.is_open(), StrategyError::MarketNotOpen);
    let lent_side = market.lent_side();
    let lent = market.lent_entry()?;
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
    let lent_value = reserve.lent_value(held)?;
    let kamino_state = Kamino {
        free: reserve.freely_available(),
        can_pay: reserve.can_pay_planned(&lending_market, held, Clock::get()?.unix_timestamp),
        stopped: reserve.redeems_stopped(&lending_market),
        deposits_blocked: reserve.block_ctoken_usage,
    };
    let (decision, exit_seen_slot) = withdraw_mode::decide_with_exit_delay(
        market.withdraw_mode,
        market.exit_seen_slot,
        Clock::get()?.slot,
        buffer,
        lent_value,
        kamino_state,
        lent.min_rebalance,
    )?;
    let market_key = market.key();
    if decision.withdraw_mode != market.withdraw_mode {
        if decision.withdraw_mode {
            emit!(WithdrawModeEntered {
                market_state: market_key,
                free_liquidity: kamino_state.free,
                exposure: decision.exposure,
            });
        } else {
            emit!(WithdrawModeLeft {
                market_state: market_key,
                free_liquidity: kamino_state.free,
                exposure: decision.exposure,
            });
        }
    }
    let Some(planned) = decision.planned else {
        let market = &mut ctx.accounts.market_state;
        market.withdraw_mode = decision.withdraw_mode;
        market.exit_seen_slot = exit_seen_slot;
        return Ok(());
    };

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
    market.withdraw_mode = decision.withdraw_mode;
    market.exit_seen_slot = exit_seen_slot;
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
