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
fn a_funded_market_holding_ctokens_passes_every_check() {
    // As if rebalance had lent three quarters of the lent side: quotes and swaps value the
    // cTokens from the Kamino reserve dumped from this build's cluster.
    for lent_entry in 0..2 {
        let mut env = Env::new();
        let other = env.create_mint(&TOKEN);
        let (lent_mint, buffer) = [(wsol(), 50 * SOL), (lent(1).0, 50_000_000_000)][lent_entry];
        let spec = MarketSpec {
            mints: [(other, TOKEN), (lent_mint, TOKEN)],
            params: lending_amm::InitParams {
                lent_index: 1,
                lp_fee_bps: 30,
            },
        };
        let (market, _) = env
            .create_funded_market(&spec, [1_000_000_000_000, buffer])
            .unwrap();
        env.give_ctokens(&market, 3 * buffer);
        assert_conforms(&env, &market);
    }
}
