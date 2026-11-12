//! `pipeline_resolve_accounts` and `pipeline_quote`: read-only calls quoters and SDKs make
//! in simulation. Nothing signs and the trader accounts may be placeholders, so only the
//! market state is read.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::state::{is_market_state, MarketState};

/// The router's ten fixed trade accounts.
#[derive(Accounts)]
pub struct ReadTrade<'info> {
    /// CHECK: unused in reads.
    pub market_signer: UncheckedAccount<'info>,
    #[account(constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// CHECK: unused in reads.
    pub trader: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub trader_input: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub trader_output: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub input_vault: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub input_mint: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub output_mint: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub input_token_program: UncheckedAccount<'info>,
    /// CHECK: unused in reads.
    pub output_token_program: UncheckedAccount<'info>,
}

/// A swap needs one strategy account after the router's ten: the output vault.
pub fn handle_resolve_accounts(
    ctx: Context<ReadTrade>,
    request: crate::interface::ResolveRequest,
) -> Result<()> {
    let state = ctx.accounts.market_state.load()?;
    let (_, output_vault) = state.vaults(request.trade.input_index, request.trade.output_index)?;
    let result = psi::ResolveResult {
        accounts: vec![psi::AccountRef {
            address: output_vault.to_bytes(),
            writable: true,
        }],
        complete: true,
    };
    set_return_data(&crate::borsh_encode(&result)?);
    Ok(())
}

pub fn handle_quote(
    ctx: Context<ReadTrade>,
    request: crate::interface::TradeRequest,
) -> Result<()> {
    let state = ctx.accounts.market_state.load()?;
    let quote = crate::pricing::quote(&state, &request)?;
    set_return_data(&crate::borsh_encode(&quote)?);
    Ok(())
}
