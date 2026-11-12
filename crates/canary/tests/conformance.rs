//! `conformance`: `pipeline-check` run unchanged on the copy, its whole report kept.

mod common;

use canary::swap::{SwapPath, SwapReceipt, SwapRequest, ThroughRouter};
use canary::{market::Market, run_market, Failure, MarketResults, Outcome, RunOptions};
use common::Cluster;
use litesvm::LiteSVM;
use pipeline_check::SvmSource;
use pipeline_client::Pubkey;

fn run(cluster: &Cluster, market: Pubkey, options: RunOptions) -> MarketResults {
    run_market(&mut SvmSource::new(cluster.svm.clone()), market, &options)
        .into_results()
        .expect("a full source never lacks an account")
}

#[test]
fn a_conforming_market_passes_and_the_whole_report_is_kept() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);

    let record = run(&cluster, market.market, RunOptions::default())
        .record("conformance")
        .clone();

    assert_eq!(record.outcome, Outcome::Pass, "{}", record.reason);
    assert_eq!(record.numbers["schema"], pipeline_check::SCHEMA);
    let checks = record.numbers["checks"].as_array().unwrap();
    assert_eq!(checks.len(), pipeline_check::CHECKS.len());
    assert!(checks.iter().all(|c| c["message"].is_string()));
}

#[test]
fn a_stranded_market_fails_as_pipeline_check_reports_it() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    cluster.edit(&market.state, |data| data[0] ^= 0xff);

    let record = run(&cluster, market.market, RunOptions::default())
        .record("conformance")
        .clone();

    assert_eq!(record.outcome, Outcome::Fail, "{}", record.reason);
    assert_eq!(record.numbers["summary"]["result"], "fail");
}

/// A swap path that does not execute the router, as the direct implementation will not.
struct WithoutRouter;

impl SwapPath for WithoutRouter {
    fn runs_router(&self) -> bool {
        false
    }

    fn swap(
        &self,
        svm: &mut LiteSVM,
        market: &Market,
        request: &SwapRequest,
    ) -> Result<SwapReceipt, Failure> {
        ThroughRouter.swap(svm, market, request)
    }
}

#[test]
fn conformance_is_not_run_on_a_swap_path_that_does_not_execute_the_router() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);

    let results = run(
        &cluster,
        market.market,
        RunOptions {
            swap: &WithoutRouter,
            ..RunOptions::default()
        },
    );

    let record = results.record("conformance");
    assert_eq!(record.outcome, Outcome::NotRun, "{}", record.reason);
    assert!(record.reason.contains("router"), "{}", record.reason);
    // The trading checks go through the swap function and still run.
    assert_eq!(results.record("exit_sizes").outcome, Outcome::Pass);
}
