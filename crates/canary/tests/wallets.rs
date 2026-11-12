//! Wallets are new random keys on every run, from a seed chosen once per run, so the
//! snapshot rounds of one run trade from the same wallets while no strategy can know them in
//! advance.

mod common;

use canary::source::{record_snapshot, SnapshotSource};
use canary::{run_market, MarketRun, RunOptions};
use common::Cluster;
use pipeline_check::SvmSource;
use pipeline_client::pda;

fn wallets(results: &canary::MarketResults) -> Vec<String> {
    results.record("exit_sizes").numbers["pairs"][0]["sizes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["wallet"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn every_size_trades_from_its_own_wallet_and_two_runs_use_different_wallets() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    let run = || {
        run_market(
            &mut SvmSource::new(cluster.svm.clone()),
            market.market,
            &RunOptions::default(),
        )
        .into_results()
        .unwrap()
    };
    let (first, second) = (wallets(&run()), wallets(&run()));
    let distinct: std::collections::BTreeSet<&String> = first.iter().collect();
    assert_eq!(distinct.len(), first.len(), "{first:?}");
    assert!(
        first.iter().all(|w| !second.contains(w)),
        "{first:?} {second:?}"
    );
}

#[test]
fn the_rounds_of_one_run_trade_from_the_same_wallets() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    let mut snapshot =
        record_snapshot(&mut SvmSource::new(cluster.svm.clone()), market.market).unwrap();
    let seed = snapshot
        .seed
        .clone()
        .expect("a recorded snapshot carries the seed it was recorded with");
    let vault = pda::associated_token(&market.state, &market.mint_b, &common::TOKEN);
    snapshot.accounts.remove(&vault.to_string());
    snapshot.seed = None;

    // A first round with no seed: the run picks one and answers with it.
    let options = RunOptions {
        last_round: false,
        ..RunOptions::default()
    };
    let answer = run_market(
        &mut SnapshotSource::new(&snapshot).unwrap(),
        market.market,
        &options,
    );
    let MarketRun::Missing { seed: picked, .. } = answer else {
        panic!("the vault is missing")
    };
    assert_ne!(
        canary::wallets::Seed::to_hex(&picked),
        seed,
        "a new run picks a new seed"
    );

    // Posted again with that seed and the vault, both rounds' wallets are the same.
    snapshot.seed = Some(picked.to_hex());
    let complete =
        record_snapshot(&mut SvmSource::new(cluster.svm.clone()), market.market).unwrap();
    snapshot.accounts = complete.accounts;
    let run = |s: &canary::Snapshot| {
        let options = RunOptions {
            seed: s
                .seed
                .as_deref()
                .map(|h| canary::wallets::Seed::from_hex(h).unwrap()),
            ..RunOptions::default()
        };
        run_market(
            &mut SnapshotSource::new(s).unwrap(),
            market.market,
            &options,
        )
        .into_results()
        .unwrap()
    };
    assert_eq!(wallets(&run(&snapshot)), wallets(&run(&snapshot)));
}
