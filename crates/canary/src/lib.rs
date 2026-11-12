//! Canary checks: trade a private copy of one Pipeline market the way a trader would, and
//! record what happened (`docs/spec/pipescope-canary.md`).
//!
//! A run copies one market and everything its trades touch into LiteSVM with
//! `pipeline-check`'s own cloner, from a [`Source`]: read-only RPC on a developer's machine,
//! or the snapshot the container is posted. The router and the strategy are the cluster's
//! own bytes. Every trade goes through one swap function behind the licence seam
//! ([`swap::SwapPath`]), with a `pipeline-quoter` quote taken just before it.
//!
//! The checks here are `readable`, `conformance`, `exit_sizes`, `quote_matches_swap` and
//! `cost`; every policy value they use is in [`config`].

pub mod bands;
pub mod checks;
pub mod config;
pub mod failure;
pub mod hooks;
pub mod http;
pub mod market;
pub mod record;
pub mod run;
pub mod sizes;
pub mod source;
pub mod swap;
pub mod trade;
pub mod trader;
pub mod wallets;
pub mod words;

pub use failure::{Failure, FailureClass, Stage};
pub use record::{rollups, Outcome, Record, Rollup, Verdict};
pub use run::{run_market, MarketResults, MarketRun, RunOptions};
pub use source::{RpcAccounts, Snapshot, SnapshotSource, Source};
