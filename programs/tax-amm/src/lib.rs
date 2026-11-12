//! The tax AMM: a Pipeline strategy whose markets take their tax in one chosen mint, the
//! tax side, whichever way a trade goes (docs/spec/tax-amm.md).
//!
//! Pipeline's router sends trades to a strategy, makes sure the trader gets at least their
//! minimum, charges Pipeline's 0.25% fee and publishes a standard swap event, so every tax
//! market can be found, quoted, traded and charted by anything built on Pipeline.
//!
//! | Instruction                 | Called by                        | Does                                  |
//! |-----------------------------|----------------------------------|---------------------------------------|
//! | `pipeline_init_market`      | the router, from `create_market` | creates a tax market and its vaults   |
//! | `pipeline_market_info`      | the router, at market creation   | reports mints, vaults, exact-out      |
//! | `pipeline_resolve_accounts` | quoters and SDKs, in simulation  | lists the accounts a swap needs       |
//! | `pipeline_quote`            | quoters and SDKs, in simulation  | prices a trade, read-only             |
//! | `pipeline_swap`             | the router, from `swap`          | settles a trade                       |
//!
//! A market is created here and opens with its seed, which arrives with trading in
//! [Tax AMM: seed a market and trade it](https://github.com/imDev2023/testing-pipeline/issues/60);
//! until then every quote and swap is refused.
//!
//! Where things live: the build-time policy values in [`config`], the creation parameters
//! and their rules in [`params`], the market state and its fixed layout in [`state`], the
//! one pricing function in [`pricing`], and each instruction in its own module of
//! [`instructions`]. The mint extension allowlist is the shared `mint-rules` crate.

use anchor_lang::prelude::*;

pub mod config;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod interface;
pub mod params;
pub mod pricing;
pub mod state;

pub use errors::StrategyError;
pub use instructions::*;
pub use params::InitParams;
pub use state::TaxMarket;

// The program's address; its key is `~/.config/testing-pipeline/devnet/tax-amm.json`.
declare_id!("J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t");

#[program]
pub mod tax_amm {
    use super::*;

    /// Creates a tax market. `data` is the Borsh-encoded [`InitParams`].
    pub fn pipeline_init_market(ctx: Context<InitMarket>, data: Vec<u8>) -> Result<()> {
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
    pub fn pipeline_quote(ctx: Context<ReadTrade>, request: interface::TradeRequest) -> Result<()> {
        instructions::quote(ctx, request)
    }

    /// Settles a trade the router sends.
    pub fn pipeline_swap(
        ctx: Context<SwapAccounts>,
        request: interface::SwapRequest,
    ) -> Result<()> {
        instructions::swap(ctx, request)
    }
}

/// Borsh-encodes return data.
fn borsh_encode<T: AnchorSerialize>(value: &T) -> Result<Vec<u8>> {
    let mut encoded = Vec::new();
    value.serialize(&mut encoded)?;
    Ok(encoded)
}
