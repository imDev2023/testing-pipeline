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
//! | `pipeline_swap`             | the router, from `swap`          | settles a trade, the guard, the cap  |
//! | `seed`                      | the market's seeder, directly    | seeds and opens the market, once      |
//! | `pipeline_seed_liquidity`   | a launchpad's program, by CPI    | creates, seeds and opens a market     |
//! | `place_wall`                | anyone, a keeper job             | places idle SOL as the buy wall       |
//! | `settle`                    | anyone, a keeper job             | burns retired tokens but the rewards  |
//! | `pay_rewards`               | anyone, a keeper job             | pays the rewards recipient            |
//! | `sweep_fees`                | anyone, a keeper job             | pays one fee slot to its wallet       |
//! | `set_fee_recipient`         | the fee recipient                | hands its role to another wallet      |
//! | `set_rewards_recipient`     | the rewards recipient            | hands its role to another wallet      |
//!
//! Policy values live only in `config.rs` (build-time constants) and in each market's
//! creation parameters (`params.rs`).

use anchor_lang::prelude::*;

pub mod books;
pub mod cap;
pub mod config;
pub mod errors;
pub mod events;
pub mod guard;
pub mod instructions;
pub mod interface;
pub mod math;
pub mod opening;
pub mod params;
pub mod payouts;
pub mod pricing;
pub mod recipient;
pub mod state;
pub mod token;
pub mod vaults;
pub mod wall;

pub use instructions::*;
pub use params::InitParams;

// Replaced with this program's address by `scripts/new-strategy.sh`.
#[cfg(not(feature = "test-designer-recipient"))]
declare_id!("BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6");
// The `test-designer-recipient` build, which pays fee slot 1 to a test key (`config.rs`),
// runs only at an address of its own, so it refuses every instruction if it is ever deployed
// at the program's real address (Anchor checks the program id on entry, `POOL4-39`). Written
// path-qualified so that tools reading the program's address from the line above
// (`scripts/local-validator.sh`) find exactly one.
#[cfg(feature = "test-designer-recipient")]
anchor_lang::declare_id!("DesignerTestBui1d111111111111111111111111111");

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

    /// Custom action, a permissionless keeper job: closes the buy wall at the current price
    /// and places it again with everything idle, at the lower of the price and the wall's
    /// floor, tipping the caller in wrapped SOL; refused until `idle_sol` or the SOL the
    /// wall has spent reaches `WALL_THRESHOLD`.
    pub fn place_wall(ctx: Context<PlaceWall>) -> Result<()> {
        instructions::place_wall::handle_place_wall(ctx)
    }

    /// Custom action, a permissionless keeper job: splits the retired tokens, the reward share
    /// joining `rewards_owed` and the rest burned from the token vault; refused when nothing
    /// is retired. No tip, and nobody signs but whoever pays the transaction fee.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::settle::handle_settle(ctx)
    }

    /// Custom action, a permissionless keeper job: pays all of `rewards_owed` to the rewards
    /// recipient's associated token account for the token, created at the caller's expense
    /// if missing; refused when nothing is owed. No tip. Remaining accounts are the token's
    /// transfer-hook accounts.
    pub fn pay_rewards<'info>(ctx: Context<'info, PayRewards<'info>>) -> Result<()> {
        instructions::pay_rewards::handle_pay_rewards(ctx)
    }

    /// Custom action, a permissionless keeper job: pays fee slot `slot`'s whole ledger in
    /// wrapped SOL to its wallet's associated token account, created at the caller's expense
    /// if missing: 0 the fee recipient, 1 `DESIGNER_RECIPIENT` (refused while it is unset), 2
    /// `SUITE_TREASURY`; refused when nothing is owed. No tip.
    pub fn sweep_fees(ctx: Context<SweepFees>, slot: u8) -> Result<()> {
        instructions::sweep_fees::handle_sweep_fees(ctx, slot)
    }

    /// Custom action: the fee recipient hands its role, and what the role is owed, to `new`,
    /// which must not be the default key.
    pub fn set_fee_recipient(ctx: Context<SetRecipient>, new: Pubkey) -> Result<()> {
        instructions::set_recipient::handle_set_recipient(ctx, events::RecipientRole::Fee, new)
    }

    /// Custom action: the rewards recipient hands its role, and what the role is owed, to
    /// `new`, which must not be the default key.
    pub fn set_rewards_recipient(ctx: Context<SetRecipient>, new: Pubkey) -> Result<()> {
        instructions::set_recipient::handle_set_recipient(ctx, events::RecipientRole::Rewards, new)
    }

    /// Pipeline's optional extension, called by another program such as a launchpad
    /// graduating a token: creates a market at the PDA `["seeded", seeder, token_mint,
    /// wsol_mint]` from the creation parameters in `request.data` (with the signing seeder in
    /// place of theirs), takes `request.amounts` from the seeder's escrows, opens it as
    /// `seed` does and returns `SeedResult { taken, lp_amount: 0 }`. Remaining accounts are
    /// the token's transfer-hook accounts.
    pub fn pipeline_seed_liquidity<'info>(
        ctx: Context<'info, SeedLiquidity<'info>>,
        request: interface::SeedRequest,
    ) -> Result<()> {
        instructions::seed_liquidity::handle_seed_liquidity(ctx, request)
    }
}

pub(crate) fn borsh_encode<T: AnchorSerialize>(value: &T) -> Result<Vec<u8>> {
    let mut encoded = Vec::new();
    value.serialize(&mut encoded)?;
    Ok(encoded)
}
