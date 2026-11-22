//! A cluster with no market must not pass a broken build (the buy wall AMM's `POOL4-53`, made
//! for the lending AMM): besides replaying every market the cluster has, every gate run makes a
//! market of its own with the candidate, through the router, lends its surplus to Kamino,
//! trades it and sells beyond its buffer, and refuses the candidate if any step fails.
//!
//! Needs the broken builds (`python3 programs/lending-amm/scripts/broken-builds.py`).

mod common;

use lending_gate::programs;
use lending_gate::snapshot::StepKind;
use pipeline_client::Pubkey;

#[test]
fn an_empty_cluster_passes_the_current_build_by_trading_a_market_of_its_own() {
    let build = programs::current_build();
    let bare = common::bare(&build, programs::program_id());
    let program = programs::program_id();
    let bare = lending_gate::session::Session::new(bare, program);
    for session in [bare, common::registered(&build)] {
        let snapshot = common::snapshot(session, &[]);
        assert!(snapshot.markets.is_empty());
        let report = common::run(&snapshot, &build);
        assert!(report.passed(), "{report}");
        let own = report.own_market.as_ref().expect("a market of its own");
        let mut expected = vec!["make a market of its own".to_string()];
        expected.extend(vec!["pipeline_resolve_accounts".to_string(); 2]);
        expected.extend(vec!["quote".to_string(); 6]);
        expected.push("pipeline_market_info".into());
        expected.extend(["buy", "sell", "sell beyond the buffer"].map(String::from));
        assert_eq!(common::step_names(own), expected, "{report}");
        // The sale beyond the buffer really traded, redeeming from Kamino.
        let beyond = own.steps.last().unwrap();
        assert!(beyond.detail.starts_with("received "), "{report}");
    }
}

#[test]
fn an_empty_cluster_refuses_a_build_that_cannot_sell_beyond_the_buffer() {
    let snapshot = common::snapshot(common::registered(&programs::current_build()), &[]);
    let report = common::run(
        &snapshot,
        &programs::broken_build("no-sale-beyond-the-buffer"),
    );
    assert!(!report.passed(), "{report}");
    let failures = report.failures();
    let own = report.own_market.as_ref().unwrap();
    assert!(
        failures.iter().all(|f| f.market_state == own.market_state),
        "{report}"
    );
    let beyond = own
        .steps
        .iter()
        .find(|s| s.kind == StepKind::SellBeyondBuffer)
        .unwrap();
    assert!(!beyond.passed, "{report}");
    assert!(beyond.deployed_fails_too.is_none());
}

#[test]
fn an_empty_cluster_refuses_a_build_declared_for_another_address() {
    // The current build, which declares the real address, deployed at another: it refuses every
    // instruction there with Anchor's DeclaredProgramIdMismatch, as a build declared for another
    // address would at the real one.
    let elsewhere = Pubkey::new_from_array([0x4c; 32]);
    let build = programs::current_build();
    let session = lending_gate::session::Session::new(common::bare(&build, elsewhere), elsewhere);
    let snapshot = common::snapshot(session, &[]);
    let report = common::run(&snapshot, &build);
    assert!(!report.passed(), "{report}");
    let failures = report.failures();
    assert_eq!(failures.len(), 1, "{report}");
    assert_eq!(failures[0].step, "make a market of its own", "{report}");
    assert!(failures[0].detail.contains("4100"), "{report}");
}

#[test]
fn an_empty_cluster_refuses_a_build_whose_rebalance_lends_nothing() {
    // Its rebalance succeeds but deposits nothing, so its own market never holds cTokens and a
    // sale beyond the buffer has nothing to redeem: the market must still be shown lending.
    let snapshot = common::snapshot(common::registered(&programs::current_build()), &[]);
    let report = common::run(
        &snapshot,
        &programs::broken_build("rebalance-lends-nothing"),
    );
    assert!(!report.passed(), "{report}");
    let own = report.own_market.as_ref().unwrap();
    let make = own.steps.first().unwrap();
    assert_eq!(make.name, "make a market of its own", "{report}");
    assert!(!make.passed, "{report}");
    assert!(make.detail.contains("lent nothing"), "{report}");
}
