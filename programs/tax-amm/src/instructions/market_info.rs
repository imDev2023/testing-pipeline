//! `pipeline_market_info`: reports a market's mints, vaults and exact-out support. The
//! router records them when the market is created; integrators read them from the router's
//! Market.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::pricing;
use crate::state::{TaxMarket, STATE_VERSION};

/// `Account<TaxMarket>` checks that the account is owned by this program and carries the
/// market state's discriminator. That matters: anyone can call the router's
/// `register_existing_market` on any account this program owns, so this must refuse
/// anything that isn't a tax market.
#[derive(Accounts)]
pub struct MarketInfoAccounts<'info> {
    #[account(constraint = market_state.version <= STATE_VERSION @ StrategyError::NewerStateVersion)]
    pub market_state: Account<'info, TaxMarket>,
}

pub fn market_info(ctx: Context<MarketInfoAccounts>) -> Result<()> {
    let market = &ctx.accounts.market_state;
    let info = psi::MarketInfo {
        mints: market.mints.iter().map(Pubkey::to_bytes).collect(),
        vaults: market.vaults.iter().map(Pubkey::to_bytes).collect(),
        supports_exact_out: pricing::SUPPORTS_EXACT_OUT,
    };
    set_return_data(&crate::borsh_encode(&info)?);
    Ok(())
}
