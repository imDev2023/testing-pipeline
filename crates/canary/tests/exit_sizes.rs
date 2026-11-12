//! `exit_sizes`: buys each size and sells everything bought in the same slot.

mod common;

use canary::{config, run_market, MarketResults, Outcome, RunOptions};
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
fn every_size_sells_back_in_a_deep_market_and_each_size_is_reported_with_its_share_of_the_money_vault(
) {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);

    let run = run(&cluster, market.market);

    let record = run.record("exit_sizes");
    assert_eq!(record.outcome, Outcome::Pass, "{}", record.reason);
    let sizes = record.numbers["pairs"][0]["sizes"].as_array().unwrap();
    let amounts: Vec<u64> = sizes
        .iter()
        .map(|s| s["amount"].as_u64().unwrap())
        .collect();
    assert_eq!(amounts, config::SOL_SIZES);
    // 10 SOL into a vault of 1,000 SOL is 1% of it.
    let ten = &sizes[5];
    assert_eq!(ten["share_of_money_vault_ppm"].as_u64(), Some(10_000));
    assert!(
        sizes.iter().all(|s| s["sold_back"] == true),
        "{}",
        record.numbers
    );
    assert_eq!(
        record.numbers["pairs"][0]["reference"].as_u64(),
        Some(config::SOL_REFERENCE_SIZE)
    );
}

#[test]
fn tokens_that_cannot_be_sold_back_at_the_reference_size_fail_and_name_the_refusal() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market_that_crashes_on_sale(1_000 * SOL);

    let run = run(&cluster, market.market);

    let record = run.record("exit_sizes");
    assert_eq!(record.outcome, Outcome::Fail, "{}", record.reason);
    assert!(record.reason.contains("0.01 SOL"), "{}", record.reason);
    assert!(record.reason.contains("crash"), "{}", record.reason);
}

#[test]
fn a_market_that_refuses_every_trade_is_not_run_with_the_strategys_own_error() {
    let mut cluster = Cluster::new();
    let sol = cluster.wrapped_sol();
    let token = cluster.create_mint(6);
    let market = cluster.cp_market(sol, token, 30, (0, 0));

    let run = run(&cluster, market.market);

    let record = run.record("exit_sizes");
    assert_eq!(record.outcome, Outcome::NotRun, "{}", record.reason);
    assert!(
        record.reason.contains("InsufficientLiquidity"),
        "{}",
        record.reason
    );
}

#[test]
fn a_stranded_market_is_not_run() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    cluster.edit(&market.state, |data| data[0] ^= 0xff);

    let run = run(&cluster, market.market);

    let record = run.record("exit_sizes");
    assert_eq!(record.outcome, Outcome::NotRun, "{}", record.reason);
    assert!(record.reason.contains("cannot read"), "{}", record.reason);
}
