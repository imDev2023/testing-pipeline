//! A sweep over several markets, and the roll-up per strategy version.

mod common;

use canary::run::sweep;
use canary::RunOptions;
use common::{Cluster, CP};
use pipeline_check::SvmSource;

#[test]
fn the_roll_up_counts_each_checks_outcomes_per_strategy_version_and_the_stranded_markets() {
    let mut cluster = Cluster::new();
    let healthy = cluster.sol_cp_market(30);
    let stranded = cluster.sol_cp_market(100);
    cluster.edit(&stranded.state, |data| data[0] ^= 0xff);

    let result = sweep(
        &mut SvmSource::new(cluster.svm.clone()),
        &[healthy.market, stranded.market],
        &RunOptions::default(),
    );

    assert_eq!(result.records.len(), 2 * canary::checks::CHECKS.len());
    assert_eq!(
        result.rollups.len(),
        1,
        "both markets share one strategy version"
    );
    let rollup = &result.rollups[0];
    assert_eq!(rollup.strategy.as_deref(), Some(CP.to_string().as_str()));
    assert!(rollup.strategy_version.deploy_slot.is_some());
    assert_eq!(rollup.markets, 2);
    assert_eq!(rollup.stranded, 1);
    let readable = &rollup.checks["readable"];
    assert_eq!(readable.outcomes["pass"], 1);
    assert_eq!(readable.outcomes["fail"], 1);
    assert_eq!(readable.fail, vec![stranded.market.to_string()]);
    assert_eq!(rollup.checks["exit_sizes"].outcomes["not run"], 1);
}
