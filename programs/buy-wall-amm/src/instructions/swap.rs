//! `pipeline_swap`: the router calls it from `swap`, after moving the trader's input into
//! the input vault.

use crate::errors::StrategyError;
use crate::state::{is_market_state, MarketState};
use anchor_lang::prelude::*;

/// The router's ten fixed trade accounts. Remaining accounts: the output vault, as
/// `pipeline_resolve_accounts` lists it, then any transfer-hook accounts.
#[derive(Accounts)]
pub struct SwapAccounts<'info> {
    /// The router's market PDA; compared with the stored market signer.
    pub market_signer: Signer<'info>,
    #[account(mut, constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
    /// CHECK: the trader's wallet, for identity only. It never signs here.
    pub trader: UncheckedAccount<'info>,
    /// CHECK: receives refunds; the token program checks it.
    #[account(mut)]
    pub trader_input: UncheckedAccount<'info>,
    /// CHECK: receives the output; the token program checks it.
    #[account(mut)]
    pub trader_output: UncheckedAccount<'info>,
    /// CHECK: compared with the market's vault for the input mint.
    #[account(mut)]
    pub input_vault: UncheckedAccount<'info>,
    /// CHECK: checked by the token program on every transfer.
    pub input_mint: UncheckedAccount<'info>,
    /// CHECK: checked by the token program on every transfer.
    pub output_mint: UncheckedAccount<'info>,
    /// CHECK: checked by the runtime when invoked.
    pub input_token_program: UncheckedAccount<'info>,
    /// CHECK: checked by the runtime when invoked.
    pub output_token_program: UncheckedAccount<'info>,
}

pub fn handle_swap<'info>(
    ctx: Context<'info, SwapAccounts<'info>>,
    request: crate::interface::SwapRequest,
) -> Result<()> {
    let state = ctx.accounts.market_state.load()?;
    // Bypass is refused (ADR 0001): only this market's router market may trade it, so every
    // trade pays Pipeline's fee and appears in Pipeline's events.
    require_keys_eq!(
        ctx.accounts.market_signer.key(),
        state.market_signer,
        StrategyError::NotPipeline
    );
    let trade = &request.trade;
    let (input_vault, output_vault) = state.vaults(trade.input_index, trade.output_index)?;
    require_keys_eq!(
        ctx.accounts.input_vault.key(),
        input_vault,
        StrategyError::WrongAccount
    );
    let output_vault_info = ctx
        .remaining_accounts
        .first()
        .ok_or(StrategyError::WrongAccount)?;
    require_keys_eq!(
        output_vault_info.key(),
        output_vault,
        StrategyError::WrongAccount
    );
    // The same pricing as `pipeline_quote`, which refuses every request in this build;
    // settlement lands with plain trading.
    crate::pricing::quote(&state, trade)?;
    err!(StrategyError::TradingNotAvailable)
}
