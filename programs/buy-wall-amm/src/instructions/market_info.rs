//! `pipeline_market_info`: the market's mints, vaults and exact-out support. The router
//! records them when the market is created; integrators read them from the router's Market.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;
use pipeline_strategy_interface as psi;

use crate::errors::StrategyError;
use crate::state::{is_market_state, MarketState};

/// Anyone can call the router's `register_existing_market` on any account this program
/// owns, so this refuses anything that is not a real market state of a deployed layout.
#[derive(Accounts)]
pub struct MarketInfoAccounts<'info> {
    #[account(constraint = is_market_state(&market_state.to_account_info()) @ StrategyError::NotAMarket)]
    pub market_state: AccountLoader<'info, MarketState>,
}

pub fn handle_market_info(ctx: Context<MarketInfoAccounts>) -> Result<()> {
    let state = ctx.accounts.market_state.load()?;
    let info = psi::MarketInfo {
        mints: vec![state.token_mint.to_bytes(), state.wsol_mint.to_bytes()],
        vaults: vec![state.token_vault.to_bytes(), state.sol_vault.to_bytes()],
        supports_exact_out: crate::pricing::SUPPORTS_EXACT_OUT,
    };
    set_return_data(&crate::borsh_encode(&info)?);
    Ok(())
}
