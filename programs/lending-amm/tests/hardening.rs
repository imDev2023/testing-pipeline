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
fn sos_h001_adding_at_the_stored_rate_then_leaving_takes_no_interest_from_the_lps() {
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
fn sos_h003_no_other_rebalance_can_move_kamino_around_a_market_in_withdraw_mode() {
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

    // Each alone it runs: A deposits, and B, seeing a real deposit held in Kamino, starts the
    // wait to leave, which it completes only if the deposit stays for the whole wait.
    env.send_meta(&[rebalance_a], &[&caller]).unwrap();
    env.send_meta(&[rebalance_b], &[&caller]).unwrap();
    let state = env.market_state(&b.market_state);
    assert!(state.withdraw_mode && state.exit_seen_slot > 0);
}

#[test]
fn sos_h002_a_quote_or_swap_refuses_a_reserve_more_than_an_hour_stale_and_no_round_trip_pays() {
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

/// Every call that reads Kamino is refused with `error`, while an LP still leaves in kind.
fn only_in_kind_works(
    env: &mut Env,
    market: &Market,
    lp: &solana_keypair::Keypair,
    error: StrategyError,
) {
    let (other, lent_side) = (market.other_index(), market.lent_index);
    let trader = env.funded_wallet(market, [OTHER, units(0, 10)]);
    for (input, output) in [(other, lent_side), (lent_side, other)] {
        let amount = env.balance(&env.wallet_token_account(market, &trader.pubkey(), input)) / 100;
        assert_refused(env.quote(market, &exact_in(input, output, amount)), error);
        assert_refused(env.swap(market, &trader, (input, output), amount), error);
    }
    let mut max = [0u64; 2];
    max[other] = OTHER / 10;
    max[lent_side] = units(0, 5);
    let adder = env.funded_wallet(market, max);
    // Refused before the reserve's age matters, so no refresh first (klend itself refuses one of
    // a reserve of another version).
    assert_refused(env.add_liquidity(market, &adder, max, 0), error);
    assert_refused(env.rebalance(market, None), error);
    let shares = env.lp_shares_of(market, &lp.pubkey());
    assert_refused(
        env.remove_liquidity(market, lp, shares / 2, [0, 0], Payout::Cash),
        error,
    );
    env.remove_liquidity(market, lp, shares / 2, [0, 0], Payout::InKind)
        .unwrap();
}

#[test]
fn sos_h007_a_market_never_reads_a_reserve_other_than_the_one_it_recorded() {
    // As if an upgrade edited the lent mint's row of `LENT_MINTS`: the market recorded one reserve
    // and the table now names another. It must stop rather than value, lend or redeem elsewhere.
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        env.load_klend();
        let spec = lent_spec(&mut env, lent, 30);
        let (market, lp) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        env.rebalance(&market, None).unwrap();
        // The market state's `reserve` field, after the version, bumps, lent index, fee, mode,
        // both mints and vaults, the market signer, the LP mint and the cToken account.
        let reserve_field = 15 + 6 * 32 + 32;
        env.patch(&market.market_state, reserve_field, &[7u8; 32]);
        only_in_kind_works(&mut env, &market, &lp, StrategyError::ReserveWrongAddress);
    }
}

#[test]
fn sos_h008_a_reserve_of_a_version_this_program_was_not_written_for_is_refused() {
    // A klend upgrade that moved the reserve to a new layout version, keeping its size and
    // discriminator: the market must not price from offsets that may have moved.
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        env.load_klend();
        let spec = lent_spec(&mut env, lent, 30);
        let (market, lp) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        env.rebalance(&market, None).unwrap();
        let reserve = env.reserve_of(&market);
        env.patch(
            &reserve,
            lending_amm::kamino::offsets::VERSION,
            &2u64.to_le_bytes(),
        );
        only_in_kind_works(&mut env, &market, &lp, StrategyError::ReserveWrongVersion);
    }
}

#[test]
fn sos_h006_an_lp_leaves_with_the_lent_side_when_the_other_mint_cannot_move() {
    use lending_amm::events::LentSideRemoved;
    use lending_amm::shares::removal;
    // The other mint keeps a freeze authority, which the mint rules allow (as USDC's), and its
    // authority freezes the market's vault: no removal can pay the other side, so without
    // `remove_lent_side` the LPs' WSOL or USDC would be trapped with it.
    for (lent, entry) in LENT_MINTS.iter().enumerate() {
        let mut env = Env::new();
        env.load_klend();
        let other = env.create_mint_with(
            &TOKEN,
            MintOptions {
                freeze_authority: true,
                ..MintOptions::default()
            },
        );
        let spec = MarketSpec {
            mints: [(other, TOKEN), (ck(&entry.mint), TOKEN)],
            params: lending_amm::InitParams {
                lent_index: 1,
                lp_fee_bps: 30,
            },
        };
        let (market, lp) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        env.rebalance(&market, None).unwrap();
        let freeze = spl_token_2022_interface::instruction::freeze_account(
            &TOKEN,
            &market.vaults[market.other_index()],
            &other,
            &env.admin.pubkey(),
            &[],
        )
        .unwrap();
        env.send(&[freeze], &[]).unwrap();

        let wallet = lp.pubkey();
        let shares = env.lp_shares_of(&market, &wallet);
        assert!(env
            .remove_liquidity(&market, &lp, shares / 2, [0, 0], Payout::InKind)
            .is_err());

        let state = env.market_state(&market.market_state);
        let supply = env.mint_supply(&market.addresses.lp_mint);
        let (other_index, lent_index) = (market.other_index(), market.lent_index);
        let expected = removal(
            shares / 2,
            supply,
            state.reserves[other_index],
            state.reserves[lent_index],
            state.ctokens,
        )
        .unwrap();
        let lent_account = env.wallet_token_account(&market, &wallet, lent_index);
        let lent_before = env.balance(&lent_account);
        let ask = |env: &Env, min: [u64; 2]| {
            env.remove_lent_side_instruction(&market, &wallet, shares / 2, min)
        };
        // Each part has its own minimum, so a trade before the exit that moves the lent side
        // between the buffer and the cTokens, towards the other side the LP gives up, cannot
        // take part of it unbounded (finding R2-01).
        let lent_short = ask(&env, [expected.buffer + 1, 0]);
        assert_refused(
            env.send_meta(&[lent_short], &[&lp]),
            StrategyError::BelowMinLent,
        );
        let ctokens_short = ask(&env, [0, expected.ctokens + 1]);
        assert_refused(
            env.send_meta(&[ctokens_short], &[&lp]),
            StrategyError::BelowMinCtokens,
        );
        let remove = ask(&env, [expected.buffer, expected.ctokens]);
        let meta = env.send_meta(&[remove], &[&lp]).unwrap();

        assert_eq!(env.balance(&lent_account) - lent_before, expected.buffer);
        assert_eq!(
            env.balance(&env.lp_ctoken_account(&market, &wallet)),
            expected.ctokens
        );
        let after = env.market_state(&market.market_state);
        assert_eq!(after.reserves[other_index], state.reserves[other_index]);
        assert_eq!(
            after.reserves[lent_index],
            state.reserves[lent_index] - expected.buffer
        );
        assert_eq!(after.ctokens, state.ctokens - expected.ctokens);
        assert_eq!(env.lp_shares_of(&market, &wallet), shares - shares / 2);
        let event = &events::<LentSideRemoved>(&meta.logs)[0];
        assert_eq!(
            (event.lent, event.ctokens, event.other_left),
            (expected.buffer, expected.ctokens, expected.other)
        );
        println!(
            "lent {lent}: with the other vault frozen, left with {} of the lent mint and {} cTokens, {} of the other side left to the LPs who stay",
            expected.buffer, expected.ctokens, expected.other
        );
    }
}

#[test]
fn sos_h004_one_reading_of_kamino_cannot_take_a_market_out_of_withdraw_mode() {
    // A deposit before `rebalance` and a redeem after it, in separate transactions of one Jito
    // bundle, lift Kamino's free liquidity for that one reading at no risk to whoever does it.
    // Here the free liquidity is set as their deposit and redeem would leave it.
    use lending_amm::config::{
        WITHDRAW_MODE_ENTER, WITHDRAW_MODE_EXIT, WITHDRAW_MODE_EXIT_DELAY_SLOTS,
    };
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        env.load_klend();
        let spec = lent_spec(&mut env, lent, 30);
        let (market, _) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        env.rebalance(&market, None).unwrap();
        let exposure = env.exposure(&market);
        env.set_free_liquidity(&market, WITHDRAW_MODE_ENTER * exposure - 1);
        env.rebalance(&market, None).unwrap();
        assert!(env.market_state(&market.market_state).withdraw_mode);
        let crunch = WITHDRAW_MODE_EXIT * env.exposure(&market);

        // The bundle: free liquidity above the exit threshold for one `rebalance`, then back.
        env.set_free_liquidity(&market, crunch + 1);
        let slot = env.clock().slot;
        env.rebalance(&market, None).unwrap();
        let state = env.market_state(&market.market_state);
        assert!(
            state.withdraw_mode,
            "lent {lent}: one reading took the market out of withdraw mode"
        );
        assert_eq!(state.exit_seen_slot, slot);
        assert_eq!(state.ctokens, 0, "lent {lent}: it lent while waiting");
        env.set_free_liquidity(&market, crunch);

        // The keeper's sweep sees the crunch and starts the wait again.
        env.advance_clock(1_500, 600);
        env.rebalance(&market, None).unwrap();
        assert_eq!(env.market_state(&market.market_state).exit_seen_slot, 0);

        // A second bundle an hour after the first starts a new wait; it does not complete one.
        env.advance_clock(
            WITHDRAW_MODE_EXIT_DELAY_SLOTS,
            (WITHDRAW_MODE_EXIT_DELAY_SLOTS * 2 / 5) as i64,
        );
        env.set_free_liquidity(&market, crunch + 1);
        let slot = env.clock().slot;
        env.rebalance(&market, None).unwrap();
        let state = env.market_state(&market.market_state);
        assert!(state.withdraw_mode);
        assert_eq!(state.exit_seen_slot, slot);

        // Free liquidity that stays above the threshold for the whole wait, through the keeper's
        // sweeps, takes it out, and it lends again in the same call.
        assert_refused(
            env.rebalance(&market, None),
            StrategyError::BelowMinRebalance,
        );
        env.advance_clock(WITHDRAW_MODE_EXIT_DELAY_SLOTS - 1, 3_599);
        assert_refused(
            env.rebalance(&market, None),
            StrategyError::BelowMinRebalance,
        );
        assert!(env.market_state(&market.market_state).withdraw_mode);
        env.advance_clock(1, 1);
        env.rebalance(&market, None).unwrap();
        let state = env.market_state(&market.market_state);
        assert!(!state.withdraw_mode);
        assert_eq!(state.exit_seen_slot, 0);
        assert!(state.ctokens > 0);
    }
}

#[test]
fn sos_r2_04_a_wait_to_leave_withdraw_mode_does_not_outlast_a_kamino_emergency() {
    // A sighting recorded before Kamino stopped redeems must not let the market leave at the
    // first reading after the emergency, with no honest reading possible during it.
    use common::states::KaminoState;
    use lending_amm::config::{
        WITHDRAW_MODE_ENTER, WITHDRAW_MODE_EXIT, WITHDRAW_MODE_EXIT_DELAY_SLOTS as DELAY,
    };
    let lent = 0;
    let mut env = Env::new();
    env.load_klend();
    let spec = lent_spec(&mut env, lent, 30);
    let (market, _) = env
        .create_funded_market(&spec, [OTHER, units(lent, 50)])
        .unwrap();
    env.rebalance(&market, None).unwrap();
    let exposure = env.exposure(&market);
    env.set_free_liquidity(&market, WITHDRAW_MODE_ENTER * exposure - 1);
    env.rebalance(&market, None).unwrap();
    env.set_free_liquidity(&market, WITHDRAW_MODE_EXIT * env.exposure(&market) + 1);
    env.rebalance(&market, None).unwrap();
    assert!(env.market_state(&market.market_state).exit_seen_slot > 0);

    // In emergency mode `rebalance` refuses, except that it forgets the wait.
    env.set_kamino_state(&market, KaminoState::ReserveEmergencyMode);
    env.rebalance(&market, None).unwrap();
    let state = env.market_state(&market.market_state);
    assert!(state.withdraw_mode);
    assert_eq!(state.exit_seen_slot, 0);
    assert_refused(env.rebalance(&market, None), StrategyError::KaminoStopped);

    // After it, an hour on, the first reading above the threshold starts a new wait.
    let reserve = env.reserve_of(&market);
    env.patch(&reserve, lending_amm::kamino::offsets::EMERGENCY_MODE, &[0]);
    env.advance_clock(DELAY, (DELAY * 2 / 5) as i64);
    env.rebalance(&market, None).unwrap();
    let state = env.market_state(&market.market_state);
    assert!(
        state.withdraw_mode,
        "left withdraw mode at the first reading after the emergency"
    );
    assert_eq!(state.exit_seen_slot, env.clock().slot);
}
