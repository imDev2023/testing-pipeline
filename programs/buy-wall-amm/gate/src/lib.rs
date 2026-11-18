//! The buy wall AMM's release gate (docs/spec/pool4-for-solana.md, "A release gate" and
//! "Fixtures in CI"): no upgrade may strand a market.
//!
//! Before any upgrade, the gate downloads every market state of the program from the
//! cluster, with everything its trades and keeper jobs touch ([`download`]), and replays it
//! with the deployed build to record what that build does there. It then loads it into
//! LiteSVM with the candidate build and the router copied from that cluster ([`world`]), and
//! on every market (registering one the router never recorded, as anyone could) runs account
//! resolution, quotes compared with the deployed build's on the same state,
//! `pipeline_market_info`, each keeper job that is due or that the deployed build ran, a buy
//! and a sell through the router ([`check`]). In a world of its own it then makes a market
//! with the candidate through the router, trades it and checks it the same way
//! (`POOL4-53`), so a cluster with no market still exercises the candidate. It refuses the
//! build if a step fails on any market that the deployed build passed, or failed with
//! another error or elsewhere than the candidate does, if any step on its own market fails, if any layout check fails,
//! or if a quote differs without the release declaring a pricing change ([`release`]). A passing run against a cluster is recorded ([`record`]), and the
//! deploy script accepts only a build with a passing record against the cluster it deploys
//! to.
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
