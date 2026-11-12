//! Events, one per instruction of ours that changes a market, so Aviary's indexer can show a
//! market's history; current values are always read from the market state. A swap emits the
//! router's swap event instead, which carries its amounts, and moves the recorded reserves
//! by exactly the input it credits and the output it pays.

use anchor_lang::prelude::*;

use crate::params::InitParams;

/// A market was created through the router's `create_market`.
#[event]
pub struct MarketCreated {
    pub market_state: Pubkey,
    /// In the creator's order.
    pub mints: [Pubkey; 2],
    pub vaults: [Pubkey; 2],
    pub params: InitParams,
    pub reserve: Pubkey,
    pub lp_mint: Pubkey,
    pub ctoken_account: Pubkey,
    pub created_slot: u64,
    pub created_at: i64,
}

/// An LP added liquidity with `add_liquidity`.
#[event]
pub struct LiquidityAdded {
    pub market_state: Pubkey,
    pub lp: Pubkey,
    /// What the market took of each mint, by mint index.
    pub amounts: [u64; 2],
    /// The LP shares minted to the LP.
    pub shares: u64,
    /// The market's share count after the deposit, the locked minimum included.
    pub share_count: u64,
    /// Whether this was the first deposit, which set the price.
    pub first: bool,
}
