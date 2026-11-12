//! Events, one per instruction that changes a market, so Aviary's indexer can show a
//! market's history; current values are always read from the market state.

use anchor_lang::prelude::*;

use crate::params::InitParams;

/// A tax market was created through the router's `create_market`.
#[event]
pub struct MarketCreated {
    pub market_state: Pubkey,
    pub mints: [Pubkey; 2],
    pub vaults: [Pubkey; 2],
    pub params: InitParams,
    pub created_slot: u64,
    pub created_at: i64,
}

/// The seeder funded a market, which opened. `amounts` is what arrived in each vault, in
/// mint order, which the market recorded as its real reserves.
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct Seeded {
    pub market_state: Pubkey,
    pub seeder: Pubkey,
    pub amounts: [u64; 2],
}
