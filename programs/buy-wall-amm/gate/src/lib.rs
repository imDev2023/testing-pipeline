//! The buy wall AMM's release gate (docs/spec/pool4-for-solana.md, "A release gate" and
//! "Fixtures in CI"): no upgrade may strand a market.
//!
//! Before any upgrade, the gate downloads every market state of the program from the
//! cluster, with everything its trades and keeper jobs touch ([`download`]), loads it into
//! LiteSVM with the candidate build and the router copied from that cluster ([`world`]), and
//! on every market runs account resolution, quotes compared with the deployed build's on the
//! same state, each keeper job that is due, a buy and a sell through the router
//! ([`check`]). It refuses the build if any step fails on any market, or if a quote differs
//! without the release declaring a pricing change ([`release`]). A passing run against a
//! cluster is recorded ([`record`]), and the deploy script accepts only a build with a
//! passing record against the cluster it deploys to.
//!
//! The repo keeps a snapshot of every layout version as a fixture, and CI runs the same
//! checks on each against the current build and against test builds that would strand a
//! market ([`stranding`]).

#![cfg(not(kani))]

pub mod check;
pub mod cli;
pub mod download;
pub mod keeper;
pub mod programs;
pub mod quotes;
pub mod record;
pub mod release;
pub mod session;
pub mod snapshot;
pub mod source;
pub mod stranding;
pub mod synthetic;
pub mod world;
