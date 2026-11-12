//! Events, one per instruction that changes a market, so Aviary's indexer can show a
//! market's history; current values are always read from the market state.

use anchor_lang::prelude::*;

use crate::config::MAX_RECIPIENTS;
use crate::params::InitParams;

/// A tax market was created through the router's `create_market`.
#[event]
pub struct MarketCreated {
    pub market_state: Pubkey,
    pub mints: [Pubkey; 2],
    pub vaults: [Pubkey; 2],
    pub params: InitParams,
    pub created_slot: u64,
    pub created_at: i64,
}

/// The seeder funded a market, which opened. `amounts` is what arrived in each vault, in
/// mint order, which the market recorded as its real reserves.
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct Seeded {
    pub market_state: Pubkey,
    pub seeder: Pubkey,
    pub amounts: [u64; 2],
}

/// The tax authority changed the market's rates; the next swap pays them.
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct TaxesChanged {
    pub market_state: Pubkey,
    pub tax_authority: Pubkey,
    pub buy_tax_bps: u16,
    pub sell_tax_bps: u16,
}

/// The tax authority changed the market's tax recipients, their shares or the burn share.
/// What each slot is already owed stays with the slot.
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct RecipientsChanged {
    pub market_state: Pubkey,
    pub tax_authority: Pubkey,
    pub recipients: [Pubkey; MAX_RECIPIENTS],
    pub shares: [u16; MAX_RECIPIENTS],
    pub burn_share_bps: u16,
}

/// The tax authority renounced: the market's taxes and recipients never change again.
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct TaxAuthorityRenounced {
    pub market_state: Pubkey,
    pub tax_authority: Pubkey,
}

/// One tax slot was paid out (docs/spec/tax-amm.md, "Payout"): `amount` of the tax-side
/// mint went to the associated token account of `recipient`, or was burned from the vault
/// for the burn slot, whose `recipient` is the default key. A slot with nothing owed pays
/// nothing and emits nothing.
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct Distributed {
    pub market_state: Pubkey,
    /// 0 to 3 a tax recipient, 4 the burn, 5 the suite share.
    pub slot: u8,
    pub recipient: Pubkey,
    pub amount: u64,
}
