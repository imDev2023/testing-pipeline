//! The lending AMM's release gate (GLOSSARY.md, "Release gate"; docs/spec/lending-pool.md, "A
//! release gate"): no upgrade may strand a market.
//!
//! Before any upgrade, the gate downloads every market state of the program from the cluster,
//! with everything its trades touch and Kamino Lend's program and accounts for every lent mint
//! of the build ([`download`]), and replays it with the deployed build to record what that build
//! does there. It then loads it into LiteSVM with the candidate build, the router and klend
//! copied from that cluster ([`world`]), and on every market runs account resolution both ways,
//! quotes compared with the deployed build's on the same state, `pipeline_market_info`,
//! `rebalance` when it is due or the deployed build ran it, a buy and a sell through the router
//! and a sale beyond the buffer that redeems from Kamino inside the swap ([`check`]). In a world
//! of its own it then makes a market with the candidate through the router and checks it the
//! same way ([`own`]), so a cluster with no market still exercises the candidate. It refuses
//! the build if a step fails on any market that the deployed build passed (or failed with
//! another error, or in another program), if any step on its own market fails, if any layout
//! check fails, or if a quote differs without the release declaring a pricing change
//! ([`release`]). A passing run against a cluster is recorded ([`record`]), and the deploy
//! script accepts only a build with a passing record against the cluster it deploys to
//! (`programs/lending-amm/scripts/pre-deploy.sh`).
//!
//! It is the buy wall AMM's gate (`programs/buy-wall-amm/gate`, docs/spec/pool4-for-solana.md,
//! "A release gate") made for the lending AMM, sharing its cluster reads, records, release
//! declaration and error reading through `programs/release-gate`.

#![cfg(not(kani))]

pub mod check;
pub mod cli;
pub mod download;
pub mod kamino;
pub mod own;
pub mod programs;
pub mod session;
pub mod snapshot;
pub mod world;

pub use release_gate::{errors, record, release, source};
