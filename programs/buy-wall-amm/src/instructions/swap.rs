//! `pipeline_swap`: settles a trade the router sends (docs/spec/pool4-for-solana.md,
//! "Pricing", "After pricing", "The fee" and "Counters").
//!
//! Only this market's router market may call it, so every trade pays Pipeline's fee, emits a
//! swap event and counts in the market's counters (bypass is refused: ADR 0001). The router
//! has just moved the trader's input into the input vault; this credits what arrived beyond
//! every ledger kept there, prices it with the same function as `pipeline_quote`, pays the
//! trader from the output vault, and books the trade. The input and the fee stay in the
//! vaults: nothing is refunded and nothing is paid out to a recipient during a swap.
//!
//! Remaining accounts: the output vault and the vault authority, as
//! `pipeline_resolve_accounts` lists them, then any transfer-hook accounts of the token,
//! which a buy's output transfer forwards.

use anchor_lang::prelude::*;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::pricing::{self, Side};
use crate::state::{is_market_state, vault_authority, MarketState, AUTHORITY_SEED};
use crate::token::{token_balance, transfer_checked, Transfer};

/// The router's ten fixed trade accounts.
#[derive(Accounts)]
pub struct SwapAccounts<'info> {
    /// The router's market PDA; compared with the stored market signer.
    pub market_signer: Signer<'info>,
    #[account(mut, constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// CHECK: the trader's wallet, for identity only. It never signs here.
    pub trader: UncheckedAccount<'info>,
    /// CHECK: the router's; this strategy never refunds, so it is not used.
    #[account(mut)]
    pub trader_input: UncheckedAccount<'info>,
    /// CHECK: receives the output; the token program checks it, and it may not be the
    /// output vault.
    #[account(mut)]
    pub trader_output: UncheckedAccount<'info>,
    /// CHECK: compared with the market's vault for the input mint.
    #[account(mut)]
    pub input_vault: UncheckedAccount<'info>,
    /// CHECK: compared with the market's mint at the input index.
    pub input_mint: UncheckedAccount<'info>,
    /// CHECK: compared with the market's mint at the output index.
    pub output_mint: UncheckedAccount<'info>,
    /// CHECK: checked by the runtime when invoked.
    pub input_token_program: UncheckedAccount<'info>,
    /// CHECK: the output transfer invokes it; the vault's owner must be it.
    pub output_token_program: UncheckedAccount<'info>,
}

pub fn handle_swap<'info>(
    ctx: Context<'info, SwapAccounts<'info>>,
    request: crate::interface::SwapRequest,
) -> Result<()> {
    let market_state = ctx.accounts.market_state.key();
    let (priced, authority_bump, output_vault_info, authority, hook_accounts, decimals) = {
        let state = ctx.accounts.market_state.load()?;
        require_keys_eq!(
            ctx.accounts.market_signer.key(),
            state.market_signer,
            StrategyError::NotPipeline
        );
        let trade = &request.trade;
        let (input_vault, output_vault) = state.vaults(trade.input_index, trade.output_index)?;
        let mints = [state.token_mint, state.wsol_mint];
        let mint = |index: u8| {
            mints
                .get(index as usize)
                .copied()
                .ok_or(StrategyError::WrongAccount)
        };
        require_keys_eq!(
            ctx.accounts.input_vault.key(),
            input_vault,
            StrategyError::WrongAccount
        );
        require_keys_eq!(
            ctx.accounts.input_mint.key(),
            mint(trade.input_index)?,
            StrategyError::WrongAccount
        );
        require_keys_eq!(
            ctx.accounts.output_mint.key(),
            mint(trade.output_index)?,
            StrategyError::WrongAccount
        );
        let [output_vault_info, authority, hook_accounts @ ..] = ctx.remaining_accounts else {
            return err!(StrategyError::WrongAccount);
        };
        require_keys_eq!(
            output_vault_info.key(),
            output_vault,
            StrategyError::WrongAccount
        );
        // Paying the vault itself would move nothing while the market booked a payout.
        require_keys_neq!(
            ctx.accounts.trader_output.key(),
            output_vault,
            StrategyError::WrongAccount
        );
        // Signing with the wrong account would fail in the token program anyway; checking
        // it here names the mistake (`POOL4-24`).
        let authority_key = vault_authority(&market_state, state.authority_bump)
            .ok_or(StrategyError::WrongAccount)?;
        require_keys_eq!(authority.key(), authority_key, StrategyError::WrongAccount);

        // Credit what arrived beyond every ledger kept in the input vault, capped at what
        // the router sent in this call, so a donation to either vault is never credited.
        let recorded = state
            .recorded(trade.input_index)
            .ok_or(StrategyError::Overflow)?;
        let vault_balance = token_balance(&ctx.accounts.input_vault.to_account_info())?;
        let credited = psi::credited_input(vault_balance, recorded, request.amount_sent);
        let priced = pricing::quote(
            &state,
            &crate::interface::TradeRequest {
                amount: credited,
                ..trade.clone()
            },
        )?;
        // The token is the only mint a transfer hook can be on; wrapped SOL has none.
        let hook_accounts = match priced.side {
            Side::Buy => hook_accounts,
            Side::Sell => &[],
        };
        let decimals = mint_decimals(&ctx.accounts.output_mint.to_account_info())?;
        (
            priced,
            state.authority_bump,
            output_vault_info,
            authority,
            hook_accounts,
            decimals,
        )
    };

    let bump = [authority_bump];
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, market_state.as_ref(), &bump];
    transfer_checked(
        Transfer {
            token_program: &ctx.accounts.output_token_program.to_account_info(),
            from: output_vault_info,
            mint: &ctx.accounts.output_mint.to_account_info(),
            to: &ctx.accounts.trader_output.to_account_info(),
            authority,
            hook_accounts,
        },
        priced.amount_out,
        decimals,
        &[authority_seeds],
    )?;

    // Steps 2, 3 and 7 of "After pricing": the books, the price and the counters.
    let mut state = ctx.accounts.market_state.load_mut()?;
    let books = state
        .books()
        .after(&priced, state.wall_split_bps())
        .ok_or(StrategyError::Overflow)?;
    let counters = state
        .counters()
        .and_then(|counters| counters.after(&priced))
        .ok_or(StrategyError::Overflow)?;
    state.set_books(&books);
    state.set_sqrt_price(priced.sqrt_price);
    state.set_last_close(priced.sqrt_price);
    state
        .set_counters(&counters)
        .ok_or(StrategyError::Overflow)?;
    Ok(())
}

/// The decimals of an SPL Token or Token-2022 mint (byte 44 of both layouts).
fn mint_decimals(mint: &AccountInfo) -> Result<u8> {
    let data = mint.try_borrow_data()?;
    data.get(44)
        .copied()
        .ok_or_else(|| error!(StrategyError::WrongAccount))
}
