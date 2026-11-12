//! Snapshots and their rounds: when a trade names an account the snapshot lacks, the run
//! answers with exactly the missing addresses; at the last round the affected checks are
//! "not run", naming them.

mod common;

use canary::checks::CHECKS;
use canary::config::SNAPSHOT_ROUNDS;
use canary::source::{record_snapshot, Snapshot, SnapshotSource};
use canary::{run_market, MarketRun, Outcome, RunOptions};
use common::Cluster;
use pipeline_check::SvmSource;
use pipeline_client::pda;

fn options(round: u32) -> RunOptions {
    RunOptions {
        last_round: round >= SNAPSHOT_ROUNDS,
        ..RunOptions::default()
    }
}

fn run(snapshot: &Snapshot) -> MarketRun {
    let mut source = SnapshotSource::new(snapshot).unwrap();
    run_market(
        &mut source,
        snapshot.market.parse().unwrap(),
        &options(snapshot.round),
    )
}

#[test]
fn a_snapshot_recorded_from_a_full_run_answers_with_results_identical_in_outcome() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    let snapshot =
        record_snapshot(&mut SvmSource::new(cluster.svm.clone()), market.market).unwrap();
    assert!(snapshot.accounts.len() > 10, "{}", snapshot.accounts.len());

    let MarketRun::Results(from_snapshot) = run(&snapshot) else {
        panic!("a recorded snapshot holds every account the run asks for");
    };
    let direct = run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market.market,
        &RunOptions::default(),
    )
    .into_results()
    .unwrap();
    for check in CHECKS {
        assert_eq!(
            from_snapshot.record(check).outcome,
            direct.record(check).outcome,
            "{check}"
        );
        assert_eq!(
            from_snapshot.record(check).outcome,
            Outcome::Pass,
            "{check}: {}",
            from_snapshot.record(check).reason
        );
    }
}

#[test]
fn a_snapshot_lacking_an_account_a_trade_names_answers_with_exactly_the_missing_addresses() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    let mut snapshot =
        record_snapshot(&mut SvmSource::new(cluster.svm.clone()), market.market).unwrap();
    // The output vault of a buy, which the strategy's account resolution names.
    let token_vault = pda::associated_token(&market.state, &market.mint_b, &common::TOKEN);
    assert!(snapshot.accounts.remove(&token_vault.to_string()).is_some());

    for round in 1..SNAPSHOT_ROUNDS {
        snapshot.round = round;
        match run(&snapshot) {
            MarketRun::Missing { addresses, .. } => {
                assert_eq!(addresses, vec![token_vault], "round {round}")
            }
            MarketRun::Results(_) => panic!("round {round} answered with results"),
        }
    }
}

#[test]
fn after_the_last_round_the_affected_checks_are_not_run_naming_the_accounts() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    let mut snapshot =
        record_snapshot(&mut SvmSource::new(cluster.svm.clone()), market.market).unwrap();
    let token_vault = pda::associated_token(&market.state, &market.mint_b, &common::TOKEN);
    snapshot.accounts.remove(&token_vault.to_string());
    snapshot.round = SNAPSHOT_ROUNDS;

    let MarketRun::Results(results) = run(&snapshot) else {
        panic!("the last round always answers with results");
    };

    for check in CHECKS {
        let record = results.record(check);
        assert_eq!(record.outcome, Outcome::NotRun, "{check}");
        assert!(
            record.reason.contains(&token_vault.to_string()),
            "{check}: {}",
            record.reason
        );
    }
}

#[test]
fn an_account_marked_absent_on_the_cluster_completes_the_run() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    // The market's fee account for the token: the cloner asks for it. Once the snapshot says
    // the cluster has no account there, the copy creates it as anyone may and the run is
    // complete.
    let mut snapshot =
        record_snapshot(&mut SvmSource::new(cluster.svm.clone()), market.market).unwrap();
    let fee_account = pda::fee_account(&market.market, &market.mint_b, &common::TOKEN);
    snapshot.accounts.remove(&fee_account.to_string());
    snapshot.round = 1;

    let MarketRun::Missing { addresses, .. } = run(&snapshot) else {
        panic!("the cloner asks for the fee account");
    };
    assert_eq!(addresses, vec![fee_account]);

    // Posted again with the fee account marked as absent on the cluster, the run is complete.
    snapshot.accounts.insert(fee_account.to_string(), None);
    snapshot.round = 2;
    let MarketRun::Results(results) = run(&snapshot) else {
        panic!("nothing is missing any more");
    };
    assert_eq!(
        results.record("exit_sizes").outcome,
        Outcome::Pass,
        "{}",
        results.record("exit_sizes").reason
    );
}
