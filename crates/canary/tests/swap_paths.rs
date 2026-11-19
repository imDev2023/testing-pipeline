//! The licence seam (`CANARY-26`): every trade goes through one swap function with two
//! implementations, through the router's own bytes (used on devnet) and calling the strategy
//! directly with Pipeline's Apache-2.0 settlement code. Both give every check the same
//! result from the same state and wallets; only `conformance`, which runs the router inside
//! `pipeline-check`, is "not run" on the direct path.

mod common;

use canary::swap::{DirectToStrategy, SwapPath, ThroughRouter};
use canary::wallets::Seed;
use canary::{run_market, MarketResults, Outcome, Record, RunOptions};
use common::{Cluster, SOL};
use pipeline_check::SvmSource;
use pipeline_client::Pubkey;
use serde_json::Value;

/// The evil strategy's behaviour byte for a quote that claims twice what the swap pays.
const QUOTE_LIES: u8 = 7;

fn run(
    cluster: &Cluster,
    market: Pubkey,
    path: &'static dyn SwapPath,
    extra: Vec<u8>,
) -> MarketResults {
    run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market,
        &RunOptions {
            swap: path,
            extra,
            seed: Some(Seed::from_hex(&"5e".repeat(32)).unwrap()),
            ..RunOptions::default()
        },
    )
    .into_results()
    .expect("a full source never lacks an account")
}

/// A record's numbers without what only says how the swap was carried: compute units, and
/// the VM's raw error text, whose instruction index differs between the two transactions.
fn comparable(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        "compute_units" | "strategy_compute_units" | "error"
                    )
                })
                .map(|(k, v)| (k.clone(), comparable(v)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.iter().map(comparable).collect()),
        other => other.clone(),
    }
}

fn assert_same_results(router: &MarketResults, direct: &MarketResults) {
    assert_eq!(router.records.len(), direct.records.len());
    for (r, d) in router.records.iter().zip(&direct.records) {
        assert_eq!(r.check, d.check);
        if r.check == "conformance" {
            assert_eq!(d.outcome, Outcome::NotRun, "{}", d.reason);
            assert!(d.reason.contains("router"), "{}", d.reason);
            continue;
        }
        assert_eq!(
            (r.outcome, &r.reason),
            (d.outcome, &d.reason),
            "{}",
            r.check
        );
        assert_eq!(
            comparable(&r.numbers),
            comparable(&d.numbers),
            "{}",
            r.check
        );
        assert_eq!(r.inputs, d.inputs, "{}", r.check);
    }
}

fn outcome<'a>(results: &'a MarketResults, check: &str) -> &'a Record {
    results.record(check)
}

#[test]
fn every_check_gives_the_same_result_on_both_paths_in_a_deep_market() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);

    let router = run(&cluster, market.market, &ThroughRouter, vec![]);
    let direct = run(&cluster, market.market, &DirectToStrategy, vec![]);

    assert_eq!(outcome(&router, "exit_sizes").outcome, Outcome::Pass);
    assert_same_results(&router, &direct);
}

#[test]
fn every_check_gives_the_same_result_on_both_paths_when_the_token_has_a_hook() {
    let mut cluster = Cluster::new();
    let market = common::whitelist_hooked_market(&mut cluster);

    let router = run(&cluster, market.market, &ThroughRouter, vec![]);
    let direct = run(&cluster, market.market, &DirectToStrategy, vec![]);

    assert_eq!(outcome(&direct, "exit_sizes").outcome, Outcome::Pass);
    assert_same_results(&router, &direct);
}

#[test]
fn a_sale_that_crashes_fails_the_same_way_on_both_paths() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market_that_crashes_on_sale(1_000 * SOL);

    let router = run(&cluster, market.market, &ThroughRouter, vec![]);
    let direct = run(&cluster, market.market, &DirectToStrategy, vec![]);

    assert_eq!(outcome(&direct, "exit_sizes").outcome, Outcome::Fail);
    assert_same_results(&router, &direct);
}

#[test]
fn a_swap_that_pays_less_than_its_quote_fails_the_same_way_on_both_paths() {
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * SOL);

    let router = run(&cluster, market.market, &ThroughRouter, vec![QUOTE_LIES]);
    let direct = run(&cluster, market.market, &DirectToStrategy, vec![QUOTE_LIES]);

    assert_eq!(
        outcome(&direct, "quote_matches_swap").outcome,
        Outcome::Fail
    );
    assert_same_results(&router, &direct);
}

#[test]
fn a_strategy_that_tries_to_pull_more_from_the_trader_fails_the_same_way_on_both_paths() {
    // Under the router the strategy never holds the trader's signature, so the direct path
    // must not give it one either.
    const TAKE_MORE: u8 = 1;
    let mut cluster = Cluster::new();
    let market = cluster.evil_market(1_000 * SOL);

    let router = run(&cluster, market.market, &ThroughRouter, vec![TAKE_MORE]);
    let direct = run(&cluster, market.market, &DirectToStrategy, vec![TAKE_MORE]);

    assert_eq!(outcome(&direct, "exit_sizes").outcome, Outcome::NotRun);
    assert_same_results(&router, &direct);
}

#[test]
fn the_checks_over_time_and_across_wallets_give_the_same_results_on_both_paths() {
    // Canary's fixture strategy, in the three behaviours those checks exist to catch: an
    // insider paid more (exit_wallets fails), a launch tax (exit_launch_clock warns) and a
    // market that closes a day later (exit_hold and exit_late warn).
    const DAY: u64 = 86_400;
    for (mode, age, check, expected) in [
        (
            common::mode::INSIDER_PAID_MORE,
            0,
            "exit_wallets",
            Outcome::Fail,
        ),
        (
            common::mode::LAUNCH_TAX,
            2 * DAY,
            "exit_launch_clock",
            Outcome::Warn,
        ),
        (common::mode::CLOSES, DAY, "exit_hold", Outcome::Warn),
    ] {
        let mut cluster = Cluster::new();
        let insider = cluster.admin_key();
        let market = cluster.fixture_market(mode, insider);
        if age > 0 {
            cluster.pass_time(age);
        }

        let router = run(&cluster, market.market, &ThroughRouter, vec![]);
        let direct = run(&cluster, market.market, &DirectToStrategy, vec![]);

        let record = outcome(&direct, check);
        assert_eq!(record.outcome, expected, "mode {mode}: {}", record.reason);
        assert_same_results(&router, &direct);
    }
}
