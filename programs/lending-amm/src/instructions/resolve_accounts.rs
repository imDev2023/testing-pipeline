//! `pipeline_resolve_accounts`: lists the accounts a swap needs after the router's ten fixed
//! trade accounts. While nothing is lent, a market needs only the output vault and the vault
//! authority, which signs the payout, so it answers in one round.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::instructions::ReadTrade;
use crate::interface::ResolveRequest;

pub fn resolve_accounts(ctx: Context<ReadTrade>, request: ResolveRequest) -> Result<()> {
    let market = &ctx.accounts.market_state;
    let (_, output) = market
        .trade_sides(request.trade.input_index, request.trade.output_index)
        .ok_or(StrategyError::WrongAccount)?;
    let result = psi::ResolveResult {
        accounts: vec![
            psi::AccountRef {
                address: market.vaults[output].to_bytes(),
                writable: true,
            },
            psi::AccountRef {
                address: market.authority(&market.key())?.to_bytes(),
                writable: false,
            },
        ],
        complete: true,
    };
    set_return_data(&crate::borsh_encode(&result)?);
    Ok(())
}
