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

/// The checks whose buys go into `pipeline-check`'s own trader accounts, which it writes
/// without the immutable owner extension every real Token-2022 associated token account has:
/// on a market with a contained mint the containment hook refuses those buys
/// (`DestinationOwnerCanChange`, `HOOK-47`), so these fail there until Pipeline's checker
/// writes the extension.
const KNOWN_ON_CONTAINED: [&str; 2] = ["quote_matches_swap", "round_trip"];

fn check(env: &Env, market: &Market, options: &CheckOptions, what: &str) {
    let report = check_market(&env.svm, market.market, options);
    println!("{what}:\n{}", report.to_text());
    judge(&report, what, &[], None);
}

/// [`check`] on a market with a contained mint at `contained_index`: the [`KNOWN_ON_CONTAINED`]
/// checks must fail, only with error 6023, and only once a buy into an account like the
/// checker's own shows the containment hook itself raising it as `DestinationOwnerCanChange`,
/// since 6023 is other programs' number too.
fn check_contained(
    env: &mut Env,
    market: &Market,
    contained_index: usize,
    options: &CheckOptions,
    what: &str,
) {
    let report = check_market(&env.svm, market.market, options);
    println!("{what}:\n{}", report.to_text());
    let shown = env
        .show_hook_refusal(market, contained_index)
        .unwrap_or_else(|why| panic!("{what}: {why}"));
    judge(&report, what, &KNOWN_ON_CONTAINED, Some(&shown));
}

fn judge(
    report: &pipeline_check::Report,
    what: &str,
    known: &[&str],
    shown: Option<&HookRefusalShown>,
) {
    for id in known {
        let check = report.checks.iter().find(|check| check.id == *id).unwrap();
        assert!(
            matches!(check.status, Status::Fail | Status::Warn),
            "{what}: {id} passed, so Pipeline's checker may now write the immutable owner \
             extension and HOOK-47's known failures can go"
        );
        let shown = shown.expect("known failures are accepted only with the hook's refusal shown");
        if let Err(reason) = known_failure_is_the_hooks(check, shown) {
            panic!("{what}: {reason}");
        }
    }
    let worse: Vec<String> = report
        .checks
        .iter()
        .filter(|check| !known.contains(&check.id.as_str()))
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
        .filter(|check| check.id != "exact_out_refund" && !known.contains(&check.id.as_str()))
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
fn a_seeded_market_with_a_contained_mint_passes_every_check() {
    // The containment hook is the one transfer hook a market's mint may run, in its home
    // market.
    let mut env = Env::new();
    let market = env.contained_market(1, [100_000_000_000, 200_000_000_000]);
    check_contained(
        &mut env,
        &market,
        1,
        &CheckOptions::default(),
        "a contained mint on side 1",
    );
}

#[test]
fn the_hooks_refusal_is_not_shown_on_a_market_whose_mint_has_no_hook() {
    // The evidence the known failures need is the hook's own refusal: a buy into an account
    // without the immutable owner extension, of a Token-2022 mint with no hook, goes through.
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
        (env.create_mint(&TOKEN), TOKEN),
    ];
    let market = env.seeded_market(
        mints,
        &params(1, 300, 500),
        [100_000_000_000, 200_000_000_000],
    );
    let why = env.show_hook_refusal(&market, 0).unwrap_err();
    assert!(why.contains("went through"), "{why}");
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

#[test]
fn a_market_a_launchpad_seeded_passes_every_check() {
    let mut env = Env::new();
    let mints = [
        (env.create_mint(&TOKEN), TOKEN),
        (env.create_mint(&TOKEN_2022), TOKEN_2022),
    ];
    let amounts = [100_000_000_000, 200_000_000_000];
    let launch = env.launch(mints, amounts);
    let graduated = env
        .graduate(&launch, &params(1, 300, 500), amounts)
        .unwrap();
    check(
        &env,
        &graduated.market,
        &CheckOptions::default(),
        "seeded by the stand-in launchpad through pipeline_seed_liquidity",
    );
}
