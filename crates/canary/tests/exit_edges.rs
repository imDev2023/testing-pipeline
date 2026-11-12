//! Each outcome of the checks over time and across wallets at the tolerance's and the bands'
//! edges (`CANARY-12`, `CANARY-13`), on the judging functions the run uses, with
//! measurements built exactly at the edges. `tests/exits.rs` drives the same functions
//! through the router.

mod common;

use canary::checks::exit_sizes;
use canary::checks::exits::Reference;
use canary::checks::readable::Trading;
use canary::checks::timed::{self, Timed, TimedPair};
use canary::checks::{
    exit_hold, exit_late, exit_launch_clock, exit_queue, exit_transferred, exit_wallets,
};
use canary::config::{
    FAIL_BAND_BELOW_PPM, PASS_BAND_MIN_PPM, PPM, SOL_REFERENCE_SIZE, TOLERANCE_PPM,
};
use canary::failure::{Failure, FailureClass, Stage};
use canary::trade::RoundTrip;
use canary::{Outcome, Verdict};
use common::rows::*;
use pipeline_client::Pubkey;

const AMOUNT: u64 = SOL_REFERENCE_SIZE;
/// What the present returns in these measurements.
const NOW: u64 = 990_000;

fn reference(own: u64) -> Reference {
    Reference {
        token: 1,
        amount: AMOUNT,
        stand_in: false,
        own_return_ppm: Some(own),
    }
}

/// The size ladder the checks take their words and reference from.
fn sizes() -> exit_sizes::Measured {
    ladder_at(NOW, |_| None)
}

fn counts(verdict: &Verdict) -> bool {
    verdict.numbers["could_not_sell_back"].as_bool().unwrap()
}

// ---------------------------------------------------------------------------------------
// exit_hold, exit_late, exit_launch_clock
// ---------------------------------------------------------------------------------------

/// A timed measurement: the present at `NOW`, then one later row per `(position, row)`.
fn timed(ordinary_next: Option<RoundTrip>, later: Vec<(&str, RoundTrip)>) -> timed::Measured {
    let mut rows = vec![Timed {
        position: "now".into(),
        ordinary: true,
        row: sold(AMOUNT, NOW),
    }];
    if let Some(row) = ordinary_next {
        rows.push(Timed {
            position: "in the next slot".into(),
            ordinary: true,
            row,
        });
    }
    rows.extend(later.into_iter().map(|(position, row)| Timed {
        position: position.into(),
        ordinary: false,
        row,
    }));
    timed::Measured {
        pairs: vec![TimedPair {
            token: 1,
            reference: Some(reference(NOW)),
            rows,
        }],
    }
}

type Judge = fn(&timed::Measured, &exit_sizes::Measured, &Trading) -> Verdict;
const TIMED: [(&str, Judge); 3] = [
    ("exit_hold", exit_hold::judge),
    ("exit_late", exit_late::judge),
    ("exit_launch_clock", exit_launch_clock::judge),
];

#[test]
fn every_timed_check_passes_at_the_tolerance_and_warns_just_beyond_it() {
    for (check, judge) in TIMED {
        let at = |ppm| {
            judge(
                &timed(None, vec![("after 1 day", sold(AMOUNT, ppm))]),
                &sizes(),
                &Trading::Open,
            )
        };
        let edge = at(NOW - TOLERANCE_PPM);
        assert_eq!(edge.outcome, Outcome::Pass, "{check}: {}", edge.reason);
        let beyond = at(NOW - TOLERANCE_PPM - 1);
        assert_eq!(beyond.outcome, Outcome::Warn, "{check}: {}", beyond.reason);
        assert!(
            beyond.reason.contains("97.9% after 1 day"),
            "{check}: {}",
            beyond.reason
        );
        // More back later is never a finding.
        assert_eq!(at(PPM).outcome, Outcome::Pass, "{check}");
    }
}

#[test]
fn a_later_sale_that_fails_warns_and_only_exit_hold_counts_it_as_could_not_sell_back() {
    for (check, judge) in TIMED {
        let verdict = judge(
            &timed(None, vec![("after 3 days", stuck(AMOUNT))]),
            &sizes(),
            &Trading::Open,
        );
        assert_eq!(
            verdict.outcome,
            Outcome::Warn,
            "{check}: {}",
            verdict.reason
        );
        assert!(
            verdict.reason.contains("after 3 days"),
            "{check}: {}",
            verdict.reason
        );
        assert_eq!(counts(&verdict), check == "exit_hold", "{check}");
    }
}

#[test]
fn only_exit_hold_fails_when_the_sale_fails_in_the_next_slot() {
    for (check, judge) in TIMED {
        let verdict = judge(
            &timed(Some(stuck(AMOUNT)), vec![]),
            &sizes(),
            &Trading::Open,
        );
        let expected = if check == "exit_hold" {
            Outcome::Fail
        } else {
            Outcome::Warn
        };
        assert_eq!(verdict.outcome, expected, "{check}: {}", verdict.reason);
    }
    // A next-slot sale that returns less than the tolerance allows is a warn, not a fail.
    let lower = exit_hold::judge(
        &timed(Some(sold(AMOUNT, NOW - TOLERANCE_PPM - 1)), vec![]),
        &sizes(),
        &Trading::Open,
    );
    assert_eq!(lower.outcome, Outcome::Warn, "{}", lower.reason);
}

#[test]
fn exit_hold_fails_when_the_same_slot_sale_fails() {
    let mut m = timed(None, vec![("after 1 day", sold(AMOUNT, NOW))]);
    m.pairs[0].rows[0].row = stuck(AMOUNT);
    let verdict = exit_hold::judge(&m, &sizes(), &Trading::Open);
    assert_eq!(verdict.outcome, Outcome::Fail, "{}", verdict.reason);
    assert!(counts(&verdict));
    // exit_late has nothing to compare with when the present fails, and is not run.
    let late = exit_late::judge(&m, &sizes(), &Trading::Open);
    assert_eq!(late.outcome, Outcome::NotRun, "{}", late.reason);
}

#[test]
fn the_launch_clock_is_not_run_when_no_position_is_past() {
    let verdict = exit_launch_clock::judge(&timed(None, vec![]), &sizes(), &Trading::Open);
    assert_eq!(verdict.outcome, Outcome::NotRun, "{}", verdict.reason);
}

// ---------------------------------------------------------------------------------------
// exit_wallets
// ---------------------------------------------------------------------------------------

/// A round trip that put `AMOUNT` in and got `back` out.
fn back(back: u64) -> RoundTrip {
    let mut row = sold(AMOUNT, 0);
    if let Some(Ok(receipt)) = row.sell.as_mut().map(|l| l.swap.as_mut()) {
        receipt.trader_received = back;
    }
    row
}

fn insider() -> exit_wallets::Insider {
    exit_wallets::Insider {
        roles: vec!["the market creator".into()],
        key: Pubkey::new_unique(),
        skipped: None,
    }
}

fn wallets(fresh: Vec<RoundTrip>, insider_row: Option<RoundTrip>) -> exit_wallets::Measured {
    let insider = insider();
    let mut rows: Vec<exit_wallets::WalletRow> = fresh
        .into_iter()
        .map(|row| exit_wallets::WalletRow {
            who: "a fresh wallet".into(),
            fresh: true,
            row,
        })
        .collect();
    if let Some(row) = insider_row {
        rows.push(exit_wallets::WalletRow {
            who: insider.who(),
            fresh: false,
            row,
        });
    }
    exit_wallets::Measured {
        insiders: vec![insider],
        pairs: vec![exit_wallets::WalletPair {
            token: 1,
            reference: Some(reference(NOW)),
            rows,
        }],
    }
}

const FAIR_BACK: u64 = AMOUNT / 100 * 99;

#[test]
fn exit_wallets_passes_when_all_get_the_same_and_judges_an_insider_by_a_single_unit() {
    let fresh = || vec![back(FAIR_BACK); 5];
    let at = |insider_back| {
        exit_wallets::judge(
            &wallets(fresh(), Some(back(insider_back))),
            &sizes(),
            &Trading::Open,
        )
    };
    assert_eq!(
        at(FAIR_BACK).outcome,
        Outcome::Pass,
        "{}",
        at(FAIR_BACK).reason
    );
    let more = at(FAIR_BACK + 1);
    assert_eq!(more.outcome, Outcome::Fail, "{}", more.reason);
    assert!(
        more.reason.starts_with("The market creator ("),
        "{}",
        more.reason
    );
    let less = at(FAIR_BACK - 1);
    assert_eq!(less.outcome, Outcome::Warn, "{}", less.reason);
}

#[test]
fn exit_wallets_fails_when_fresh_wallets_differ_by_a_single_unit() {
    let mut fresh = vec![back(FAIR_BACK); 5];
    fresh[3] = back(FAIR_BACK - 1);
    let verdict = exit_wallets::judge(&wallets(fresh, None), &sizes(), &Trading::Open);
    assert_eq!(verdict.outcome, Outcome::Fail, "{}", verdict.reason);
    assert!(
        verdict
            .reason
            .starts_with("Fresh wallets got different results"),
        "{}",
        verdict.reason
    );
}

#[test]
fn an_insider_who_cannot_sell_warns_and_counts_as_could_not_sell_back() {
    let verdict = exit_wallets::judge(
        &wallets(vec![back(FAIR_BACK); 5], Some(stuck(AMOUNT))),
        &sizes(),
        &Trading::Open,
    );
    assert_eq!(verdict.outcome, Outcome::Warn, "{}", verdict.reason);
    assert!(counts(&verdict));
}

// ---------------------------------------------------------------------------------------
// exit_transferred
// ---------------------------------------------------------------------------------------

fn transferred(
    own: u64,
    transfer: Result<u64, Failure>,
    receiver_back: Option<Result<u64, ()>>,
) -> exit_transferred::Measured {
    let buyer = sold(AMOUNT, own);
    let mut buyer_row = RoundTrip {
        sell: None,
        ..buyer.clone()
    };
    if transfer.is_err() {
        buyer_row.sell = buyer.sell.clone();
    }
    let receiver_sale = receiver_back.map(|r| match r {
        Ok(got) => back(got).sell.unwrap(),
        Err(()) => stuck(AMOUNT).sell.unwrap(),
    });
    exit_transferred::Measured {
        pairs: vec![exit_transferred::TransferPair {
            token: 1,
            reference: Some(reference(own)),
            buyer: Some(buyer_row),
            receiver: Pubkey::new_unique(),
            hook: None,
            sent: AMOUNT,
            transfer: Some(transfer),
            receiver_sale,
        }],
    }
}

/// What comes back at `ppm` of `AMOUNT`.
fn at_ppm(ppm: u64) -> u64 {
    (AMOUNT as u128 * ppm as u128 / PPM as u128) as u64
}

#[test]
fn exit_transferred_passes_at_the_pass_band_and_warns_just_below_it_when_the_buyer_does_not() {
    let at = |ppm| {
        exit_transferred::judge(
            &transferred(NOW, Ok(AMOUNT), Some(Ok(at_ppm(ppm)))),
            &sizes(),
            &Trading::Open,
        )
    };
    let edge = at(PASS_BAND_MIN_PPM);
    assert_eq!(edge.outcome, Outcome::Pass, "{}", edge.reason);
    let below = at(PASS_BAND_MIN_PPM - 1);
    assert_eq!(below.outcome, Outcome::Warn, "{}", below.reason);
    assert!(!counts(&below));
}

#[test]
fn below_the_pass_band_for_buyer_and_receiver_alike_the_transfer_is_judged_on_the_tolerance() {
    let own = 600_000;
    let at = |ppm| {
        exit_transferred::judge(
            &transferred(own, Ok(AMOUNT), Some(Ok(at_ppm(ppm)))),
            &sizes(),
            &Trading::Open,
        )
    };
    let edge = at(own - TOLERANCE_PPM);
    assert_eq!(edge.outcome, Outcome::Pass, "{}", edge.reason);
    assert!(
        edge.reason.contains("which cost reports"),
        "{}",
        edge.reason
    );
    let beyond = at(own - TOLERANCE_PPM - 1);
    assert_eq!(beyond.outcome, Outcome::Warn, "{}", beyond.reason);
}

#[test]
fn a_refused_transfer_warns_says_so_and_never_counts_as_could_not_sell_back() {
    let refusal = Failure::plain(
        Stage::Transfer,
        FailureClass::OtherProgramRefused,
        &Pubkey::new_unique(),
        "transfer rejected",
    );
    let verdict = exit_transferred::judge(
        &transferred(NOW, Err(refusal), None),
        &sizes(),
        &Trading::Open,
    );
    assert_eq!(verdict.outcome, Outcome::Warn, "{}", verdict.reason);
    assert!(
        verdict
            .reason
            .starts_with("The token could not be sent to another wallet"),
        "{}",
        verdict.reason
    );
    assert!(
        verdict.reason.contains("the buyer got back 99.0%"),
        "{}",
        verdict.reason
    );
    assert!(!counts(&verdict));
}

#[test]
fn a_transferred_token_that_cannot_be_sold_fails_and_counts_as_could_not_sell_back() {
    let verdict = exit_transferred::judge(
        &transferred(NOW, Ok(AMOUNT), Some(Err(()))),
        &sizes(),
        &Trading::Open,
    );
    assert_eq!(verdict.outcome, Outcome::Fail, "{}", verdict.reason);
    assert!(counts(&verdict));
}

// ---------------------------------------------------------------------------------------
// exit_queue
// ---------------------------------------------------------------------------------------

/// Five buyers who each put in `AMOUNT` and together got back exactly `ppm` of it, less
/// `short` units taken from the last.
fn queue(ppm: u64, short: u64) -> exit_queue::Measured {
    let mut buyers: Vec<RoundTrip> = (0..5).map(|_| back(at_ppm(ppm))).collect();
    let last = back(at_ppm(ppm) - short);
    buyers[4] = last;
    exit_queue::Measured {
        pairs: vec![exit_queue::QueuePair {
            token: 1,
            reference: Some(reference(NOW)),
            buyers,
        }],
    }
}

#[test]
fn exit_queue_is_judged_on_the_total_at_both_band_edges() {
    let at = |ppm, short| exit_queue::judge(&queue(ppm, short), &sizes(), &Trading::Open).outcome;
    assert_eq!(at(PASS_BAND_MIN_PPM, 0), Outcome::Pass);
    assert_eq!(at(PASS_BAND_MIN_PPM, 1), Outcome::Warn);
    assert_eq!(at(FAIL_BAND_BELOW_PPM, 0), Outcome::Warn);
    assert_eq!(at(FAIL_BAND_BELOW_PPM, 1), Outcome::Fail);
}

#[test]
fn any_buyer_in_the_queue_who_cannot_sell_fails_it() {
    let mut m = queue(NOW, 0);
    m.pairs[0].buyers[2] = stuck(AMOUNT);
    let verdict = exit_queue::judge(&m, &sizes(), &Trading::Open);
    assert_eq!(verdict.outcome, Outcome::Fail, "{}", verdict.reason);
    assert!(
        verdict.reason.contains("buyer 3 could not sell"),
        "{}",
        verdict.reason
    );
    assert!(counts(&verdict));
}

#[test]
fn every_exit_check_is_not_run_when_trading_is_not_run() {
    let closed = Trading::NotRun("the market refuses every trade (WrongStatus)".into());
    let verdicts = [
        exit_hold::judge(&timed(None, vec![]), &sizes(), &closed),
        exit_late::judge(&timed(None, vec![]), &sizes(), &closed),
        exit_launch_clock::judge(&timed(None, vec![]), &sizes(), &closed),
        exit_wallets::judge(&wallets(vec![back(FAIR_BACK); 5], None), &sizes(), &closed),
        exit_transferred::judge(&transferred(NOW, Ok(AMOUNT), None), &sizes(), &closed),
        exit_queue::judge(&queue(NOW, 0), &sizes(), &closed),
    ];
    for verdict in verdicts {
        assert_eq!(verdict.outcome, Outcome::NotRun, "{}", verdict.reason);
        assert!(verdict.reason.contains("WrongStatus"), "{}", verdict.reason);
    }
}
