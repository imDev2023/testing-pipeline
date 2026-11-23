//! # Withdraw mode, and what `rebalance` does in each of Kamino's states
//!
//! As pure functions of numbers (docs/spec/lending-pool.md, "Withdraw mode" and "When Kamino
//! can't pay"):
//!
//! - The market's exposure is `X = max(V, T)`: the larger of its lent value `V` and its target
//!   lent value `T = L - t`, what it would lend with the buffer at its target `t`
//!   ([`crate::buffer::target`]). With the target term, a market that has redeemed everything
//!   does not lend straight back into the crunch, and a market never makes its first deposit
//!   into a reserve too thin to pay it back (owner, 2026-11-10).
//! - [`next_mode`]: below `WITHDRAW_MODE_ENTER` times `X` of freely available liquidity the
//!   market is in withdraw mode, above `WITHDRAW_MODE_EXIT` times `X` it is not, and between the
//!   two it keeps the mode it has. The thresholds never overlap, since the entry multiple is
//!   below the exit multiple, and their products are taken in 128 bits, where they cannot
//!   overflow; Kani proves both below.
//! - [`decide`]: `rebalance` refuses while Kamino has stopped redeems (either emergency mode, or
//!   a deprecated reserve); in withdraw mode it redeems everything Kamino can pay and deposits
//!   nothing; outside it the band applies ([`crate::buffer::plan`]), except that a deposit is
//!   skipped while Kamino blocks cToken deposits (`block_ctoken_usage`). A call that changes the
//!   mode succeeds even when it moves nothing, so the mode is recorded and its event emitted;
//!   one that neither moves nor changes the mode refuses, so a keeper's simulation shows there is
//!   nothing to do and nobody pays for a no-op.

use crate::buffer::{self, Move};
use crate::config::{WITHDRAW_MODE_ENTER, WITHDRAW_MODE_EXIT, WITHDRAW_MODE_EXIT_DELAY_SLOTS};
use crate::errors::StrategyError;

// The thresholds never overlap: a liquidity below the entry threshold is never above the exit
// threshold too. Checked when the program is built, so a change to either cannot break it.
const _: () = assert!(WITHDRAW_MODE_ENTER <= WITHDRAW_MODE_EXIT);

/// What `rebalance` reads of Kamino for a market's reserve.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Kamino {
    /// The reserve's freely available liquidity, which withdraw mode measures.
    pub free: u64,
    /// What a redeem may plan to take right now ([`crate::kamino::Reserve::can_pay_planned`]):
    /// at most the value of the market's own cTokens.
    pub can_pay: u64,
    /// Either emergency mode is on, or the reserve is deprecated: klend redeems nothing.
    pub stopped: bool,
    /// `block_ctoken_usage`: klend takes no cToken deposits, though it still redeems.
    pub deposits_blocked: bool,
}

/// What `rebalance` does: the mode the market has afterwards, what it moves, if anything, and
/// the exposure `X` it measured the mode against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    pub withdraw_mode: bool,
    pub planned: Option<Move>,
    pub exposure: u64,
}

/// The market's exposure, `X = max(V, T)`, for a lent value `lent_value` out of a lent side of
/// `lent_total` (at least `lent_value`), where `T = L - floor(L x BUFFER_TARGET_BPS / 10,000)`.
pub fn exposure(lent_value: u64, lent_total: u64) -> u64 {
    // The target buffer is at most L.
    lent_value.max(lent_total - buffer::target(lent_total))
}

/// Whether the market is in withdraw mode after `rebalance`, given whether it was (`current`),
/// Kamino's freely available liquidity `free` and the market's exposure `exposure`: in it below
/// `WITHDRAW_MODE_ENTER x X`, out of it above `WITHDRAW_MODE_EXIT x X`, and as it was between.
pub fn next_mode(current: bool, free: u64, exposure: u64) -> bool {
    let (free, exposure) = (free as u128, exposure as u128);
    // Each product is a u64 times a u64, so it fits in a u128.
    if free < WITHDRAW_MODE_ENTER as u128 * exposure {
        true
    } else if free > WITHDRAW_MODE_EXIT as u128 * exposure {
        false
    } else {
        current
    }
}

/// What `rebalance` does, as [`decide`] says, except that a market in withdraw mode leaves only
/// once it has seen Kamino's freely available liquidity above the exit threshold for
/// `WITHDRAW_MODE_EXIT_DELAY_SLOTS`: `exit_seen_slot` is when it first saw it so, 0 if it has not,
/// and `slot` is now. Returns the decision and the `exit_seen_slot` to record: the first sighting's
/// slot while the market waits to leave, and 0 once it is not waiting, so a `rebalance` that sees
/// the liquidity back at or below the threshold starts the wait again. A call that records a new
/// value succeeds even when it moves nothing, as one that changes the mode does.
pub fn decide_with_exit_delay(
    withdraw_mode: bool,
    exit_seen_slot: u64,
    slot: u64,
    buffer: u64,
    lent_value: u64,
    kamino: Kamino,
    min_rebalance: u64,
) -> Result<(Decision, u64), StrategyError> {
    let lent_total = buffer
        .checked_add(lent_value)
        .ok_or(StrategyError::Overflow)?;
    let x = exposure(lent_value, lent_total);
    if kamino.stopped {
        // While Kamino redeems nothing `rebalance` refuses, except to forget a wait to leave: a
        // sighting from before an emergency must not let the market leave at the first reading
        // after it (finding R2-04, docs/security/lending-amm/).
        if exit_seen_slot != 0 {
            return Ok((
                Decision {
                    withdraw_mode,
                    planned: None,
                    exposure: x,
                },
                0,
            ));
        }
        return Err(StrategyError::KaminoStopped);
    }
    let wants_out = withdraw_mode && !next_mode(withdraw_mode, kamino.free, x);
    let waited = exit_seen_slot != 0
        && slot >= exit_seen_slot.saturating_add(WITHDRAW_MODE_EXIT_DELAY_SLOTS);
    if wants_out && !waited {
        // Still in withdraw mode while it waits: it redeems everything Kamino can pay. A sighting
        // is recorded as slot 1 at the earliest, since 0 means none.
        let seen = if exit_seen_slot == 0 {
            slot.max(1)
        } else {
            exit_seen_slot
        };
        return match redeem_everything(lent_value, kamino.can_pay, min_rebalance) {
            Ok(planned) => Ok((
                Decision {
                    withdraw_mode: true,
                    planned: Some(planned),
                    exposure: x,
                },
                seen,
            )),
            Err(_) if seen != exit_seen_slot => Ok((
                Decision {
                    withdraw_mode: true,
                    planned: None,
                    exposure: x,
                },
                seen,
            )),
            Err(refusal) => Err(refusal),
        };
    }
    match decide(withdraw_mode, buffer, lent_value, kamino, min_rebalance) {
        Ok(decision) => Ok((decision, 0)),
        // Nothing to move and no change of mode, but a wait to forget.
        Err(_) if exit_seen_slot != 0 => Ok((
            Decision {
                withdraw_mode,
                planned: None,
                exposure: x,
            },
            0,
        )),
        Err(refusal) => Err(refusal),
    }
}

/// The exit delay's rules, which Proptest and Kani check: [`decide_with_exit_delay`] takes a market
/// out of withdraw mode only once `WITHDRAW_MODE_EXIT_DELAY_SLOTS` have passed since a sighting it
/// recorded; while a market waits it stays in withdraw mode, redeems only, and records its first
/// sighting; a market not waiting records none; and otherwise it does what [`decide`] does.
#[cfg(any(test, kani))]
pub(crate) fn assert_the_exit_waits(
    current: bool,
    exit_seen_slot: u64,
    slot: u64,
    buffer: u64,
    lent_value: u64,
    kamino: Kamino,
    min_rebalance: u64,
) {
    let result = decide_with_exit_delay(
        current,
        exit_seen_slot,
        slot,
        buffer,
        lent_value,
        kamino,
        min_rebalance,
    );
    let x = exposure(lent_value, buffer + lent_value);
    let wants_out = current && !next_mode(current, kamino.free, x);
    let waited = exit_seen_slot != 0
        && slot >= exit_seen_slot.saturating_add(WITHDRAW_MODE_EXIT_DELAY_SLOTS);
    if kamino.stopped {
        // Only a wait to forget, and nothing moved.
        match result {
            Ok((decision, seen)) => {
                assert!(exit_seen_slot != 0 && seen == 0);
                assert!(decision.planned.is_none() && decision.withdraw_mode == current);
            }
            Err(refusal) => {
                assert!(exit_seen_slot == 0 && matches!(refusal, StrategyError::KaminoStopped))
            }
        }
        return;
    }
    match result {
        Err(refusal) => {
            assert!(kamino.stopped || !matches!(refusal, StrategyError::KaminoStopped));
            // A refusal changes nothing: nothing to forget, and no first sighting to record.
            assert!(
                kamino.stopped
                    || (exit_seen_slot == 0 && !wants_out)
                    || (wants_out && exit_seen_slot != 0 && !waited)
            );
        }
        Ok((decision, seen)) => {
            assert!(!kamino.stopped);
            if current && !decision.withdraw_mode {
                assert!(waited);
            }
            if wants_out && !waited {
                assert!(decision.withdraw_mode);
                assert!(
                    seen == if exit_seen_slot == 0 {
                        slot.max(1)
                    } else {
                        exit_seen_slot
                    }
                );
                assert!(!matches!(decision.planned, Some(Move::Deposit(_))));
            } else {
                assert!(seen == 0);
                if let Ok(direct) = decide(current, buffer, lent_value, kamino, min_rebalance) {
                    assert!(direct == decision);
                }
            }
        }
    }
}

/// In withdraw mode: redeem everything Kamino can pay, `min(V, can_pay)`. A redeem below the lent
/// mint's floor is skipped, unless it takes the whole position, so a market can always empty
/// out its last cTokens.
fn redeem_everything(
    lent_value: u64,
    can_pay: u64,
    min_rebalance: u64,
) -> Result<Move, StrategyError> {
    let amount = lent_value.min(can_pay);
    if amount == 0 || (amount < min_rebalance && amount < lent_value) {
        return Err(StrategyError::BelowMinRebalance);
    }
    Ok(Move::Redeem(amount))
}

/// What `rebalance` does for a market whose buffer is `buffer` and whose cTokens are worth
/// `lent_value` at the stored rate, in withdraw mode or not (`withdraw_mode`), against Kamino's
/// state `kamino`, with the lent mint's floor `min_rebalance`.
pub fn decide(
    withdraw_mode: bool,
    buffer: u64,
    lent_value: u64,
    kamino: Kamino,
    min_rebalance: u64,
) -> Result<Decision, StrategyError> {
    if kamino.stopped {
        return Err(StrategyError::KaminoStopped);
    }
    let lent_total = buffer
        .checked_add(lent_value)
        .ok_or(StrategyError::Overflow)?;
    let x = exposure(lent_value, lent_total);
    let mode = next_mode(withdraw_mode, kamino.free, x);
    let planned = if mode {
        redeem_everything(lent_value, kamino.can_pay, min_rebalance)
    } else {
        match buffer::plan(buffer, lent_total, kamino.can_pay, min_rebalance) {
            Ok(Move::Deposit(_)) if kamino.deposits_blocked => {
                Err(StrategyError::KaminoDepositsBlocked)
            }
            planned => planned,
        }
    };
    match planned {
        Ok(planned) => Ok(Decision {
            withdraw_mode: mode,
            planned: Some(planned),
            exposure: x,
        }),
        Err(_) if mode != withdraw_mode => Ok(Decision {
            withdraw_mode: mode,
            planned: None,
            exposure: x,
        }),
        Err(refusal) => Err(refusal),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::BUFFER_TARGET_BPS;
    use proptest::prelude::*;

    fn kamino(free: u64, can_pay: u64) -> Kamino {
        Kamino {
            free,
            can_pay,
            ..Kamino::default()
        }
    }

    fn code(result: Result<Decision, StrategyError>) -> Result<Decision, u32> {
        result.map_err(|error| error as u32)
    }

    #[test]
    fn the_exposure_is_the_larger_of_the_lent_value_and_the_target_lent_value() {
        // L = 100 with 20% as the buffer's target: T = 80.
        assert_eq!(exposure(50, 100), 80);
        assert_eq!(exposure(90, 100), 90);
        // Nothing lent: T alone, so a first deposit is measured too.
        assert_eq!(exposure(0, 100), 80);
        // T rounds up, as L less the target rounded down.
        assert_eq!(
            exposure(0, 101),
            101 - 101 * BUFFER_TARGET_BPS as u64 / 10_000
        );
        assert_eq!(exposure(0, 0), 0);
    }

    #[test]
    fn the_mode_enters_below_the_entry_threshold_leaves_above_the_exit_and_holds_between() {
        let x = 100;
        let enter = WITHDRAW_MODE_ENTER * x;
        let exit = WITHDRAW_MODE_EXIT * x;
        for current in [false, true] {
            assert!(next_mode(current, enter - 1, x));
            assert!(!next_mode(current, exit + 1, x));
            // Both edges are between.
            assert_eq!(next_mode(current, enter, x), current);
            assert_eq!(next_mode(current, exit, x), current);
        }
    }

    #[test]
    fn the_examples_of_each_state() {
        let floor = 10;
        // Normal, inside the band and well away from the threshold: nothing to do.
        assert_eq!(
            code(decide(false, 20, 80, kamino(10_000, 1_000), floor)),
            Err(StrategyError::WithinBand as u32)
        );
        // Below the entry threshold: enter and redeem everything Kamino can pay.
        assert_eq!(
            code(decide(false, 20, 80, kamino(399, 1_000), floor)),
            Ok(Decision {
                withdraw_mode: true,
                planned: Some(Move::Redeem(80)),
                exposure: 80
            })
        );
        // Kamino can pay only part of it.
        assert_eq!(
            code(decide(false, 20, 80, kamino(399, 30), floor)),
            Ok(Decision {
                withdraw_mode: true,
                planned: Some(Move::Redeem(30)),
                exposure: 80
            })
        );
        // Entering with nothing Kamino can pay still records the mode.
        assert_eq!(
            code(decide(false, 20, 80, kamino(399, 0), floor)),
            Ok(Decision {
                withdraw_mode: true,
                planned: None,
                exposure: 80
            })
        );
        // Already in it, everything redeemed: nothing to do, and it stays.
        assert_eq!(
            code(decide(true, 100, 0, kamino(500, 0), floor)),
            Err(StrategyError::BelowMinRebalance as u32)
        );
        // Above the exit threshold it leaves, and lends again in the same call.
        assert_eq!(
            code(decide(true, 100, 0, kamino(801, 0), floor)),
            Ok(Decision {
                withdraw_mode: false,
                planned: Some(Move::Deposit(80)),
                exposure: 80
            })
        );
        // Leaving while deposits are blocked still records the mode.
        let blocked = Kamino {
            deposits_blocked: true,
            ..kamino(801, 0)
        };
        assert_eq!(
            code(decide(true, 100, 0, blocked, floor)),
            Ok(Decision {
                withdraw_mode: false,
                planned: None,
                exposure: 80
            })
        );
        // Blocked deposits are skipped and redeems go ahead.
        let blocked = Kamino {
            deposits_blocked: true,
            ..kamino(10_000, 1_000)
        };
        assert_eq!(
            code(decide(false, 100, 0, blocked, floor)),
            Err(StrategyError::KaminoDepositsBlocked as u32)
        );
        assert_eq!(
            code(decide(false, 5, 95, blocked, floor)),
            Ok(Decision {
                withdraw_mode: false,
                planned: Some(Move::Redeem(15)),
                exposure: 95
            })
        );
        // Stopped redeems refuse, whatever else holds.
        let stopped = Kamino {
            stopped: true,
            ..kamino(0, 0)
        };
        assert_eq!(
            code(decide(false, 20, 80, stopped, floor)),
            Err(StrategyError::KaminoStopped as u32)
        );
        // In withdraw mode a remainder below the floor is redeemed only when it is the whole
        // position.
        assert_eq!(
            code(decide(true, 100, 5, kamino(0, 1_000), floor)),
            Ok(Decision {
                withdraw_mode: true,
                planned: Some(Move::Redeem(5)),
                exposure: 84
            })
        );
        assert_eq!(
            code(decide(true, 100, 50, kamino(0, 5), floor)),
            Err(StrategyError::BelowMinRebalance as u32)
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Withdraw mode's invariants: the mode follows the thresholds; in withdraw mode
        /// `rebalance` only redeems, never more than Kamino can pay or the market has lent;
        /// it never deposits while deposits are blocked; it refuses while redeems are stopped;
        /// a market in withdraw mode stays in it while the free liquidity is at or below the exit
        /// threshold; and a market that has lent nothing never deposits into a reserve below the
        /// entry threshold.
        #[test]
        fn rebalance_follows_withdraw_modes_rules(
            current: bool,
            buffer in 0u64..=u64::MAX / 2,
            lent_value in 0u64..=u64::MAX / 2,
            free: u64,
            can_pay: u64,
            stopped in proptest::bool::weighted(0.1),
            deposits_blocked: bool,
            min_rebalance in 0u64..=100_000_000,
        ) {
            let can_pay = can_pay.min(lent_value);
            let state = Kamino { free, can_pay, stopped, deposits_blocked };
            let x = exposure(lent_value, buffer + lent_value) as u128;
            match decide(current, buffer, lent_value, state, min_rebalance) {
                Err(StrategyError::KaminoStopped) => prop_assert!(stopped),
                Err(_) => {
                    prop_assert!(!stopped);
                    prop_assert_eq!(next_mode(current, free, x as u64), current);
                }
                Ok(decision) => {
                    prop_assert!(!stopped);
                    prop_assert_eq!(decision.withdraw_mode, next_mode(current, free, x as u64));
                    if (free as u128) < WITHDRAW_MODE_ENTER as u128 * x {
                        prop_assert!(decision.withdraw_mode);
                    }
                    if current && free as u128 <= WITHDRAW_MODE_EXIT as u128 * x {
                        prop_assert!(decision.withdraw_mode);
                    }
                    match decision.planned {
                        Some(Move::Deposit(d)) => {
                            prop_assert!(!decision.withdraw_mode && !deposits_blocked && d > 0);
                            prop_assert!(lent_value > 0 || free as u128 >= WITHDRAW_MODE_ENTER as u128 * x);
                        }
                        Some(Move::Redeem(r)) => {
                            prop_assert!(r > 0 && r <= can_pay && r <= lent_value);
                            if decision.withdraw_mode {
                                prop_assert_eq!(r, lent_value.min(can_pay));
                            }
                        }
                        None => prop_assert!(decision.withdraw_mode != current),
                    }
                }
            }
        }

        /// The exit delay: a market leaves withdraw mode only after seeing the free liquidity
        /// above the exit threshold for `WITHDRAW_MODE_EXIT_DELAY_SLOTS`, redeems and never
        /// deposits while it waits, and records a sighting only while it waits.
        #[test]
        fn a_market_leaves_withdraw_mode_only_after_the_exit_delay(
            current: bool,
            exit_seen_slot in proptest::option::of(1u64..=u64::MAX).prop_map(|s| s.unwrap_or(0)),
            slot: u64,
            buffer in 0u64..=u64::MAX / 2,
            lent_value in 0u64..=u64::MAX / 2,
            free: u64,
            can_pay: u64,
            stopped in proptest::bool::weighted(0.1),
            deposits_blocked: bool,
            min_rebalance in 0u64..=100_000_000,
        ) {
            let state = Kamino { free, can_pay: can_pay.min(lent_value), stopped, deposits_blocked };
            assert_the_exit_waits(current, exit_seen_slot, slot, buffer, lent_value, state, min_rebalance);
        }
    }
}

// Kani proofs (`cargo kani`, docs/toolchain.md), for every input: the thresholds never overlap,
// so no state both enters and leaves withdraw mode, and their products cannot overflow; and
// `decide` never panics. None of them reasons about a quotient, so none needs a bound.
#[cfg(kani)]
mod proofs {
    use super::*;

    /// No liquidity is both below the entry threshold and above the exit threshold, for any
    /// exposure, and both products fit in 128 bits.
    #[kani::proof]
    fn the_thresholds_never_overlap_and_their_products_never_overflow() {
        let free: u64 = kani::any();
        let exposure: u64 = kani::any();
        let enter = (WITHDRAW_MODE_ENTER as u128).checked_mul(exposure as u128);
        let exit = (WITHDRAW_MODE_EXIT as u128).checked_mul(exposure as u128);
        assert!(enter.is_some() && exit.is_some());
        let (enter, exit) = (enter.unwrap_or(0), exit.unwrap_or(0));
        assert!(!((free as u128) < enter && (free as u128) > exit));
        // And the mode follows them: below the one it is on, above the other off, between it
        // holds.
        let current: bool = kani::any();
        let mode = next_mode(current, free, exposure);
        if (free as u128) < enter {
            assert!(mode);
        } else if (free as u128) > exit {
            assert!(!mode);
        } else {
            assert!(mode == current);
        }
    }

    /// For any market and any state of Kamino, `rebalance`'s decision runs without panicking.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn decide_never_panics() {
        let state = Kamino {
            free: kani::any(),
            can_pay: kani::any(),
            stopped: kani::any(),
            deposits_blocked: kani::any(),
        };
        let _ = decide(kani::any(), kani::any(), kani::any(), state, kani::any());
    }

    /// The exposure is the larger of the lent value and the target lent value, so never below
    /// the lent value, and never above the lent side: bounded below 2^16;
    /// `proofs/withdraw_mode_z3.py` for every input.
    #[kani::proof]
    fn the_exposure_is_the_larger_term_and_within_the_lent_side_bounded() {
        let lent_total: u64 = kani::any_where(|&l| l < (1 << 16));
        assert_exposure_is_the_larger_term(kani::any_where(|&v| v <= lent_total), lent_total);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    fn the_exposure_is_the_larger_term_and_within_the_lent_side() {
        let lent_total: u64 = kani::any();
        assert_exposure_is_the_larger_term(kani::any_where(|&v| v <= lent_total), lent_total);
    }

    fn assert_exposure_is_the_larger_term(lent_value: u64, lent_total: u64) {
        let x = exposure(lent_value, lent_total);
        let target_lent = lent_total - buffer::target(lent_total);
        assert!(x >= lent_value && x >= target_lent);
        assert!(x == lent_value || x == target_lent);
        assert!(x <= lent_total);
    }

    /// Withdraw mode's rules for `rebalance`, the Proptest property's statements:
    /// it refuses while redeems are stopped and otherwise only while the mode holds; the mode
    /// it records follows the thresholds, so a market in withdraw mode stays in it while the
    /// free liquidity is at or below the exit threshold; in withdraw mode it only redeems,
    /// everything Kamino can pay; it never deposits while deposits are blocked, and a market
    /// that has lent nothing never makes its first deposit into a reserve below the entry
    /// threshold; it never redeems more than Kamino can pay or the market has lent; and a call
    /// that moves nothing changed the mode.
    fn assert_decide_follows_the_rules(
        current: bool,
        buffer: u64,
        lent_value: u64,
        state: Kamino,
        min_rebalance: u64,
    ) {
        let Some(lent_total) = buffer.checked_add(lent_value) else {
            return;
        };
        let x = exposure(lent_value, lent_total) as u128;
        let enter = WITHDRAW_MODE_ENTER as u128 * x;
        let exit = WITHDRAW_MODE_EXIT as u128 * x;
        let free = state.free as u128;
        match decide(current, buffer, lent_value, state, min_rebalance) {
            Err(StrategyError::KaminoStopped) => assert!(state.stopped),
            Err(_) => {
                assert!(!state.stopped);
                assert!(next_mode(current, state.free, x as u64) == current);
            }
            Ok(decision) => {
                assert!(!state.stopped);
                assert!(decision.exposure as u128 == x);
                assert!(decision.withdraw_mode == next_mode(current, state.free, x as u64));
                if free < enter {
                    assert!(decision.withdraw_mode);
                }
                if current && free <= exit {
                    assert!(decision.withdraw_mode);
                }
                match decision.planned {
                    Some(Move::Deposit(d)) => {
                        assert!(!decision.withdraw_mode && !state.deposits_blocked && d > 0);
                        assert!(d <= buffer);
                        assert!(lent_value > 0 || free >= enter);
                    }
                    Some(Move::Redeem(r)) => {
                        assert!(r > 0 && r <= state.can_pay && r <= lent_value);
                        if decision.withdraw_mode {
                            assert!(r == lent_value.min(state.can_pay));
                        }
                    }
                    None => assert!(decision.withdraw_mode != current),
                }
            }
        }
    }

    /// The rules for every input but a bounded buffer and lent value, below 2^8, where the
    /// target's division is cheap; `proofs/withdraw_mode_z3.py` proves the exposure's terms for
    /// every input, and the rules are the same comparisons whatever the size.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn rebalance_follows_withdraw_modes_rules_bounded() {
        let state = Kamino {
            free: kani::any(),
            can_pay: kani::any(),
            stopped: kani::any(),
            deposits_blocked: kani::any(),
        };
        assert_decide_follows_the_rules(
            kani::any(),
            kani::any_where(|&b| b < (1 << 8)),
            kani::any_where(|&v| v < (1 << 8)),
            state,
            kani::any(),
        );
    }

    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::solver(cadical)]
    fn rebalance_follows_withdraw_modes_rules() {
        let state = Kamino {
            free: kani::any(),
            can_pay: kani::any(),
            stopped: kani::any(),
            deposits_blocked: kani::any(),
        };
        assert_decide_follows_the_rules(kani::any(), kani::any(), kani::any(), state, kani::any());
    }

    /// The exit delay's rules for every input but a bounded buffer and lent value, below 2^8,
    /// as for `decide`'s own rules.
    #[kani::proof]
    #[kani::solver(cadical)]
    fn a_market_leaves_withdraw_mode_only_after_the_exit_delay_bounded() {
        let state = Kamino {
            free: kani::any(),
            can_pay: kani::any(),
            stopped: kani::any(),
            deposits_blocked: kani::any(),
        };
        assert_the_exit_waits(
            kani::any(),
            kani::any(),
            kani::any(),
            kani::any_where(|&b| b < (1 << 8)),
            kani::any_where(|&v| v < (1 << 8)),
            state,
            kani::any(),
        );
    }
}
