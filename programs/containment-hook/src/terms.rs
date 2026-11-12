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

/// The deadline rule as plain arithmetic in a wider type, which cannot overflow: what
/// [`check_deadline`] must agree with for every input.
#[cfg(any(test, kani))]
fn deadline_allowed(now: i64, deadline: i64) -> bool {
    let delay = deadline as i128 - now as i128;
    delay > 0 && delay <= MAX_UNLOCK_DEADLINE_SECS as i128
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
}
