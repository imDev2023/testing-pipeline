//! The buy wall AMM's build-time values, in one place, so each is cheap to find and change.
//!
//! These are the constants of docs/spec/pool4-for-solana.md, "Constants", and nothing else
//! in the program repeats their values. Each is compiled into the program: changing one is
//! a program upgrade, which ends when the program is frozen. Values a market's creator
//! chooses are creation parameters instead (`params.rs`), never constants.
//!
//! Like every decision in the spec, these are defaults MetalLegBob may change
//! (`POOL4-02` to `POOL4-17` in docs/decisions.md).

use anchor_lang::prelude::*;

/// The lowest fee a market may choose, in basis points of each swap (0.25%).
pub const MIN_FEE_BPS: u16 = 25;
/// The highest fee a market may choose, in basis points of each swap (3%).
pub const MAX_FEE_BPS: u16 = 300;
/// The designer share, owed to IMD and Adam, in basis points of the fee (10%).
/// Published in the IDL (`#[constant]`), where the demo script reads it (`POOL4-25`).
#[constant]
pub const DESIGNER_SHARE_BPS: u16 = 1_000;
/// The suite share, in basis points of the fee (10%).
/// Published in the IDL (`#[constant]`), where the demo script reads it (`POOL4-25`).
#[constant]
pub const SUITE_SHARE_BPS: u16 = 1_000;
/// The wallet the designer share is paid to. Unset (the all-zero key) while IMD and Adam
/// have no known Solana address; an upgrade sets it before the program is frozen.
pub const DESIGNER_RECIPIENT: Pubkey = Pubkey::new_from_array([0; 32]);
/// The suite treasury, the same wallet the tax AMM pays its suite share to; its key is in
/// `~/.config/testing-pipeline/devnet/suite-treasury.json` and docs/toolchain.md ("Keys").
pub const SUITE_TREASURY: Pubkey = pubkey!("CbqE9TtDJf67xFnXybBrzV6Tg4Mw71hX2VhWcm4R9VZF");
/// The highest reward share a market may choose, in basis points of the trimmed tokens.
pub const MAX_REWARD_SHARE_BPS: u16 = 3_000;
/// The lowest cap floor a market may choose, in basis points of the seeded tokens (0.1%).
pub const MIN_CAP_FLOOR_BPS: u16 = 10;
/// The highest cap decay a market may choose, in basis points of the seeded tokens a day.
pub const MAX_CAP_DECAY_BPS: u16 = 10_000;
/// Idle SOL, or SOL the wall has spent, that lets the wall be placed again (0.01 SOL).
/// Published in the IDL (`#[constant]`), where the demo script reads it, as are the tip cap
/// and the guard's rates below (`POOL4-35`).
#[constant]
pub const WALL_THRESHOLD: u64 = 10_000_000;
/// The most a wall placement tips its caller (0.002 SOL).
#[constant]
pub const KEEPER_TIP_CAP: u64 = 2_000_000;
/// How fast the wall's floor may rise, in basis points of the price a day.
#[constant]
pub const FLOOR_CRAWL_BPS: u64 = 400;
/// How fast the reference may follow the price: `REF_STEP_BPS` of the price per
/// `REF_STEP_WINDOW` seconds.
#[constant]
pub const REF_STEP_BPS: u64 = 200;
/// See `REF_STEP_BPS`, in seconds.
#[constant]
pub const REF_STEP_WINDOW: i64 = 12;
/// The most cap decay allowance that builds up while a market is idle, in seconds.
/// Published in the IDL (`#[constant]`), where the demo script reads it (`POOL4-30`).
#[constant]
pub const DECAY_CREDIT_WINDOW: i64 = 86_400;
/// The lowest square-root price (Q64.64) a trade may reach: 2^32.
pub const MIN_SQRT_PRICE: u128 = 1 << 32;
/// The highest square-root price (Q64.64) a trade may reach: 2^96.
pub const MAX_SQRT_PRICE: u128 = 1 << 96;
/// The least SOL a seed may bring, in lamports (0.1 SOL).
pub const MIN_SEED_LAMPORTS: u64 = 100_000_000;
/// The lowest square-root price (Q64.64) a market may open at: 2^40.
pub const MIN_OPENING_SQRT_PRICE: u128 = 1 << 40;
/// The highest square-root price (Q64.64) a market may open at: 2^88.
pub const MAX_OPENING_SQRT_PRICE: u128 = 1 << 88;
/// The least liquidity the curve may ever hold.
/// Published in the IDL (`#[constant]`), where the demo script reads it (`POOL4-30`).
#[constant]
pub const MIN_LIQUIDITY: u128 = 1_000_000;
/// The size of every market state, in bytes, for good (docs/spec/pool4-for-solana.md,
/// "Market state").
pub const MARKET_STATE_SIZE: usize = 1_024;

// The `security.txt` every program of ours embeds (docs/spec/README.md, "Verified builds").
// `name` is the program's public name, Aviary Buy Wall AMM, which lives only here and in
// `metadata.json` (docs/spec/README.md, "Names"). The contact is this repo's private
// vulnerability reporting page, never a personal address. Internal reviews are never
// presented as audits, so `auditors` stays "None".
//
// The macro joins its values with `concat!`, so they must be string literals.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Aviary Buy Wall AMM",
    project_url: "https://github.com/imDev2023/testing-pipeline",
    contacts: "link:https://github.com/imDev2023/testing-pipeline/security/advisories/new",
    policy: "https://github.com/imDev2023/testing-pipeline/security/policy",
    preferred_languages: "en",
    source_code: "https://github.com/imDev2023/testing-pipeline",
    auditors: "None"
}
