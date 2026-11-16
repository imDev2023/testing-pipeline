//! A quote that differs from the baseline build's on the same state refuses the build,
//! unless the release declares a pricing change from that baseline build
//! (docs/spec/pool4-for-solana.md, "A release gate").

use buy_wall_gate::release::{PricingChange, Release};
use buy_wall_gate::snapshot::{QuoteOutcome, Snapshot};
use buy_wall_gate::{check, programs, synthetic};

/// The synthetic snapshot as if the baseline build had quoted one more for its first buy, so
/// the current build's quote differs from the baseline's there.
fn snapshot_with_a_different_quote() -> (Snapshot, String, u64) {
    let mut snapshot =
        synthetic::build(&programs::current_build(), &programs::pinned_router()).unwrap();
    let quote = &mut snapshot.baseline.quotes[0];
    let QuoteOutcome::AmountOut(out) = quote.result else {
        panic!("the first quote is refused: {quote:?}");
    };
    quote.result = QuoteOutcome::AmountOut(out + 1);
    let market_state = quote.market_state.clone();
    let amount = quote.amount;
    (snapshot, market_state, amount)
}

fn declaring(from: &str) -> Release {
    Release {
        pricing_change: Some(PricingChange {
            from: vec![from.to_string()],
            why: "a test".into(),
        }),
    }
}

#[test]
fn a_changed_quote_refuses_the_build_and_names_the_market_and_the_step() {
    let (snapshot, market_state, amount) = snapshot_with_a_different_quote();
    let build = programs::current_build();
    let report = check::run(
        &snapshot,
        &build,
        Some(&programs::pinned_router()),
        &Release::default(),
    );
    assert!(!report.passed(), "{report}");
    let failures = report.failures();
    assert_eq!(failures.len(), 1, "{report}");
    assert_eq!(failures[0].market_state, market_state);
    assert_eq!(failures[0].step, format!("quote (buy {amount})"));
    assert!(report.to_string().contains("REFUSED"), "{report}");
}

#[test]
fn a_release_declaring_a_pricing_change_from_the_baseline_build_lets_its_quotes_differ() {
    let (snapshot, _, _) = snapshot_with_a_different_quote();
    let baseline = snapshot.baseline.executable_sha256.clone().unwrap();
    let report = check::run(
        &snapshot,
        &programs::current_build(),
        Some(&programs::pinned_router()),
        &declaring(&baseline),
    );
    assert!(report.passed(), "{report}");
    assert!(report
        .to_string()
        .contains("a pricing change the release declares"));
}

#[test]
fn a_pricing_change_declared_from_another_build_does_not_cover_this_one() {
    let (snapshot, _, _) = snapshot_with_a_different_quote();
    let report = check::run(
        &snapshot,
        &programs::current_build(),
        Some(&programs::pinned_router()),
        &declaring(&"0".repeat(64)),
    );
    assert!(!report.passed(), "{report}");
}

#[test]
fn the_committed_release_declares_no_pricing_change() {
    let release = Release::read(&programs::release_path()).unwrap();
    assert_eq!(release, Release::default());
}
