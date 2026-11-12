//! The events each instruction emits (docs/spec/pool4-for-solana.md, "Custom actions and
//! metadata"), so Aviary's indexer can show a market's history. Aviary reads current values
//! from the market state, not from events.

use anchor_lang::prelude::*;

use crate::params::InitParams;

/// `pipeline_init_market` created a market.
#[event]
pub struct MarketCreated {
    pub market_state: Pubkey,
    pub token_mint: Pubkey,
    /// The creation parameters, as the market keeps them for good.
    pub params: InitParams,
    pub creation_slot: u64,
    pub creation_time: i64,
}

/// `seed` opened a market.
#[event]
pub struct MarketSeeded {
    pub market_state: Pubkey,
    /// What arrived in the token vault.
    pub token_amount: u64,
    /// What arrived in the SOL vault.
    pub sol_amount: u64,
    pub sqrt_price: u128,
    pub liquidity: u128,
    pub cap: u64,
    pub cap_floor: u64,
    pub cap_decay_per_day: u64,
    pub seed_time: i64,
}
