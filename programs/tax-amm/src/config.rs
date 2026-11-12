//! The tax AMM's build-time values, in one place, so each is cheap to find and change.
//!
//! Every value here is compiled into the program: changing one is a program upgrade,
//! which ends when the program is frozen (docs/spec/tax-amm.md, "Constants"). Values a
//! market creator chooses are creation parameters instead, never constants.
//!
//! Like every decision in the spec, these are defaults MetalLegBob may change.

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
