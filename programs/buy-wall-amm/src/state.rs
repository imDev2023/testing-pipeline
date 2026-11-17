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
pub const RESERVE_LEN: usize = 289;

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

    // The reward share (`POOL4-49`), appended into the reserve before the first deployment.
    /// 719: u64, token units the ratchet has lowered the cap by that no trim has matched yet
    pub cap_fall_unmatched: [u8; 8],
    /// 727: u64, token units, the part of `retired_tokens` that earns the reward share
    pub retired_rewardable: [u8; 8],

    /// 735 to the end: zeroed, for fields later layouts append.
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
    cap_fall_unmatched, set_cap_fall_unmatched: u64;
    retired_rewardable, set_retired_rewardable: u64;
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
            cap_fall_unmatched: self.cap_fall_unmatched(),
            retired_rewardable: self.retired_rewardable(),
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
        self.set_cap_fall_unmatched(inventory.cap_fall_unmatched);
        self.set_retired_rewardable(inventory.retired_rewardable);
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

    /// What the payout keeper jobs read and write (`payouts.rs`).
    pub fn owed(&self) -> crate::payouts::Owed {
        crate::payouts::Owed {
            retired_tokens: self.retired_tokens(),
            retired_rewardable: self.retired_rewardable(),
            rewards_owed: self.rewards_owed(),
            fees_recipient: self.fees_recipient(),
            fees_designer: self.fees_designer(),
            fees_suite: self.fees_suite(),
            tokens_burned: self.tokens_burned(),
            rewards_paid: self.rewards_paid(),
        }
    }

    pub fn set_owed(&mut self, owed: &crate::payouts::Owed) {
        self.set_retired_tokens(owed.retired_tokens);
        self.set_retired_rewardable(owed.retired_rewardable);
        self.set_rewards_owed(owed.rewards_owed);
        self.set_fees_recipient(owed.fees_recipient);
        self.set_fees_designer(owed.fees_designer);
        self.set_fees_suite(owed.fees_suite);
        self.set_tokens_burned(owed.tokens_burned);
        self.set_rewards_paid(owed.rewards_paid);
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

/// The accounts a keeper job names for one of a market's vaults, checked against the market
/// state: the vault and its mint are the market's for `side` (0 the token, 1 wrapped SOL),
/// the market is open, and the vault authority is the PDA from the stored bump. Returns the
/// bump, for the vault authority's signer seeds.
pub fn check_vault_accounts(
    state: &MarketState,
    market_state: &Pubkey,
    side: u8,
    vault: &Pubkey,
    mint: &Pubkey,
    authority: &Pubkey,
) -> Result<u8> {
    require!(state.status == STATUS_OPEN, StrategyError::MarketNotOpen);
    let (expected_vault, expected_mint) = match side {
        0 => (state.token_vault, state.token_mint),
        1 => (state.sol_vault, state.wsol_mint),
        _ => return err!(StrategyError::WrongAccount),
    };
    require_keys_eq!(*mint, expected_mint, StrategyError::WrongAccount);
    require_keys_eq!(*vault, expected_vault, StrategyError::WrongAccount);
    let expected_authority =
        vault_authority(market_state, state.authority_bump).ok_or(StrategyError::WrongAccount)?;
    require_keys_eq!(*authority, expected_authority, StrategyError::WrongAccount);
    Ok(state.authority_bump)
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

// Kani proofs of the state's accessors (INV-OS-8): every getter reads its own field
// little-endian, over a market state of arbitrary bytes; every setter writes exactly its own
// field's bytes and every projection exactly the fields of its struct. The projections are
// hand-written field lists, where a slip (`set_owed` writing the designer's fees into the
// recipient's ledger, `set_inventory` writing the price) would move value between ledgers on
// every keeper job or swap. Each expected state is built here field by field from the
// struct's own field names, apart from the setters.
//
// The setters are checked writing arbitrary values into one patterned state, each field's
// bytes set to a value of its own and none zero: a setter only stores, never reading the
// state it writes into, so where it writes and what does not depend on that state, and a
// write anywhere else (of the value, or a clearing zero) shows against the pattern. Every
// state here is built and compared field by field: through `bytemuck` casts of the 1,016
// bytes, and over arbitrary bytes, the same harnesses took CBMC 25 seconds to over 3
// minutes each (2026-11-16).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// A state of arbitrary bytes, for the getters.
    fn any_state() -> MarketState {
        MarketState {
            layout_version: kani::any(),
            status: kani::any(),
            authority_bump: kani::any(),
            token_vault_bump: kani::any(),
            sol_vault_bump: kani::any(),
            market_signer: Pubkey::new_from_array(kani::any()),
            token_mint: Pubkey::new_from_array(kani::any()),
            wsol_mint: Pubkey::new_from_array(kani::any()),
            token_vault: Pubkey::new_from_array(kani::any()),
            sol_vault: Pubkey::new_from_array(kani::any()),
            seeder: Pubkey::new_from_array(kani::any()),
            creation_slot: kani::any(),
            creation_time: kani::any(),
            seed_time: kani::any(),
            volume: kani::any(),
            fees_collected: kani::any(),
            swap_count: kani::any(),
            fee_bps: kani::any(),
            wall_split_bps: kani::any(),
            reward_share_bps: kani::any(),
            fee_recipient: Pubkey::new_from_array(kani::any()),
            rewards_recipient: Pubkey::new_from_array(kani::any()),
            cap_floor_bps: kani::any(),
            cap_decay_bps: kani::any(),
            cap_floor: kani::any(),
            cap_decay_per_day: kani::any(),
            seeded_tokens: kani::any(),
            sqrt_price: kani::any(),
            liquidity: kani::any(),
            wall_liquidity: kani::any(),
            wall_top: kani::any(),
            wall_sol_placed: kani::any(),
            pool_tokens: kani::any(),
            pool_sol: kani::any(),
            retired_tokens: kani::any(),
            rewards_owed: kani::any(),
            idle_sol: kani::any(),
            fees_recipient: kani::any(),
            fees_designer: kani::any(),
            fees_suite: kani::any(),
            cap: kani::any(),
            decay_credit: kani::any(),
            decay_time: kani::any(),
            reference: kani::any(),
            ref_time: kani::any(),
            floor: kani::any(),
            floor_time: kani::any(),
            last_slot: kani::any(),
            last_close: kani::any(),
            tokens_trimmed: kani::any(),
            sol_trimmed: kani::any(),
            wall_tokens_bought: kani::any(),
            tokens_burned: kani::any(),
            rewards_paid: kani::any(),
            tips_paid: kani::any(),
            cap_fall_unmatched: kani::any(),
            retired_rewardable: kani::any(),
            reserve: kani::any(),
        }
    }

    /// `N` bytes of `value`.
    fn filled<const N: usize>(value: u8) -> [u8; N] {
        [value; N]
    }

    /// The patterned state the setters write into: field `k` (from 0, in layout order) is
    /// all `k + 1`, the second volume `k + 101`.
    fn patterned() -> MarketState {
        MarketState {
            layout_version: 1,
            status: 2,
            authority_bump: 3,
            token_vault_bump: 4,
            sol_vault_bump: 5,
            market_signer: Pubkey::new_from_array([6; 32]),
            token_mint: Pubkey::new_from_array([7; 32]),
            wsol_mint: Pubkey::new_from_array([8; 32]),
            token_vault: Pubkey::new_from_array([9; 32]),
            sol_vault: Pubkey::new_from_array([10; 32]),
            seeder: Pubkey::new_from_array([11; 32]),
            creation_slot: filled(12),
            creation_time: filled(13),
            seed_time: filled(14),
            volume: [[15; 16], [115; 16]],
            fees_collected: filled(16),
            swap_count: filled(17),
            fee_bps: filled(18),
            wall_split_bps: filled(19),
            reward_share_bps: filled(20),
            fee_recipient: Pubkey::new_from_array([21; 32]),
            rewards_recipient: Pubkey::new_from_array([22; 32]),
            cap_floor_bps: filled(23),
            cap_decay_bps: filled(24),
            cap_floor: filled(25),
            cap_decay_per_day: filled(26),
            seeded_tokens: filled(27),
            sqrt_price: filled(28),
            liquidity: filled(29),
            wall_liquidity: filled(30),
            wall_top: filled(31),
            wall_sol_placed: filled(32),
            pool_tokens: filled(33),
            pool_sol: filled(34),
            retired_tokens: filled(35),
            rewards_owed: filled(36),
            idle_sol: filled(37),
            fees_recipient: filled(38),
            fees_designer: filled(39),
            fees_suite: filled(40),
            cap: filled(41),
            decay_credit: filled(42),
            decay_time: filled(43),
            reference: filled(44),
            ref_time: filled(45),
            floor: filled(46),
            floor_time: filled(47),
            last_slot: filled(48),
            last_close: filled(49),
            tokens_trimmed: filled(50),
            sol_trimmed: filled(51),
            wall_tokens_bought: filled(52),
            tokens_burned: filled(53),
            rewards_paid: filled(54),
            tips_paid: filled(55),
            cap_fall_unmatched: filled(56),
            retired_rewardable: filled(57),
            reserve: filled(58),
        }
    }

    /// Whether two states hold the same bytes, field by field. The pattern names every field
    /// with no `..`, so a field a later layout appends fails to compile here until it is
    /// compared too.
    fn same(a: &MarketState, b: &MarketState) -> bool {
        let MarketState {
            layout_version,
            status,
            authority_bump,
            token_vault_bump,
            sol_vault_bump,
            market_signer,
            token_mint,
            wsol_mint,
            token_vault,
            sol_vault,
            seeder,
            creation_slot,
            creation_time,
            seed_time,
            volume,
            fees_collected,
            swap_count,
            fee_bps,
            wall_split_bps,
            reward_share_bps,
            fee_recipient,
            rewards_recipient,
            cap_floor_bps,
            cap_decay_bps,
            cap_floor,
            cap_decay_per_day,
            seeded_tokens,
            sqrt_price,
            liquidity,
            wall_liquidity,
            wall_top,
            wall_sol_placed,
            pool_tokens,
            pool_sol,
            retired_tokens,
            rewards_owed,
            idle_sol,
            fees_recipient,
            fees_designer,
            fees_suite,
            cap,
            decay_credit,
            decay_time,
            reference,
            ref_time,
            floor,
            floor_time,
            last_slot,
            last_close,
            tokens_trimmed,
            sol_trimmed,
            wall_tokens_bought,
            tokens_burned,
            rewards_paid,
            tips_paid,
            cap_fall_unmatched,
            retired_rewardable,
            reserve,
        } = a;
        *layout_version == b.layout_version
            && *status == b.status
            && *authority_bump == b.authority_bump
            && *token_vault_bump == b.token_vault_bump
            && *sol_vault_bump == b.sol_vault_bump
            && *market_signer == b.market_signer
            && *token_mint == b.token_mint
            && *wsol_mint == b.wsol_mint
            && *token_vault == b.token_vault
            && *sol_vault == b.sol_vault
            && *seeder == b.seeder
            && *creation_slot == b.creation_slot
            && *creation_time == b.creation_time
            && *seed_time == b.seed_time
            && *volume == b.volume
            && *fees_collected == b.fees_collected
            && *swap_count == b.swap_count
            && *fee_bps == b.fee_bps
            && *wall_split_bps == b.wall_split_bps
            && *reward_share_bps == b.reward_share_bps
            && *fee_recipient == b.fee_recipient
            && *rewards_recipient == b.rewards_recipient
            && *cap_floor_bps == b.cap_floor_bps
            && *cap_decay_bps == b.cap_decay_bps
            && *cap_floor == b.cap_floor
            && *cap_decay_per_day == b.cap_decay_per_day
            && *seeded_tokens == b.seeded_tokens
            && *sqrt_price == b.sqrt_price
            && *liquidity == b.liquidity
            && *wall_liquidity == b.wall_liquidity
            && *wall_top == b.wall_top
            && *wall_sol_placed == b.wall_sol_placed
            && *pool_tokens == b.pool_tokens
            && *pool_sol == b.pool_sol
            && *retired_tokens == b.retired_tokens
            && *rewards_owed == b.rewards_owed
            && *idle_sol == b.idle_sol
            && *fees_recipient == b.fees_recipient
            && *fees_designer == b.fees_designer
            && *fees_suite == b.fees_suite
            && *cap == b.cap
            && *decay_credit == b.decay_credit
            && *decay_time == b.decay_time
            && *reference == b.reference
            && *ref_time == b.ref_time
            && *floor == b.floor
            && *floor_time == b.floor_time
            && *last_slot == b.last_slot
            && *last_close == b.last_close
            && *tokens_trimmed == b.tokens_trimmed
            && *sol_trimmed == b.sol_trimmed
            && *wall_tokens_bought == b.wall_tokens_bought
            && *tokens_burned == b.tokens_burned
            && *rewards_paid == b.rewards_paid
            && *tips_paid == b.tips_paid
            && *cap_fall_unmatched == b.cap_fall_unmatched
            && *retired_rewardable == b.retired_rewardable
            && *reserve == b.reserve
    }

    /// `after` is `expected`, built from the patterned state with only `fields` changed.
    macro_rules! written_exactly {
        ($after:ident, $expected:ident; $($field:ident),*) => {{
            $(assert!($after.$field == $expected.$field);)*
            assert!(same(&$after, &$expected));
        }};
    }

    /// Sets each field in turn, last field first: the sets nest, each expanding the rest of
    /// the list before its own.
    macro_rules! set_in_reverse {
        ($after:ident, $expected:ident;) => {};
        ($after:ident, $expected:ident; $field:ident, $set:ident: $ty:ty; $($rest:tt)*) => {{
            set_in_reverse!($after, $expected; $($rest)*);
            let value: $ty = kani::any();
            $after.$set(value);
            $expected.$field = value.to_le_bytes();
        }};
    }

    /// For each little-endian field: the getter decodes the field's bytes in any state, and
    /// the setter writes the value's little-endian bytes into that field and no other byte,
    /// so reading back what was written gives the value and writing back what was read
    /// changes nothing. The setters run one after another, in the list's order and then in
    /// reverse, each pass compared once with the fields assigned directly: a stray write into
    /// another field shows in the pass where that field's own setter has already run.
    /// Comparing after every setter took CBMC some 20 seconds a comparison (2026-11-16).
    macro_rules! each_field_round_trips {
        ($($field:ident, $set:ident: $ty:ty;)*) => {{
            let state = any_state();
            $(assert!(state.$field() == <$ty>::from_le_bytes(state.$field));)*
            let (mut after, mut expected) = (patterned(), patterned());
            $(
                let value: $ty = kani::any();
                after.$set(value);
                expected.$field = value.to_le_bytes();
            )*
            assert!(same(&after, &expected));
            let (mut after, mut expected) = (patterned(), patterned());
            set_in_reverse!(after, expected; $($field, $set: $ty;)*);
            assert!(same(&after, &expected));
        }};
    }

    /// Every `le_fields!` accessor pair, the identity and counter fields. Verified in 40
    /// seconds on the owner's Mac (2026-11-16).
    #[kani::proof]
    fn the_identity_and_parameter_accessors_round_trip_and_write_only_their_bytes() {
        each_field_round_trips! {
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
        }
    }

    /// The pricing and ledger accessors, the reward share's two among them. Verified in 42
    /// seconds on the owner's Mac (2026-11-16), before the reward share's two were added.
    #[kani::proof]
    fn the_pricing_and_ledger_accessors_round_trip_and_write_only_their_bytes() {
        each_field_round_trips! {
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
            cap_fall_unmatched, set_cap_fall_unmatched: u64;
            retired_rewardable, set_retired_rewardable: u64;
        }
    }

    /// The cap, guard and lifetime total accessors. Verified in 47 seconds on the owner's
    /// Mac (2026-11-16).
    #[kani::proof]
    fn the_cap_guard_and_total_accessors_round_trip_and_write_only_their_bytes() {
        each_field_round_trips! {
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
    }

    /// `volume(i)` and `set_volume(i)` work exactly for the two mints and refuse every index
    /// past them, writing nothing: each mint by its own index (a symbolic index into the
    /// volumes took CBMC over three minutes), the two set in both orders as the
    /// little-endian fields are. Verified in 41 seconds on the owner's Mac (2026-11-16).
    #[kani::proof]
    fn the_volumes_read_and_write_exactly_their_own_mint() {
        let state = any_state();
        for index in [0, 1] {
            assert!(state.volume(index) == Some(u128::from_le_bytes(state.volume[index])));
        }
        let past: usize = kani::any();
        kani::assume(past >= 2);
        assert!(state.volume(past).is_none());
        for order in [[0, 1], [1, 0]] {
            let (mut after, mut expected) = (patterned(), patterned());
            for index in order {
                let value: u128 = kani::any();
                assert!(after.set_volume(index, value).is_some());
                expected.volume[index] = value.to_le_bytes();
            }
            assert!(after.set_volume(past, kani::any()).is_none());
            assert!(same(&after, &expected));
        }
    }

    /// The counters' projection reads and writes exactly the volume, fee and swap counters.
    /// Verified in 25 seconds on the owner's Mac (2026-11-16).
    #[kani::proof]
    fn the_counters_read_and_write_exactly_their_fields() {
        let state = any_state();
        let read = state.counters().unwrap();
        assert!(read.volume[0] == u128::from_le_bytes(state.volume[0]));
        assert!(read.volume[1] == u128::from_le_bytes(state.volume[1]));
        assert!(read.fees_collected == u128::from_le_bytes(state.fees_collected));
        assert!(read.swap_count == u64::from_le_bytes(state.swap_count));
        let counters = crate::books::Counters {
            volume: [kani::any(), kani::any()],
            fees_collected: kani::any(),
            swap_count: kani::any(),
        };
        let mut after = patterned();
        assert!(after.set_counters(&counters).is_some());
        let mut expected = patterned();
        expected.volume = [
            counters.volume[0].to_le_bytes(),
            counters.volume[1].to_le_bytes(),
        ];
        expected.fees_collected = counters.fees_collected.to_le_bytes();
        expected.swap_count = counters.swap_count.to_le_bytes();
        written_exactly!(after, expected; volume, fees_collected, swap_count);
    }

    /// The swap's books read and write exactly the six ledgers a swap changes. Verified in
    /// 21 seconds on the owner's Mac (2026-11-16).
    #[kani::proof]
    fn the_books_read_and_write_exactly_their_ledgers() {
        let state = any_state();
        assert!(
            state.books()
                == crate::books::Books {
                    pool_tokens: u64::from_le_bytes(state.pool_tokens),
                    pool_sol: u64::from_le_bytes(state.pool_sol),
                    idle_sol: u64::from_le_bytes(state.idle_sol),
                    fees_recipient: u64::from_le_bytes(state.fees_recipient),
                    fees_designer: u64::from_le_bytes(state.fees_designer),
                    fees_suite: u64::from_le_bytes(state.fees_suite),
                }
        );
        let books = crate::books::Books {
            pool_tokens: kani::any(),
            pool_sol: kani::any(),
            idle_sol: kani::any(),
            fees_recipient: kani::any(),
            fees_designer: kani::any(),
            fees_suite: kani::any(),
        };
        let mut after = patterned();
        after.set_books(&books);
        let mut expected = patterned();
        expected.pool_tokens = books.pool_tokens.to_le_bytes();
        expected.pool_sol = books.pool_sol.to_le_bytes();
        expected.idle_sol = books.idle_sol.to_le_bytes();
        expected.fees_recipient = books.fees_recipient.to_le_bytes();
        expected.fees_designer = books.fees_designer.to_le_bytes();
        expected.fees_suite = books.fees_suite.to_le_bytes();
        written_exactly!(after, expected; pool_tokens, pool_sol, idle_sol, fees_recipient, fees_designer, fees_suite);
    }

    /// The cap's inventory reads its thirteen fields and writes back all of them but the
    /// price, which a trim never moves; the cap rules are read only. Verified in 27 seconds on
    /// the owner's Mac (2026-11-16), before the reward share's two fields were added.
    #[kani::proof]
    fn the_inventory_reads_and_writes_exactly_its_fields_and_never_the_price() {
        let state = any_state();
        assert!(
            state.inventory()
                == crate::cap::Inventory {
                    sqrt_price: u128::from_le_bytes(state.sqrt_price),
                    liquidity: u128::from_le_bytes(state.liquidity),
                    pool_tokens: u64::from_le_bytes(state.pool_tokens),
                    pool_sol: u64::from_le_bytes(state.pool_sol),
                    retired_tokens: u64::from_le_bytes(state.retired_tokens),
                    idle_sol: u64::from_le_bytes(state.idle_sol),
                    cap: u64::from_le_bytes(state.cap),
                    decay_credit: u128::from_le_bytes(state.decay_credit),
                    decay_time: i64::from_le_bytes(state.decay_time),
                    tokens_trimmed: u128::from_le_bytes(state.tokens_trimmed),
                    sol_trimmed: u128::from_le_bytes(state.sol_trimmed),
                    cap_fall_unmatched: u64::from_le_bytes(state.cap_fall_unmatched),
                    retired_rewardable: u64::from_le_bytes(state.retired_rewardable),
                }
        );
        assert!(
            state.cap_rules()
                == crate::cap::CapRules {
                    cap_floor: u64::from_le_bytes(state.cap_floor),
                    cap_decay_per_day: u64::from_le_bytes(state.cap_decay_per_day),
                }
        );
        let inventory = crate::cap::Inventory {
            sqrt_price: kani::any(),
            liquidity: kani::any(),
            pool_tokens: kani::any(),
            pool_sol: kani::any(),
            retired_tokens: kani::any(),
            idle_sol: kani::any(),
            cap: kani::any(),
            decay_credit: kani::any(),
            decay_time: kani::any(),
            tokens_trimmed: kani::any(),
            sol_trimmed: kani::any(),
            cap_fall_unmatched: kani::any(),
            retired_rewardable: kani::any(),
        };
        let mut after = patterned();
        after.set_inventory(&inventory);
        let mut expected = patterned();
        expected.liquidity = inventory.liquidity.to_le_bytes();
        expected.pool_tokens = inventory.pool_tokens.to_le_bytes();
        expected.pool_sol = inventory.pool_sol.to_le_bytes();
        expected.retired_tokens = inventory.retired_tokens.to_le_bytes();
        expected.idle_sol = inventory.idle_sol.to_le_bytes();
        expected.cap = inventory.cap.to_le_bytes();
        expected.decay_credit = inventory.decay_credit.to_le_bytes();
        expected.decay_time = inventory.decay_time.to_le_bytes();
        expected.tokens_trimmed = inventory.tokens_trimmed.to_le_bytes();
        expected.sol_trimmed = inventory.sol_trimmed.to_le_bytes();
        expected.cap_fall_unmatched = inventory.cap_fall_unmatched.to_le_bytes();
        expected.retired_rewardable = inventory.retired_rewardable.to_le_bytes();
        written_exactly!(after, expected; liquidity, pool_tokens, pool_sol, retired_tokens, idle_sol, cap, decay_credit, decay_time, tokens_trimmed, sol_trimmed, cap_fall_unmatched, retired_rewardable);
    }

    /// `place_wall`'s books read and write exactly their nine fields, never the price, the
    /// curve's liquidity, the floor or the fee, which it reads through `wall_at` only.
    /// Verified in 28 seconds on the owner's Mac (2026-11-16).
    #[kani::proof]
    fn the_wall_books_read_and_write_exactly_their_fields() {
        let state = any_state();
        let wall = crate::wall::Wall {
            liquidity: u128::from_le_bytes(state.wall_liquidity),
            top: u128::from_le_bytes(state.wall_top),
        };
        assert!(state.wall() == wall);
        assert!(
            state.wall_books()
                == crate::wall::WallBooks {
                    wall,
                    wall_sol_placed: u64::from_le_bytes(state.wall_sol_placed),
                    pool_tokens: u64::from_le_bytes(state.pool_tokens),
                    pool_sol: u64::from_le_bytes(state.pool_sol),
                    retired_tokens: u64::from_le_bytes(state.retired_tokens),
                    idle_sol: u64::from_le_bytes(state.idle_sol),
                    wall_tokens_bought: u128::from_le_bytes(state.wall_tokens_bought),
                    tips_paid: u128::from_le_bytes(state.tips_paid),
                }
        );
        assert!(
            state.wall_at()
                == crate::wall::At {
                    sqrt_price: u128::from_le_bytes(state.sqrt_price),
                    liquidity: u128::from_le_bytes(state.liquidity),
                    floor: u128::from_le_bytes(state.floor),
                    fee_bps: u16::from_le_bytes(state.fee_bps),
                }
        );
        let books = crate::wall::WallBooks {
            wall: crate::wall::Wall {
                liquidity: kani::any(),
                top: kani::any(),
            },
            wall_sol_placed: kani::any(),
            pool_tokens: kani::any(),
            pool_sol: kani::any(),
            retired_tokens: kani::any(),
            idle_sol: kani::any(),
            wall_tokens_bought: kani::any(),
            tips_paid: kani::any(),
        };
        let mut after = patterned();
        after.set_wall_books(&books);
        let mut expected = patterned();
        expected.wall_liquidity = books.wall.liquidity.to_le_bytes();
        expected.wall_top = books.wall.top.to_le_bytes();
        expected.wall_sol_placed = books.wall_sol_placed.to_le_bytes();
        expected.pool_tokens = books.pool_tokens.to_le_bytes();
        expected.pool_sol = books.pool_sol.to_le_bytes();
        expected.retired_tokens = books.retired_tokens.to_le_bytes();
        expected.idle_sol = books.idle_sol.to_le_bytes();
        expected.wall_tokens_bought = books.wall_tokens_bought.to_le_bytes();
        expected.tips_paid = books.tips_paid.to_le_bytes();
        written_exactly!(after, expected; wall_liquidity, wall_top, wall_sol_placed, pool_tokens, pool_sol, retired_tokens, idle_sol, wall_tokens_bought, tips_paid);
    }

    /// The payouts' ledgers read and write exactly their eight fields, each into its own
    /// ledger. Verified in 26 seconds on the owner's Mac (2026-11-16), before
    /// `retired_rewardable` was added.
    #[kani::proof]
    fn the_owed_ledgers_read_and_write_exactly_their_fields() {
        let state = any_state();
        assert!(
            state.owed()
                == crate::payouts::Owed {
                    retired_tokens: u64::from_le_bytes(state.retired_tokens),
                    retired_rewardable: u64::from_le_bytes(state.retired_rewardable),
                    rewards_owed: u64::from_le_bytes(state.rewards_owed),
                    fees_recipient: u64::from_le_bytes(state.fees_recipient),
                    fees_designer: u64::from_le_bytes(state.fees_designer),
                    fees_suite: u64::from_le_bytes(state.fees_suite),
                    tokens_burned: u128::from_le_bytes(state.tokens_burned),
                    rewards_paid: u128::from_le_bytes(state.rewards_paid),
                }
        );
        let owed = crate::payouts::Owed {
            retired_tokens: kani::any(),
            retired_rewardable: kani::any(),
            rewards_owed: kani::any(),
            fees_recipient: kani::any(),
            fees_designer: kani::any(),
            fees_suite: kani::any(),
            tokens_burned: kani::any(),
            rewards_paid: kani::any(),
        };
        let mut after = patterned();
        after.set_owed(&owed);
        let mut expected = patterned();
        expected.retired_tokens = owed.retired_tokens.to_le_bytes();
        expected.retired_rewardable = owed.retired_rewardable.to_le_bytes();
        expected.rewards_owed = owed.rewards_owed.to_le_bytes();
        expected.fees_recipient = owed.fees_recipient.to_le_bytes();
        expected.fees_designer = owed.fees_designer.to_le_bytes();
        expected.fees_suite = owed.fees_suite.to_le_bytes();
        expected.tokens_burned = owed.tokens_burned.to_le_bytes();
        expected.rewards_paid = owed.rewards_paid.to_le_bytes();
        written_exactly!(after, expected; retired_tokens, retired_rewardable, rewards_owed, fees_recipient, fees_designer, fees_suite, tokens_burned, rewards_paid);
    }

    /// The guard reads and writes exactly its six fields. Verified in 34 seconds on the
    /// owner's Mac (2026-11-16).
    #[kani::proof]
    fn the_guard_reads_and_writes_exactly_its_fields() {
        let state = any_state();
        assert!(
            state.guard()
                == crate::guard::Guard {
                    reference: u128::from_le_bytes(state.reference),
                    ref_time: i64::from_le_bytes(state.ref_time),
                    floor: u128::from_le_bytes(state.floor),
                    floor_time: i64::from_le_bytes(state.floor_time),
                    last_slot: u64::from_le_bytes(state.last_slot),
                    last_close: u128::from_le_bytes(state.last_close),
                }
        );
        let guard = crate::guard::Guard {
            reference: kani::any(),
            ref_time: kani::any(),
            floor: kani::any(),
            floor_time: kani::any(),
            last_slot: kani::any(),
            last_close: kani::any(),
        };
        let mut after = patterned();
        after.set_guard(&guard);
        let mut expected = patterned();
        expected.reference = guard.reference.to_le_bytes();
        expected.ref_time = guard.ref_time.to_le_bytes();
        expected.floor = guard.floor.to_le_bytes();
        expected.floor_time = guard.floor_time.to_le_bytes();
        expected.last_slot = guard.last_slot.to_le_bytes();
        expected.last_close = guard.last_close.to_le_bytes();
        written_exactly!(after, expected; reference, ref_time, floor, floor_time, last_slot, last_close);
    }
}
