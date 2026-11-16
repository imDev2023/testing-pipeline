//! `pipeline_quote`: prices a trade without changing anything. Runs in simulation, so
//! nothing signs and the trader accounts may be placeholders: only the market state and the
//! Kamino reserve, the third of the strategy accounts `pipeline_resolve_accounts` lists, are
//! read.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;

use crate::instructions::{strategy_accounts, ReadTrade};
use crate::interface::TradeRequest;
use crate::pricing;

pub fn quote<'info>(ctx: Context<'info, ReadTrade<'info>>, request: TradeRequest) -> Result<()> {
    let market = &ctx.accounts.market_state;
    let accounts = strategy_accounts(market, ctx.remaining_accounts)?;
    let quote = pricing::quote(market, &accounts.reserve, &request)?;
    set_return_data(&crate::borsh_encode(&quote)?);
    Ok(())
}
