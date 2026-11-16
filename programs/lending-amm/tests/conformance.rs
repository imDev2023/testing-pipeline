//! Conformance (docs/spec/README.md, "Test layers" 4): `pipeline-check` quotes and swaps
//! the market in every direction and size through the real router, and must report zero
//! Fail and zero Warn; the exact-out checks are skipped by design, since the lending AMM
//! refuses exact-out (docs/spec/lending-pool.md, "Accepted `pipeline-check` warnings").

mod common;

use common::*;
use pipeline_check::{check_market, CheckOptions, Status};

fn assert_conforms(env: &Env, market: &Market) {
    assert_conforms_with(env, market, &CheckOptions::default());
}

fn assert_conforms_with(env: &Env, market: &Market, options: &CheckOptions) {
    let report = check_market(&env.svm, market.market, options);
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

#[test]
fn quotes_equal_swaps_on_both_sides_of_the_buffers_edge() {
    // pipeline-check's default sizes come from vault balances and never pay out more than the
    // lent-mint vault, the buffer, holds; explicit sizes do: a sell paying out half the buffer
    // and one paying out 1.4 times it, which redeems from Kamino in the swap. Every check passes
    // with them, `quote_matches_swap` and `transaction_size` (with the redeem accounts) included.
    for lent_entry in 0..2 {
        let mut env = Env::new();
        let market = env.lending_market(lent_entry, 30);
        let (other, lent) = (market.other_index(), market.lent_index);
        let buffer = env.buffer(&market);
        let within = env.largest_sell_within(&market, buffer / 2);
        let beyond = env.sell_paying(&market, buffer / 10 * 14);
        let pays = |amount| {
            env.quote(&market, &exact_in(other, lent, amount))
                .unwrap()
                .amount_out
        };
        assert!(pays(within) <= buffer && pays(beyond) > buffer);
        let options = CheckOptions {
            amounts: Some(vec![within / 100, within, beyond]),
            ..CheckOptions::default()
        };
        assert_conforms_with(&env, &market, &options);
    }
}

#[test]
fn a_market_in_withdraw_mode_passes_every_check() {
    // Kamino's free liquidity falls below WITHDRAW_MODE_ENTER times the market's exposure:
    // rebalance enters withdraw mode and redeems everything Kamino can pay, and the market, its
    // lent side now all in the buffer, passes while Kamino stays thin.
    for lent_entry in 0..2 {
        let mut env = Env::new();
        let market = env.lending_market(lent_entry, 30);
        let exposure = env.exposure(&market);
        env.set_free_liquidity(
            &market,
            lending_amm::config::WITHDRAW_MODE_ENTER * exposure - 1,
        );
        env.rebalance(&market, None).unwrap();
        let state = env.market_state(&market.market_state);
        assert!(state.withdraw_mode && state.ctokens == 0);
        assert_conforms(&env, &market);
    }
}

#[test]
fn a_market_whose_reserve_or_lending_market_is_in_emergency_mode_passes_every_check() {
    // Kamino redeems nothing, so the market trades from its buffer alone, its lent side still
    // valued at the stored rate; pipeline-check's sizes stay within the buffer and pass.
    use common::states::KaminoState;
    for lent_entry in 0..2 {
        for state in [
            KaminoState::ReserveEmergencyMode,
            KaminoState::MarketEmergencyMode,
        ] {
            let mut env = Env::new();
            let market = env.lending_market(lent_entry, 30);
            env.set_kamino_state(&market, state);
            assert_conforms(&env, &market);
        }
    }
}

#[test]
fn a_market_seeded_by_a_launchpad_passes_every_check_and_again_once_it_has_lent() {
    // Seeded by the stand-in launchpad and recorded with the router in the same transaction,
    // its shares locked, on a plain token and a hooked one; then rebalance lends.
    for hooked in [false, true] {
        let mut env = Env::new();
        env.load_klend();
        let token = if hooked {
            (env.create_hooked_mint().0, TOKEN_2022)
        } else {
            (env.create_mint(&TOKEN), TOKEN)
        };
        let seed = [1_000_000_000_000, 50 * SOL];
        let launch = env.launch([token, (wsol(), TOKEN)], seed);
        let params = lending_amm::InitParams {
            lent_index: 1,
            lp_fee_bps: 30,
        };
        let authority = launch.addresses(&params).authority;
        let market = env
            .graduate(&launch, &params, seed, &authority)
            .unwrap()
            .market;
        assert_conforms(&env, &market);
        env.rebalance(&market, None).unwrap();
        assert!(env.market_state(&market.market_state).ctokens > 0);
        assert_conforms(&env, &market);
    }
}
