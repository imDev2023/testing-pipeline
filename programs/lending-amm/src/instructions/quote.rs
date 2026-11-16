//! `pipeline_quote`: prices a trade without changing anything. Runs in simulation, so
//! nothing signs and the trader accounts may be placeholders: only the market state, the
//! Kamino reserve, the third of the strategy accounts `pipeline_resolve_accounts` lists, and,
//! for a lent-side output beyond the buffer, the redeem accounts after it and the output mint
//! are read. It prices with the same function as `pipeline_swap`, so a quote shows whether a
//! trade redeems from Kamino and refuses one Kamino could not pay right now.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;

use crate::errors::StrategyError;
use crate::instructions::{strategy_accounts, ReadTrade};
use crate::interface::TradeRequest;

pub fn quote<'info>(ctx: Context<'info, ReadTrade<'info>>, request: TradeRequest) -> Result<()> {
    let market = &ctx.accounts.market_state;
    let (_, output) = market
        .trade_sides(request.input_index, request.output_index)
        .ok_or(StrategyError::WrongAccount)?;
    let accounts = strategy_accounts(market, ctx.remaining_accounts, output)?;
    let quote = accounts.quote(market, ctx.accounts.output_mint.as_ref(), &request)?;
    set_return_data(&crate::borsh_encode(&quote.result())?);
    Ok(())
}
