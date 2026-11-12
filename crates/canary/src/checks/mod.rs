//! The checks this binary runs, each as a measurement in the copy and a judgement over it
//! (`CANARY-15`; `docs/spec/pipescope-canary.md`, "The checks"). The judgements are pure
//! functions of the measurements, so each outcome rule is tested at its band edges.

pub mod conformance;
pub mod contained_mint;
pub mod cost;
pub mod custom_instructions;
pub mod direct_call;
pub mod exit_sizes;
pub mod quote_matches_swap;
pub mod readable;
pub mod token_authorities;
pub mod transaction_accounts;

/// Check ids, stable.
pub const READABLE: &str = "readable";
pub const CONFORMANCE: &str = "conformance";
pub const EXIT_SIZES: &str = "exit_sizes";
pub const QUOTE_MATCHES_SWAP: &str = "quote_matches_swap";
pub const COST: &str = "cost";
pub const DIRECT_CALL: &str = "direct_call";
pub const TOKEN_AUTHORITIES: &str = "token_authorities";
pub const TRANSACTION_ACCOUNTS: &str = "transaction_accounts";
pub const CONTAINED_MINT: &str = "contained_mint";
pub const CUSTOM_INSTRUCTIONS: &str = "custom_instructions";

/// Every check this binary runs, in the order of its records.
pub const CHECKS: [&str; 10] = [
    READABLE,
    CONFORMANCE,
    EXIT_SIZES,
    QUOTE_MATCHES_SWAP,
    COST,
    DIRECT_CALL,
    TOKEN_AUTHORITIES,
    TRANSACTION_ACCOUNTS,
    CONTAINED_MINT,
    CUSTOM_INSTRUCTIONS,
];
