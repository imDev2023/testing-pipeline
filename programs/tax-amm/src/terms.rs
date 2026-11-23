//! The hash of a market's terms, which the seed checks (docs/spec/tax-amm.md, "The seed";
//! hardening finding H019, #67): a seeder signs `seed` with the hash of the terms it agreed
//! to, and the seed refuses a market whose terms as stored hash otherwise, so nobody can
//! lure a seeder into funding a look-alike market whose terms it did not choose.
//!
//! The terms are everything a market's creation parameters set and everything that decides
//! the rates it will charge: the SHA-256 of the Borsh encoding of the two mints, the creation
//! parameters as stored (`init_data`'s fields, in their order), the pending buy and sell tax
//! and the slot they apply from (all 0 when nothing is pending). A client computes it from
//! the terms it creates a market with, or from the market state it shows its seeder.

use anchor_lang::prelude::*;

use crate::params::InitParams;
use crate::state::TaxMarket;

/// The terms of a market, in the order they are hashed.
#[derive(AnchorSerialize)]
struct Terms {
    mints: [Pubkey; 2],
    params: InitParams,
    pending_buy_tax_bps: u16,
    pending_sell_tax_bps: u16,
    pending_from_slot: u64,
}

/// The hash of `market`'s terms as stored.
pub fn terms_hash(market: &TaxMarket) -> Result<[u8; 32]> {
    let terms = Terms {
        mints: market.mints,
        params: market.params(),
        pending_buy_tax_bps: market.pending_buy_tax_bps,
        pending_sell_tax_bps: market.pending_sell_tax_bps,
        pending_from_slot: market.pending_from_slot,
    };
    let bytes = crate::borsh_encode(&terms)?;
    Ok(solana_sha256_hasher::hash(&bytes).to_bytes())
}
