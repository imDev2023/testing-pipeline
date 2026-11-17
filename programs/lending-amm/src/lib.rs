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
//! | `pipeline_seed_liquidity`   | a launchpad's program, by CPI    | creates a market and makes its first     |
//! |                             |                                  | deposit from the launchpad's escrows     |
//! | `add_liquidity`             | LPs, directly                    | adds both mints for LP shares            |
//! | `remove_liquidity`          | LPs, directly                    | burns LP shares for both mints, in cash  |
//! |                             |                                  | or with the cTokens' part in kind        |
//! | `remove_lent_side`          | LPs, directly                    | burns LP shares for the lent side's      |
//! |                             |                                  | parts alone, when the other mint can't   |
//! |                             |                                  | move                                     |
//! | `lock_lp`                   | LPs, directly                    | moves LP shares into the lock account    |
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
pub mod withdraw_mode;

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

    /// For a launchpad graduating a token: creates a market at the PDA `["seeded", seeder,
    /// other_mint, lent_mint, lp_fee_bps]` with the creation parameters in `request.data`,
    /// makes its first deposit of `request.amounts` from the seeder's escrows, mints the shares
    /// to the LP recipient's associated token account for the LP mint, and returns
    /// `SeedResult`. The caller then records the market with the router.
    pub fn pipeline_seed_liquidity<'info>(
        ctx: Context<'info, SeedLiquidity<'info>>,
        request: interface::SeedRequest,
    ) -> Result<()> {
        instructions::seed_liquidity(ctx, request)
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

    /// Burns `lp` of the LP's shares for their part of the other side, the buffer and the
    /// cTokens: in cash, the cTokens' part redeemed from Kamino and paid in the lent mint, or in
    /// kind, paid as cTokens with no Kamino account read or called.
    pub fn remove_liquidity<'info>(
        ctx: Context<'info, RemoveLiquidity<'info>>,
        lp: u64,
        min_other: u64,
        min_lent: u64,
        in_kind: bool,
    ) -> Result<()> {
        instructions::remove_liquidity_handler(ctx, lp, min_other, min_lent, in_kind)
    }

    /// Burns `lp` of the LP's shares for their part of the buffer, in the lent mint, and of the
    /// cTokens, in kind, leaving the other side's part to the LPs who stay: the way out when the
    /// other mint's freeze authority or transfer hook stops `remove_liquidity`.
    pub fn remove_lent_side<'info>(
        ctx: Context<'info, RemoveLentSide<'info>>,
        lp: u64,
        min_lent: u64,
    ) -> Result<()> {
        instructions::remove_lent_side_handler(ctx, lp, min_lent)
    }

    /// Moves `amount` of the LP's shares into the market's lock account, for good.
    pub fn lock_lp(ctx: Context<LockLp>, amount: u64) -> Result<()> {
        instructions::lock_lp_handler(ctx, amount)
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
