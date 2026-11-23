//! `outside_supply`: supply held outside the market's pool that the market cannot buy back,
//! sold into the real quote buyers paid in (`CANARY-47`, `HOOK-50`), on Canary's fixture
//! strategy launched as on a virtual quote reserve (30 SOL, the containment launch's
//! default) and on constant-product markets whose quote is all real.

mod common;

use canary::checks::outside_supply::{judge, Measured, OutsideMint, Sale};
use canary::checks::readable::Trading;
use canary::config::OUTSIDE_SUPPLY_WARN_PPM;
use canary::{run_market, Outcome, Record, RunOptions};
use common::Cluster;
use pipeline_check::SvmSource;
use pipeline_client::Pubkey;

/// A billion tokens of 6 decimals.
const SUPPLY: u64 = 1_000_000_000_000_000;

fn record(cluster: &Cluster, market: Pubkey) -> Record {
    run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market,
        &RunOptions::default(),
    )
    .into_results()
    .expect("a full source never lacks an account")
    .record("outside_supply")
    .clone()
}

#[test]
fn a_launch_keeping_a_fifth_of_the_supply_outside_a_virtual_reserves_pool_warns() {
    let mut cluster = Cluster::new();
    let market = cluster.virtual_reserve_market(SUPPLY, SUPPLY / 5 * 4);

    let record = record(&cluster, market.market);

    assert_eq!(record.outcome, Outcome::Warn, "{}", record.reason);
    assert!(
        record.reason.starts_with(
            "Supply held outside the pool could be sold into the real quote buyers paid in: of the "
        ),
        "{}",
        record.reason
    );
    assert!(
        record
            .reason
            .contains(" of mint 1 outside the pool, the market cannot buy back 200000"),
        "{}",
        record.reason
    );
    assert!(
        record
            .reason
            .ends_with("of the 0.01 SOL in its quote vault after an ordinary buy of 0.01 SOL."),
        "{}",
        record.reason
    );
    // Sold first, the fifth takes all but dust of what the buyer paid in.
    let share = record.numbers["worst_share_ppm"].as_u64().unwrap();
    assert!(share > 999_000, "{}", record.numbers);
    // What the market cannot buy back is the fifth that never came out of its pool, found to
    // about a millionth of the outside supply.
    let row = &record.numbers["mints"][0];
    let unbacked = row["unbacked"].as_u64().unwrap();
    let outside = row["outside"].as_u64().unwrap();
    assert!(
        (SUPPLY / 5..SUPPLY / 5 + outside / 1_000_000).contains(&unbacked),
        "{row}"
    );
    assert!(row["first"]["refused"].is_object(), "{row}");
}

#[test]
fn a_virtual_reserve_seeded_with_the_whole_supply_passes() {
    let mut cluster = Cluster::new();
    let market = cluster.virtual_reserve_market(SUPPLY, SUPPLY);

    let record = record(&cluster, market.market);

    assert_eq!(record.outcome, Outcome::Pass, "{}", record.reason);
    // Only the ordinary buyer's tokens are outside, and the market buys them all back.
    assert!(
        record
            .reason
            .contains("the market can buy back all 333222.259246 of mint 1 outside the pool"),
        "{}",
        record.reason
    );
    assert_eq!(record.numbers["mints"][0]["unbacked"], 0);
}

#[test]
fn a_constant_product_market_with_most_of_its_supply_outside_passes() {
    let mut cluster = Cluster::new();
    // The tests' constant-product markets hold a hundredth of their token's supply.
    let market = cluster.sol_cp_market(30);

    let record = record(&cluster, market.market);

    assert_eq!(record.outcome, Outcome::Pass, "{}", record.reason);
    assert_eq!(record.numbers["mints"][0]["unbacked"], 0);
    assert!(record.numbers["mints"][0]["first"].is_null());
}

/// A measurement whose unbacked part, sold first, takes `taken` of a 1 SOL quote vault.
fn measured(taken: u64) -> Measured {
    Measured {
        money: 0,
        reference: 10_000_000,
        buy_failure: None,
        mints: vec![OutsideMint {
            mint: 1,
            address: Pubkey::new_unique().to_string(),
            decimals: 6,
            money_vault: 1_000_000_000,
            supply: 1_000,
            vault: 800,
            outside: 200,
            all: Some(Sale {
                asked: 200,
                sold: 10,
                taken: 1_000_000_000,
                refused: None,
            }),
            unbacked: 190,
            first: Some(Sale {
                asked: 190,
                sold: 190,
                taken,
                refused: None,
            }),
            failure: None,
        }],
    }
}

#[test]
fn the_warn_starts_at_the_threshold_share_of_the_quote_vault() {
    let words = |amount: u64| format!("{amount} lamports");
    let at = OUTSIDE_SUPPLY_WARN_PPM * 1_000; // of 1 SOL, in lamports

    let below = judge(Some(&measured(at - 1)), &Trading::Open, &words);
    let edge = judge(Some(&measured(at)), &Trading::Open, &words);

    assert_eq!(below.outcome, Outcome::Pass, "{}", below.reason);
    assert_eq!(edge.outcome, Outcome::Warn, "{}", edge.reason);
    assert!(
        edge.reason.contains("sold first, that part would take 10000000 lamports of the 1000000000 lamports in its quote vault"),
        "{}",
        edge.reason
    );
}

#[test]
fn nothing_outside_the_pool_passes_and_closed_trading_is_not_run() {
    let words = |amount: u64| format!("{amount} lamports");
    let mut m = measured(0);
    m.mints[0].outside = 0;
    m.mints[0].all = None;
    m.mints[0].unbacked = 0;
    m.mints[0].first = None;

    let verdict = judge(Some(&m), &Trading::Open, &words);
    assert_eq!(verdict.outcome, Outcome::Pass, "{}", verdict.reason);
    assert!(
        verdict.reason.ends_with("all of mint 1 is in the pool."),
        "{}",
        verdict.reason
    );

    let closed = judge(
        Some(&m),
        &Trading::NotRun("the market refuses every trade".into()),
        &words,
    );
    assert_eq!(closed.outcome, Outcome::NotRun, "{}", closed.reason);
}
