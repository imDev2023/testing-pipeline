//! The checks this binary runs, each as a measurement in the copy and a judgement over it
//! (`CANARY-15`; `docs/spec/pipescope-canary.md`, "The checks"). The judgements are pure
//! functions of the measurements, so each outcome rule is tested at its band edges.

pub mod conformance;
pub mod cost;
pub mod exit_hold;
pub mod exit_late;
pub mod exit_launch_clock;
pub mod exit_queue;
pub mod exit_sizes;
pub mod exit_transferred;
pub mod exit_wallets;
pub mod exits;
pub mod quote_matches_swap;
pub mod readable;
pub mod timed;

/// Check ids, stable.
pub const READABLE: &str = "readable";
pub const CONFORMANCE: &str = "conformance";
pub const EXIT_SIZES: &str = "exit_sizes";
pub const EXIT_HOLD: &str = "exit_hold";
pub const EXIT_LATE: &str = "exit_late";
pub const EXIT_LAUNCH_CLOCK: &str = "exit_launch_clock";
pub const EXIT_WALLETS: &str = "exit_wallets";
pub const EXIT_TRANSFERRED: &str = "exit_transferred";
pub const EXIT_QUEUE: &str = "exit_queue";
pub const QUOTE_MATCHES_SWAP: &str = "quote_matches_swap";
pub const COST: &str = "cost";

/// Every check this binary runs, in the order of its records.
pub const CHECKS: [&str; 11] = [
    READABLE,
    CONFORMANCE,
    EXIT_SIZES,
    EXIT_HOLD,
    EXIT_LATE,
    EXIT_LAUNCH_CLOCK,
    EXIT_WALLETS,
    EXIT_TRANSFERRED,
    EXIT_QUEUE,
    QUOTE_MATCHES_SWAP,
    COST,
];
