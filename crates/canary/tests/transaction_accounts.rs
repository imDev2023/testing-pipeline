//! `transaction_accounts`: the accounts a strategy asks for that describe the transaction,
//! not the market (the Instructions, SlotHashes and RecentBlockhashes sysvars), with which
//! it could tell a simulated trade from a real one.

mod common;

use std::collections::BTreeSet;

use canary::checks::transaction_accounts::{judge, Resolutions, TRANSACTION_SYSVARS};
use canary::{run_market, Outcome, RunOptions};
use common::Cluster;
use pipeline_check::SvmSource;
use pipeline_client::Pubkey;

#[test]
fn a_strategy_that_asks_only_for_market_accounts_passes() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);

    let record = run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market.market,
        &RunOptions::default(),
    )
    .into_results()
    .unwrap()
    .record("transaction_accounts")
    .clone();

    assert_eq!(record.outcome, Outcome::Pass, "{}", record.reason);
    assert!(
        record.numbers["resolutions"].as_u64().unwrap() > 0,
        "{}",
        record.numbers
    );
}

#[test]
fn a_strategy_that_asks_for_a_transaction_sysvar_warns_and_names_it() {
    for (name, sysvar) in TRANSACTION_SYSVARS {
        let accounts: BTreeSet<Pubkey> = [Pubkey::new_unique(), sysvar].into();

        let verdict = judge(&Resolutions { count: 3, accounts });

        assert_eq!(verdict.outcome, Outcome::Warn, "{}", verdict.reason);
        assert!(verdict.reason.contains(name), "{}", verdict.reason);
    }
}

#[test]
fn a_run_that_never_resolved_a_trade_is_not_run() {
    let verdict = judge(&Resolutions::default());

    assert_eq!(verdict.outcome, Outcome::NotRun, "{}", verdict.reason);
}
