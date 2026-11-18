//! Events, one per instruction of ours that changes a market, so Aviary's indexer can show a
//! market's history; current values are always read from the market state. A swap emits the
//! router's swap event instead, which carries its amounts, and moves the recorded reserves
//! by exactly the input it credits and the output it pays; a swap that redeems its shortfall
//! from Kamino also emits [`ShortfallRedeemed`]. An SPL Token burn of LP shares emits nothing of
//! ours; the LP mint's supply shows it.

use anchor_lang::prelude::*;

use crate::params::InitParams;

/// A market was created, through the router's `create_market` or a launchpad's
/// `pipeline_seed_liquidity`, which then emits [`MarketSeeded`].
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

/// A launchpad's program seeded a new market with `pipeline_seed_liquidity`: its first deposit
/// came from the seeder's escrows, and its shares went to the LP recipient.
#[event]
pub struct MarketSeeded {
    pub market_state: Pubkey,
    /// The calling program's PDA that signed, whose address scopes the market's.
    pub seeder: Pubkey,
    /// The owner of the shares, and the token account of the LP mint they went to: the
    /// recipient's associated token account, the lock account when the recipient is the vault
    /// authority.
    pub lp_recipient: Pubkey,
    pub shares_account: Pubkey,
    /// What the market took of each mint, by mint index.
    pub amounts: [u64; 2],
    /// The LP shares minted to the recipient.
    pub shares: u64,
    /// The market's share count after the seed, the locked minimum included.
    pub share_count: u64,
}

/// Which way a `rebalance` moved the lent mint.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum RebalanceDirection {
    /// From the buffer into Kamino, for cTokens.
    Deposit,
    /// From Kamino into the buffer, for cTokens burned.
    Redeem,
}

/// `rebalance` moved the buffer back towards its target.
#[event]
pub struct Rebalanced {
    pub market_state: Pubkey,
    pub direction: RebalanceDirection,
    /// The lent mint that actually left or joined the buffer, as measured at the vault.
    pub liquidity: u64,
    /// The cTokens that were actually minted to or burned from the market, as measured at its
    /// cToken account.
    pub ctokens: u64,
    /// The buffer `B` the market has recorded afterwards.
    pub buffer: u64,
    /// The cTokens `c` the market has recorded afterwards.
    pub ctokens_held: u64,
    /// The running totals of the lent mint deposited into and redeemed from Kamino
    /// afterwards; the lending yield so far is `V + redeemed - deposited`.
    pub deposited: u128,
    pub redeemed: u128,
}

/// `rebalance` put the market into withdraw mode: Kamino's freely available liquidity was below
/// `WITHDRAW_MODE_ENTER` times the market's exposure (docs/spec/lending-pool.md, "Withdraw
/// mode"). Emitted before the call's [`Rebalanced`], if it moved anything.
#[event]
pub struct WithdrawModeEntered {
    pub market_state: Pubkey,
    /// The reserve's freely available liquidity `rebalance` measured.
    pub free_liquidity: u64,
    /// The market's exposure `X = max(V, T)`: the larger of its lent value and its target lent
    /// value.
    pub exposure: u64,
}

/// `rebalance` took the market out of withdraw mode: Kamino's freely available liquidity was
/// back above `WITHDRAW_MODE_EXIT` times the market's exposure, so the band applies again.
/// Emitted before the call's [`Rebalanced`], if it moved anything.
#[event]
pub struct WithdrawModeLeft {
    pub market_state: Pubkey,
    /// The reserve's freely available liquidity `rebalance` measured.
    pub free_liquidity: u64,
    /// The market's exposure `X = max(V, T)`.
    pub exposure: u64,
}

/// A swap redeemed its shortfall from Kamino before paying the trader
/// (docs/spec/lending-pool.md, "Redeeming the shortfall").
#[event]
pub struct ShortfallRedeemed {
    pub market_state: Pubkey,
    /// What the trade paid out beyond the buffer, `out - B`.
    pub shortfall: u64,
    /// The cTokens burned, `ceil(shortfall x S_ctoken / S_total)` at the stored rate, as
    /// measured at the market's cToken account.
    pub ctokens: u64,
    /// The lent mint klend's redeem actually paid into the buffer vault, at least the shortfall;
    /// anything above it stays in the buffer.
    pub liquidity: u64,
    /// The buffer `B` the market has recorded after paying the trader.
    pub buffer: u64,
    /// The cTokens `c` the market has recorded afterwards.
    pub ctokens_held: u64,
    /// The running total of the lent mint redeemed from Kamino afterwards.
    pub redeemed: u128,
}

/// An LP removed liquidity with `remove_liquidity` (docs/spec/lending-pool.md, "Removing").
#[event]
pub struct LiquidityRemoved {
    pub market_state: Pubkey,
    pub lp: Pubkey,
    /// The LP shares burned.
    pub shares: u64,
    /// The market's share count after the removal, the locked minimum included.
    pub share_count: u64,
    /// What the LP received of each mint, by mint index: the other side's part, and of the lent
    /// mint the buffer's part plus, in cash, what klend paid for the cTokens' part.
    pub amounts: [u64; 2],
    /// The cTokens that left the market, as measured: paid to the LP in kind, burned by klend's
    /// redeem in cash.
    pub ctokens: u64,
    /// Whether the cTokens' part was paid as cTokens.
    pub in_kind: bool,
    /// In cash, the lent mint klend's redeem paid for the cTokens' part, included in `amounts`.
    pub redeemed: u64,
}

/// An LP moved shares into the market's lock account with `lock_lp`, for good
/// (docs/spec/lending-pool.md, "Locking").
#[event]
pub struct SharesLocked {
    pub market_state: Pubkey,
    pub lp: Pubkey,
    /// The shares locked by this call.
    pub amount: u64,
    /// The lock account's balance afterwards: every share locked in the market so far.
    pub locked: u64,
    /// The market's share count, the locked minimum included, which locking leaves unchanged.
    pub share_count: u64,
}
