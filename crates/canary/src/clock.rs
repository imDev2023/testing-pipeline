//! Clock positions (`CANARY-08`, `CANARY-09`; `docs/spec/pipescope-canary.md`, "Clock
//! positions"): a wait moves slot, epoch and Unix time forward together at the rates in
//! [`config`](crate::config), and the launch clock sets them back to a moment after the
//! market's creation. Only the clock moves; the state stays as it is.

use litesvm::LiteSVM;
use solana_clock::Clock;
use solana_epoch_schedule::EpochSchedule;

use crate::config::{
    Wait, SLOTS_PER_EPOCH, SLOTS_PER_SECOND_DENOMINATOR, SLOTS_PER_SECOND_NUMERATOR,
};

/// Slots that pass in `seconds`.
fn slots_in(seconds: u64) -> u64 {
    seconds.saturating_mul(SLOTS_PER_SECOND_NUMERATOR) / SLOTS_PER_SECOND_DENOMINATOR
}

/// The cluster's epoch schedule: epochs of `SLOTS_PER_EPOCH` slots after a warmup of shorter
/// ones, as devnet and mainnet were started, so the first full epoch begins at slot 524,256.
fn schedule() -> EpochSchedule {
    EpochSchedule::custom(SLOTS_PER_EPOCH, SLOTS_PER_EPOCH, true)
}

/// `now` moved to `slot`: its epoch moved by the epoch boundaries crossed, and, when the epoch
/// changes, the epoch's start time set to when its first slot was, at the configured rate.
fn at_slot(now: &Clock, slot: u64, unix_timestamp: i64) -> Clock {
    let schedule = schedule();
    let (from, to) = (schedule.get_epoch(now.slot), schedule.get_epoch(slot));
    let epoch = if to >= from {
        now.epoch.saturating_add(to - from)
    } else {
        now.epoch.saturating_sub(from - to)
    };
    let epoch_start_timestamp = if to == from {
        now.epoch_start_timestamp
    } else {
        let into = slot.saturating_sub(schedule.get_first_slot_in_epoch(to));
        let seconds =
            into.saturating_mul(SLOTS_PER_SECOND_DENOMINATOR) / SLOTS_PER_SECOND_NUMERATOR;
        unix_timestamp.saturating_sub_unsigned(seconds)
    };
    Clock {
        slot,
        epoch,
        leader_schedule_epoch: epoch.saturating_add(1),
        unix_timestamp,
        epoch_start_timestamp,
    }
}

/// The clock after `wait` from `now`: "the next slot" is one slot and no seconds.
pub fn after(now: &Clock, wait: Wait) -> Clock {
    let (slots, seconds) = match wait {
        Wait::SameSlot => return now.clone(),
        Wait::NextSlot => (1, 0),
        Wait::Seconds(seconds) => (slots_in(seconds), seconds),
    };
    at_slot(
        now,
        now.slot.saturating_add(slots),
        now.unix_timestamp.saturating_add_unsigned(seconds),
    )
}

/// The clock set back to `unix_timestamp`, or `None` when that moment is not yet past.
pub fn at(now: &Clock, unix_timestamp: i64) -> Option<Clock> {
    let back = u64::try_from(now.unix_timestamp.checked_sub(unix_timestamp)?).ok()?;
    if back == 0 {
        return None;
    }
    Some(at_slot(
        now,
        now.slot.saturating_sub(slots_in(back)),
        unix_timestamp,
    ))
}

/// Puts `svm` at `clock`, moving its slot on first when the clock moves forward.
pub fn set(svm: &mut LiteSVM, clock: &Clock) {
    let current: Clock = svm.get_sysvar();
    if clock.slot > current.slot {
        svm.warp_to_slot(clock.slot);
    }
    svm.set_sysvar(clock);
}
