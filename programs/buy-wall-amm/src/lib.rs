//! The buy wall AMM: a Pipeline strategy whose markets own all their liquidity, a token
//! against wrapped SOL on a constant-product curve with an inventory cap and a buy wall
//! below the price, a port of IMD's Pool4 design (docs/spec/pool4-for-solana.md).
//!
//! Generated from Pipeline's Apache-2.0 strategy template (`scripts/new-strategy.sh` at
//! Pipeline commit `5ad130d`) and owned here from then on.
//!
//! | Instruction                 | Called by                        | Does                                 |
//! |-----------------------------|----------------------------------|--------------------------------------|
//! | `pipeline_init_market`      | the router, from `create_market` | creates a market state and its vaults |
//! | `pipeline_market_info`      | the router, at market creation   | reports mints, vaults, exact-out      |
//! | `pipeline_resolve_accounts` | quoters and SDKs, in simulation  | lists the output vault, its authority |
//! | `pipeline_quote`            | quoters and SDKs, in simulation  | prices an exact-in trade             |
//! | `pipeline_swap`             | the router, from `swap`          | settles a trade, then the cap        |
//! | `seed`                      | the market's seeder, directly    | seeds and opens the market, once      |
//!
//! Policy values live only in `config.rs` (build-time constants) and in each market's
//! creation parameters (`params.rs`).

use anchor_lang::prelude::*;

pub mod books;
pub mod cap;
pub mod config;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod interface;
pub mod math;
pub mod opening;
pub mod params;
pub mod pricing;
pub mod state;
pub mod token;
pub mod vaults;

pub use instructions::*;
pub use params::InitParams;

// Replaced with this program's address by `scripts/new-strategy.sh`.
declare_id!("BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6");

#[program]
pub mod buy_wall_amm {
    use super::*;

    /// Creates a market. `data` is the Borsh encoding of [`InitParams`].
    pub fn pipeline_init_market(ctx: Context<InitMarket>, data: Vec<u8>) -> Result<()> {
        instructions::init_market::handle_init_market(ctx, data)
    }

    /// Reports the market's mints (the token at index 0, wrapped SOL at index 1), its
    /// vaults and that it does not support exact-out.
    pub fn pipeline_market_info(ctx: Context<MarketInfoAccounts>) -> Result<()> {
        instructions::market_info::handle_market_info(ctx)
    }

    /// Lists the accounts a swap needs after the router's ten: the output vault and the
    /// vault authority.
    pub fn pipeline_resolve_accounts(
        ctx: Context<ReadTrade>,
        request: interface::ResolveRequest,
    ) -> Result<()> {
        instructions::read_trade::handle_resolve_accounts(ctx, request)
    }

    /// Prices an exact-in trade without changing anything; refuses exact-out.
    pub fn pipeline_quote(ctx: Context<ReadTrade>, request: interface::TradeRequest) -> Result<()> {
        instructions::read_trade::handle_quote(ctx, request)
    }

    /// Settles an exact-in trade the router sends: pays the trader from the output vault,
    /// books the fee, the ledgers, the price and the counters, then lowers the inventory
    /// cap or trims the curve, emitting `CapLowered` or `Trimmed`.
    pub fn pipeline_swap<'info>(
        ctx: Context<'info, SwapAccounts<'info>>,
        request: interface::SwapRequest,
    ) -> Result<()> {
        instructions::swap::handle_swap(ctx, request)
    }

    /// Custom action: seeds and opens a market, signed by its seeder, once. Remaining
    /// accounts are the token's transfer-hook accounts.
    pub fn seed<'info>(
        ctx: Context<'info, Seed<'info>>,
        token_amount: u64,
        sol_amount: u64,
    ) -> Result<()> {
        instructions::seed::handle_seed(ctx, token_amount, sol_amount)
    }
}

pub(crate) fn borsh_encode<T: AnchorSerialize>(value: &T) -> Result<Vec<u8>> {
    let mut encoded = Vec::new();
    value.serialize(&mut encoded)?;
    Ok(encoded)
}
