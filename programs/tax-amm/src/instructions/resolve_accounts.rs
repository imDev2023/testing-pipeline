//! `pipeline_resolve_accounts`: lists the accounts a swap needs after the router's ten
//! fixed trade accounts. A tax market needs only the output vault, so it answers in one
//! round.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::instructions::ReadTrade;
use crate::interface::ResolveRequest;

pub fn resolve_accounts(ctx: Context<ReadTrade>, request: ResolveRequest) -> Result<()> {
    let (_, output_vault) = ctx
        .accounts
        .market_state
        .trade_vaults(request.trade.input_index, request.trade.output_index)
        .ok_or(StrategyError::WrongAccount)?;
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
