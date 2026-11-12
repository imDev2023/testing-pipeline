//! `pipeline_quote`: prices a trade without changing anything. Runs in simulation, so
//! nothing signs and the trader accounts may be placeholders: only the market state is read.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;

use crate::instructions::ReadTrade;
use crate::interface::TradeRequest;
use crate::pricing;

pub fn quote(ctx: Context<ReadTrade>, request: TradeRequest) -> Result<()> {
    let quote = pricing::quote(&ctx.accounts.market_state, &request)?;
    set_return_data(&crate::borsh_encode(&quote)?);
    Ok(())
}
