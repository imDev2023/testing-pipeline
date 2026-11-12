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

/// The highest buy or sell tax any tax market may ever charge, in basis points: 10%, so no
/// tax market can be a honeypot through its tax. Published in the IDL (`#[constant]`).
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

/// Tax recipients per market.
pub const MAX_RECIPIENTS: usize = 4;

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
