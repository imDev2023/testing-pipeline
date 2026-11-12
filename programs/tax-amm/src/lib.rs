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
//! | `distribute`                | anyone, directly                 | pays out what one tax slot is owed    |
//! | `set_taxes`                 | the tax authority, directly      | moves the rates inside their ranges   |
//! | `set_recipients`            | the tax authority, directly      | changes the recipients and the burn   |
//! | `renounce_tax_authority`    | the tax authority, directly      | gives up its powers for good          |
//!
//! A market is created through the router and opens with its seed, usually in the same
//! transaction; until then every quote and swap is refused. From then on its liquidity is
//! locked for good, and every trade's tax is booked as owed to its slots in the tax-side
//! vault. Its optional tax authority may move the rates inside the ranges fixed at
//! creation, change the tax recipients, and renounce; nobody else can change a market.
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

    /// Custom action: anyone pays out what one tax slot is owed, a tax recipient or the
    /// suite share to its wallet's associated token account for the tax-side mint (created
    /// at the caller's expense when missing), the burn by burning from the vault.
    /// Remaining accounts are the tax-side mint's transfer-hook accounts.
    pub fn distribute<'info>(ctx: Context<'info, Distribute<'info>>, slot: u8) -> Result<()> {
        instructions::distribute_slot(ctx, slot)
    }

    /// Custom action: the tax authority moves the buy and sell tax, each inside the range
    /// fixed at creation. The next swap pays the new rates.
    pub fn set_taxes(
        ctx: Context<TaxAuthorityAction>,
        buy_tax_bps: u16,
        sell_tax_bps: u16,
    ) -> Result<()> {
        instructions::change_taxes(ctx, buy_tax_bps, sell_tax_bps)
    }

    /// Custom action: the tax authority replaces the tax recipients, their shares and the
    /// burn share, under the rules of creation. What each slot is owed stays with the slot.
    pub fn set_recipients(
        ctx: Context<TaxAuthorityAction>,
        recipients: [Pubkey; config::MAX_RECIPIENTS],
        shares: [u16; config::MAX_RECIPIENTS],
        burn_share_bps: u16,
    ) -> Result<()> {
        instructions::change_recipients(ctx, recipients, shares, burn_share_bps)
    }

    /// Custom action: the tax authority renounces, after which the market's taxes and
    /// recipients never change again.
    pub fn renounce_tax_authority(ctx: Context<TaxAuthorityAction>) -> Result<()> {
        instructions::renounce(ctx)
    }
}

/// Borsh-encodes return data.
fn borsh_encode<T: AnchorSerialize>(value: &T) -> Result<Vec<u8>> {
    let mut encoded = Vec::new();
    value.serialize(&mut encoded)?;
    Ok(encoded)
}
