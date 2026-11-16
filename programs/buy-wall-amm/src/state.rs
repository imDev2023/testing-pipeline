//! The market state: one fixed-size, zero-copy layout of every field the whole spec needs
//! (docs/spec/pool4-for-solana.md, "Market state").
//!
//! An upgrade must never strand a market, so:
//!
//! - every market state is exactly `MARKET_STATE_SIZE` bytes from creation and is never
//!   resized, which a compile-time assertion below holds the struct to;
//! - it starts with an 8-byte discriminator written here as fixed bytes, never derived from
//!   a type's name (`POOL4-21`), and a layout version byte;
//! - every field sits at a fixed offset with no padding: every field is a byte array (or a
//!   byte), so the struct has alignment 1, and 128-bit and other integers are little-endian;
//! - the reserve after the last field is zeroed; a later version may only append fields
//!   into it, a zeroed new field meaning the old behaviour, and never moves, resizes or
//!   removes a field.
//!
//! The byte offset of every field is in the spec's "Market state" table, which a test
//! (`tests/layout.rs`) reads and checks against this struct.

use anchor_lang::prelude::*;

use crate::config::MARKET_STATE_SIZE;
use crate::errors::StrategyError;

/// The market state's account discriminator, fixed for good (`POOL4-21`, `POOL4-22`).
pub const MARKET_STATE_DISCRIMINATOR: &[u8; 8] = b"BWMARKET";
/// The layout this build writes.
pub const LAYOUT_VERSION: u8 = 1;
/// Every layout version ever deployed. Every instruction accepts all of them.
pub const DEPLOYED_LAYOUT_VERSIONS: &[u8] = &[1];

/// `status`: created by `pipeline_init_market`, waiting for its seed.
pub const STATUS_CREATED: u8 = 1;
/// `status`: seeded and open.
pub const STATUS_OPEN: u8 = 2;

/// The first seed of the vault authority, `["authority", market_state]`.
pub const AUTHORITY_SEED: &[u8] = b"authority";
/// The first seed of a market state created by another program, `["seeded", seeder,
/// token_mint, wsol_mint]`.
pub const SEEDED_SEED: &[u8] = b"seeded";

/// The vault authority of `market_state` from its stored bump, or `None` if that bump does
/// not give a PDA.
pub fn vault_authority(market_state: &Pubkey, bump: u8) -> Option<Pubkey> {
    Pubkey::create_program_address(
        &[AUTHORITY_SEED, market_state.as_ref(), &[bump]],
        &crate::ID,
    )
    .ok()
}

/// Bytes left zeroed and reserved after the last field.
pub const RESERVE_LEN: usize = 305;

/// A buy wall market. The 8-byte discriminator comes first in the account and is not part
/// of the struct; offsets in the comments are from the start of the account.
#[account(zero_copy, discriminator = MARKET_STATE_DISCRIMINATOR)]
pub struct MarketState {
    // Identity.
    /// 8: the layout version, `LAYOUT_VERSION` when written by this build.
    pub layout_version: u8,
    /// 9: `STATUS_CREATED` or `STATUS_OPEN`.
    pub status: u8,
    /// 10: the bump of the vault authority, `["authority", market_state]`.
    pub authority_bump: u8,
    /// 11: the bump of the token vault, `["vault", market_state, token_mint]`.
    pub token_vault_bump: u8,
    /// 12: the bump of the SOL vault, `["vault", market_state, wsol_mint]`.
    pub sol_vault_bump: u8,
    /// 13: the router's market PDA, the only signer `pipeline_swap` accepts.
    pub market_signer: Pubkey,
    /// 45
    pub token_mint: Pubkey,
    /// 77
    pub wsol_mint: Pubkey,
    /// 109
    pub token_vault: Pubkey,
    /// 141
    pub sol_vault: Pubkey,
    /// 173: the only signer `seed` accepts.
    pub seeder: Pubkey,
    /// 205: u64
    pub creation_slot: [u8; 8],
    /// 213: i64, Unix seconds
    pub creation_time: [u8; 8],
    /// 221: i64, Unix seconds; 0 until the seed
    pub seed_time: [u8; 8],

    // Counters.
    /// 229 and 245: u128 each, by mint index
    pub volume: [[u8; 16]; 2],
    /// 261: u128, lamports
    pub fees_collected: [u8; 16],
    /// 277: u64
    pub swap_count: [u8; 8],

    // Parameters.
    /// 285: u16
    pub fee_bps: [u8; 2],
    /// 287: u16
    pub wall_split_bps: [u8; 2],
    /// 289: u16
    pub reward_share_bps: [u8; 2],
    /// 291
    pub fee_recipient: Pubkey,
    /// 323
    pub rewards_recipient: Pubkey,
    /// 355: u16, the creation parameter `cap_floor` is computed from at the seed
    pub cap_floor_bps: [u8; 2],
    /// 357: u16, the creation parameter `cap_decay_per_day` is computed from at the seed
    pub cap_decay_bps: [u8; 2],
    /// 359: u64, token units
    pub cap_floor: [u8; 8],
    /// 367: u64, token units a day
    pub cap_decay_per_day: [u8; 8],
    /// 375: u64, token units
    pub seeded_tokens: [u8; 8],

    // Pricing.
    /// 383: u128, Q64.64
    pub sqrt_price: [u8; 16],
    /// 399: u128
    pub liquidity: [u8; 16],
    /// 415: u128
    pub wall_liquidity: [u8; 16],
    /// 431: u128, Q64.64
    pub wall_top: [u8; 16],
    /// 447: u64, lamports
    pub wall_sol_placed: [u8; 8],

    // Ledgers, u64 each.
    /// 455: token units
    pub pool_tokens: [u8; 8],
    /// 463: lamports
    pub pool_sol: [u8; 8],
    /// 471: token units
    pub retired_tokens: [u8; 8],
    /// 479: token units
    pub rewards_owed: [u8; 8],
    /// 487: lamports
    pub idle_sol: [u8; 8],
    /// 495: lamports
    pub fees_recipient: [u8; 8],
    /// 503: lamports
    pub fees_designer: [u8; 8],
    /// 511: lamports
    pub fees_suite: [u8; 8],

    // Cap.
    /// 519: u64, the inventory cap, token units
    pub cap: [u8; 8],
    /// 527: u128, token-seconds
    pub decay_credit: [u8; 16],
    /// 543: i64
    pub decay_time: [u8; 8],

    // Wall guard.
    /// 551: u128, Q64.64, the spec's `ref`
    pub reference: [u8; 16],
    /// 567: i64
    pub ref_time: [u8; 8],
    /// 575: u128, Q64.64
    pub floor: [u8; 16],
    /// 591: i64
    pub floor_time: [u8; 8],
    /// 599: u64
    pub last_slot: [u8; 8],
    /// 607: u128, Q64.64
    pub last_close: [u8; 16],

    // Totals, u128 each.
    /// 623: token units
    pub tokens_trimmed: [u8; 16],
    /// 639: lamports
    pub sol_trimmed: [u8; 16],
    /// 655: token units
    pub wall_tokens_bought: [u8; 16],
    /// 671: token units
    pub tokens_burned: [u8; 16],
    /// 687: token units
    pub rewards_paid: [u8; 16],
    /// 703: lamports
    pub tips_paid: [u8; 16],

    /// 719 to the end: zeroed, for fields later layouts append.
    pub reserve: [u8; RESERVE_LEN],
}

// The account is the discriminator plus the struct, exactly `MARKET_STATE_SIZE` bytes, and
// the struct has no padding: alignment 1 means no field is ever padded, and bytemuck's
// `Pod` derive (through `zero_copy`) refuses padding at compile time as well.
const _: () =
    assert!(MARKET_STATE_DISCRIMINATOR.len() + size_of::<MarketState>() == MARKET_STATE_SIZE);
const _: () = assert!(align_of::<MarketState>() == 1);

/// Little-endian getters and setters for the integer fields.
macro_rules! le_fields {
    ($($field:ident, $set:ident: $ty:ty;)*) => {
        impl MarketState {
            $(
                pub fn $field(&self) -> $ty {
                    <$ty>::from_le_bytes(self.$field)
                }
                pub fn $set(&mut self, value: $ty) {
                    self.$field = value.to_le_bytes();
                }
            )*
        }
    };
}

le_fields! {
    creation_slot, set_creation_slot: u64;
    creation_time, set_creation_time: i64;
    seed_time, set_seed_time: i64;
    fees_collected, set_fees_collected: u128;
    swap_count, set_swap_count: u64;
    fee_bps, set_fee_bps: u16;
    wall_split_bps, set_wall_split_bps: u16;
    reward_share_bps, set_reward_share_bps: u16;
    cap_floor_bps, set_cap_floor_bps: u16;
    cap_decay_bps, set_cap_decay_bps: u16;
    cap_floor, set_cap_floor: u64;
    cap_decay_per_day, set_cap_decay_per_day: u64;
    seeded_tokens, set_seeded_tokens: u64;
    sqrt_price, set_sqrt_price: u128;
    liquidity, set_liquidity: u128;
    wall_liquidity, set_wall_liquidity: u128;
    wall_top, set_wall_top: u128;
    wall_sol_placed, set_wall_sol_placed: u64;
    pool_tokens, set_pool_tokens: u64;
    pool_sol, set_pool_sol: u64;
    retired_tokens, set_retired_tokens: u64;
    rewards_owed, set_rewards_owed: u64;
    idle_sol, set_idle_sol: u64;
    fees_recipient, set_fees_recipient: u64;
    fees_designer, set_fees_designer: u64;
    fees_suite, set_fees_suite: u64;
    cap, set_cap: u64;
    decay_credit, set_decay_credit: u128;
    decay_time, set_decay_time: i64;
    reference, set_reference: u128;
    ref_time, set_ref_time: i64;
    floor, set_floor: u128;
    floor_time, set_floor_time: i64;
    last_slot, set_last_slot: u64;
    last_close, set_last_close: u128;
    tokens_trimmed, set_tokens_trimmed: u128;
    sol_trimmed, set_sol_trimmed: u128;
    wall_tokens_bought, set_wall_tokens_bought: u128;
    tokens_burned, set_tokens_burned: u128;
    rewards_paid, set_rewards_paid: u128;
    tips_paid, set_tips_paid: u128;
}

impl MarketState {
    /// The volume counter of mint `index` (0 the token, 1 wrapped SOL).
    pub fn volume(&self, index: usize) -> Option<u128> {
        self.volume
            .get(index)
            .map(|bytes| u128::from_le_bytes(*bytes))
    }

    pub fn set_volume(&mut self, index: usize, value: u128) -> Option<()> {
        *self.volume.get_mut(index)? = value.to_le_bytes();
        Some(())
    }

    /// The ledgers a swap changes.
    pub fn books(&self) -> crate::books::Books {
        crate::books::Books {
            pool_tokens: self.pool_tokens(),
            pool_sol: self.pool_sol(),
            idle_sol: self.idle_sol(),
            fees_recipient: self.fees_recipient(),
            fees_designer: self.fees_designer(),
            fees_suite: self.fees_suite(),
        }
    }

    pub fn set_books(&mut self, books: &crate::books::Books) {
        self.set_pool_tokens(books.pool_tokens);
        self.set_pool_sol(books.pool_sol);
        self.set_idle_sol(books.idle_sol);
        self.set_fees_recipient(books.fees_recipient);
        self.set_fees_designer(books.fees_designer);
        self.set_fees_suite(books.fees_suite);
    }

    /// What the inventory cap's steps read and write (`cap.rs`).
    pub fn inventory(&self) -> crate::cap::Inventory {
        crate::cap::Inventory {
            sqrt_price: self.sqrt_price(),
            liquidity: self.liquidity(),
            pool_tokens: self.pool_tokens(),
            pool_sol: self.pool_sol(),
            retired_tokens: self.retired_tokens(),
            idle_sol: self.idle_sol(),
            cap: self.cap(),
            decay_credit: self.decay_credit(),
            decay_time: self.decay_time(),
            tokens_trimmed: self.tokens_trimmed(),
            sol_trimmed: self.sol_trimmed(),
        }
    }

    /// Writes back what the cap's steps change; they never change the price.
    pub fn set_inventory(&mut self, inventory: &crate::cap::Inventory) {
        self.set_liquidity(inventory.liquidity);
        self.set_pool_tokens(inventory.pool_tokens);
        self.set_pool_sol(inventory.pool_sol);
        self.set_retired_tokens(inventory.retired_tokens);
        self.set_idle_sol(inventory.idle_sol);
        self.set_cap(inventory.cap);
        self.set_decay_credit(inventory.decay_credit);
        self.set_decay_time(inventory.decay_time);
        self.set_tokens_trimmed(inventory.tokens_trimmed);
        self.set_sol_trimmed(inventory.sol_trimmed);
    }

    /// The buy wall, as pricing trades through it.
    pub fn wall(&self) -> crate::wall::Wall {
        crate::wall::Wall {
            liquidity: self.wall_liquidity(),
            top: self.wall_top(),
        }
    }

    /// What `place_wall` reads and writes (`wall.rs`).
    pub fn wall_books(&self) -> crate::wall::WallBooks {
        crate::wall::WallBooks {
            wall: self.wall(),
            wall_sol_placed: self.wall_sol_placed(),
            pool_tokens: self.pool_tokens(),
            pool_sol: self.pool_sol(),
            retired_tokens: self.retired_tokens(),
            idle_sol: self.idle_sol(),
            wall_tokens_bought: self.wall_tokens_bought(),
            tips_paid: self.tips_paid(),
        }
    }

    pub fn set_wall_books(&mut self, books: &crate::wall::WallBooks) {
        self.set_wall_liquidity(books.wall.liquidity);
        self.set_wall_top(books.wall.top);
        self.set_wall_sol_placed(books.wall_sol_placed);
        self.set_pool_tokens(books.pool_tokens);
        self.set_pool_sol(books.pool_sol);
        self.set_retired_tokens(books.retired_tokens);
        self.set_idle_sol(books.idle_sol);
        self.set_wall_tokens_bought(books.wall_tokens_bought);
        self.set_tips_paid(books.tips_paid);
    }

    /// What `place_wall` reads and never writes.
    pub fn wall_at(&self) -> crate::wall::At {
        crate::wall::At {
            sqrt_price: self.sqrt_price(),
            liquidity: self.liquidity(),
            floor: self.floor(),
            fee_bps: self.fee_bps(),
        }
    }

    /// The buy wall's guard (`guard.rs`).
    pub fn guard(&self) -> crate::guard::Guard {
        crate::guard::Guard {
            reference: self.reference(),
            ref_time: self.ref_time(),
            floor: self.floor(),
            floor_time: self.floor_time(),
            last_slot: self.last_slot(),
            last_close: self.last_close(),
        }
    }

    pub fn set_guard(&mut self, guard: &crate::guard::Guard) {
        self.set_reference(guard.reference);
        self.set_ref_time(guard.ref_time);
        self.set_floor(guard.floor);
        self.set_floor_time(guard.floor_time);
        self.set_last_slot(guard.last_slot);
        self.set_last_close(guard.last_close);
    }

    /// The market's cap rules, fixed at its seed.
    pub fn cap_rules(&self) -> crate::cap::CapRules {
        crate::cap::CapRules {
            cap_floor: self.cap_floor(),
            cap_decay_per_day: self.cap_decay_per_day(),
        }
    }

    /// The counters a swap changes.
    pub fn counters(&self) -> Option<crate::books::Counters> {
        Some(crate::books::Counters {
            volume: [self.volume(0)?, self.volume(1)?],
            fees_collected: self.fees_collected(),
            swap_count: self.swap_count(),
        })
    }

    pub fn set_counters(&mut self, counters: &crate::books::Counters) -> Option<()> {
        self.set_volume(0, *counters.volume.first()?)?;
        self.set_volume(1, *counters.volume.get(1)?)?;
        self.set_fees_collected(counters.fees_collected);
        self.set_swap_count(counters.swap_count);
        Some(())
    }

    /// What the market has recorded in the vault of mint `index`: the sum of every ledger
    /// kept there (the spec's "Ledgers"), so input is credited only beyond all of them.
    pub fn recorded(&self, index: u8) -> Option<u64> {
        let ledgers: &[u64] = match index {
            0 => &[
                self.pool_tokens(),
                self.retired_tokens(),
                self.rewards_owed(),
            ],
            1 => &[
                self.pool_sol(),
                self.idle_sol(),
                self.fees_recipient(),
                self.fees_designer(),
                self.fees_suite(),
            ],
            _ => return None,
        };
        ledgers
            .iter()
            .try_fold(0u64, |total, ledger| total.checked_add(*ledger))
    }

    /// The input and output vaults of a trade: mint index 0 is the token, 1 wrapped SOL.
    pub fn vaults(&self, input_index: u8, output_index: u8) -> Result<(Pubkey, Pubkey)> {
        match (input_index, output_index) {
            (0, 1) => Ok((self.token_vault, self.sol_vault)),
            (1, 0) => Ok((self.sol_vault, self.token_vault)),
            _ => err!(StrategyError::WrongAccount),
        }
    }
}

/// Whether `account` is a market state this program can read: owned by this program,
/// exactly `MARKET_STATE_SIZE` bytes, with the discriminator and a deployed layout version.
/// Anchor's `AccountLoader` checks the owner and the discriminator; this adds the size and
/// the version, which it does not.
pub fn is_market_state(account: &AccountInfo) -> bool {
    if *account.owner != crate::ID || account.data_len() != MARKET_STATE_SIZE {
        return false;
    }
    let Ok(data) = account.try_borrow_data() else {
        return false;
    };
    data.get(..8) == Some(&MARKET_STATE_DISCRIMINATOR[..])
        && data
            .get(8)
            .is_some_and(|version| DEPLOYED_LAYOUT_VERSIONS.contains(version))
}
