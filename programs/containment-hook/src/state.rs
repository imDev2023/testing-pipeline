//! The hook's accounts, all PDAs of this program, one set per contained mint
//! (docs/spec/containment-hook.md, "Accounts"):
//!
//! | Account            | Seeds                           | Holds                               |
//! |--------------------|---------------------------------|-------------------------------------|
//! | Config             | `["config", mint]`              | [`Config`]: the binding, for good   |
//! | Validation account | `["extra-account-metas", mint]` | the one extra account, the config   |
//! | Unlock PDA         | `["unlock", mint]`              | nothing; the mint's hook authority  |

use anchor_lang::prelude::*;

/// The config's layout version, its byte after the discriminator.
pub const CONFIG_VERSION: u8 = 1;

pub const CONFIG_SEED: &[u8] = b"config";
/// The transfer hook interface's standard seed, which Token-2022 and every client use to
/// find a hook's extra accounts.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";
pub const UNLOCK_SEED: &[u8] = b"unlock";

/// One contained mint's binding to its home market. `bind` writes it once; no instruction
/// changes it afterwards, and it is never closed, so it stays as the record of the token's
/// containment. Only `unlocked_at` will be set, once, by the unlock.
#[account]
#[derive(InitSpace, Debug, PartialEq, Eq)]
pub struct Config {
    /// [`CONFIG_VERSION`].
    pub version: u8,
    /// The contained mint.
    pub mint: Pubkey,
    /// The home market: the router's `Market` account.
    pub market: Pubkey,
    /// The tax AMM market state the `Market` records.
    pub market_state: Pubkey,
    /// The contained token's vault in the home market, as the `Market` records it.
    pub vault: Pubkey,
    /// The home market's Pipeline fee account for the contained token.
    pub fee_account: Pubkey,
    /// The market's other mint, which its tax is taken in.
    pub quote_mint: Pubkey,
    /// The tax the home market must collect for the unlock, in quote-mint base units.
    pub unlock_goal: u64,
    /// The Unix time from which the unlock is due whatever the tax collected.
    pub unlock_deadline: i64,
    /// The Unix time of the binding.
    pub bound_at: i64,
    pub config_bump: u8,
    pub extra_account_metas_bump: u8,
    pub unlock_bump: u8,
    /// The Unix time of the unlock, or none while the token is contained.
    pub unlocked_at: Option<i64>,
}

impl Config {
    /// The account's size, discriminator included.
    pub const SPACE: usize = Config::DISCRIMINATOR.len() + Config::INIT_SPACE;
}

/// The transfer hook interface's `Execute` discriminator,
/// `sha256("spl-transfer-hook-interface:execute")[..8]`.
pub const EXECUTE_DISCRIMINATOR: [u8; 8] = [105, 37, 101, 197, 75, 251, 102, 26];

/// The validation account's whole data, as `test-hook` writes its own: one type-length-value
/// entry for `Execute` holding a list of one extra account, the config, a PDA of this
/// program from the seeds `["config", <the mint, Execute's account 1>]`, read-only.
pub const VALIDATION_DATA: [u8; VALIDATION_LEN] = validation_data();
pub const VALIDATION_LEN: usize = 8 + 4 + 4 + EXTRA_ACCOUNT_META_LEN;

/// An `ExtraAccountMeta`: its kind, 32 bytes of address configuration, signer, writable.
const EXTRA_ACCOUNT_META_LEN: usize = 35;
/// The kind of an extra account that is a PDA of the hook program itself.
const PDA_OF_HOOK_PROGRAM: u8 = 1;
/// Seed kinds in an address configuration: a literal, then an account's key by index.
const SEED_LITERAL: u8 = 1;
const SEED_ACCOUNT_KEY: u8 = 3;
/// `Execute`'s account order: source, mint, destination, owner, validation account.
const EXECUTE_MINT_INDEX: u8 = 1;

const fn validation_data() -> [u8; VALIDATION_LEN] {
    let mut data = [0u8; VALIDATION_LEN];
    let mut at = 0;
    // The entry's type, then the length of its value.
    while at < 8 {
        data[at] = EXECUTE_DISCRIMINATOR[at];
        at += 1;
    }
    let value_len = (4 + EXTRA_ACCOUNT_META_LEN as u32).to_le_bytes();
    let count = 1u32.to_le_bytes();
    let mut i = 0;
    while i < 4 {
        data[8 + i] = value_len[i];
        data[12 + i] = count[i];
        i += 1;
    }
    // The one extra account: the config.
    at = 16;
    data[at] = PDA_OF_HOOK_PROGRAM;
    at += 1;
    data[at] = SEED_LITERAL;
    data[at + 1] = CONFIG_SEED.len() as u8;
    at += 2;
    let mut j = 0;
    while j < CONFIG_SEED.len() {
        data[at + j] = CONFIG_SEED[j];
        j += 1;
    }
    at += CONFIG_SEED.len();
    data[at] = SEED_ACCOUNT_KEY;
    data[at + 1] = EXECUTE_MINT_INDEX;
    // The rest of the 32 bytes stays zero; then not a signer, not writable.
    data[16 + 1 + 32] = 0;
    data[16 + 1 + 32 + 1] = 0;
    data
}
