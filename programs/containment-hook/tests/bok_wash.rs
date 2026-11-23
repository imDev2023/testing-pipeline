//! Book of Knowledge properties of the price of washing a home market to its unlock goal
//! (#74, T04), on the tax AMM's own pricing and split functions and Pipeline's own fee
//! functions, never a copy of them:
//!
//! - EC-1: a buy of the quote mint's `x` then a sell of what it bought, through the router,
//!   leaves the trader at least the tax both legs booked poorer in the quote mint, so a party
//!   with no share of the tax pays at least the whole unlock goal to reach it;
//! - EC-2: a trader holding recipient slot 0 with share `s` pays, after `distribute`, at
//!   least `(1 - 0.9 s)` of the tax both legs booked plus Pipeline's quote-mint fees, less
//!   the split's remainder rounding; a sole recipient (s = 100%, burn 0) pays at least the
//!   suite share plus those fees.
//!
//! Pipeline 0.3's fee side, as the router's `execute_swap` takes it: the tax AMM declares no
//! fee mint, so on a market quoted in wrapped SOL the fee is in wrapped SOL (on a buy, 25 bps
//! of the input on top; on a sell, 25 bps of what arrived, out of it), and on any other
//! market each trade pays in its input (a sell's fee in the token, on top). The tax side is
//! the quote mint, as `bind` requires. The model with the same rules is
//! `.bok/models/t04_wash_unlock.py` (not committed).

use pipeline_strategy_interface::fees::{amount_for_budget, pipeline_fee};
use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use std::sync::atomic::{AtomicU32, Ordering};
use tax_amm::config::{MAX_RECIPIENTS, MAX_TAX_BPS, SUITE_SHARE_BPS};
use tax_amm::pricing::{exact_in, Sides, Tax};
use tax_amm::split::split_tax;

const CASES: u32 = 10_000;
/// Round trips must price both legs to say anything: four times the cases, and each test
/// fails unless at least `CASES` of them did.
const PAIRED_CASES: u32 = 4 * CASES;
const BPS: u128 = 10_000;

fn run_paired<S: Strategy>(strategy: S, property: impl Fn(S::Value) -> Result<bool, TestCaseError>)
where
    S::Value: std::fmt::Debug,
{
    let exercised = AtomicU32::new(0);
    TestRunner::new(Config::with_cases(PAIRED_CASES))
        .run(&strategy, |value| {
            if property(value)? {
                exercised.fetch_add(1, Ordering::Relaxed);
            }
            Ok(())
        })
        .unwrap();
    let exercised = exercised.into_inner();
    assert!(
        exercised >= CASES,
        "only {exercised} of {PAIRED_CASES} cases priced both legs"
    );
}

#[derive(Clone, Copy, Debug)]
struct Pool {
    quote: u64,
    token: u64,
    virtual_reserve: u64,
    virtual_on_quote: bool,
}

#[derive(Clone, Copy, Debug)]
struct Trip {
    pool: Pool,
    buy_bps: u16,
    sell_bps: u16,
    amount: u64,
    wrapped_sol: bool,
}

/// What one round trip did, in the quote mint unless named otherwise.
#[derive(Debug)]
struct RoundTrip {
    spent: u128,
    back: u128,
    taxes: [u64; 2],
    quote_fees: u128,
}

fn pool() -> impl Strategy<Value = Pool> {
    let amount = || prop_oneof![1u64..1_000, 1u64..1_000_000_000_000, 1u64..=u64::MAX >> 4];
    let virtual_reserve = prop_oneof![Just(0u64), 1u64..1_000_000_000_000, 1u64..=u64::MAX >> 4];
    (amount(), amount(), virtual_reserve, any::<bool>()).prop_map(
        |(quote, token, virtual_reserve, virtual_on_quote)| Pool {
            quote,
            token,
            virtual_reserve,
            virtual_on_quote,
        },
    )
}

fn trip() -> impl Strategy<Value = Trip> {
    let rate = || prop_oneof![Just(0u16), Just(MAX_TAX_BPS), 0..=MAX_TAX_BPS];
    let amount = prop_oneof![1u64..1_000, 1u64..1_000_000_000_000, 1u64..=u64::MAX >> 8];
    (pool(), rate(), rate(), amount, any::<bool>()).prop_map(
        |(pool, buy_bps, sell_bps, amount, wrapped_sol)| Trip {
            pool,
            buy_bps,
            sell_bps,
            amount,
            wrapped_sol,
        },
    )
}

/// A buy of `trip.amount` of the quote mint, then a sell of everything it bought (less, on a
/// market without a fee mint, the sell's fee in the token), or `None` if either leg is
/// refused.
fn round_trip(trip: &Trip) -> Option<RoundTrip> {
    let Pool {
        quote,
        token,
        virtual_reserve,
        virtual_on_quote,
    } = trip.pool;
    let (virtual_quote, virtual_token) = if virtual_on_quote {
        (virtual_reserve, 0)
    } else {
        (0, virtual_reserve)
    };
    let buy = exact_in(
        Sides {
            reserve_in: quote,
            reserve_out: token,
            virtual_in: virtual_quote,
            virtual_out: virtual_token,
        },
        Tax::Buy(trip.buy_bps),
        trip.amount,
    )
    .ok()?;
    let buy_fee = pipeline_fee(trip.amount) as u128;
    let bought = buy.amount_out;
    let sent = if trip.wrapped_sol {
        bought
    } else {
        amount_for_budget(bought, 0)
    };
    let sell = exact_in(
        Sides {
            reserve_in: buy.reserve_out,
            reserve_out: buy.reserve_in,
            virtual_in: virtual_token,
            virtual_out: virtual_quote,
        },
        Tax::Sell(trip.sell_bps),
        sent,
    )
    .ok()?;
    let (back, sell_fee) = if trip.wrapped_sol {
        let fee = pipeline_fee(sell.amount_out) as u128;
        (sell.amount_out as u128 - fee, fee)
    } else {
        (sell.amount_out as u128, 0)
    };
    Some(RoundTrip {
        spent: trip.amount as u128 + buy_fee,
        back,
        taxes: [buy.tax, sell.tax],
        quote_fees: buy_fee + sell_fee,
    })
}

/// EC-1: an outsider's quote loss on a round trip is at least the tax it booked, on either
/// fee side, at any rates up to the cap and any pool.
#[test]
fn ec_1_an_outsider_never_books_tax_for_less_than_it_costs() {
    run_paired(trip(), |trip| {
        let Some(rt) = round_trip(&trip) else {
            return Ok(false);
        };
        let tax = rt.taxes[0] as u128 + rt.taxes[1] as u128;
        prop_assert!(rt.spent >= rt.back);
        let loss = rt.spent - rt.back;
        prop_assert!(loss >= tax, "lost {} for {} of tax: {:?}", loss, tax, rt);
        // And beyond the tax, at least Pipeline's quote-mint fees.
        prop_assert!(loss >= tax + rt.quote_fees);
        Ok(true)
    });
}

fn shares_and_burn() -> impl Strategy<Value = (u16, u16)> {
    prop_oneof![
        Just((10_000u16, 0u16)),
        (0u16..=10_000).prop_flat_map(|s| (Just(s), 0..=10_000 - s)),
    ]
}

/// EC-2: what a trader holding slot 0 pays for a round trip, after `distribute` pays it
/// slot 0's part of both legs' tax.
#[test]
fn ec_2_a_recipient_pays_at_least_the_suite_share_plus_the_fees() {
    let sole = AtomicU32::new(0);
    run_paired((trip(), shares_and_burn()), |(trip, (share, burn))| {
        let Some(rt) = round_trip(&trip) else {
            return Ok(false);
        };
        let mut shares = [0u16; MAX_RECIPIENTS];
        shares[0] = share;
        shares[1] = 10_000 - share - burn;
        let mut refund = 0u128;
        let mut bound = 0u128; // sum of (tax - rest * s / BPS), in BPS units
        let mut suites = 0u128;
        for tax in rt.taxes {
            let slots = split_tax(tax, &shares, burn).expect("whole shares split");
            refund += slots[0] as u128;
            let suite = tax as u128 * SUITE_SHARE_BPS as u128 / BPS;
            suites += suite;
            let rest = tax as u128 - suite;
            bound += tax as u128 * BPS - rest * share as u128;
        }
        let net = (rt.spent - rt.back) as i128 - refund as i128;
        prop_assert!(net >= 0, "a recipient profits from a round trip: {:?}", rt);
        let net = net as u128;
        // (1 - 0.9 s) of the tax plus the quote fees, less under one unit per split part
        // (at most five parts carry a remainder, per leg).
        prop_assert!(
            net * BPS + 10 * BPS >= bound + rt.quote_fees * BPS,
            "net {} below (1 - 0.9 s) of the tax plus fees: {:?}",
            net,
            rt
        );
        if share == 10_000 && burn == 0 {
            sole.fetch_add(1, Ordering::Relaxed);
            // The sole recipient gets back everything but the suite share, exactly.
            prop_assert_eq!(
                net,
                suites
                    + rt.quote_fees
                    + (rt.spent
                        - rt.back
                        - rt.quote_fees
                        - rt.taxes[0] as u128
                        - rt.taxes[1] as u128)
            );
            prop_assert!(net >= suites + rt.quote_fees);
        }
        Ok(true)
    });
    assert!(sole.into_inner() >= CASES / 10);
}
