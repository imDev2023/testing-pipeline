//! The unlock terms a launcher chooses at binding, and the rules on them, as pure functions
//! that take no accounts (docs/spec/containment-hook.md, "Binding"; docs/spec/README.md,
//! "Test layers" 2).

use crate::config::MAX_UNLOCK_DEADLINE_SECS;

/// Why the unlock terms are refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TermsRefusal {
    /// The unlock goal is zero, which would make the token unlockable at once.
    ZeroGoal,
    /// The deadline is not later than the binding.
    DeadlineNotInFuture,
    /// The deadline is more than [`MAX_UNLOCK_DEADLINE_SECS`] after the binding.
    DeadlineTooFar,
}

/// The deadline rule: an unlock deadline is allowed exactly when it is later than `now`,
/// the binding's Unix time, and at most [`MAX_UNLOCK_DEADLINE_SECS`] after it.
pub fn check_deadline(now: i64, deadline: i64) -> Result<(), TermsRefusal> {
    if deadline <= now {
        return Err(TermsRefusal::DeadlineNotInFuture);
    }
    // `deadline > now`, so the difference is positive; it overflows an i64 only when it is
    // far beyond the limit anyway.
    match deadline.checked_sub(now) {
        Some(delay) if delay <= MAX_UNLOCK_DEADLINE_SECS => Ok(()),
        _ => Err(TermsRefusal::DeadlineTooFar),
    }
}

/// Every rule on `bind`'s arguments: a goal above zero, in quote-mint base units, and the
/// deadline rule.
pub fn check_terms(now: i64, unlock_goal: u64, unlock_deadline: i64) -> Result<(), TermsRefusal> {
    if unlock_goal == 0 {
        return Err(TermsRefusal::ZeroGoal);
    }
    check_deadline(now, unlock_deadline)
}

/// What made an unlock due.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DueBy {
    /// The home market has collected the unlock goal in tax.
    Goal,
    /// The unlock deadline has passed, and the goal was not reached.
    Deadline,
}

/// The unlock rule (docs/spec/containment-hook.md, "Unlock"): an unlock is due exactly when
/// the home market's `tax_collected`, a u128 in quote-mint base units, is at least the
/// unlock goal, or when `now` is at or past the unlock deadline. The goal is named when both
/// hold. `None` means not due yet.
///
/// `tax_collected` is `None` when the market state can no longer be read as a tax AMM market
/// state, for example after an upgrade changed it: the goal then counts as not reached, and
/// the deadline alone decides, since it exists to cap how long holders can be stuck when the
/// home market stops working ("Unlock deadline").
pub fn unlock_due(
    tax_collected: Option<u128>,
    unlock_goal: u64,
    now: i64,
    unlock_deadline: i64,
) -> Option<DueBy> {
    if tax_collected.is_some_and(|tax| tax >= u128::from(unlock_goal)) {
        Some(DueBy::Goal)
    } else if now >= unlock_deadline {
        Some(DueBy::Deadline)
    } else {
        None
    }
}

/// The deadline rule as plain arithmetic in a wider type, which cannot overflow: what
/// [`check_deadline`] must agree with for every input.
#[cfg(any(test, kani))]
fn deadline_allowed(now: i64, deadline: i64) -> bool {
    let delay = deadline as i128 - now as i128;
    delay > 0 && delay <= MAX_UNLOCK_DEADLINE_SECS as i128
}

/// The unlock rule as the spec words it, in the widest types, with no early return: what
/// [`unlock_due`] must agree with for every input.
#[cfg(any(test, kani))]
fn due_by(
    tax_collected: Option<u128>,
    unlock_goal: u64,
    now: i64,
    unlock_deadline: i64,
) -> Option<DueBy> {
    let goal_reached = match tax_collected {
        Some(tax) => tax >= unlock_goal as u128,
        None => false,
    };
    let deadline_passed = now as i128 >= unlock_deadline as i128;
    match (goal_reached, deadline_passed) {
        (true, _) => Some(DueBy::Goal),
        (false, true) => Some(DueBy::Deadline),
        (false, false) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn the_edges_of_the_deadline_rule() {
        assert_eq!(
            check_deadline(NOW, NOW),
            Err(TermsRefusal::DeadlineNotInFuture)
        );
        assert_eq!(
            check_deadline(NOW, NOW - 1),
            Err(TermsRefusal::DeadlineNotInFuture)
        );
        assert_eq!(check_deadline(NOW, NOW + 1), Ok(()));
        assert_eq!(check_deadline(NOW, NOW + MAX_UNLOCK_DEADLINE_SECS), Ok(()));
        assert_eq!(
            check_deadline(NOW, NOW + MAX_UNLOCK_DEADLINE_SECS + 1),
            Err(TermsRefusal::DeadlineTooFar)
        );
        assert_eq!(
            check_deadline(i64::MIN, i64::MAX),
            Err(TermsRefusal::DeadlineTooFar)
        );
        assert_eq!(
            check_deadline(i64::MAX, i64::MIN),
            Err(TermsRefusal::DeadlineNotInFuture)
        );
    }

    #[test]
    fn the_edges_of_the_unlock() {
        const GOAL: u64 = 5_000_000_000;
        let deadline = NOW + 30 * 24 * 60 * 60;
        // Before either: one unit short of the goal and one second before the deadline.
        assert_eq!(
            unlock_due(Some(GOAL as u128 - 1), GOAL, deadline - 1, deadline),
            None
        );
        assert_eq!(unlock_due(Some(0), GOAL, NOW, deadline), None);
        // The goal, at it and past it.
        assert_eq!(
            unlock_due(Some(GOAL as u128), GOAL, NOW, deadline),
            Some(DueBy::Goal)
        );
        assert_eq!(
            unlock_due(Some(u128::MAX), GOAL, NOW, deadline),
            Some(DueBy::Goal)
        );
        // The deadline, at it and past it.
        assert_eq!(
            unlock_due(Some(0), GOAL, deadline, deadline),
            Some(DueBy::Deadline)
        );
        assert_eq!(
            unlock_due(Some(0), GOAL, i64::MAX, deadline),
            Some(DueBy::Deadline)
        );
        // Both: the goal is named.
        assert_eq!(
            unlock_due(Some(GOAL as u128), GOAL, deadline, deadline),
            Some(DueBy::Goal)
        );
        // A counter far beyond a u64 still compares in full.
        assert_eq!(
            unlock_due(Some(1 << 64), u64::MAX, NOW, deadline),
            Some(DueBy::Goal)
        );
        assert_eq!(
            unlock_due(Some(u64::MAX as u128 - 1), u64::MAX, NOW, deadline),
            None
        );
        // A counter that cannot be read never reaches the goal; the deadline still decides.
        assert_eq!(unlock_due(None, 1, deadline - 1, deadline), None);
        assert_eq!(
            unlock_due(None, 1, deadline, deadline),
            Some(DueBy::Deadline)
        );
        assert_eq!(unlock_due(None, 0, NOW, deadline), None);
    }

    #[test]
    fn ninety_days_is_the_longest_deadline() {
        assert_eq!(MAX_UNLOCK_DEADLINE_SECS, 7_776_000);
    }

    #[test]
    fn a_zero_goal_is_refused_before_the_deadline_is_looked_at() {
        assert_eq!(check_terms(NOW, 0, NOW + 1), Err(TermsRefusal::ZeroGoal));
        assert_eq!(check_terms(NOW, 0, NOW), Err(TermsRefusal::ZeroGoal));
        assert_eq!(check_terms(NOW, 1, NOW + 1), Ok(()));
        assert_eq!(
            check_terms(NOW, u64::MAX, NOW),
            Err(TermsRefusal::DeadlineNotInFuture)
        );
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// Over the whole domain of both times.
        #[test]
        fn the_deadline_rule_is_exactly_later_than_now_and_at_most_the_longest_deadline(
            now in any::<i64>(),
            deadline in any::<i64>(),
        ) {
            prop_assert_eq!(check_deadline(now, deadline).is_ok(), deadline_allowed(now, deadline));
        }

        /// Near the binding, where real deadlines fall and where uniform sampling of two
        /// i64s almost never lands.
        #[test]
        fn the_deadline_rule_near_the_binding(
            now in -4_000_000_000i64..4_000_000_000,
            delay in -2 * MAX_UNLOCK_DEADLINE_SECS..2 * MAX_UNLOCK_DEADLINE_SECS,
        ) {
            let deadline = now + delay;
            let result = check_deadline(now, deadline);
            prop_assert_eq!(result.is_ok(), delay > 0 && delay <= MAX_UNLOCK_DEADLINE_SECS);
            if delay <= 0 {
                prop_assert_eq!(result, Err(TermsRefusal::DeadlineNotInFuture));
            } else if delay > MAX_UNLOCK_DEADLINE_SECS {
                prop_assert_eq!(result, Err(TermsRefusal::DeadlineTooFar));
            }
        }

        /// Over the whole domain of every input: due exactly when the goal is reached or the
        /// deadline has passed, naming the goal whenever it is reached.
        #[test]
        fn the_unlock_is_due_exactly_by_the_goal_or_the_deadline(
            tax in any::<Option<u128>>(),
            goal in any::<u64>(),
            now in any::<i64>(),
            deadline in any::<i64>(),
        ) {
            prop_assert_eq!(unlock_due(tax, goal, now, deadline), due_by(tax, goal, now, deadline));
        }

        /// Near both edges, where uniform sampling almost never lands: a counter within a few
        /// units of the goal, and a clock within a few seconds of the deadline.
        #[test]
        fn the_unlock_near_its_edges(
            goal in 1u64..=u64::MAX,
            short in -3i128..=3,
            deadline in any::<i64>(),
            early in -3i128..=3,
        ) {
            let tax = (goal as i128 + short).max(0) as u128;
            let now = (deadline as i128 + early).clamp(i64::MIN as i128, i64::MAX as i128) as i64;
            let due = unlock_due(Some(tax), goal, now, deadline);
            prop_assert_eq!(due, due_by(Some(tax), goal, now, deadline));
            if tax < goal as u128 && now < deadline {
                prop_assert_eq!(due, None);
            }
            // Unreadable, the same counter leaves only the deadline.
            prop_assert_eq!(unlock_due(None, goal, now, deadline), (now >= deadline).then_some(DueBy::Deadline));
        }

        /// More tax or a later clock never takes back an unlock that was due, and an unlock
        /// due by the deadline stays due whatever becomes of the counter.
        #[test]
        fn a_due_unlock_stays_due(
            tax in any::<Option<u128>>(),
            more_tax in any::<u128>(),
            goal in any::<u64>(),
            now in any::<i64>(),
            later in any::<i64>(),
            deadline in any::<i64>(),
        ) {
            if unlock_due(tax, goal, now, deadline).is_some() {
                let tax2 = tax.map(|tax| tax.saturating_add(more_tax));
                let now2 = now.max(later);
                prop_assert!(unlock_due(tax2, goal, now2, deadline).is_some());
            }
            if now >= deadline {
                prop_assert!(unlock_due(None, goal, now, deadline).is_some());
            }
        }

        /// A goal is allowed exactly when it is above zero, whatever the deadline.
        #[test]
        fn the_terms_are_the_goal_rule_then_the_deadline_rule(
            now in any::<i64>(),
            goal in any::<u64>(),
            deadline in any::<i64>(),
        ) {
            let expected = if goal == 0 {
                Err(TermsRefusal::ZeroGoal)
            } else {
                check_deadline(now, deadline)
            };
            prop_assert_eq!(check_terms(now, goal, deadline), expected);
        }
    }
}

/// Kani proofs of the deadline rule over every pair of i64 times: it never panics or
/// overflows, it allows exactly the deadlines later than now and at most the longest
/// deadline after it, and it names the right reason when it refuses.
#[cfg(kani)]
mod proofs {
    use super::*;

    #[kani::proof]
    fn the_deadline_rule_is_exact_for_every_time() {
        let now: i64 = kani::any();
        let deadline: i64 = kani::any();
        let result = check_deadline(now, deadline);
        assert_eq!(result.is_ok(), deadline_allowed(now, deadline));
        if deadline <= now {
            assert_eq!(result, Err(TermsRefusal::DeadlineNotInFuture));
        } else if !deadline_allowed(now, deadline) {
            assert_eq!(result, Err(TermsRefusal::DeadlineTooFar));
        }
    }

    /// Over every counter, readable or not, every goal and every pair of times: the unlock is
    /// due exactly when a readable counter reaches the goal or the deadline has passed, it
    /// never panics, and it names the goal whenever the goal is reached.
    #[kani::proof]
    fn the_unlock_is_due_exactly_by_the_goal_or_the_deadline() {
        let tax: Option<u128> = kani::any();
        let goal: u64 = kani::any();
        let now: i64 = kani::any();
        let deadline: i64 = kani::any();
        let due = unlock_due(tax, goal, now, deadline);
        assert_eq!(due, due_by(tax, goal, now, deadline));
        let goal_reached = matches!(tax, Some(tax) if tax >= goal as u128);
        assert_eq!(due.is_some(), goal_reached || now >= deadline);
        assert_eq!(due == Some(DueBy::Goal), goal_reached);
    }

    #[kani::proof]
    fn the_terms_refuse_exactly_a_zero_goal_or_a_refused_deadline() {
        let now: i64 = kani::any();
        let goal: u64 = kani::any();
        let deadline: i64 = kani::any();
        let result = check_terms(now, goal, deadline);
        assert_eq!(result.is_ok(), goal > 0 && deadline_allowed(now, deadline));
        if goal == 0 {
            assert_eq!(result, Err(TermsRefusal::ZeroGoal));
        }
    }

    /// Book of Knowledge TM-4 (#74): over every input, more tax or a later clock never takes
    /// back an unlock that was due, and an unlock due by the deadline stays due whatever
    /// becomes of the counter, readable or not; the Proptest `a_due_unlock_stays_due` samples
    /// the same statement.
    #[kani::proof]
    fn a_due_unlock_stays_due_for_every_input() {
        let tax: Option<u128> = kani::any();
        let more_tax: u128 = kani::any();
        let goal: u64 = kani::any();
        let now: i64 = kani::any();
        let later: i64 = kani::any();
        let deadline: i64 = kani::any();
        if unlock_due(tax, goal, now, deadline).is_some() {
            let tax2 = tax.map(|tax| tax.saturating_add(more_tax));
            assert!(unlock_due(tax2, goal, now.max(later), deadline).is_some());
        }
        if now >= deadline {
            assert!(unlock_due(None, goal, now, deadline).is_some());
            assert!(unlock_due(tax, goal, now.max(later), deadline).is_some());
        }
    }

    /// Book of Knowledge TM-5 (#74): every binding the terms accept is unlockable by anyone
    /// from `MAX_UNLOCK_DEADLINE_SECS` after the binding on, whatever the home market's
    /// counter, readable or not (docs/spec/containment-hook.md, "Unlock deadline": the
    /// deadline caps how long holders can be stuck when the home market stops working).
    #[kani::proof]
    fn every_bound_token_is_unlockable_by_the_longest_deadline() {
        let now: i64 = kani::any();
        let goal: u64 = kani::any();
        let deadline: i64 = kani::any();
        let wait: i64 = kani::any();
        let tax: Option<u128> = kani::any();
        kani::assume(check_terms(now, goal, deadline).is_ok());
        kani::assume(wait >= 0);
        let Some(later) = now
            .checked_add(MAX_UNLOCK_DEADLINE_SECS)
            .and_then(|at| at.checked_add(wait))
        else {
            return;
        };
        assert!(unlock_due(tax, goal, later, deadline).is_some());
        // And never before the binding's own second: accepted terms are not due at once by
        // the deadline.
        assert!(unlock_due(Some(0), goal, now, deadline).is_none());
    }
}
