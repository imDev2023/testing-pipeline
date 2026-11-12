//! The market state: one account per tax market, complete and final from the first build,
//! so later versions fill fields in and never move one (docs/spec/tax-amm.md, "Counters for
//! the containment hook").
//!
//! It is Borsh-encoded with only fixed-size fields, so every field sits at a fixed offset.
//! The containment hook reads the tax side and `tax_collected` straight from the account's
//! bytes, at the offsets in [`layout`], and `tests/layout.rs` pins every field's offset, so
//! the two programs cannot drift apart unnoticed.

use anchor_lang::prelude::*;

use crate::config::MAX_RECIPIENTS;
use crate::params::InitParams;

/// The market state's layout version, its byte after the discriminator.
pub const STATE_VERSION: u8 = 1;

/// Seeds of the vault authority PDA, `["authority", market_state]`, which owns both vaults.
pub const AUTHORITY_SEED: &[u8] = b"authority";
/// Seeds of each vault PDA, `["vault", market_state, mint]`.
pub const VAULT_SEED: &[u8] = b"vault";
/// Seeds of the market state of a market a launchpad seeded through
/// `pipeline_seed_liquidity`, `["seeded", seeder, mint_0, mint_1]`.
pub const SEEDED_SEED: &[u8] = b"seeded";

/// What each tax slot is owed, by index: the tax recipients, then the burn, then the suite
/// share (docs/spec/tax-amm.md, "Payout").
pub const OWED_SLOTS: usize = MAX_RECIPIENTS + 2;
pub const BURN_SLOT: usize = MAX_RECIPIENTS;
pub const SUITE_SLOT: usize = MAX_RECIPIENTS + 1;

/// Room kept at the end of the account, all zeros, so a later version can add a field
/// without moving any and without reallocating existing markets.
pub const RESERVED_LEN: usize = 64;

/// Byte offsets in the account, discriminator included. The containment hook reads these
/// directly; they never change.
pub mod layout {
    /// `tax_side`: one byte, the mint index (0 or 1) the market's tax is taken in.
    pub const TAX_SIDE: usize = 10;
    /// `tax_collected`: a little-endian u128, every tax taken so far, in the tax-side mint.
    pub const TAX_COLLECTED: usize = 460;
    /// The whole account.
    pub const LEN: usize = 596;
}

/// Where a market is in its life. New states are only ever added after the last.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarketStatus {
    /// Created and not yet seeded: every quote and swap is refused.
    Created,
    /// Seeded: open for swaps through the router, for good.
    Open,
}

/// A tax market: the market state account the router records and passes to every call.
#[account]
#[derive(InitSpace, Debug)]
pub struct TaxMarket {
    /// [`STATE_VERSION`].
    pub version: u8,
    pub status: MarketStatus,
    /// The mint index (0 or 1) every tax is taken in; fixed at creation.
    pub tax_side: u8,
    /// The mint index (0 or 1) whose reserve `virtual_reserve` adds to; fixed at creation.
    pub virtual_side: u8,
    /// The bump of the vault authority PDA.
    pub authority_bump: u8,
    /// Set once the tax authority renounces, after which taxes and recipients never change.
    pub tax_authority_renounced: bool,
    /// The two mints, in the creator's order.
    pub mints: [Pubkey; 2],
    /// The vault for each mint, in the same order.
    pub vaults: [Pubkey; 2],
    /// The router's market PDA for this market state, the only caller allowed to swap.
    pub market_signer: Pubkey,
    pub buy_tax_bps: u16,
    pub sell_tax_bps: u16,
    pub buy_tax_min_bps: u16,
    pub buy_tax_max_bps: u16,
    pub sell_tax_min_bps: u16,
    pub sell_tax_max_bps: u16,
    /// The default key when the market has none.
    pub tax_authority: Pubkey,
    pub seeder: Pubkey,
    pub recipients: [Pubkey; MAX_RECIPIENTS],
    pub shares: [u16; MAX_RECIPIENTS],
    pub burn_share_bps: u16,
    pub virtual_reserve: u64,
    /// What the market owns in each vault, as far as pricing is concerned.
    pub reserves: [u64; 2],
    /// Tax booked to each slot and not yet paid out, in the tax-side mint (see
    /// [`OWED_SLOTS`]).
    pub owed: [u64; OWED_SLOTS],
    /// Counters for the containment hook, changed only by router swaps.
    pub tax_collected: u128,
    pub volume: [u128; 2],
    pub swap_count: u64,
    /// When the market was created.
    pub created_slot: u64,
    pub created_at: i64,
    pub reserved: [u8; RESERVED_LEN],
}

impl TaxMarket {
    /// The account's size, discriminator included.
    pub const SPACE: usize = TaxMarket::DISCRIMINATOR.len() + TaxMarket::INIT_SPACE;

    /// The creation parameters as they stand in the market state now.
    pub fn params(&self) -> InitParams {
        InitParams {
            tax_side: self.tax_side,
            buy_tax_bps: self.buy_tax_bps,
            sell_tax_bps: self.sell_tax_bps,
            buy_tax_min_bps: self.buy_tax_min_bps,
            buy_tax_max_bps: self.buy_tax_max_bps,
            sell_tax_min_bps: self.sell_tax_min_bps,
            sell_tax_max_bps: self.sell_tax_max_bps,
            tax_authority: self.tax_authority,
            seeder: self.seeder,
            recipients: self.recipients,
            shares: self.shares,
            burn_share_bps: self.burn_share_bps,
            virtual_side: self.virtual_side,
            virtual_reserve: self.virtual_reserve,
        }
    }

    /// The input and output mint indexes of a trade from `input` to `output`, if it is one
    /// of the market's two directions. Every instruction that trades asks this, so there is
    /// one rule for a valid direction.
    pub fn direction(input: u8, output: u8) -> Option<(usize, usize)> {
        match (input, output) {
            (0, 1) => Some((0, 1)),
            (1, 0) => Some((1, 0)),
            _ => None,
        }
    }

    /// The input and output vaults of a trade from mint index `input` to `output`.
    pub fn trade_vaults(&self, input: u8, output: u8) -> Option<(Pubkey, Pubkey)> {
        let (i, o) = Self::direction(input, output)?;
        Some((self.vaults[i], self.vaults[o]))
    }
}

/// The vault authority of a market state, `["authority", market_state]` with the bump the
/// market state stores, or `None` if that bump does not make a PDA.
pub fn vault_authority(market_state: &Pubkey, bump: u8) -> Option<Pubkey> {
    Pubkey::create_program_address(
        &[AUTHORITY_SEED, market_state.as_ref(), &[bump]],
        &crate::ID,
    )
    .ok()
}
