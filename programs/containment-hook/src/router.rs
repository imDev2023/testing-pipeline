//! What the hook reads from Pipeline's router: its `Market` account and the market's fee
//! account (docs/spec/containment-hook.md, "Checks on the home market").
//!
//! The router's source is never copied here (BSL 1.1); the `Market` layout is read from the
//! Borsh struct Pipeline's Apache-2.0 `pipeline-client` publishes at the pinned commit, and
//! `tests/layout.rs` checks this reading against `pipeline-client`'s own decoder on
//! markets the real router created.

use anchor_lang::prelude::*;
use pipeline_strategy_interface as psi;

/// Pipeline's router, `PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34`.
pub const ROUTER_PROGRAM_ID: Pubkey = Pubkey::new_from_array(psi::PIPELINE_PROGRAM_ID);

/// Anchor's discriminator of the router's `Market` account, `sha256("account:Market")[..8]`.
pub const MARKET_DISCRIMINATOR: [u8; 8] = [219, 190, 213, 55, 0, 227, 198, 154];

/// Byte offsets in the router's `Market` account, discriminator included: the strategy
/// program, the market state, the mint count, four mints, four vaults, whether exact-out is
/// supported, the creator, the creation time, then the market's bump and its fee
/// authority's bump. Pipeline 0.3 appended the market's fee mint index after them, which the
/// hook does not read; `read_market` asks only for the length up to the fee authority's bump.
mod offset {
    use super::psi::MAX_MARKET_MINTS;
    pub const STRATEGY: usize = 8;
    pub const MARKET_STATE: usize = 40;
    pub const MINT_COUNT: usize = 72;
    pub const MINTS: usize = 73;
    pub const VAULTS: usize = MINTS + 32 * MAX_MARKET_MINTS;
    pub const SUPPORTS_EXACT_OUT: usize = VAULTS + 32 * MAX_MARKET_MINTS;
    pub const CREATED_BY: usize = SUPPORTS_EXACT_OUT + 1;
    pub const CREATED_AT: usize = CREATED_BY + 32;
    pub const BUMP: usize = CREATED_AT + 8;
    pub const FEE_AUTHORITY_BUMP: usize = BUMP + 1;
    pub const LEN: usize = FEE_AUTHORITY_BUMP + 1;
}

/// The fields of a router `Market` that `bind` uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RouterMarket {
    pub strategy: Pubkey,
    pub market_state: Pubkey,
    pub mint_count: u8,
    pub mints: [Pubkey; psi::MAX_MARKET_MINTS],
    pub vaults: [Pubkey; psi::MAX_MARKET_MINTS],
    pub bump: u8,
    pub fee_authority_bump: u8,
}

impl RouterMarket {
    /// The market's mints, as many as it trades.
    pub fn mints(&self) -> &[Pubkey] {
        self.mints.get(..self.mint_count as usize).unwrap_or(&[])
    }
}

/// Reads a router `Market` account's data, or `None` unless it carries the `Market`
/// discriminator and is long enough.
pub fn read_market(data: &[u8]) -> Option<RouterMarket> {
    if data.len() < offset::LEN || data.get(..8)? != MARKET_DISCRIMINATOR {
        return None;
    }
    let key = |at: usize| -> Option<Pubkey> {
        Some(Pubkey::new_from_array(
            data.get(at..at + 32)?.try_into().ok()?,
        ))
    };
    let mut mints = [Pubkey::default(); psi::MAX_MARKET_MINTS];
    let mut vaults = [Pubkey::default(); psi::MAX_MARKET_MINTS];
    for (i, (mint, vault)) in mints.iter_mut().zip(vaults.iter_mut()).enumerate() {
        *mint = key(offset::MINTS + 32 * i)?;
        *vault = key(offset::VAULTS + 32 * i)?;
    }
    let mint_count = *data.get(offset::MINT_COUNT)?;
    if mint_count as usize > psi::MAX_MARKET_MINTS {
        return None;
    }
    Some(RouterMarket {
        strategy: key(offset::STRATEGY)?,
        market_state: key(offset::MARKET_STATE)?,
        mint_count,
        mints,
        vaults,
        bump: *data.get(offset::BUMP)?,
        fee_authority_bump: *data.get(offset::FEE_AUTHORITY_BUMP)?,
    })
}

/// The router's market PDA `["market", strategy, market_state]` with the bump the `Market`
/// records, or `None` if those seeds and bump give no address.
pub fn market_address(market: &RouterMarket) -> Option<Pubkey> {
    Pubkey::create_program_address(
        &[
            psi::seeds::MARKET,
            market.strategy.as_ref(),
            market.market_state.as_ref(),
            &[market.bump],
        ],
        &ROUTER_PROGRAM_ID,
    )
    .ok()
}

/// The market's fee account for `mint`: the Token-2022 associated token account of the
/// router's fee authority PDA `["fees", market]`, derived with the bump the `Market`
/// records, as the router's `init_fee_account` creates it.
pub fn fee_account(
    market_address: &Pubkey,
    market: &RouterMarket,
    mint: &Pubkey,
) -> Option<Pubkey> {
    let fee_authority = Pubkey::create_program_address(
        &[
            psi::seeds::FEE_AUTHORITY,
            market_address.as_ref(),
            &[market.fee_authority_bump],
        ],
        &ROUTER_PROGRAM_ID,
    )
    .ok()?;
    Some(
        anchor_spl::associated_token::get_associated_token_address_with_program_id(
            &fee_authority,
            mint,
            &anchor_spl::token_2022::ID,
        ),
    )
}
