//! The tax AMM's side of the contract (docs/spec/containment-hook.md, "Depends on"): the
//! hook reads a home market's state straight from its bytes, at the offsets the tax AMM's
//! crate publishes in `tax_amm::state::layout` and pins in its own `tests/layout.rs`, so the
//! two programs read one definition and never a copy of it.

use anchor_lang::Discriminator;
use tax_amm::state::layout;
use tax_amm::TaxMarket;

/// The market state's layout version, its first byte after the discriminator.
const VERSION: usize = 8;
/// The one market state version the hook reads. A later tax AMM build that writes another
/// could keep the length while moving what the hook reads, so its market states read as
/// unreadable: `bind` refuses them and `unlock` leaves them to the deadline
/// (docs/spec/containment-hook.md, "Unlock deadline"). A tax AMM build that changes its
/// version fails this crate's build until the hook is reviewed against it.
const KNOWN_VERSION: u8 = 1;
const _: () = assert!(KNOWN_VERSION == tax_amm::state::STATE_VERSION);

/// The data if it is a whole tax AMM market state the hook can read: exactly its length,
/// with its discriminator, at [`KNOWN_VERSION`].
fn whole(data: &[u8]) -> Option<&[u8]> {
    (data.len() == layout::LEN
        && data.get(..8)? == TaxMarket::DISCRIMINATOR
        && *data.get(VERSION)? == KNOWN_VERSION)
        .then_some(data)
}

/// The tax side of a tax AMM market state's data: the mint index (0 or 1) its tax is taken
/// in. `None` unless the data is a whole market state the hook can read.
pub fn tax_side(data: &[u8]) -> Option<u8> {
    whole(data)?.get(layout::TAX_SIDE).copied()
}

/// The tax a tax AMM market has collected so far, in its tax-side mint: the counter only
/// router swaps change, which the unlock goal is measured against
/// (docs/spec/containment-hook.md, "Unlock goal"). `None` unless the data is a whole market
/// state the hook can read.
pub fn tax_collected(data: &[u8]) -> Option<u128> {
    let bytes = whole(data)?.get(layout::TAX_COLLECTED..layout::TAX_COLLECTED + 16)?;
    Some(u128::from_le_bytes(bytes.try_into().ok()?))
}
