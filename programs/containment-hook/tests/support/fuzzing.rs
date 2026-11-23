//! The hook's fuzz product (`fuzz.rs`) and the tax AMM's harness it runs on, compiled only
//! into `tests/fuzz.rs` rather than into every test binary through `support` (the tax AMM's
//! hardening finding T07, #67). Both reach the test support through this module, which
//! re-exports it.

#![allow(dead_code)]

pub use super::support::*;

#[path = "../../../tax-amm/tests/common/fuzz/harness.rs"]
pub mod harness;

#[path = "fuzz.rs"]
pub mod fuzz;
