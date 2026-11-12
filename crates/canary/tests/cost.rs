//! `cost`: the round-trip return at every size, and the loss at the ordinary sizes split
//! into Pipeline's fee, Token-2022 transfer fees and the rest.

mod common;

use canary::{run_market, MarketResults, Outcome, RunOptions};
use common::Cluster;
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

fn cost_of_cp_market(fee_bps: u16) -> canary::Record {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(fee_bps);
    run(&cluster, market.market).record("cost").clone()
}

#[test]
fn a_low_fee_market_passes_and_its_loss_splits_into_pipelines_fee_and_the_rest() {
    let record = cost_of_cp_market(30);

    assert_eq!(record.outcome, Outcome::Pass, "{}", record.reason);
    let split = &record.numbers["pairs"][0]["reference"];
    let put_in = split["put_in"].as_i64().unwrap();
    let back = split["got_back"].as_i64().unwrap();
    let pipeline = split["pipeline_fee"].as_i64().unwrap();
    let transfer = split["transfer_fees"].as_i64().unwrap();
    let rest = split["rest"].as_i64().unwrap();
    assert_eq!(put_in - back, pipeline + transfer + rest, "{split}");
    // Pipeline's fee on the buy is what its fee maths charge on the 0.01 SOL sent.
    let expected =
        pipeline_strategy_interface::fees::pipeline_fee(canary::config::SOL_REFERENCE_SIZE);
    assert_eq!(
        split["pipeline_fee_buy"].as_u64(),
        Some(expected),
        "{split}"
    );
    assert!(pipeline > 0 && transfer == 0 && rest > 0, "{split}");
    // A 0.3% pool fee on each leg and 0.25% for Pipeline on each: about 98.9% back.
    let percent = split["return_ppm"].as_u64().unwrap();
    assert!((985_000..992_000).contains(&percent), "{split}");
}

#[test]
fn a_market_returning_between_the_bands_warns() {
    // 15% each way: about 71.9% back.
    let record = cost_of_cp_market(1_500);
    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    assert!(record.reason.contains("71."), "{}", record.reason);
}

#[test]
fn a_market_returning_less_than_the_fail_band_fails() {
    // 30% each way: about 48.8% back, like the outside builder's AMM on devnet.
    let record = cost_of_cp_market(3_000);
    assert_eq!(record.outcome, Outcome::Fail, "{}", record.reason);
    assert!(record.reason.contains("48."), "{}", record.reason);
}
