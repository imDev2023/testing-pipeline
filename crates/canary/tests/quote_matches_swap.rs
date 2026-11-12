//! `quote_matches_swap`: every committed swap against the quote taken in the same state
//! just before it.

mod common;

use canary::{run_market, MarketResults, Outcome, RunOptions};
use common::{Cluster, SOL};
use pipeline_check::SvmSource;
use pipeline_client::Pubkey;

fn run(cluster: &Cluster, market: Pubkey, extra: Vec<u8>) -> MarketResults {
    run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market,
        &RunOptions {
            extra,
            ..RunOptions::default()
        },
    )
    .into_results()
    .expect("a full source never lacks an account")
}

/// `test-strategy-evil`'s behaviours, chosen by the first byte of `TradeRequest::extra`.
const QUOTE_LIES: u8 = 7;
const QUOTE_HOG: u8 = 8;

#[test]
fn every_swap_equals_its_quote_in_an_honest_market_and_the_count_is_reported() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);

    let record = run(&cluster, market.market, vec![])
        .record("quote_matches_swap")
        .clone();

    assert_eq!(record.outcome, Outcome::Pass, "{}", record.reason);
    // Six sizes, each a buy and a sale.
    assert_eq!(
        record.numbers["compared"].as_u64(),
        Some(12),
        "{}",
        record.numbers
    );
    assert!(record.reason.contains("12"), "{}", record.reason);
}

#[test]
fn a_quote_that_promises_more_than_the_swap_pays_fails() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * SOL);

    let record = run(&cluster, market.market, vec![QUOTE_LIES])
        .record("quote_matches_swap")
        .clone();

    assert_eq!(record.outcome, Outcome::Fail, "{}", record.reason);
    assert!(
        record.reason.contains("output received"),
        "{}",
        record.reason
    );
}

#[test]
fn a_quoted_swap_the_router_refuses_fails_and_names_the_router() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    cluster.pause_router();

    let results = run(&cluster, market.market, vec![]);

    let record = results.record("quote_matches_swap");
    assert_eq!(record.outcome, Outcome::Fail, "{}", record.reason);
    assert!(
        record.reason.contains("router refused"),
        "{}",
        record.reason
    );
    let failure = &record.numbers["disagreements"][0]["swap_failure"];
    assert_eq!(failure["class"], "router_refused", "{failure}");
    assert!(failure["anchor"]["name"].is_string(), "{failure}");
}

#[test]
fn a_swap_that_works_although_its_quote_failed_fails() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * SOL);

    let results = run(&cluster, market.market, vec![QUOTE_HOG]);

    let record = results.record("quote_matches_swap");
    assert_eq!(record.outcome, Outcome::Fail, "{}", record.reason);
    assert!(
        record.reason.contains("although its quote failed"),
        "{}",
        record.reason
    );
    assert!(
        record.reason.contains("out of compute"),
        "{}",
        record.reason
    );
}

#[test]
fn a_market_that_refuses_every_trade_is_not_run() {
    let mut cluster = Cluster::new();
    let sol = cluster.wrapped_sol();
    let token = cluster.create_mint(6);
    let market = cluster.cp_market(sol, token, 30, (0, 0));

    let record = run(&cluster, market.market, vec![])
        .record("quote_matches_swap")
        .clone();

    assert_eq!(record.outcome, Outcome::NotRun, "{}", record.reason);
}
