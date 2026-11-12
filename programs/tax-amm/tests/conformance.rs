//! Conformance (docs/spec/README.md, "Test layers" 4; docs/spec/tax-amm.md, "`pipeline-check`
//! warns"): Pipeline's `check_market` reports zero Fail and zero Warn on seeded tax markets,
//! with `exact_out_refund` skipped because exact-out is refused by design. A market with a
//! virtual reserve is checked with explicit amounts, since `pipeline-check` sizes its
//! trades from vault balances.

mod common;

use common::*;
use pipeline_check::{check_market, CheckOptions, Status};
use pipeline_client::Pubkey;
use tax_amm::InitParams;

fn check(env: &Env, market: &Market, options: &CheckOptions, what: &str) {
    let report = check_market(&env.svm, market.market, options);
    println!("{what}:\n{}", report.to_text());
    let worse: Vec<String> = report
        .checks
        .iter()
        .filter(|check| matches!(check.status, Status::Fail | Status::Warn))
        .map(|check| format!("{} ({:?}): {}", check.id, check.status, check.message))
        .collect();
    assert!(worse.is_empty(), "{what}: {worse:#?}");
    assert_eq!(
        report.status("exact_out_refund"),
        Some(Status::Skip),
        "{what}"
    );
    // Every other check ran and passed: none was skipped for want of a quote or a swap.
    for check in report
        .checks
        .iter()
        .filter(|check| check.id != "exact_out_refund")
    {
        assert_eq!(check.status, Status::Pass, "{what}: {}", check.id);
    }
    assert_eq!(
        report.checks.len(),
        14,
        "{what}: every check of pipeline-check"
    );
}

fn params(tax_side: u8, buy: u16, sell: u16) -> InitParams {
    let mut p = valid_params(&Pubkey::new_unique());
    p.tax_side = tax_side;
    p.buy_tax_min_bps = 0;
    p.buy_tax_max_bps = 1_000;
    p.buy_tax_bps = buy;
    p.sell_tax_bps = sell;
    p
}

#[test]
fn seeded_markets_pass_every_check() {
    let cases = [
        (
            "SPL Token, typical taxes on side 1",
            [TOKEN, TOKEN],
            1,
            300,
            500,
        ),
        (
            "Token-2022, the highest taxes on side 0",
            [TOKEN_2022, TOKEN_2022],
            0,
            1_000,
            1_000,
        ),
        ("mixed, no tax", [TOKEN, TOKEN_2022], 1, 0, 0),
    ];
    for (what, programs, tax_side, buy, sell) in cases {
        let mut env = Env::new();
        let mints = programs.map(|program| (env.create_mint(&program), program));
        let market = env.seeded_market(
            mints,
            &params(tax_side, buy, sell),
            [100_000_000_000, 200_000_000_000],
        );
        check(&env, &market, &CheckOptions::default(), what);
    }
}

#[test]
fn a_seeded_market_with_a_hooked_mint_passes_every_check() {
    let mut env = Env::new();
    let hooked = env.create_hooked_mint();
    let plain = env.create_mint(&TOKEN);
    let market = env.seeded_market(
        [(plain, TOKEN), (hooked, TOKEN_2022)],
        &params(0, 300, 500),
        [100_000_000_000, 200_000_000_000],
    );
    check(
        &env,
        &market,
        &CheckOptions::default(),
        "a hooked mint on side 1",
    );
}

#[test]
fn a_market_launched_single_sided_on_a_virtual_reserve_passes_every_check_given_amounts() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let mut p = params(1, 300, 500);
    p.virtual_side = 1;
    p.virtual_reserve = 50_000_000_000;
    let market = env.seeded_market(mints, &p, [1_000_000_000_000, 0]);
    // Someone buys first, so side 1 holds a real reserve to sell back from.
    let trader = env.funded_wallet(&market, 100_000_000_000);
    env.swap(&market, &trader, (1, 0), 10_000_000_000).unwrap();
    let options = CheckOptions {
        amounts: Some(vec![1_000_000, 100_000_000, 1_000_000_000]),
        ..CheckOptions::default()
    };
    check(&env, &market, &options, "single-sided on a virtual reserve");
}
