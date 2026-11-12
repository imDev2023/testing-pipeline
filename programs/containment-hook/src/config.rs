//! The containment hook's build-time values, in one place, so each is cheap to find and
//! change (docs/spec/containment-hook.md, "Where its policy values live").
//!
//! Both are compiled into the program because holders rely on them: changing one is a
//! program upgrade, possible until the hook is frozen and never after. What a launcher
//! chooses per token, the unlock goal and the unlock deadline, are `bind`'s arguments with
//! no default anywhere, and the mint extension allowlist is the shared `mint-rules` crate's.
//!
//! Like every decision in the spec, these are defaults MetalLegBob may change.

use anchor_lang::prelude::*;

/// The latest unlock deadline a launcher may set, in seconds after the binding: 90 days,
/// which caps how long holders can be stuck if the home market stops working.
/// Published in the IDL, so clients such as the launch script check it without repeating it.
#[constant]
pub const MAX_UNLOCK_DEADLINE_SECS: i64 = 90 * 24 * 60 * 60;

/// The only strategy a home market may run on: the tax AMM, taken from its own crate so its
/// address is written once in the whole workspace.
pub const TAX_AMM_PROGRAM_ID: Pubkey = tax_amm::ID;

// The `security.txt` every program of ours embeds (docs/spec/README.md, "Verified builds").
// `name` is the program's public name, which lives only here, since the hook is not a
// strategy and has no metadata (docs/spec/README.md, "Names"). The contact is this repo's
// private vulnerability reporting page, never a personal address. Internal reviews are
// never presented as audits, so `auditors` stays "None".
//
// The macro joins its values with `concat!`, so they must be string literals.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Aviary Containment Hook",
    project_url: "https://github.com/imDev2023/testing-pipeline",
    contacts: "link:https://github.com/imDev2023/testing-pipeline/security/advisories/new",
    policy: "https://github.com/imDev2023/testing-pipeline/security/policy",
    preferred_languages: "en",
    source_code: "https://github.com/imDev2023/testing-pipeline",
    auditors: "None"
}
