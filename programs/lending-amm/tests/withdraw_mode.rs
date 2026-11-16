//! Withdraw mode: `rebalance` measures Kamino's freely available liquidity against
//! `X = max(V, T)`, the larger of the market's lent value and its target lent value; below
//! `WITHDRAW_MODE_ENTER` times `X` the market enters withdraw mode and redeems everything Kamino
//! can pay, above `WITHDRAW_MODE_EXIT` times `X` it leaves, and between the two it keeps the mode
//! it has (docs/spec/lending-pool.md, "Withdraw mode").
//!
//! Every transaction goes through the real programs: the router copied from devnet, the lending
//! AMM, and klend's deployed bytes with the Kamino accounts dumped from the cluster this build
//! lends on, each state of Kamino made by editing those accounts.

mod common;

use common::rebalance::{lent_spec, units, OTHER};
use common::*;
use lending_amm::config::{LENT_MINTS, WITHDRAW_MODE_ENTER, WITHDRAW_MODE_EXIT};
use lending_amm::events::{RebalanceDirection, Rebalanced, WithdrawModeEntered, WithdrawModeLeft};
use lending_amm::StrategyError;

/// A market lending `LENT_MINTS[lent]`, opened with `[OTHER, 50 units]` and rebalanced, so it
/// holds real cTokens from klend's deposit and its buffer is at its target.
fn lent_market(env: &mut Env, lent: usize) -> Market {
    let spec = lent_spec(env, lent, 30);
    let (market, _) = env
        .create_funded_market(&spec, [OTHER, units(lent, 50)])
        .unwrap();
    env.rebalance(&market, None).unwrap();
    assert!(env.market_state(&market.market_state).ctokens > 0);
    market
}

#[test]
fn below_the_entry_threshold_rebalance_enters_withdraw_mode_and_redeems_everything_kamino_can_pay()
{
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        let market = lent_market(&mut env, lent);
        let held = env.market_state(&market.market_state).ctokens;
        let total = env.lent_total(&market);
        let exposure = env.exposure(&market);
        let free = WITHDRAW_MODE_ENTER * exposure - 1;
        env.set_free_liquidity(&market, free);

        let meta = env.rebalance(&market, None).unwrap();

        let state = env.market_state(&market.market_state);
        println!(
            "lent {lent}: X {exposure}, Kamino free {free}: withdraw mode, redeemed {} for {held} cTokens",
            state.redeemed
        );
        assert!(state.withdraw_mode);
        // Everything: Kamino could pay the whole position, so every cToken was redeemed.
        assert_eq!(state.ctokens, 0);
        assert_eq!(env.balance(&market.addresses.ctoken_account), 0);
        // klend pays at the rate it refreshes to, at least the stored one; its rounding may cost
        // the lent side one unit, and no more.
        let after = env.lent_total(&market);
        assert!(after + 1 >= total, "{total} {after}");

        let entered = events::<WithdrawModeEntered>(&meta.logs);
        assert_eq!(entered.len(), 1);
        assert_eq!(entered[0].market_state, ak(&market.market_state));
        assert_eq!(entered[0].free_liquidity, free);
        assert_eq!(entered[0].exposure, exposure);
        let rebalanced = events::<Rebalanced>(&meta.logs);
        assert_eq!(rebalanced.len(), 1);
        assert_eq!(rebalanced[0].direction, RebalanceDirection::Redeem);
        assert_eq!(rebalanced[0].ctokens, held);
    }
}

#[test]
fn in_withdraw_mode_it_stays_while_kamino_is_at_or_below_the_exit_threshold_then_leaves_and_lends_again(
) {
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        let market = lent_market(&mut env, lent);
        let exposure = env.exposure(&market);
        env.set_free_liquidity(&market, WITHDRAW_MODE_ENTER * exposure - 1);
        env.rebalance(&market, None).unwrap();
        assert_eq!(env.market_state(&market.market_state).ctokens, 0);

        // Everything is redeemed, so V is 0, but X is still the target lent value T: a second
        // call neither deposits nor leaves, and refuses as a no-op, changing nothing.
        let exposure = env.exposure(&market);
        let total = env.lent_total(&market);
        assert_eq!(exposure, total - lending_amm::buffer::target(total));
        for free in [
            WITHDRAW_MODE_ENTER * exposure - 1,
            WITHDRAW_MODE_ENTER * exposure,
            WITHDRAW_MODE_EXIT * exposure,
        ] {
            env.set_free_liquidity(&market, free);
            let before = env.market_state(&market.market_state);
            assert_refused(
                env.rebalance(&market, None),
                StrategyError::BelowMinRebalance,
            );
            assert_eq!(
                env.market_state(&market.market_state),
                before,
                "free {free}"
            );
            assert!(before.withdraw_mode);
        }

        // One unit above the exit threshold it leaves, and the band applies again in the same
        // call: the buffer holds the whole lent side, so it lends the surplus.
        let free = WITHDRAW_MODE_EXIT * exposure + 1;
        env.set_free_liquidity(&market, free);
        let meta = env.rebalance(&market, None).unwrap();
        let state = env.market_state(&market.market_state);
        println!("lent {lent}: left withdraw mode at {free} free, X {exposure}, lent again for {} cTokens", state.ctokens);
        assert!(!state.withdraw_mode);
        assert!(state.ctokens > 0);
        let left = events::<WithdrawModeLeft>(&meta.logs);
        assert_eq!(left.len(), 1);
        assert_eq!((left[0].free_liquidity, left[0].exposure), (free, exposure));
        assert!(events::<WithdrawModeEntered>(&meta.logs).is_empty());
        assert_eq!(
            events::<Rebalanced>(&meta.logs)[0].direction,
            RebalanceDirection::Deposit
        );
    }
}

#[test]
fn between_the_thresholds_a_market_keeps_the_mode_it_has() {
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        let market = lent_market(&mut env, lent);
        // Out of withdraw mode, Kamino anywhere from the entry threshold to the exit threshold:
        // the band applies, and the buffer is at its target, so there is nothing to do.
        let exposure = env.exposure(&market);
        for free in [
            WITHDRAW_MODE_ENTER * exposure,
            WITHDRAW_MODE_EXIT * exposure,
        ] {
            env.set_free_liquidity(&market, free);
            assert_refused(env.rebalance(&market, None), StrategyError::WithinBand);
            assert!(!env.market_state(&market.market_state).withdraw_mode);
        }
    }
}

#[test]
fn a_market_that_has_lent_nothing_makes_no_first_deposit_into_a_reserve_below_the_entry_threshold()
{
    for lent in 0..LENT_MINTS.len() {
        let mut env = Env::new();
        let spec = lent_spec(&mut env, lent, 30);
        let (market, _) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        // V is 0, so X is T alone, 80% of the lent side.
        let exposure = env.exposure(&market);
        assert_eq!(exposure, units(lent, 40));
        env.set_free_liquidity(&market, WITHDRAW_MODE_ENTER * exposure - 1);

        let meta = env.rebalance(&market, None).unwrap();
        let state = env.market_state(&market.market_state);
        assert!(state.withdraw_mode);
        assert_eq!((state.ctokens, state.deposited), (0, 0));
        assert_eq!(state.reserves[market.lent_index], units(lent, 50));
        assert_eq!(events::<WithdrawModeEntered>(&meta.logs).len(), 1);
        assert!(events::<Rebalanced>(&meta.logs).is_empty());
        // And at the entry threshold itself, a fresh market lends as usual.
        let mut env = Env::new();
        let spec = lent_spec(&mut env, lent, 30);
        let (market, _) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        env.set_free_liquidity(&market, WITHDRAW_MODE_ENTER * exposure);
        env.rebalance(&market, None).unwrap();
        assert!(env.market_state(&market.market_state).ctokens > 0);
    }
}
