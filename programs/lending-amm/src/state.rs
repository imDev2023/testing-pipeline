//! The market state: one account per lending AMM market, in its final layout from the first
//! build, so later versions fill fields in and never move one.
//!
//! On 2026-11-08 an upgrade of another strategy on devnet stranded most of its markets,
//! because the new program could no longer read what older versions had written. So this
//! account holds, from the start, every field the whole spec needs (the recorded cTokens,
//! withdraw mode and the running totals deposited into and redeemed from Kamino included,
//! which later tickets fill), a version byte, and reserved space that only ever gains
//! appended fields, with a zeroed value meaning the old behaviour.
//!
//! It is Borsh-encoded with only fixed-size fields, so every field sits at a fixed offset;
//! `tests/layout.rs` pins every one.

use anchor_lang::prelude::*;

/// The market state's layout version, its byte after the discriminator.
pub const STATE_VERSION: u8 = 1;

/// Seeds of the market state PDA, `["market", other_mint, lent_mint, lp_fee_bps as u16 LE]`.
pub const MARKET_SEED: &[u8] = b"market";
/// Seeds of the vault authority PDA, `["authority", market_state]`: signs every transfer out
/// of the vaults, owns the cToken account and is the LP mint's mint authority.
pub const AUTHORITY_SEED: &[u8] = b"authority";
/// Seeds of each vault PDA, `["vault", market_state, mint]`.
pub const VAULT_SEED: &[u8] = b"vault";
/// Seeds of the cToken account PDA, `["ctoken", market_state]`.
pub const CTOKEN_SEED: &[u8] = b"ctoken";
/// Seeds of the LP mint PDA, `["lp_mint", market_state]`.
pub const LP_MINT_SEED: &[u8] = b"lp_mint";
/// Seeds of an LP's shares account PDA, `["lp_shares", market_state, lp]`: a token account
/// of the LP mint owned by the LP, where `add_liquidity` mints their shares.
pub const LP_SHARES_SEED: &[u8] = b"lp_shares";

/// Room kept at the end of the account, all zeros, so a later version can add a field
/// without moving any and without reallocating existing markets.
pub const RESERVED_LEN: usize = 256;

/// Byte offsets in the account, discriminator included. They never change.
pub mod layout {
    pub const VERSION: usize = 8;
    pub const LENT_INDEX: usize = 11;
    pub const LP_FEE_BPS: usize = 12;
    pub const WITHDRAW_MODE: usize = 14;
    pub const MINTS: usize = 15;
    pub const RESERVES: usize = 335;
    pub const CTOKENS: usize = 351;
    pub const DEPOSITED: usize = 359;
    pub const REDEEMED: usize = 375;
    pub const RESERVED: usize = 407;
    /// The whole account.
    pub const LEN: usize = 663;
}

/// A lending AMM market: the market state account the router records and passes to every
/// call.
#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct LendingAmmMarket {
    /// [`STATE_VERSION`].
    pub version: u8,
    /// The bump of the market state's own PDA.
    pub bump: u8,
    /// The bump of the vault authority PDA.
    pub authority_bump: u8,
    /// The mint index (0 or 1) that is lent; the other is never lent.
    pub lent_index: u8,
    /// The LP fee, in basis points of every swap's input; it stays in the market.
    pub lp_fee_bps: u16,
    /// Set while the market is in withdraw mode (docs/spec/lending-pool.md, "Withdraw mode").
    pub withdraw_mode: bool,
    /// The two mints, in the creator's order.
    pub mints: [Pubkey; 2],
    /// The vault for each mint, in the same order; the lent mint's vault holds the buffer.
    pub vaults: [Pubkey; 2],
    /// The router's market PDA for this market state, the only caller allowed to swap.
    pub market_signer: Pubkey,
    /// The market's LP mint.
    pub lp_mint: Pubkey,
    /// The token account holding the market's cTokens.
    pub ctoken_account: Pubkey,
    /// The Kamino reserve the lent side is deposited into, from `LENT_MINTS`.
    pub reserve: Pubkey,
    /// That reserve's collateral (cToken) mint.
    pub collateral_mint: Pubkey,
    /// For a market created by `pipeline_seed_liquidity`, the seeder whose address scopes
    /// it; the default key for a market created through the router.
    pub seeder: Pubkey,
    /// What the market has recorded in each vault, by mint index: the other side's reserve
    /// `R`, and on the lent side the buffer `B`. Tokens sent to a vault any other way are
    /// donations, never counted.
    pub reserves: [u64; 2],
    /// The cTokens the market has recorded in its cToken account, `c`.
    pub ctokens: u64,
    /// Running total of the lent mint deposited into Kamino.
    pub deposited: u128,
    /// Running total of the lent mint redeemed from Kamino, in swaps, removals and
    /// `rebalance`.
    pub redeemed: u128,
    /// When the market was created.
    pub created_slot: u64,
    pub created_at: i64,
    pub reserved: [u8; RESERVED_LEN],
}

impl LendingAmmMarket {
    /// The account's size, discriminator included.
    pub const SPACE: usize = LendingAmmMarket::DISCRIMINATOR.len() + LendingAmmMarket::INIT_SPACE;

    /// The mint index that is lent.
    pub fn lent_side(&self) -> usize {
        self.lent_index as usize & 1
    }

    /// The mint index that is not lent.
    pub fn other_index(&self) -> usize {
        1 - self.lent_side()
    }

    /// The lent mint.
    pub fn lent_mint(&self) -> Pubkey {
        self.mints[self.lent_side()]
    }

    /// Whether the first deposit has been made, which opens the market to quotes and swaps.
    ///
    /// Keyed on the other side alone: once the first deposit has put something there, no
    /// instruction can take it back to 0 (a swap pays out less than a side's whole reserve,
    /// and the locked minimum's share of it never leaves). The buffer can reach 0 while
    /// cTokens are lent, and that must never make a later deposit a first deposit, which
    /// would mint shares at a price of the depositor's choosing.
    pub fn is_open(&self) -> bool {
        self.reserves[self.other_index()] > 0
    }

    /// The vault authority PDA `["authority", market_state]`, from its stored bump.
    pub fn authority(&self, market_state: &Pubkey) -> Result<Pubkey> {
        Pubkey::create_program_address(
            &[
                AUTHORITY_SEED,
                market_state.as_ref(),
                &[self.authority_bump],
            ],
            &crate::ID,
        )
        .map_err(|_| error!(crate::errors::StrategyError::WrongAccount))
    }

    /// The input and output mint indices of a trade, if it is one this market can make.
    pub fn trade_sides(&self, input: u8, output: u8) -> Option<(usize, usize)> {
        match (input, output) {
            (0, 1) => Some((0, 1)),
            (1, 0) => Some((1, 0)),
            _ => None,
        }
    }
}

/// The market state's address for a pair, a lent side and a fee, with its bump.
pub fn market_state_address(
    other_mint: &Pubkey,
    lent_mint: &Pubkey,
    lp_fee_bps: u16,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            MARKET_SEED,
            other_mint.as_ref(),
            lent_mint.as_ref(),
            &lp_fee_bps.to_le_bytes(),
        ],
        &crate::ID,
    )
}
