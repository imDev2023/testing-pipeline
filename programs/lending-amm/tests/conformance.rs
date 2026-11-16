//! Conformance (docs/spec/README.md, "Test layers" 4): `pipeline-check` quotes and swaps
//! the market in every direction and size through the real router, and must report zero
//! Fail and zero Warn; the exact-out checks are skipped by design, since the lending AMM
//! refuses exact-out (docs/spec/lending-pool.md, "Accepted `pipeline-check` warnings").

mod common;

use common::*;
use pipeline_check::{check_market, CheckOptions, Status};

fn assert_conforms(env: &Env, market: &Market) {
    let report = check_market(&env.svm, market.market, &CheckOptions::default());
    println!("{}", report.to_text());
    let not_passing: Vec<_> = report
        .checks
        .iter()
        .filter(|check| matches!(check.status, Status::Fail | Status::Warn))
        .map(|check| format!("{} {:?}: {}", check.id, check.status, check.message))
        .collect();
    assert!(not_passing.is_empty(), "{not_passing:#?}");
    let skipped: Vec<_> = report
        .checks
        .iter()
        .filter(|check| check.status == Status::Skip)
        .map(|check| check.id.as_str())
        .collect();
    assert!(
        skipped.iter().all(|id| id.contains("exact_out")),
        "only exact-out checks may be skipped: {skipped:?}"
    );
    assert!(report
        .checks
        .iter()
        .any(|check| check.status == Status::Pass));
}

#[test]
fn a_funded_wsol_market_passes_every_check() {
    for fee in [0u16, 30, 200] {
        let mut env = Env::new();
        let spec = env.wsol_market_spec(fee);
        let (market, _) = env
            .create_funded_market(&spec, [1_000_000_000_000, 50 * SOL])
            .unwrap();
        assert_conforms(&env, &market);
    }
}

#[test]
fn a_funded_market_with_a_hooked_other_side_passes_every_check() {
    let mut env = Env::new();
    let (hooked, _) = env.create_hooked_mint();
    let spec = MarketSpec {
        mints: [(hooked, TOKEN_2022), (wsol(), TOKEN)],
        params: lending_amm::InitParams {
            lent_index: 1,
            lp_fee_bps: 30,
        },
    };
    let (market, _) = env
        .create_funded_market(&spec, [500_000_000_000, 20 * SOL])
        .unwrap();
    assert_conforms(&env, &market);
}

#[test]
fn a_funded_usdc_market_lending_at_index_0_passes_every_check() {
    let mut env = Env::new();
    let other = env.create_mint(&TOKEN_2022);
    let spec = MarketSpec {
        mints: [(lent(1).0, TOKEN), (other, TOKEN_2022)],
        params: lending_amm::InitParams {
            lent_index: 0,
            lp_fee_bps: 30,
        },
    };
    let (market, _) = env
        .create_funded_market(&spec, [5_000_000_000, 80_000_000_000])
        .unwrap();
    assert_conforms(&env, &market);
}

#[test]
fn a_market_rebalance_has_lent_passes_every_check() {
    // rebalance lends four fifths of the lent side through klend's real deposit, and quotes
    // and swaps then value the cTokens from the Kamino reserve of this build's cluster; then a
    // swap drains the buffer below its band and rebalance redeems from Kamino, and the market
    // passes again.
    for lent_entry in 0..2 {
        let mut env = Env::new();
        let spec = common::rebalance::lent_spec(&mut env, lent_entry, 30);
        let buffer = common::rebalance::units(lent_entry, 50);
        let (market, _) = env
            .create_funded_market(&spec, [1_000_000_000_000, buffer])
            .unwrap();
        env.rebalance(&market, None).unwrap();
        assert!(env.market_state(&market.market_state).ctokens > 0);
        assert_conforms(&env, &market);

        let market = env.market_below_the_band(lent_entry);
        env.rebalance(&market, None).unwrap();
        assert!(env.market_state(&market.market_state).redeemed > 0);
        assert_conforms(&env, &market);
    }
}
