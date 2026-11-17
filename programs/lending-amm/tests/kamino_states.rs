//! "When Kamino can't pay": the market has no switches of its own and reads Kamino's state at
//! each call, so every row of the spec's table is checked here in every column, for quotes and
//! swaps, `rebalance`, adding and removing (docs/spec/lending-pool.md, "When Kamino can't pay").
//!
//! | Kamino's state | Swaps | `rebalance` | Adding liquidity | Removing liquidity |
//! | --- | --- | --- | --- | --- |
//! | Normal | Buffer, then redeem the shortfall | Band and withdraw mode | Allowed | Cash or in kind |
//! | Little free liquidity, or withdrawal cap used up | Up to the buffer plus what Kamino can pay | Redeems what it can; withdraw mode if below the threshold | Allowed | Cash if Kamino can pay the LP's share, else in kind |
//! | `block_ctoken_usage` set | As normal | Skips deposits, still redeems | Allowed | Cash or in kind |
//! | Reserve or market emergency mode | Buffer only | Refuses | Allowed | In kind |
//! | Reserve deprecated after a total write-off | Buffer only, for good | Refuses | Refused | In kind |
//! | Reserve fails the layout check | Refused | Refuses | Refused | In kind |
//!
//! Each state is made by editing the cloned Kamino accounts, and every transaction runs on the
//! router copied from devnet, the lending AMM and klend's deployed bytes.

mod common;

use common::rebalance::{lent_spec, units, OTHER};
use common::remove::Payout;
use common::states::KaminoState;
use common::*;
use lending_amm::config::LENT_MINTS;
use lending_amm::kamino::with_rate_headroom;
use lending_amm::StrategyError;
use solana_keypair::Keypair;
use solana_signer::Signer;

/// Kamino's freely available liquidity in the "little free liquidity" row: 10 whole units of the
/// lent mint, against markets lending 40, so below the entry threshold and above both lent mints'
/// `MIN_REBALANCE`.
fn little(lent: usize) -> u64 {
    units(lent, 10)
}

/// Every row of the table, the little free liquidity of each lent mint aside.
fn states(lent: usize) -> [KaminoState; 8] {
    [
        KaminoState::Normal,
        KaminoState::LittleFreeLiquidity(little(lent)),
        KaminoState::CapUsedUp,
        KaminoState::BlockCtokenUsage,
        KaminoState::ReserveEmergencyMode,
        KaminoState::MarketEmergencyMode,
        KaminoState::Deprecated,
        KaminoState::FailsLayoutCheck,
    ]
}

/// What a call should do in a state: succeed, or be refused with the program's error.
type Expected = Result<(), StrategyError>;

fn check<T: std::fmt::Debug>(result: Result<T, String>, expected: Expected, what: &str) {
    match expected {
        Ok(()) => {
            result.unwrap_or_else(|e| panic!("{what}: {e}"));
        }
        Err(error) => {
            println!("{what}: refused with {error:?}, as the table says");
            assert_refused(result, error);
        }
    }
}

/// The error every call that reads the reserve fails with once it fails the layout check.
const LAYOUT: StrategyError = StrategyError::ReserveWrongDiscriminator;

/// A market lending `LENT_MINTS[lent]`, opened by its LP with `[OTHER, 50 units]` and
/// rebalanced, so four fifths of its lent side are real cTokens from klend's deposit; `prepare`
/// then runs on it, and Kamino is put into `state`. Returns the LP.
fn market_in(
    lent: usize,
    state: KaminoState,
    prepare: impl FnOnce(&mut Env, &Market),
) -> (Env, Market, Keypair) {
    let mut env = Env::new();
    env.load_klend();
    let spec = lent_spec(&mut env, lent, 30);
    let (market, lp) = env
        .create_funded_market(&spec, [OTHER, units(lent, 50)])
        .unwrap();
    env.rebalance(&market, None).unwrap();
    prepare(&mut env, &market);
    env.set_kamino_state(&market, state);
    (env, market, lp)
}

/// A sell of the other mint by a fresh trader that pays out `out` of the lent side, sized on the
/// market as it is in Kamino's normal state; Kamino is then put into `state`, and the sell quoted
/// and swapped through the router, the quote's answer and the swap's checked against `expected`.
fn sell(
    lent: usize,
    state: KaminoState,
    out: impl Fn(&Env, &Market) -> u64,
    expected: Expected,
    what: &str,
) {
    let (mut env, market, _) = market_in(lent, KaminoState::Normal, |_, _| {});
    let (other, lent_side) = (market.other_index(), market.lent_index);
    let amount = env.sell_paying(&market, out(&env, &market));
    env.set_kamino_state(&market, state);
    // Account resolution lists klend's redeem accounts only for a sale whose quote redeems: none
    // for one the reserve's own state refuses. Only the lending market's emergency mode, which
    // resolution cannot read without the lending market's account, still gets them, and the
    // quote and the swap then refuse the sale with them.
    if matches!(expected, Err(StrategyError::BeyondBuffer)) {
        let trade = exact_in(other, lent_side, amount);
        let listed = env.resolve_accounts(&market, &trade).unwrap().len();
        let redeem_accounts = state == KaminoState::MarketEmergencyMode;
        assert_eq!(
            listed,
            if redeem_accounts { 11 } else { 3 },
            "{what}: resolved {listed} accounts"
        );
    }
    check(
        env.quote(&market, &exact_in(other, lent_side, amount)),
        expected,
        &format!("{what}: quote"),
    );
    let trader = env.funded_wallet(&market, [2 * amount, 0]);
    let before = env.market_state(&market.market_state);
    let swapped = env.swap(&market, &trader, (other, lent_side), amount);
    if expected.is_err() {
        assert_eq!(env.market_state(&market.market_state), before, "{what}");
    }
    check(swapped, expected, &format!("{what}: swap"));
}

#[test]
fn swaps_pay_from_the_buffer_and_redeem_beyond_it_only_where_kamino_can_pay() {
    for lent in 0..LENT_MINTS.len() {
        for state in states(lent) {
            let what = format!("lent {lent}, {state:?}");
            // Within the buffer: every state but a failed layout check trades as usual.
            let expected = match state {
                KaminoState::FailsLayoutCheck => Err(LAYOUT),
                _ => Ok(()),
            };
            sell(
                lent,
                state,
                |env, market| env.buffer(market) / 2,
                expected,
                &format!("{what}, within the buffer"),
            );

            // Beyond the buffer by half of the little free liquidity: Kamino pays it in every
            // state where it redeems at all.
            let expected = match state {
                KaminoState::Normal
                | KaminoState::LittleFreeLiquidity(_)
                | KaminoState::BlockCtokenUsage => Ok(()),
                KaminoState::CapUsedUp
                | KaminoState::ReserveEmergencyMode
                | KaminoState::MarketEmergencyMode
                | KaminoState::Deprecated => Err(StrategyError::BeyondBuffer),
                KaminoState::FailsLayoutCheck => Err(LAYOUT),
            };
            let half = little(lent) / 2;
            sell(
                lent,
                state,
                move |env, market| env.buffer(market) + half,
                expected,
                &format!("{what}, beyond the buffer"),
            );

            // With little free liquidity, up to the buffer plus what Kamino can pay, and no more.
            if let KaminoState::LittleFreeLiquidity(free) = state {
                sell(
                    lent,
                    state,
                    move |env, market| env.buffer(market) + 2 * free,
                    Err(StrategyError::BeyondBuffer),
                    &format!("{what}, beyond the buffer plus what Kamino can pay"),
                );
            }
        }
    }
}

/// Drains the buffer below its band with a sell the buffer covers, leaving about 5% of the lent
/// side in it.
fn drain_buffer(env: &mut Env, market: &Market) {
    let out = env.buffer(market) - env.lent_total(market) / 20;
    let amount = env.sell_paying(market, out);
    let trader = env.funded_wallet(market, [2 * amount, 0]);
    env.swap(
        market,
        &trader,
        (market.other_index(), market.lent_index),
        amount,
    )
    .unwrap();
    let state = env.market_state(&market.market_state);
    assert_eq!(
        lending_amm::buffer::band(state.reserves[market.lent_index], env.lent_total(market)),
        lending_amm::buffer::Band::Below
    );
}

/// What one cToken of the market's reserve is worth, rounded up.
fn one_ctoken(env: &Env, market: &Market) -> u64 {
    let reserve = env.program_reserve(market);
    let supply = reserve.total_supply_sf().unwrap();
    (supply >> 60).div_ceil(reserve.mint_total_supply as u128) as u64 + 1
}

#[test]
fn rebalance_redeems_what_it_can_skips_blocked_deposits_and_refuses_when_kamino_has_stopped() {
    for lent in 0..LENT_MINTS.len() {
        for state in states(lent) {
            let what = format!("lent {lent}, {state:?}");
            // Below the band, with Kamino in `state`.
            let (mut env, market, _) = market_in(lent, state, drain_buffer);
            let before = env.market_state(&market.market_state);
            let result = env.rebalance(&market, None);
            let after = env.market_state(&market.market_state);
            let redeemed = (after.redeemed - before.redeemed) as u64;
            match state {
                KaminoState::Normal | KaminoState::BlockCtokenUsage => {
                    result.unwrap_or_else(|e| panic!("{what}: {e}"));
                    assert!(redeemed > 0 && !after.withdraw_mode, "{what}");
                }
                KaminoState::LittleFreeLiquidity(free) => {
                    // Below the entry threshold: withdraw mode, and it redeems what Kamino can
                    // pay, its free liquidity less the headroom for the rate klend refreshes to.
                    result.unwrap_or_else(|e| panic!("{what}: {e}"));
                    let planned = with_rate_headroom(free);
                    println!("{what}: withdraw mode, redeemed {redeemed} of {free} free");
                    assert!(after.withdraw_mode, "{what}");
                    let one = one_ctoken(&env, &market);
                    assert!(
                        redeemed <= planned && planned - redeemed <= one,
                        "{what}: {planned} {one}"
                    );
                }
                KaminoState::CapUsedUp => {
                    // Kamino can pay nothing in this interval, so there is nothing to do.
                    assert_refused(result, StrategyError::BelowMinRebalance);
                    assert_eq!(after, before, "{what}");
                }
                KaminoState::ReserveEmergencyMode
                | KaminoState::MarketEmergencyMode
                | KaminoState::Deprecated => {
                    assert_refused(result, StrategyError::KaminoStopped);
                    assert_eq!(after, before, "{what}");
                }
                KaminoState::FailsLayoutCheck => {
                    assert_refused(result, LAYOUT);
                    assert_eq!(after, before, "{what}");
                }
            }
        }

        // Above the band, with cToken deposits blocked: the deposit is skipped, and nothing
        // changes.
        let mut env = Env::new();
        let spec = lent_spec(&mut env, lent, 30);
        let (fresh, _) = env
            .create_funded_market(&spec, [OTHER, units(lent, 50)])
            .unwrap();
        env.set_kamino_state(&fresh, KaminoState::BlockCtokenUsage);
        let before = env.market_state(&fresh.market_state);
        assert_refused(
            env.rebalance(&fresh, None),
            StrategyError::KaminoDepositsBlocked,
        );
        assert_eq!(env.market_state(&fresh.market_state), before);
    }
}

#[test]
fn adding_is_allowed_unless_the_reserve_is_deprecated_or_fails_its_check() {
    for lent in 0..LENT_MINTS.len() {
        for state in states(lent) {
            let what = format!("lent {lent}, {state:?}: add_liquidity");
            let (mut env, market, _) = market_in(lent, state, |_, _| {});
            let lp = env.funded_wallet(&market, [OTHER, units(lent, 50)]);
            let expected = match state {
                KaminoState::Deprecated => Err(StrategyError::ReserveDeprecated),
                KaminoState::FailsLayoutCheck => Err(LAYOUT),
                _ => Ok(()),
            };
            check(
                env.add_liquidity(&market, &lp, [OTHER / 10, units(lent, 5)], 0),
                expected,
                &what,
            );
        }
    }
}

#[test]
fn removal_is_in_cash_where_kamino_can_pay_the_lps_share_and_in_kind_in_every_state() {
    for lent in 0..LENT_MINTS.len() {
        for state in states(lent) {
            let what = format!("lent {lent}, {state:?}");
            // Half of the LP's shares: their cTokens' part is worth about 20 units, more than the
            // little free liquidity.
            let (mut env, market, lp) = market_in(lent, state, |_, _| {});
            let shares = env.lp_shares_of(&market, &lp.pubkey()) / 2;
            let expected = match state {
                KaminoState::Normal | KaminoState::BlockCtokenUsage => Ok(()),
                KaminoState::FailsLayoutCheck => Err(LAYOUT),
                _ => Err(StrategyError::KaminoCannotPay),
            };
            check(
                env.remove_liquidity(&market, &lp, shares, [0, 0], Payout::Cash),
                expected,
                &format!("{what}: half in cash"),
            );
            // With little free liquidity, a share Kamino can pay still goes in cash.
            if let KaminoState::LittleFreeLiquidity(_) = state {
                let small = env.lp_shares_of(&market, &lp.pubkey()) / 100;
                check(
                    env.remove_liquidity(&market, &lp, small, [0, 0], Payout::Cash),
                    Ok(()),
                    &format!("{what}: a hundredth in cash"),
                );
            }
            // In kind always works, a failed layout check included.
            let held = env.lp_shares_of(&market, &lp.pubkey());
            env.remove_liquidity(&market, &lp, held / 10, [0, 0], Payout::InKind)
                .unwrap_or_else(|e| panic!("{what}: in kind: {e}"));
            assert!(
                env.balance(&env.lp_ctoken_account(&market, &lp.pubkey())) > 0,
                "{what}"
            );
        }
    }
}
