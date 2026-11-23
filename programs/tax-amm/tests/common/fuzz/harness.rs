//! The invariant fuzzer's harness and the tax AMM's product on it, compiled only into the
//! test binaries that fuzz rather than into every one through `common` (hardening finding
//! T07, #67).
//!
//! A fuzz test declares this module beside its `common` module, for the tax AMM's
//! `tests/fuzz.rs`:
//!
//! ```ignore
//! mod common;
//! #[path = "common/fuzz/harness.rs"]
//! mod harness;
//! ```
//!
//! The harness's modules reach the shared test support as `super::super`, which this
//! module re-exports.

#![allow(dead_code)]

pub use super::common::*;

#[path = "mod.rs"]
pub mod fuzz;
