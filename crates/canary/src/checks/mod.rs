//! The checks this binary runs, each as a measurement in the copy and a judgement over it
//! (`CANARY-15`; `docs/spec/pipescope-canary.md`, "The checks"). The judgements are pure
//! functions of the measurements, so each outcome rule is tested at its band edges.

pub mod conformance;
pub mod cost;
pub mod exit_sizes;
pub mod quote_matches_swap;
pub mod readable;

/// Check ids, stable.
pub const READABLE: &str = "readable";
pub const CONFORMANCE: &str = "conformance";
pub const EXIT_SIZES: &str = "exit_sizes";
pub const QUOTE_MATCHES_SWAP: &str = "quote_matches_swap";
pub const COST: &str = "cost";

/// Every check this binary runs, in the order of its records.
pub const CHECKS: [&str; 5] = [READABLE, CONFORMANCE, EXIT_SIZES, QUOTE_MATCHES_SWAP, COST];
