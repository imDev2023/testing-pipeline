//! The tax AMM's side of the contract (docs/spec/containment-hook.md, "Depends on"): the
//! hook reads a home market's state straight from its bytes, at the offsets the tax AMM's
//! crate publishes in `tax_amm::state::layout` and pins in its own `tests/layout.rs`, so the
//! two programs read one definition and never a copy of it.

use anchor_lang::Discriminator;
use tax_amm::state::layout;
use tax_amm::TaxMarket;

/// The data if it is a whole tax AMM market state: exactly its length, with its
/// discriminator.
fn whole(data: &[u8]) -> Option<&[u8]> {
    (data.len() == layout::LEN && data.get(..8)? == TaxMarket::DISCRIMINATOR).then_some(data)
}

/// The tax side of a tax AMM market state's data: the mint index (0 or 1) its tax is taken
/// in. `None` unless the data is a whole market state with the tax AMM's discriminator.
pub fn tax_side(data: &[u8]) -> Option<u8> {
    whole(data)?.get(layout::TAX_SIDE).copied()
}

/// The tax a tax AMM market has collected so far, in its tax-side mint: the counter only
/// router swaps change, which the unlock goal is measured against
/// (docs/spec/containment-hook.md, "Unlock goal"). `None` unless the data is a whole market
/// state with the tax AMM's discriminator.
pub fn tax_collected(data: &[u8]) -> Option<u128> {
    let bytes = whole(data)?.get(layout::TAX_COLLECTED..layout::TAX_COLLECTED + 16)?;
    Some(u128::from_le_bytes(bytes.try_into().ok()?))
}
