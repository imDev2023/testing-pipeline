//! Regression tests for the findings of the lending AMM's internal adversarial review
//! (`docs/security/lending-amm/`), each named `sos_<finding id>`, against the router copied from
//! devnet, klend's deployed bytes and the Kamino accounts dumped from the cluster this build
//! lends on.

mod common;

use common::rebalance::{lent_spec, units, OTHER};
use common::remove::Payout;
use common::*;
use lending_amm::config::LENT_MINTS;
use lending_amm::StrategyError;
use pipeline_client::TradeMode;
use solana_signer::Signer;

/// How far behind the clock a reserve's last refresh may be on the cluster the program deploys
/// to: our devnet WSOL reserve was dumped 777,050 slots after its last refresh.
const STALE_SLOTS: u64 = 800_000;

/// A market lending `LENT_MINTS[lent]` at an LP fee of 0, opened with `[OTHER, 50 units]` and
/// rebalanced, so four fifths of its lent side are cTokens; then borrowers take the reserve's
/// free liquidity down to 5 times what the market lends, so interest accrues, and the clock moves
/// on `STALE_SLOTS` slots with no refresh of the reserve.
fn stale_market(env: &mut Env, lent: usize) -> Market {
    env.load_klend();
    let spec = lent_spec(env, lent, 0);
    let (market, _) = env
        .create_funded_market(&spec, [OTHER, units(lent, 50)])
        .unwrap();
    env.rebalance(&market, None).unwrap();
    let lent_value = env.lent_total(&market) - env.buffer(&market);
    env.set_free_liquidity(&market, 5 * lent_value);
    env.advance_clock(STALE_SLOTS, (STALE_SLOTS * 2 / 5) as i64);
    market
}

#[test]
fn sos_stale_entry_adding_at_the_stored_rate_then_leaving_takes_no_interest_from_the_lps() {
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        let market = stale_market(&mut env, lent);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let state = env.market_state(&market.market_state);
        let total = env.lent_total(&market);

        // Ten times the market, at its ratio, added at the stored rate, which has not counted
        // `STALE_SLOTS` slots of interest: refused.
        let mut amounts = [0u64; 2];
        amounts[other] = 10 * state.reserves[other];
        amounts[lent_side] = 10 * total;
        let attacker = env.funded_wallet(&market, amounts);
        let add = env.add_liquidity_instruction(&market, &attacker.pubkey(), amounts, 0);
        assert_refused(
            env.send_meta(std::slice::from_ref(&add), &[&attacker]),
            StrategyError::ReserveStale,
        );
        // A refresh earlier in the same slot but not in the transaction would do as well; a
        // slot later it is stale again.
        let refresh = env.refresh_reserve_instruction(&market);
        env.send(&[refresh], &[]).unwrap();
        env.advance_clock(1, 1);
        assert_refused(
            env.send_meta(std::slice::from_ref(&add), &[&attacker]),
            StrategyError::ReserveStale,
        );

        // With klend's refresh first, the deposit buys its share at the rate klend refreshed to,
        // and leaving at once, in kind, takes back no more than it put in.
        let refresh = env.refresh_reserve_instruction(&market);
        let add = env.add_liquidity_instruction(&market, &attacker.pubkey(), amounts, 0);
        env.send_meta(&[refresh, add], &[&attacker]).unwrap();
        let shares = env.lp_shares_of(&market, &attacker.pubkey());
        env.remove_liquidity(&market, &attacker, shares, [0, 0], Payout::InKind)
            .unwrap();
        let fresh = env.program_reserve(&market);
        let wallet = attacker.pubkey();
        let ctokens = env.balance_or_zero(&env.lp_ctoken_account(&market, &wallet));
        let paid_other =
            amounts[other] - env.balance(&env.wallet_token_account(&market, &wallet, other));
        let paid_lent = amounts[lent_side]
            - env.balance(&env.wallet_token_account(&market, &wallet, lent_side));
        let ctoken_value = fresh.lent_value(ctokens).unwrap();
        println!("lent {lent}: paid {paid_other} other and {paid_lent} lent net, got back {ctoken_value} in cTokens");
        assert!(
            ctoken_value <= paid_lent,
            "lent {lent}: took {} of the LPs' interest",
            ctoken_value - paid_lent
        );
        assert!(paid_other < u64::MAX);
    }
}

#[test]
fn sos_rebalance_alone_no_other_rebalance_can_move_kamino_around_a_market_in_withdraw_mode() {
    // Market B is in withdraw mode, with Kamino's free liquidity right at its exit threshold.
    // Market A, on the same reserve, holds its whole lent side in its buffer, so its `rebalance`
    // deposits. With both in one transaction, A's deposit would lift Kamino's free liquidity past
    // B's exit threshold for B's `rebalance` alone, so B would lend into the crunch, and a third
    // market's redeem after it could take that liquidity straight back out: the very move
    // `rebalance`'s rule against sharing its transaction exists to stop.
    use lending_amm::config::{WITHDRAW_MODE_ENTER, WITHDRAW_MODE_EXIT};
    use solana_keypair::Keypair;
    let lent = 0;
    let mut env = Env::new();
    env.load_klend();
    let spec = lent_spec(&mut env, lent, 30);
    let (b, _) = env
        .create_funded_market(&spec, [OTHER, units(lent, 50)])
        .unwrap();
    env.rebalance(&b, None).unwrap();
    let exposure = env.exposure(&b);
    env.set_free_liquidity(&b, WITHDRAW_MODE_ENTER * exposure - 1);
    env.rebalance(&b, None).unwrap();
    assert!(env.market_state(&b.market_state).withdraw_mode);

    let spec = lent_spec(&mut env, lent, 100);
    let (a, _) = env
        .create_funded_market(&spec, [OTHER, units(lent, 50)])
        .unwrap();
    let b_exposure = env.exposure(&b);
    env.set_free_liquidity(&b, WITHDRAW_MODE_EXIT * b_exposure);
    assert!(env.free_liquidity(&b) >= WITHDRAW_MODE_ENTER * env.exposure(&a));
    let before = env.market_state(&b.market_state);

    let caller = Keypair::new();
    env.svm.airdrop(&caller.pubkey(), 10 * SOL).unwrap();
    let rebalance_a = env.rebalance_instruction(&a, &caller.pubkey());
    let rebalance_b = env.rebalance_instruction(&b, &caller.pubkey());
    assert_refused(
        env.send_meta(&[rebalance_a.clone(), rebalance_b.clone()], &[&caller]),
        lending_amm::StrategyError::RebalanceNotAlone,
    );
    assert_eq!(env.market_state(&b.market_state), before);

    // Each alone it runs: A deposits, and B, seeing a real deposit held in Kamino, leaves.
    env.send_meta(&[rebalance_a], &[&caller]).unwrap();
    env.send_meta(&[rebalance_b], &[&caller]).unwrap();
    assert!(!env.market_state(&b.market_state).withdraw_mode);
}

#[test]
fn sos_stale_trade_a_quote_or_swap_refuses_a_reserve_more_than_an_hour_stale_and_no_round_trip_pays(
) {
    use lending_amm::config::TRADE_MAX_RESERVE_AGE_SLOTS;
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        let market = stale_market(&mut env, lent);
        let (other, lent_side) = (market.other_index(), market.lent_index);
        let size = env.lent_total(&market) / 10;
        let trader = env.funded_wallet(&market, [10 * size, 10 * size]);
        let sell = exact_in(lent_side, other, size);
        assert_refused(env.quote(&market, &sell), StrategyError::ReserveStale);
        assert_refused(
            env.swap(&market, &trader, (lent_side, other), size),
            StrategyError::ReserveStale,
        );

        // klend's refresh first in the same transaction, and the trade goes through.
        let refresh = env.refresh_reserve_instruction(&market);
        let swap = env
            .swap_instruction(
                &market,
                &trader.pubkey(),
                (lent_side, other),
                size,
                TradeMode::ExactIn,
            )
            .unwrap();
        env.send_meta(&[refresh, swap], &[&trader]).unwrap();

        // At the bound's edge it trades, a slot later it refuses: the most interest a trade at the
        // stored rate can leave out is `TRADE_MAX_RESERVE_AGE_SLOTS` slots' worth.
        env.advance_clock(
            TRADE_MAX_RESERVE_AGE_SLOTS,
            (TRADE_MAX_RESERVE_AGE_SLOTS * 2 / 5) as i64,
        );
        env.quote(&market, &sell).unwrap();
        env.advance_clock(1, 1);
        assert_refused(env.quote(&market, &sell), StrategyError::ReserveStale);

        // A round trip across a refresh from the bound's edge, at an LP fee of 0 and with
        // borrowers holding the reserve near its steepest rate: sell the lent mint at the stored
        // rate, refresh, buy it back. Pipeline's fee on both legs outweighs the interest.
        let refresh = env.refresh_reserve_instruction(&market);
        env.send(&[refresh], &[]).unwrap();
        env.advance_clock(
            TRADE_MAX_RESERVE_AGE_SLOTS,
            (TRADE_MAX_RESERVE_AGE_SLOTS * 2 / 5) as i64,
        );
        let wallet = trader.pubkey();
        let lent_account = env.wallet_token_account(&market, &wallet, lent_side);
        let other_account = env.wallet_token_account(&market, &wallet, other);
        let (lent_before, other_before) = (env.balance(&lent_account), env.balance(&other_account));
        let stale_value = env
            .program_reserve(&market)
            .lent_value(env.market_state(&market.market_state).ctokens)
            .unwrap();
        env.swap(&market, &trader, (lent_side, other), size)
            .unwrap();
        let refresh = env.refresh_reserve_instruction(&market);
        env.send(&[refresh], &[]).unwrap();
        let fresh_value = env
            .program_reserve(&market)
            .lent_value(env.market_state(&market.market_state).ctokens)
            .unwrap();
        let received = env.balance(&other_account) - other_before;
        env.swap(&market, &trader, (other, lent_side), received)
            .unwrap();
        let back = env.balance(&lent_account) as i128 - lent_before as i128;
        println!(
            "lent {lent}: an hour's interest raised V by {} bps; the round trip of {size} returned {back}",
            (fresh_value - stale_value) as u128 * 10_000 / stale_value as u128
        );
        assert!(back < 0, "lent {lent}: the round trip paid {back}");
    }
}
