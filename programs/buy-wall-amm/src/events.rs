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

/// A swap left the curve holding less than the inventory cap and the ratchet lowered the
/// cap (docs/spec/pool4-for-solana.md, "After pricing" step 6).
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct CapLowered {
    pub market_state: Pubkey,
    /// The new inventory cap, in token units.
    pub cap: u64,
    /// How far the cap fell, in token units.
    pub lowered_by: u64,
    /// What the curve holds at the swap's price, in token units.
    pub held: u64,
    /// The decay credit left, in token-seconds.
    pub decay_credit: u128,
}

/// A swap left the curve holding more than the inventory cap and the trim took the excess
/// out of it without moving the price (docs/spec/pool4-for-solana.md, "After pricing" step
/// 6).
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct Trimmed {
    pub market_state: Pubkey,
    /// Token units moved from the pool to the retired tokens.
    pub tokens: u64,
    /// Lamports moved from the pool to idle SOL.
    pub sol: u64,
    /// The curve's liquidity after the trim.
    pub liquidity: u128,
    /// The inventory cap, unchanged by a trim.
    pub cap: u64,
}

/// `place_wall` closed the old wall at the current price and placed the new one with
/// everything idle (docs/spec/pool4-for-solana.md, "`place_wall`").
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct WallPlaced {
    pub market_state: Pubkey,
    /// Whoever called it.
    pub caller: Pubkey,
    /// The wrapped SOL account the tip was paid to.
    pub tip_account: Pubkey,
    /// The SOL the old wall had spent buying tokens, in lamports.
    pub converted: u64,
    /// Lamports the old wall still held, moved to idle SOL.
    pub closed_sol: u64,
    /// Token units the old wall had bought, moved to the retired tokens.
    pub closed_tokens: u64,
    /// Lamports the pool held beyond the curve's own holdings, moved to idle SOL.
    pub dust_sol: u64,
    /// Token units the pool held beyond the curve's own holdings, moved to the retired
    /// tokens.
    pub dust_tokens: u64,
    /// The caller's tip, in lamports.
    pub tip: u64,
    /// The new wall's top, a Q64.64 square-root price.
    pub wall_top: u128,
    /// The new wall's liquidity.
    pub wall_liquidity: u128,
    /// The lamports the new wall holds.
    pub wall_sol_placed: u64,
}
