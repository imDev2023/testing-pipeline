//! `readable`: whether the strategy's current version reads the market, and quotes each way.

mod common;

use canary::{config, run_market, Outcome, RunOptions};
use common::Cluster;
use pipeline_check::SvmSource;

#[test]
fn a_market_its_strategy_reads_passes_and_every_record_carries_the_harness() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);

    let run = run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market.market,
        &RunOptions::default(),
    )
    .into_results()
    .expect("a full snapshot needs no more accounts");

    let readable = run.record("readable");
    assert_eq!(readable.outcome, Outcome::Pass, "{}", readable.reason);
    assert_eq!(readable.market, market.market.to_string());
    assert!(run.records.iter().all(|r| r.harness == config::HARNESS));
}

#[test]
fn a_market_whose_state_the_strategy_cannot_read_fails_as_stranded() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    // A different account discriminator, as a market created by an older layout would have.
    cluster.edit(&market.state, |data| data[0] ^= 0xff);

    let run = run(&cluster, market.market, RunOptions::default());

    let readable = run.record("readable");
    assert_eq!(readable.outcome, Outcome::Fail, "{}", readable.reason);
    assert!(readable.reason.contains("stranded"), "{}", readable.reason);
    assert!(
        readable.reason.contains("AccountDiscriminatorMismatch"),
        "{}",
        readable.reason
    );
}

#[test]
fn a_market_that_reads_but_refuses_every_trade_passes_and_names_the_refusal() {
    let mut cluster = Cluster::new();
    let sol = cluster.wrapped_sol();
    let token = cluster.create_mint(6);
    let market = cluster.cp_market(sol, token, 30, (0, 0));

    let run = run(&cluster, market.market, RunOptions::default());

    let readable = run.record("readable");
    assert_eq!(readable.outcome, Outcome::Pass, "{}", readable.reason);
    assert!(
        readable.reason.contains("refuses every trade"),
        "{}",
        readable.reason
    );
    assert!(
        readable.reason.contains("InsufficientLiquidity"),
        "{}",
        readable.reason
    );
}

#[test]
fn a_direction_that_crashes_warns_and_names_the_panic() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * common::SOL);
    cluster.add_third_mint(&market, 1_000 * common::SOL);

    let run = run(&cluster, market.market, RunOptions::default());

    let readable = run.record("readable");
    assert_eq!(readable.outcome, Outcome::Warn, "{}", readable.reason);
    assert!(readable.reason.contains("crash"), "{}", readable.reason);
    // The panic names its source line.
    assert!(
        readable
            .reason
            .contains("test-strategy-evil/src/lib.rs at "),
        "{}",
        readable.reason
    );
}

#[test]
fn a_direction_that_runs_out_of_compute_warns() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * common::SOL);
    const QUOTE_HOG: u8 = 8;

    let run = run(
        &cluster,
        market.market,
        RunOptions {
            extra: vec![QUOTE_HOG],
            ..RunOptions::default()
        },
    );

    let readable = run.record("readable");
    assert_eq!(readable.outcome, Outcome::Warn, "{}", readable.reason);
    assert!(
        readable.reason.contains("out of compute"),
        "{}",
        readable.reason
    );
}

fn run(
    cluster: &Cluster,
    market: pipeline_client::Pubkey,
    options: RunOptions,
) -> canary::MarketResults {
    run_market(&mut SvmSource::new(cluster.svm.clone()), market, &options)
        .into_results()
        .expect("a full source never lacks an account")
}
