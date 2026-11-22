//! The tax AMM's build-time values, in one place, so each is cheap to find and change.
//!
//! Every value here is compiled into the program: changing one is a program upgrade,
//! which ends when the program is frozen (docs/spec/tax-amm.md, "Constants"). Values a
//! market creator chooses are creation parameters instead, never constants
//! (`crate::params::InitParams`), and the mint extension allowlist lives in the
//! `mint-rules` crate, which the suite's other programs share.
//!
//! Like every decision in the spec, these are defaults MetalLegBob may change.

use anchor_lang::prelude::*;

/// The highest buy or sell tax any tax market may ever charge, in basis points: 10%, so the
/// tax alone can never stop a holder selling. It says nothing of the mints, whose own
/// authorities and transfer hooks the mint rules govern. Published in the IDL
/// (`#[constant]`).
#[constant]
pub const MAX_TAX_BPS: u16 = 1_000;

/// The suite share, in basis points of every tax, taken before the creator's split: 10%.
/// Published in the IDL (`#[constant]`), where the demo script reads it.
#[constant]
pub const SUITE_SHARE_BPS: u16 = 1_000;

/// The wallet the suite share is paid to. On devnet its key is
/// `~/.config/testing-pipeline/devnet/suite-treasury.json` (docs/toolchain.md, "Keys").
/// Published in the IDL (`#[constant]`), where the demo script and Aviary read the suite
/// share slot's wallet for `distribute`.
#[constant]
pub const SUITE_TREASURY: Pubkey = pubkey!("CbqE9TtDJf67xFnXybBrzV6Tg4Mw71hX2VhWcm4R9VZF");

/// The containment hook, `programs/containment-hook`: the one transfer hook program a
/// market's mint may name, and only with that mint's unlock PDA (`["unlock", mint]` under
/// it, [`CONTAINMENT_UNLOCK_SEED`]) as its hook authority, which only ever clears the hook
/// (docs/spec/tax-amm.md, "Mint rules"; hardening finding H007, #67). Every other hook
/// program could refuse sells while buys still land. The containment hook depends on this
/// crate, so its id is written here, and its tests pin it to its `declare_id!`.
pub const CONTAINMENT_HOOK_ID: Pubkey = pubkey!("aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv");

/// The seed of a mint's unlock PDA under [`CONTAINMENT_HOOK_ID`], the containment hook's
/// `UNLOCK_SEED`.
pub const CONTAINMENT_UNLOCK_SEED: &[u8] = b"unlock";

/// The quote mints, which may keep a mint or a freeze authority when a market is seeded:
/// both native SOL mints, whose authorities are none anyway, and the cluster's USDC, Circle's
/// devnet mint (a mainnet build names mainnet's, `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
/// Every other mint must have neither when its market is seeded, so nobody can mint into the
/// curve or freeze a vault (docs/spec/tax-amm.md, "Mint rules"; hardening findings H008 and
/// H016, #67).
pub const QUOTE_MINTS: [Pubkey; 3] = [
    crate::params::NATIVE_MINTS[0],
    crate::params::NATIVE_MINTS[1],
    pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
];

/// Tax recipients per market.
pub const MAX_RECIPIENTS: usize = 4;

// Each value's safe range, at compile time, so no build can carry one outside it
// (hardening finding H047, #67): a tax rate of 10,000 basis points or more would leave a
// buy nothing, a suite share above 10,000 would underflow the creator's part of every tax,
// and the tax slots (the recipients, then the burn and the suite share) are numbered in a
// `u8`.
const _: () = assert!(MAX_TAX_BPS < 10_000);
const _: () = assert!(SUITE_SHARE_BPS <= 10_000);
const _: () = assert!(MAX_RECIPIENTS >= 1 && MAX_RECIPIENTS + 2 <= u8::MAX as usize);

// The `security.txt` every program of ours embeds (docs/spec/README.md, "Verified builds").
// `name` is the program's public name, which lives only here and in `metadata.json`
// (docs/spec/README.md, "Names"). The contact is this repo's private vulnerability
// reporting page, never a personal address. Internal reviews are never presented as
// audits, so `auditors` stays "None".
//
// The macro joins its values with `concat!`, so they must be string literals.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Aviary Tax AMM",
    project_url: "https://github.com/imDev2023/testing-pipeline",
    contacts: "link:https://github.com/imDev2023/testing-pipeline/security/advisories/new",
    policy: "https://github.com/imDev2023/testing-pipeline/security/policy",
    preferred_languages: "en",
    source_code: "https://github.com/imDev2023/testing-pipeline",
    auditors: "None"
}
