//! The lending AMM: a Pipeline strategy whose markets are two-mint constant-product pools
//! with open LP shares, one side of which, WSOL or USDC, is lent to Kamino Lend
//! (docs/spec/lending-pool.md).
//!
//! Pipeline's router sends trades to a strategy, makes sure the trader gets at least their
//! minimum, charges Pipeline's 0.25% fee and publishes a standard swap event, so every
//! lending AMM market can be found, quoted, traded and charted by anything built on Pipeline.
//!
//! | Instruction                 | Called by                        | Does                                     |
//! |-----------------------------|----------------------------------|------------------------------------------|
//! | `pipeline_init_market`      | the router, from `create_market` | creates a market, its vaults and LP mint |
//! | `pipeline_market_info`      | the router, at market creation   | reports mints, vaults, exact-out         |
//! | `pipeline_resolve_accounts` | quoters and SDKs, in simulation  | lists the accounts a swap needs          |
//! | `pipeline_quote`            | quoters and SDKs, in simulation  | prices a trade, read-only                |
//! | `pipeline_swap`             | the router, from `swap`          | settles a trade                          |
//! | `add_liquidity`             | LPs, directly                    | adds both mints for LP shares            |
//! | `rebalance`                 | anyone, a keeper                 | moves the buffer back to its target      |
//!
//! Quotes, swaps and deposits value the lent side as `L = B + V`: the buffer `B` in the lent
//! mint's vault, plus the market's recorded cTokens at the Kamino reserve's stored rate, read
//! after the reserve is checked ([`kamino`]). A swap that pays out more of the lent side than
//! the buffer holds redeems just the shortfall from Kamino inside the swap, and never deposits.
//! `rebalance` lends the surplus to Kamino and redeems a shortfall from it, by the rule in
//! [`buffer`], whenever the buffer's share of the lent side has left its band.
//!
//! Where things live: the build-time policy values in [`config`], the creation parameters
//! and their rules in [`params`], the market state and its final layout in [`state`], the
//! one pricing function in [`pricing`], the share maths in [`shares`], the buffer's rule in
//! [`buffer`], every read of and call to Kamino in [`kamino`], and each instruction
//! in its own module of [`instructions`]. The mint extension allowlist is the shared
//! `mint-rules` crate.

use anchor_lang::prelude::*;

pub mod buffer;
pub mod config;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod interface;
pub mod kamino;
pub mod params;
pub mod pricing;
pub mod shares;
pub mod state;
pub mod token;

pub use errors::StrategyError;
pub use instructions::*;
pub use params::InitParams;
pub use state::LendingAmmMarket;

// The program's address; its key is `~/.config/testing-pipeline/devnet/lending-amm.json`.
declare_id!("Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG");

#[program]
pub mod lending_amm {
    use super::*;

    /// Creates a market. `data` is the Borsh-encoded [`InitParams`].
    pub fn pipeline_init_market<'info>(
        ctx: Context<'info, InitMarket<'info>>,
        data: Vec<u8>,
    ) -> Result<()> {
        instructions::init_market(ctx, data)
    }

    /// Reports the market's mints, vaults and exact-out support.
    pub fn pipeline_market_info(ctx: Context<MarketInfoAccounts>) -> Result<()> {
        instructions::market_info(ctx)
    }

    /// Lists the strategy accounts a swap needs, after the router's ten fixed ones.
    pub fn pipeline_resolve_accounts(
        ctx: Context<ReadTrade>,
        request: interface::ResolveRequest,
    ) -> Result<()> {
        instructions::resolve_accounts(ctx, request)
    }

    /// Prices a trade without changing anything.
    pub fn pipeline_quote<'info>(
        ctx: Context<'info, ReadTrade<'info>>,
        request: interface::TradeRequest,
    ) -> Result<()> {
        instructions::quote(ctx, request)
    }

    /// Settles a trade the router sends.
    pub fn pipeline_swap<'info>(
        ctx: Context<'info, SwapAccounts<'info>>,
        request: interface::SwapRequest,
    ) -> Result<()> {
        instructions::swap(ctx, request)
    }

    /// Adds both mints to a market for LP shares; the first deposit opens it.
    pub fn add_liquidity<'info>(
        ctx: Context<'info, AddLiquidity<'info>>,
        max_0: u64,
        max_1: u64,
        min_lp: u64,
    ) -> Result<()> {
        instructions::add_liquidity_handler(ctx, max_0, max_1, min_lp)
    }

    /// Moves the buffer back to its target by depositing into Kamino or redeeming from it,
    /// when its share of the lent side has left its band. Anyone may call it.
    pub fn rebalance<'info>(ctx: Context<'info, Rebalance<'info>>) -> Result<()> {
        instructions::rebalance_handler(ctx)
    }
}

/// Borsh-encodes return data.
fn borsh_encode<T: AnchorSerialize>(value: &T) -> Result<Vec<u8>> {
    let mut encoded = Vec::new();
    value.serialize(&mut encoded)?;
    Ok(encoded)
}
