//! Each outcome of each check at its band edges, on the judging functions the run uses,
//! with measurements built exactly at the edges (a round trip through a real pool cannot be
//! made to land on 950,000 parts per million). The end-to-end tests beside this file drive
//! the same functions through the router.

use canary::bands::{band, Band};
use canary::checks::exit_sizes::{Measured, Pair};
use canary::checks::readable::Trading;
use canary::checks::{cost, exit_sizes, quote_matches_swap};
use canary::config::{FAIL_BAND_BELOW_PPM, PASS_BAND_MIN_PPM, PPM, SOL_REFERENCE_SIZE, SOL_SIZES};
use canary::failure::{Failure, FailureClass, Stage};
use canary::market::MintFacts;
use canary::sizes::{Basis, Ladder};
use canary::swap::SwapReceipt;
use canary::trade::{ClockPosition, Leg, Quote, RoundTrip};
use canary::Outcome;
use pipeline_client::Pubkey;

const CLOCK: ClockPosition = ClockPosition {
    slot: 1,
    epoch: 1,
    unix_timestamp: 1,
};

fn receipt(spent: u64, received: u64) -> SwapReceipt {
    SwapReceipt {
        trader_spent: spent,
        trader_received: received,
        net_sent: spent,
        received,
        pipeline_fee: 0,
        compute_units: 1,
        strategy_compute_units: None,
    }
}

fn quote_for(r: &SwapReceipt) -> Quote {
    Quote {
        amount_in: r.net_sent,
        net_sent: r.net_sent,
        pipeline_fee: r.pipeline_fee,
        total_spend: r.trader_spent,
        amount_out: r.received,
        strategy_amount_out: r.received,
        compute_units: 1,
    }
}

fn leg(amount_in: u64, swap: Result<SwapReceipt, Failure>) -> Leg {
    let quote = match &swap {
        Ok(r) => Ok(quote_for(r)),
        Err(f) => Err(f.clone()),
    };
    Leg {
        input: 0,
        output: 1,
        amount_in,
        clock: CLOCK,
        quote,
        swap,
    }
}

fn refused(stage: Stage) -> Failure {
    Failure::plain(
        stage,
        FailureClass::StrategyRefused,
        &Pubkey::new_unique(),
        "WrongStatus",
    )
}

/// A round trip of `amount` that put `amount` in and got back `return_ppm` of it.
fn sold(amount: u64, return_ppm: u64) -> RoundTrip {
    let back = (amount as u128 * return_ppm as u128 / PPM as u128) as u64;
    RoundTrip {
        amount,
        wallet: Pubkey::new_unique(),
        buy: leg(amount, Ok(receipt(amount, amount))),
        sell: Some(leg(amount, Ok(receipt(amount, back)))),
    }
}

/// A round trip whose buy worked and whose sale failed.
fn stuck(amount: u64) -> RoundTrip {
    RoundTrip {
        amount,
        wallet: Pubkey::new_unique(),
        buy: leg(amount, Ok(receipt(amount, amount))),
        sell: Some(leg(amount, Err(refused(Stage::Swap)))),
    }
}

/// A round trip whose buy failed.
fn unbought(amount: u64) -> RoundTrip {
    RoundTrip {
        amount,
        wallet: Pubkey::new_unique(),
        buy: leg(amount, Err(refused(Stage::Swap))),
        sell: None,
    }
}

fn mint() -> MintFacts {
    MintFacts {
        address: Pubkey::new_unique(),
        token_program: pipeline_client::TOKEN_PROGRAM_ID,
        decimals: 9,
        supply: 0,
        mint_authority: None,
        freeze_authority: None,
        transfer_fee: None,
        transfer_hook: None,
        permanent_delegate: None,
        pause_authority: None,
    }
}

/// The wrapped SOL ladder, with one row per size.
fn measured(rows: Vec<RoundTrip>) -> Measured {
    assert_eq!(rows.len(), SOL_SIZES.len());
    Measured {
        money: 0,
        ladder: Ladder {
            basis: Basis::Sol,
            sizes: SOL_SIZES.to_vec(),
            reference: SOL_REFERENCE_SIZE,
        },
        money_vault: 1_000 * SOL_SIZES[4],
        money_decimals: 9,
        mints: vec![mint(), mint()],
        pairs: vec![Pair { token: 1, rows }],
    }
}

/// Every size at `ppm`, except those `edit` changes.
fn ladder_at(ppm: u64, edit: impl Fn(u64) -> Option<RoundTrip>) -> Measured {
    measured(
        SOL_SIZES
            .iter()
            .map(|a| edit(*a).unwrap_or_else(|| sold(*a, ppm)))
            .collect(),
    )
}

const OPEN: Trading = Trading::Open;

#[test]
fn the_bands_meet_at_their_edges() {
    assert_eq!(band(PASS_BAND_MIN_PPM), Band::Pass);
    assert_eq!(band(PASS_BAND_MIN_PPM - 1), Band::Between);
    assert_eq!(band(FAIL_BAND_BELOW_PPM), Band::Between);
    assert_eq!(band(FAIL_BAND_BELOW_PPM - 1), Band::Fail);
}

#[test]
fn cost_at_its_band_edges() {
    let at = |ppm| cost::judge(&ladder_at(ppm, |_| None), &OPEN).outcome;
    assert_eq!(at(PASS_BAND_MIN_PPM), Outcome::Pass);
    assert_eq!(at(PASS_BAND_MIN_PPM - 1), Outcome::Warn);
    assert_eq!(at(FAIL_BAND_BELOW_PPM), Outcome::Warn);
    assert_eq!(at(FAIL_BAND_BELOW_PPM - 1), Outcome::Fail);
}

#[test]
fn cost_judges_the_ordinary_trade_at_the_reference_size_and_the_smallest_size() {
    // Only the reference size returns too little: the ordinary trade fails.
    let reference = ladder_at(PASS_BAND_MIN_PPM, |a| {
        (a == SOL_REFERENCE_SIZE).then(|| sold(a, FAIL_BAND_BELOW_PPM - 1))
    });
    assert_eq!(cost::judge(&reference, &OPEN).outcome, Outcome::Fail);
    // Only the smallest size: the same.
    let smallest = ladder_at(PASS_BAND_MIN_PPM, |a| {
        (a == SOL_SIZES[0]).then(|| sold(a, FAIL_BAND_BELOW_PPM - 1))
    });
    assert_eq!(cost::judge(&smallest, &OPEN).outcome, Outcome::Fail);
    // Only a larger size, even in the fail band: a warn, because it is not the ordinary trade.
    let larger = ladder_at(PASS_BAND_MIN_PPM, |a| {
        (a == SOL_SIZES[5]).then(|| sold(a, FAIL_BAND_BELOW_PPM - 1))
    });
    let verdict = cost::judge(&larger, &OPEN);
    assert_eq!(verdict.outcome, Outcome::Warn, "{}", verdict.reason);
    assert!(verdict.reason.contains("10 SOL"), "{}", verdict.reason);
}

#[test]
fn cost_lets_the_largest_size_that_round_tripped_stand_in_for_the_reference_size() {
    // The reference size cannot be bought; 0.1 SOL and up cannot either: 0.001 SOL stands in.
    let m = ladder_at(PASS_BAND_MIN_PPM, |a| {
        (a >= SOL_REFERENCE_SIZE).then(|| unbought(a))
    });
    let verdict = cost::judge(&m, &OPEN);
    assert_eq!(verdict.outcome, Outcome::Pass, "{}", verdict.reason);
    assert!(
        verdict.reason.contains("0.001 SOL stands in"),
        "{}",
        verdict.reason
    );
    assert_eq!(verdict.numbers["pairs"][0]["reference_is_stand_in"], true);
}

#[test]
fn cost_is_not_run_when_nothing_round_trips_or_trading_is_not_run() {
    let none = measured(SOL_SIZES.iter().map(|a| unbought(*a)).collect());
    assert_eq!(cost::judge(&none, &OPEN).outcome, Outcome::NotRun);
    let closed = Trading::NotRun("the market refuses every trade (WrongStatus)".into());
    let verdict = cost::judge(&ladder_at(PASS_BAND_MIN_PPM, |_| None), &closed);
    assert_eq!(verdict.outcome, Outcome::NotRun);
    assert!(verdict.reason.contains("WrongStatus"));
}

#[test]
fn exit_sizes_fails_at_the_ordinary_sizes_and_warns_above_them() {
    let at = |stuck_size: u64| {
        exit_sizes::judge(
            &ladder_at(PASS_BAND_MIN_PPM, |a| (a == stuck_size).then(|| stuck(a))),
            &OPEN,
        )
    };
    assert_eq!(at(SOL_SIZES[0]).outcome, Outcome::Fail);
    assert_eq!(at(SOL_REFERENCE_SIZE).outcome, Outcome::Fail);
    // The size just above the reference size is the first that only warns.
    let above = at(SOL_SIZES[3]);
    assert_eq!(above.outcome, Outcome::Warn, "{}", above.reason);
    assert_eq!(at(SOL_SIZES[1]).outcome, Outcome::Warn);
}

#[test]
fn exit_sizes_states_the_boundary_as_the_bonding_curves_show_it() {
    let m = ladder_at(PASS_BAND_MIN_PPM, |a| (a >= SOL_SIZES[4]).then(|| stuck(a)));
    let verdict = exit_sizes::judge(&m, &OPEN);
    assert_eq!(verdict.outcome, Outcome::Warn);
    assert!(
        verdict
            .reason
            .starts_with("A wallet that bought 1 SOL or more could not sell back (strategy refused (WrongStatus)); buys of 0.1 SOL and less sold back."),
        "{}",
        verdict.reason
    );
}

#[test]
fn exit_sizes_lists_sizes_that_could_not_be_bought_without_making_them_a_finding() {
    let m = ladder_at(PASS_BAND_MIN_PPM, |a| {
        (a == SOL_SIZES[5]).then(|| unbought(a))
    });
    let verdict = exit_sizes::judge(&m, &OPEN);
    assert_eq!(verdict.outcome, Outcome::Pass, "{}", verdict.reason);
    assert!(
        verdict.reason.contains("10 SOL could not be bought"),
        "{}",
        verdict.reason
    );
    let none = measured(SOL_SIZES.iter().map(|a| unbought(*a)).collect());
    assert_eq!(exit_sizes::judge(&none, &OPEN).outcome, Outcome::NotRun);
}

#[test]
fn quote_matches_swap_fails_in_the_ordinary_trade_and_warns_elsewhere() {
    let differing = |amount: u64| {
        let mut row = sold(amount, PASS_BAND_MIN_PPM);
        if let Ok(quote) = row.buy.quote.as_mut() {
            quote.amount_out += 1;
        }
        row
    };
    let at = |size: u64| {
        quote_matches_swap::judge(
            &ladder_at(PASS_BAND_MIN_PPM, |a| (a == size).then(|| differing(a))),
            &OPEN,
        )
    };
    assert_eq!(at(SOL_SIZES[0]).outcome, Outcome::Fail);
    assert_eq!(at(SOL_REFERENCE_SIZE).outcome, Outcome::Fail);
    let elsewhere = at(SOL_SIZES[5]);
    assert_eq!(elsewhere.outcome, Outcome::Warn, "{}", elsewhere.reason);
    let all = quote_matches_swap::judge(&ladder_at(PASS_BAND_MIN_PPM, |_| None), &OPEN);
    assert_eq!(all.outcome, Outcome::Pass);
    assert_eq!(all.numbers["compared"], 12);
}

#[test]
fn a_crash_anywhere_is_at_least_a_warn() {
    let crash = Failure {
        class: FailureClass::Crash,
        ..refused(Stage::Swap)
    };
    let m = ladder_at(PASS_BAND_MIN_PPM, |a| {
        (a == SOL_SIZES[5]).then(|| RoundTrip {
            amount: a,
            wallet: Pubkey::new_unique(),
            buy: leg(a, Err(crash.clone())),
            sell: None,
        })
    });
    assert_eq!(exit_sizes::judge(&m, &OPEN).outcome, Outcome::Warn);
    assert_eq!(cost::judge(&m, &OPEN).outcome, Outcome::Warn);
    assert_eq!(quote_matches_swap::judge(&m, &OPEN).outcome, Outcome::Warn);
}
