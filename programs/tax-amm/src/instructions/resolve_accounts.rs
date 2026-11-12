//! `pipeline_resolve_accounts`: lists the accounts a swap needs after the router's ten
//! fixed trade accounts. A tax market needs the output vault and the vault authority, which
//! signs the transfer out of it, so it answers in one round.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::instructions::ReadTrade;
use crate::interface::ResolveRequest;
use crate::state::AUTHORITY_SEED;

pub fn resolve_accounts(ctx: Context<ReadTrade>, request: ResolveRequest) -> Result<()> {
    let market = &ctx.accounts.market_state;
    let (_, output_vault) = market
        .trade_vaults(request.trade.input_index, request.trade.output_index)
        .ok_or(StrategyError::WrongAccount)?;
    let authority = Pubkey::create_program_address(
        &[
            AUTHORITY_SEED,
            market.key().as_ref(),
            &[market.authority_bump],
        ],
        &crate::ID,
    )
    .map_err(|_| StrategyError::WrongAccount)?;
    let result = psi::ResolveResult {
        accounts: vec![
            psi::AccountRef {
                address: output_vault.to_bytes(),
                writable: true,
            },
            psi::AccountRef {
                address: authority.to_bytes(),
                writable: false,
            },
        ],
        complete: true,
    };
    set_return_data(&crate::borsh_encode(&result)?);
    Ok(())
}
