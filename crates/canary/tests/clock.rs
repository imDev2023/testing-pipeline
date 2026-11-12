//! Clock positions (`CANARY-08`, `CANARY-09`): waits move slot, epoch and Unix time forward
//! together at the configured rates, and the launch clock sets them back to a moment after
//! the market's creation, only when that moment is already past.

use canary::clock;
use canary::config::{
    Wait, LAUNCH_CLOCK_SECONDS, SLOTS_PER_EPOCH, SLOTS_PER_SECOND_DENOMINATOR,
    SLOTS_PER_SECOND_NUMERATOR, WAITS,
};
use solana_clock::Clock;

fn now() -> Clock {
    Clock {
        slot: 520_000_000,
        epoch_start_timestamp: 1_793_000_000,
        epoch: 1_203,
        leader_schedule_epoch: 1_204,
        unix_timestamp: 1_794_000_000,
    }
}

#[test]
fn every_wait_moves_slot_epoch_and_time_together_at_the_configured_rates() {
    let start = now();
    for (label, wait) in WAITS {
        let after = clock::after(&start, wait);
        let (slots, seconds) = match wait {
            Wait::SameSlot => (0, 0),
            Wait::NextSlot => (1, 0),
            Wait::Seconds(s) => (
                s * SLOTS_PER_SECOND_NUMERATOR / SLOTS_PER_SECOND_DENOMINATOR,
                s,
            ),
        };
        assert_eq!(after.slot, start.slot + slots, "{label}");
        assert_eq!(
            after.unix_timestamp,
            start.unix_timestamp + seconds as i64,
            "{label}"
        );
        assert_eq!(
            after.epoch,
            start.epoch + (after.slot / SLOTS_PER_EPOCH - start.slot / SLOTS_PER_EPOCH),
            "{label}"
        );
        assert_eq!(after.leader_schedule_epoch, after.epoch + 1, "{label}");
    }
    // 30 days is 6,480,000 slots, fifteen epochs on.
    let month = clock::after(&start, WAITS[8].1);
    assert_eq!(month.slot - start.slot, 6_480_000);
    assert_eq!(month.epoch - start.epoch, 15);
}

#[test]
fn the_launch_clock_sets_the_clock_back_to_a_past_moment_and_never_forward() {
    let start = now();
    let created_at = start.unix_timestamp - 120;
    let positions: Vec<Option<Clock>> = LAUNCH_CLOCK_SECONDS
        .iter()
        .map(|(_, offset)| clock::at(&start, created_at + *offset as i64))
        .collect();
    // Creation, 10 seconds and 1 minute after it are past; 10 minutes, 1 hour and 1 day are not.
    let past: Vec<bool> = positions.iter().map(Option::is_some).collect();
    assert_eq!(past, [true, true, true, false, false, false]);
    let at_creation = positions[0].clone().unwrap();
    assert_eq!(at_creation.unix_timestamp, created_at);
    assert_eq!(at_creation.slot, start.slot - 120 * 5 / 2);
    assert_eq!(at_creation.epoch, start.epoch);
    // The present itself is not a position in the past.
    assert!(clock::at(&start, start.unix_timestamp).is_none());
}

#[test]
fn setting_the_clock_back_across_epochs_moves_the_epoch_back() {
    let start = now();
    // Two days back is 432,000 slots, one epoch.
    let then = clock::at(&start, start.unix_timestamp - 2 * 86_400).unwrap();
    assert_eq!(start.slot - then.slot, 432_000);
    assert_eq!(then.epoch, start.epoch - 1);
    assert_eq!(then.leader_schedule_epoch, then.epoch + 1);
}

#[test]
fn a_vm_takes_the_position_it_is_given() {
    let mut svm = litesvm::LiteSVM::new();
    svm.warp_to_slot(now().slot);
    svm.set_sysvar(&now());
    let later = clock::after(&now(), Wait::Seconds(3_600));
    clock::set(&mut svm, &later);
    assert_eq!(svm.get_sysvar::<Clock>(), later);
    let earlier = clock::at(&now(), now().unix_timestamp - 600).unwrap();
    clock::set(&mut svm, &earlier);
    assert_eq!(svm.get_sysvar::<Clock>(), earlier);
}
