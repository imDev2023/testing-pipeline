//! Conformance (docs/spec/README.md, "Test layers" 4; docs/spec/pool4-for-solana.md,
//! "Accepted `pipeline-check` warnings"): Pipeline's `check_market` reports zero Fail and
//! zero Warn on seeded buy wall markets, with `exact_out_refund` skipped because exact-out
//! is refused by design; every other check runs and passes.

mod common;

use buy_wall_amm::config::{MAX_FEE_BPS, MIN_FEE_BPS};
use common::*;
use pipeline_check::{check_market, CheckOptions, Status};
use solana_signer::Signer;

fn check(env: &Env, market: &Market, what: &str) {
    let report = check_market(&env.svm, market.market, &CheckOptions::default());
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
    for check in report
        .checks
        .iter()
        .filter(|check| check.id != "exact_out_refund")
    {
        assert_eq!(check.status, Status::Pass, "{what}: {}", check.id);
    }
    assert_eq!(
        report.checks.len(),
        pipeline_check::CHECKS.len(),
        "{what}: every check of pipeline-check"
    );
}

#[test]
fn seeded_markets_pass_every_check() {
    for (what, program, fee_bps, wall_split_bps, tokens, lamports) in [
        (
            "SPL Token, IMD's launch values",
            TOKEN,
            100,
            5_000,
            1_000_000_000_000,
            10 * SOL,
        ),
        (
            "Token-2022, the lowest fee, no wall split",
            TOKEN_2022,
            MIN_FEE_BPS,
            0,
            1_000_000_000_000,
            10 * SOL,
        ),
        (
            "SPL Token, the highest fee, all to the wall, a small seed",
            TOKEN,
            MAX_FEE_BPS,
            10_000,
            50_000_000_000,
            buy_wall_amm::config::MIN_SEED_LAMPORTS,
        ),
    ] {
        let mut env = Env::new();
        let token = env.seedable_token(&program);
        let mut params = launch_params(env.admin.pubkey());
        params.fee_bps = fee_bps;
        params.wall_split_bps = wall_split_bps;
        let (market, _) = env
            .create_and_seed(token, program, &params, tokens, lamports)
            .unwrap();
        check(&env, &market, what);
    }
}

#[test]
fn a_seeded_market_of_a_token_with_a_transfer_hook_passes_every_check() {
    let mut env = Env::new();
    let token = env.seedable_hooked_token();
    let market = env
        .create_and_seed_hooked(
            token,
            &launch_params(env.admin.pubkey()),
            1_000_000_000_000,
            10 * SOL,
        )
        .unwrap();
    check(&env, &market, "a token with Pipeline's test-hook");
}

#[test]
fn markets_seeded_by_another_program_pass_every_check() {
    for (what, hooked) in [
        (
            "seeded by the stand-in launchpad through pipeline_seed_liquidity",
            false,
        ),
        (
            "a token with Pipeline's test-hook, seeded by the stand-in launchpad",
            true,
        ),
    ] {
        let mut env = Env::new();
        let (token, program) = if hooked {
            (env.seedable_hooked_token(), TOKEN_2022)
        } else {
            (env.seedable_token(&TOKEN), TOKEN)
        };
        let launch = env.launch(token, program, 1_000_000_000_000, 10 * SOL);
        let graduated = env
            .graduate(
                &launch,
                &launch_params(pipeline_client::Pubkey::new_unique()),
                1_000_000_000_000,
                10 * SOL,
            )
            .unwrap();
        check(&env, &graduated.market, what);
    }
}
