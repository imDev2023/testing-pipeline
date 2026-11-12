//! `direct_call`: the strategy's `pipeline_swap` called without the router, once with another
//! key signing as the market signer and once with the real market signer not signing, after
//! the input reaches the vault as the router would send it.

mod common;

use canary::{run_market, MarketResults, Outcome, RunOptions};
use common::{Cluster, SOL};
use pipeline_check::SvmSource;
use pipeline_client::Pubkey;

fn run(cluster: &Cluster, market: Pubkey) -> MarketResults {
    run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market,
        &RunOptions::default(),
    )
    .into_results()
    .expect("a full source never lacks an account")
}

#[test]
fn a_strategy_that_checks_its_market_signer_refuses_both_calls_and_passes() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);

    let record = run(&cluster, market.market).record("direct_call").clone();

    assert_eq!(record.outcome, Outcome::Pass, "{}", record.reason);
    let attempts = record.numbers["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 2, "{}", record.numbers);
    assert!(
        attempts.iter().all(|a| a["accepted"] == false),
        "{}",
        record.numbers
    );
    // Each refusal is the strategy's own, named.
    assert!(
        attempts
            .iter()
            .all(|a| a["failure"]["class"] == "strategy_refused"),
        "{}",
        record.numbers
    );
}

#[test]
fn a_strategy_that_trusts_any_caller_warns() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * SOL);

    let record = run(&cluster, market.market).record("direct_call").clone();

    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    assert!(record.reason.contains("Pipeline fee"), "{}", record.reason);
    let attempts = record.numbers["attempts"].as_array().unwrap();
    assert!(
        attempts.iter().all(|a| a["accepted"] == true),
        "{}",
        record.numbers
    );
}

#[test]
fn a_market_that_refuses_every_trade_is_not_run() {
    let mut cluster = Cluster::new();
    let sol = cluster.wrapped_sol();
    let token = cluster.create_mint(6);
    let market = cluster.cp_market(sol, token, 30, (0, 0));

    let record = run(&cluster, market.market).record("direct_call").clone();

    assert_eq!(record.outcome, Outcome::NotRun, "{}", record.reason);
}

#[test]
fn a_strategy_that_refuses_even_the_call_as_the_router_makes_it_is_not_run() {
    // The evil strategy's "take more" tries to pull extra input from the trader, which no
    // call can let it do, so every direct call fails whoever signs.
    const TAKE_MORE: u8 = 1;
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * SOL);

    let record = run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market.market,
        &RunOptions {
            extra: vec![TAKE_MORE],
            ..RunOptions::default()
        },
    )
    .into_results()
    .unwrap()
    .record("direct_call")
    .clone();

    assert_eq!(record.outcome, Outcome::NotRun, "{}", record.reason);
    assert!(
        record.reason.contains("as the router passes it"),
        "{}",
        record.reason
    );
    assert_eq!(
        record.numbers["control"]["accepted"], false,
        "{}",
        record.numbers
    );
}
