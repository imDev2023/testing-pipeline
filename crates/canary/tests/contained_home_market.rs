//! A contained token's home market with our real containment hook, which delivers a
//! contained token only into the home market's vault and fee account, or into an account
//! whose owner can never change (`HOOK-47`). Canary's traders hold associated token accounts,
//! which carry Token-2022's immutable owner extension, so every buy and sale in the home
//! market works as a trader's would, and only a wallet-to-wallet transfer is refused.

mod common;

use canary::checks::conformance;
use canary::config::CONTAINMENT_HOOK_PROGRAM;
use canary::market::Copy;
use canary::{run_market, MarketResults, Outcome, Record, RunOptions};
use common::Cluster;
use pipeline_check::{check_market_with_source, CheckOptions, Report, SvmSource};
use pipeline_client::Pubkey;

const DAY: u64 = 86_400;

fn run(cluster: &Cluster, market: Pubkey) -> MarketResults {
    run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market,
        &RunOptions::default(),
    )
    .into_results()
    .expect("a full source never lacks an account")
}

fn assert_outcome(record: &Record, outcome: Outcome) {
    assert_eq!(
        record.outcome, outcome,
        "{}: {}",
        record.check, record.reason
    );
}

fn home_market() -> (Cluster, Pubkey) {
    let mut cluster = Cluster::new();
    let market = cluster.contained_home_market();
    cluster.pass_time(2 * DAY);
    (cluster, market.market)
}

#[test]
fn the_exit_quote_and_cost_checks_pass_in_a_contained_tokens_home_market() {
    let (cluster, market) = home_market();

    let run = run(&cluster, market);

    for check in [
        "exit_sizes",
        "exit_hold",
        "exit_late",
        "exit_launch_clock",
        "exit_wallets",
        "exit_queue",
        "quote_matches_swap",
        "cost",
        "contained_mint",
    ] {
        assert_outcome(run.record(check), Outcome::Pass);
    }
}

#[test]
fn the_hook_refuses_only_the_wallet_to_wallet_transfer_and_canary_names_it() {
    let (cluster, market) = home_market();

    let run = run(&cluster, market);

    let transferred = run.record("exit_transferred");
    assert_outcome(transferred, Outcome::Warn);
    assert_eq!(transferred.numbers["pairs"][0]["transferred"], false);
    assert_eq!(
        transferred.numbers["pairs"][0]["transfer_failure"]["program"],
        CONTAINMENT_HOOK_PROGRAM.to_string()
    );
    assert_eq!(transferred.numbers["could_not_sell_back"], false);
}

#[test]
fn conformance_counts_pipeline_checks_trades_refused_for_its_traders_accounts_as_known() {
    let (cluster, market) = home_market();

    let record = run(&cluster, market).record("conformance").clone();

    // pipeline-check's own report is kept whole: its traders' buys are refused.
    assert_eq!(record.numbers["summary"]["result"], "fail");
    assert_eq!(
        record.numbers["canary_known"],
        serde_json::json!(["quote_matches_swap", "exact_out_refund", "round_trip"])
    );
    assert_outcome(&record, Outcome::Pass);
    assert!(
        record.reason.starts_with(
            "Apart from the known, pipeline-check reports pass: 11 pass, 0 warn, 0 fail and 0 skip."
        ),
        "{}",
        record.reason
    );
    assert!(
        record.reason.contains(
            "Known, not counted: quote_matches_swap, exact_out_refund and round_trip, whose swaps fail only with the containment hook's DestinationOwnerCanChange (6023)"
        ),
        "{}",
        record.reason
    );
    assert!(
        record.reason.ends_with(
            "known until Pipeline's checker writes the immutable owner extension, HOOK-47."
        ),
        "{}",
        record.reason
    );
}

/// The home market's copy and pipeline-check's report on it.
fn copy_and_report() -> (Copy, Report) {
    let (cluster, market) = home_market();
    let copy = Copy::build(
        &mut SvmSource::new(cluster.svm.clone()),
        market,
        &CheckOptions::default(),
    )
    .unwrap();
    let report = check_market_with_source(
        &copy.pristine,
        copy.market.address,
        &CheckOptions::default(),
        copy.report_source(),
    );
    (copy, report)
}

#[test]
fn a_known_check_that_also_fails_for_another_reason_is_counted() {
    let (copy, mut report) = copy_and_report();
    assert_eq!(
        conformance::judge(&report, &copy.market).outcome,
        Outcome::Pass
    );

    let check = report
        .checks
        .iter_mut()
        .find(|c| c.id == "quote_matches_swap")
        .unwrap();
    check.details["mismatches"][1] =
        "mint 0→1 exact-in 1000000000 (medium): quoted 2 out for 1 in, swap delivered 1 for 1"
            .into();

    let verdict = conformance::judge(&report, &copy.market);
    assert_eq!(verdict.outcome, Outcome::Fail, "{}", verdict.reason);
    assert!(
        verdict.reason.starts_with("Apart from the known, pipeline-check reports fail: 11 pass, 0 warn, 1 fail and 0 skip. First fail: quote_matches_swap"),
        "{}",
        verdict.reason
    );
}

#[test]
fn the_same_failures_count_on_a_market_whose_mints_our_hook_does_not_contain() {
    let (mut copy, report) = copy_and_report();
    for mint in &mut copy.market.mints {
        mint.transfer_hook = None;
    }

    let verdict = conformance::judge(&report, &copy.market);

    assert_eq!(verdict.outcome, Outcome::Fail, "{}", verdict.reason);
    assert!(
        verdict
            .reason
            .starts_with("pipeline-check reports fail: 11 pass, 1 warn, 2 fail and 0 skip."),
        "{}",
        verdict.reason
    );
    assert!(verdict.numbers.get("canary_known").is_none());
}
