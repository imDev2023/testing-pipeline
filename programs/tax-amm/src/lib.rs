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
//! | `pipeline_swap`             | the router, from `swap`          | settles a trade, booking its tax      |
//! | `seed`                      | the market's seeder, directly    | funds the market once and opens it    |
//! | `pipeline_seed_liquidity`   | a launchpad's program, by CPI    | creates, seeds and opens a market     |
//!
//! A market is created through the router and opens with its seed, usually in the same
//! transaction; until then every quote and swap is refused. A launchpad graduating a token
//! instead creates, seeds and opens a market in one call to `pipeline_seed_liquidity`, and
//! records it with the router's `register_existing_market` in the same transaction. From then on its liquidity is
//! locked for good, and every trade's tax is booked as owed to its slots in the tax-side
//! vault.
//!
//! Where things live: the build-time policy values in [`config`], the creation parameters
//! and their rules in [`params`], the market state and its fixed layout in [`state`], the
//! one pricing function in [`pricing`], the tax split in [`split`], and each instruction
//! in its own module of [`instructions`]. The mint extension allowlist is the shared
//! `mint-rules` crate.

use anchor_lang::prelude::*;

pub mod config;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod interface;
pub mod params;
pub mod pricing;
pub mod split;
pub mod state;
pub mod token;

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

    /// Lists the strategy accounts a swap needs, after the router's ten fixed ones: the
    /// output vault and the vault authority.
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

    /// Settles a trade the router sends. Remaining accounts: the output vault and the
    /// vault authority, then the output mint's transfer-hook accounts.
    pub fn pipeline_swap<'info>(
        ctx: Context<'info, SwapAccounts<'info>>,
        request: interface::SwapRequest,
    ) -> Result<()> {
        instructions::swap(ctx, request)
    }

    /// Custom action: the seeder funds the market once, before any swap, and opens it.
    /// Remaining accounts are transfer-hook accounts, for either mint.
    pub fn seed<'info>(
        ctx: Context<'info, Seed<'info>>,
        amount_0: u64,
        amount_1: u64,
    ) -> Result<()> {
        instructions::seed_market(ctx, amount_0, amount_1)
    }

    /// Pipeline's optional extension, for a launchpad graduating a token: creates a tax
    /// market at the PDA `["seeded", seeder, mint_0, mint_1]` with the creation parameters
    /// in `request.data` (whose seeder is ignored: the calling program's PDA is the
    /// seeder), takes `request.amounts` from the seeder's escrows and opens it. Returns
    /// `SeedResult`. Remaining accounts are transfer-hook accounts, for either mint.
    pub fn pipeline_seed_liquidity<'info>(
        ctx: Context<'info, SeedLiquidity<'info>>,
        request: interface::SeedRequest,
    ) -> Result<()> {
        instructions::seed_liquidity(ctx, request)
    }
}

/// Borsh-encodes return data.
fn borsh_encode<T: AnchorSerialize>(value: &T) -> Result<Vec<u8>> {
    let mut encoded = Vec::new();
    value.serialize(&mut encoded)?;
    Ok(encoded)
}
