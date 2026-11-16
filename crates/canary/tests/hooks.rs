//! Transfer-hook accounts, resolved as `pipeline-check` resolves them, for every trade of
//! every check (`docs/spec/pipescope-canary.md`, "How a run works"): a market whose token
//! has one of Pipeline's test hooks is bought and sold like any other.

mod common;

use canary::{run_market, MarketResults, Outcome, RunOptions};
use common::{deploy, whitelist_hooked_market, Cluster, Extensions, Market, TEST_HOOK_REFILL};
use pipeline_check::SvmSource;

fn run(cluster: &Cluster, market: &Market) -> MarketResults {
    run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market.market,
        &RunOptions::default(),
    )
    .into_results()
    .expect("a full source never lacks an account")
}

#[test]
fn a_market_whose_token_has_a_whitelist_hook_is_bought_and_sold_at_every_size() {
    let mut cluster = Cluster::new();
    let market = whitelist_hooked_market(&mut cluster);

    let run = run(&cluster, &market);

    for check in ["exit_sizes", "quote_matches_swap", "cost"] {
        let record = run.record(check);
        assert_eq!(record.outcome, Outcome::Pass, "{check}: {}", record.reason);
    }
    let sizes = run.record("exit_sizes").numbers["pairs"][0]["sizes"].clone();
    assert!(
        sizes
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s["sold_back"] == true),
        "{sizes}"
    );
    assert_control_checks_trade_through_the_hook(&run);
}

/// The control checks' own trades pass the hook's accounts too: the direct calls reach the
/// strategy, which refuses them itself, and the mint authority's sale goes through.
fn assert_control_checks_trade_through_the_hook(run: &MarketResults) {
    let direct = run.record("direct_call");
    assert_eq!(direct.outcome, Outcome::Pass, "{}", direct.reason);
    for attempt in direct.numbers["attempts"].as_array().unwrap() {
        assert_eq!(attempt["failure"]["class"], "strategy_refused", "{attempt}");
    }
    let authorities = run.record("token_authorities");
    assert_eq!(authorities.outcome, Outcome::Warn, "{}", authorities.reason);
    let minted = authorities.numbers["actions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["power"] == "mint_authority")
        .unwrap();
    assert!(
        minted["sales"][0]["received"].as_u64().unwrap() > 0,
        "{minted}"
    );
}

#[test]
fn a_market_whose_token_has_the_refill_hook_is_bought_and_sold_at_every_size() {
    let mut cluster = Cluster::new();
    let admin = cluster.admin_key();
    deploy(
        &mut cluster.svm,
        TEST_HOOK_REFILL,
        "test_hook_refill",
        Some(admin),
    );
    let token = cluster.create_mint_2022(
        6,
        &Extensions {
            transfer_hook: Some((TEST_HOOK_REFILL, Some(admin))),
            ..Extensions::default()
        },
    );
    let (stash, _) = cluster.init_refill_hook(&token, 0);
    let market = cluster.sol_market_of(token);
    // A stash for the trades' transfers to empty.
    cluster.edit(&stash, |data| {
        data[64..72].copy_from_slice(&1_000u64.to_le_bytes())
    });

    let run = run(&cluster, &market);

    for check in ["exit_sizes", "quote_matches_swap", "cost"] {
        let record = run.record(check);
        assert_eq!(record.outcome, Outcome::Pass, "{check}: {}", record.reason);
    }
    assert_control_checks_trade_through_the_hook(&run);
}
