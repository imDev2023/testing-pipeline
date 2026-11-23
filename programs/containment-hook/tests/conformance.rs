//! Conformance (docs/spec/README.md, "Test layers" 4): Pipeline's `check_market` reports zero
//! Fail and zero Warn on a contained token's home market, resolving the hook accounts from
//! the validation account itself, with `exact_out_refund` skipped because the tax AMM refuses
//! exact-out by design.
//!
//! But for two checks, known to fail on every contained market until Pipeline's checker writes
//! the immutable owner extension into the associated token accounts it fakes for its traders
//! (`HOOK-47`): the hook lets a contained token go only into an account whose owner can never
//! change, and every real Token-2022 associated token account carries that extension, so on
//! chain a buy into one passes; the checker's own accounts lack it, so its buys are refused.
//! Those two must fail for exactly that reason, and every other check must pass.

mod support;

use containment_hook::HookError;
use pipeline_check::{check_market, CheckOptions, Status};
use support::*;

/// The checks whose buys go into the checker's own trader accounts, which lack the immutable
/// owner extension a real associated token account has.
const KNOWN_FAILURES: [&str; 2] = ["quote_matches_swap", "round_trip"];

#[test]
fn a_home_market_passes_every_check_but_the_two_the_checkers_own_accounts_fail() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let report = check_market(&env.svm, launched.market.market, &CheckOptions::default());
    println!("{}", report.to_text());
    // The refusal the shared helper looks for is this hook's error.
    assert_eq!(
        HOOK_REFUSAL,
        format!(
            "Custom({})",
            anchor_lang::error::ERROR_CODE_OFFSET + HookError::DestinationOwnerCanChange as u32
        )
    );
    for id in KNOWN_FAILURES {
        let check = report
            .checks
            .iter()
            .find(|check| check.id == id)
            .unwrap_or_else(|| panic!("{id} is not in the report"));
        assert!(
            matches!(check.status, Status::Fail | Status::Warn),
            "{id} passed: Pipeline's checker may now write the immutable owner extension, so \
             HOOK-47's known failures can go"
        );
        if let Err(reason) = known_failure_is_the_hooks(check) {
            panic!("{reason}");
        }
    }
    assert_eq!(report.status("exact_out_refund"), Some(Status::Skip));
    for check in report
        .checks
        .iter()
        .filter(|c| c.id != "exact_out_refund" && !KNOWN_FAILURES.contains(&c.id.as_str()))
    {
        assert_eq!(
            check.status,
            Status::Pass,
            "{}: {}",
            check.id,
            check.message
        );
    }
}
