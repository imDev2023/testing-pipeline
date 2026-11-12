//! Conformance (docs/spec/README.md, "Test layers" 4): Pipeline's `check_market` reports zero
//! Fail and zero Warn on a contained token's home market, resolving the hook accounts from
//! the validation account itself, with `exact_out_refund` skipped because the tax AMM refuses
//! exact-out by design.

mod support;

use pipeline_check::{check_market, CheckOptions, Status};
use support::*;

#[test]
fn a_home_market_passes_every_check() {
    let mut env = hook_env();
    let launched = launch(&mut env);
    let report = check_market(&env.svm, launched.market.market, &CheckOptions::default());
    println!("{}", report.to_text());
    let worse: Vec<String> = report
        .checks
        .iter()
        .filter(|check| matches!(check.status, Status::Fail | Status::Warn))
        .map(|check| format!("{} ({:?}): {}", check.id, check.status, check.message))
        .collect();
    assert!(worse.is_empty(), "{worse:#?}");
    assert_eq!(report.status("exact_out_refund"), Some(Status::Skip));
    for check in report.checks.iter().filter(|c| c.id != "exact_out_refund") {
        assert_eq!(
            check.status,
            Status::Pass,
            "{}: {}",
            check.id,
            check.message
        );
    }
}
