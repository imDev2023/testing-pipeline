//! The gate on a cluster with markets: the current build passes against itself, and builds that
//! would strand a market, or stop a sale beyond the buffer, are refused on the markets they
//! break.
//!
//! Needs the broken builds (`python3 programs/lending-amm/scripts/broken-builds.py`), the
//! gate's own among them (`gate/test-builds.json`).

mod common;

use lending_gate::programs;
use lending_gate::snapshot::StepKind;

#[test]
fn the_current_build_passes_against_itself_on_every_market() {
    let build = programs::current_build();
    let (session, markets) = common::with_markets(&build);
    let snapshot = common::snapshot(session, &markets);
    assert_eq!(snapshot.markets.len(), 2);
    let report = common::run(&snapshot, &build);
    assert!(report.passed(), "{report}");
    assert!(report.shared_failures().is_empty(), "{report}");
    let lent = &report.markets[0];
    let fresh = &report.markets[1];
    // The market lending to Kamino needs no rebalance; the fresh one does, and lends.
    assert!(
        !common::step_names(lent).contains(&"rebalance".to_string()),
        "{report}"
    );
    let rebalance = fresh
        .steps
        .iter()
        .find(|s| s.kind == StepKind::Rebalance)
        .expect("the fresh market is rebalanced");
    assert!(rebalance.passed, "{report}");
    // Both sell beyond their buffer, redeeming from Kamino inside the swap.
    for market in [lent, fresh] {
        let beyond = market
            .steps
            .iter()
            .find(|s| s.kind == StepKind::SellBeyondBuffer)
            .unwrap();
        assert!(beyond.detail.starts_with("received "), "{report}");
    }
}

#[test]
fn a_build_that_moves_a_market_state_field_is_refused_on_every_market_holding_ctokens() {
    let build = programs::current_build();
    let (session, markets) = common::with_markets(&build);
    let snapshot = common::snapshot(session, &markets);
    let report = common::run(&snapshot, &programs::broken_build("moves-a-field"));
    assert!(!report.passed(), "{report}");
    // The market lending to Kamino has its cTokens and totals read from the wrong bytes, so its
    // quotes change; the fresh one holds no cTokens and zero totals, which read the same either
    // way, so nothing of it is stranded.
    let lent = markets[0].to_string();
    let quotes_refused = report
        .failures()
        .iter()
        .filter(|f| f.market_state == lent && f.step.starts_with("quote"))
        .count();
    assert!(quotes_refused >= 3, "{report}");
}

#[test]
fn a_build_that_cannot_sell_beyond_the_buffer_is_refused_where_the_deployed_build_could() {
    let build = programs::current_build();
    let (session, markets) = common::with_markets(&build);
    let snapshot = common::snapshot(session, &markets);
    let report = common::run(
        &snapshot,
        &programs::broken_build("no-sale-beyond-the-buffer"),
    );
    assert!(!report.passed(), "{report}");
    let failures = report.failures();
    for market in &markets {
        let market = market.to_string();
        assert!(
            failures.iter().any(|f| f.market_state == market
                && (f.step.starts_with("sell beyond the buffer") || f.step.starts_with("quote"))),
            "nothing refused on {market}:\n{report}"
        );
    }
}

#[test]
fn a_build_whose_rebalance_lends_nothing_is_refused_where_the_deployed_build_sold_beyond_the_buffer(
) {
    // On the fresh market the deployed build's rebalance lends and its sale beyond the buffer
    // redeems from Kamino; the candidate's rebalance lends nothing, so it has no such sale to make,
    // and skipping what the deployed build did must count against it.
    let build = programs::current_build();
    let (session, markets) = common::with_markets(&build);
    let snapshot = common::snapshot(session, &markets);
    let report = common::run(
        &snapshot,
        &programs::broken_build("rebalance-lends-nothing"),
    );
    assert!(!report.passed(), "{report}");
    let fresh = markets[1].to_string();
    assert!(
        report
            .failures()
            .iter()
            .any(|f| f.market_state == fresh && f.step.starts_with("sell beyond the buffer")),
        "{report}"
    );
}
