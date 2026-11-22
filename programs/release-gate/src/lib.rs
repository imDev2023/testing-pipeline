//! What the release gates of our strategies share (GLOSSARY.md, "Release gate"): each
//! strategy's gate replays every live market of its program against a candidate build before
//! an upgrade, and these are the parts that do not depend on the strategy.
//!
//! - [`source`]: reading a cluster over read-only JSON-RPC, through `curl`, and recording every
//!   account served, which is what a snapshot saves.
//! - [`record`]: the records of passing runs against a cluster, which a program's pre-deploy
//!   check asks before `scripts/deploy-devnet.sh` deploys.
//! - [`release`]: the release declaration committed with each release, naming the builds
//!   whose quotes it changes.
//! - [`errors`]: reading a failed step's error: where it started and what tells it apart.
//!
//! The buy wall AMM's gate (`programs/buy-wall-amm/gate`, docs/spec/pool4-for-solana.md, "A
//! release gate") and the lending AMM's (`programs/lending-amm/gate`,
//! docs/spec/lending-pool.md, "A release gate") build on it.

#![cfg(not(kani))]

pub mod errors;
pub mod record;
pub mod release;
pub mod source;
