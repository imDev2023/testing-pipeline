//! `pipeline_resolve_accounts`: lists the accounts a swap needs after the router's ten fixed
//! trade accounts: the output vault, the vault authority, which signs the payout, and the
//! Kamino reserve the lent side lends to, read-only, from which quotes and swaps value the
//! lent side. Ordinary swaps never write-lock the reserve, which every Kamino user of that mint
//! shares (docs/spec/lending-pool.md, "Accounts"). It answers in one round.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use pipeline_strategy_interface as psi;

use crate::config;
use crate::errors::StrategyError;
use crate::instructions::ReadTrade;
use crate::interface::ResolveRequest;

pub fn resolve_accounts(ctx: Context<ReadTrade>, request: ResolveRequest) -> Result<()> {
    let market = &ctx.accounts.market_state;
    let (_, output) = market
        .trade_sides(request.trade.input_index, request.trade.output_index)
        .ok_or(StrategyError::WrongAccount)?;
    // The reserve `LENT_MINTS` names for the lent mint, which the market also recorded.
    let lent_mint = market.mints[market.lent_index as usize & 1];
    let reserve = config::lent_mint(&lent_mint)
        .ok_or(StrategyError::LentMintNotListed)?
        .reserve;
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
            psi::AccountRef {
                address: reserve.to_bytes(),
                writable: false,
            },
        ],
        complete: true,
    };
    set_return_data(&crate::borsh_encode(&result)?);
    Ok(())
}
