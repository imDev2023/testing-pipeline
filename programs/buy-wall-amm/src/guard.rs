//! The buy wall's guard, in pure functions that take no accounts (docs/spec/pool4-for-solana.md,
//! "After pricing" steps 1, 3 and 4, and "`place_wall`"), so the proofs run against them
//! directly.
//!
//! The wall can never be placed above its floor nor the lowest close since the last placement
//! (`wall.rs`), so pumping the price and placing the wall high earns nothing. Both the
//! reference and the floor change only at a slot's first update, toward or to the price the
//! previous slot's trading ended at, so no trade can move either in its own slot
//! (`POOL4-50`): the reference follows that price by at most `REF_STEP_BPS` per
//! `REF_STEP_WINDOW`; the floor rises at most `FLOOR_CRAWL_BPS` a day toward the reference,
//! never above it nor that price, and drops to that price if it is lower. A dip bought
//! straight back inside one slot never drags the floor down, and no buy lifts it in its own
//! slot, so a quiet spell's crawl can never be realised above the price a slot opened at.
//! Every swap's close also lowers `low_since_placement`, the lowest close since the last
//! placement, which caps the next placement and which only a placement resets, so a dip
//! bought back, in its own slot or later, and whatever trades after it, cannot have the wall
//! placed above the dip's low with the SOL the dip left idle (the placement cap, `POOL4-50`
//! as amended on 2026-11-19).
//!
//! Rates are on the price, and these values are square-root prices, so each step is halved:
//! a price rising by `x` basis points is a square root rising by about `x / 2`. Every time
//! difference saturates at 0, and each clock only ever moves forward (`max(stored, now)`, SOS
//! finding H009), so no second is counted twice. These run after pricing, so they never change
//! a trade or its quote.

use crate::cap::SECONDS_PER_DAY;
use crate::config::{FLOOR_CRAWL_BPS, REF_STEP_BPS, REF_STEP_WINDOW};
use crate::params::BPS;

/// What the guard reads and writes of a market.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Guard {
    /// The reference, the spec's `ref`, a Q64.64 square-root price.
    pub reference: u128,
    /// The Unix time the reference last moved.
    pub ref_time: i64,
    /// The wall's floor, a Q64.64 square-root price.
    pub floor: u128,
    /// The Unix time the floor was last brought up to date.
    pub floor_time: i64,
    /// The slot the reference was last brought up to date in.
    pub last_slot: u64,
    /// The price the last swap left, Q64.64.
    pub last_close: u128,
    /// The lowest close since the last placement, Q64.64: the seed sets it to the opening
    /// price, every swap lowers it to its close if that is lower, and `place_wall` places no
    /// higher, then resets it to the price at placement. 0, a market written before this
    /// field, caps nothing.
    pub low_since_placement: u128,
}

/// `now - then` in seconds, saturating at 0; `reference_step` and `floor_crawl` cap it.
fn elapsed(then: i64, now: i64) -> u128 {
    u128::try_from(now.saturating_sub(then)).unwrap_or(0)
}

/// `floor(value × bps × dt / (2 × 10,000 × window))`, in 128 bits: square-root prices stay
/// at or below `MAX_SQRT_PRICE` (2^96), so the product stays below 2^122 for every rate and
/// window here; `None` beyond that.
fn halved_rate(value: u128, bps: u64, dt: u128, window: u128) -> Option<u128> {
    let denominator = 2u128.checked_mul(BPS as u128)?.checked_mul(window)?;
    value
        .checked_mul(bps as u128)?
        .checked_mul(dt)?
        .checked_div(denominator)
}

/// `from` moved toward `to` by at most `by`, never past it.
fn toward(from: u128, to: u128, by: u128) -> u128 {
    if to >= from {
        from.saturating_add(by).min(to)
    } else {
        from.saturating_sub(by).max(to)
    }
}

/// The most the reference may move after `dt` seconds (capped at `REF_STEP_WINDOW`):
/// `floor(ref × REF_STEP_BPS × dt / (2 × 10,000 × REF_STEP_WINDOW))`.
pub fn reference_step(reference: u128, dt: u128) -> Option<u128> {
    let window = u128::try_from(REF_STEP_WINDOW).ok()?;
    halved_rate(reference, REF_STEP_BPS, dt.min(window), window)
}

/// How far the floor may crawl after `dt` seconds (capped at a day):
/// `floor(floor × FLOOR_CRAWL_BPS × dt / (2 × 10,000 × 86,400))`.
pub fn floor_crawl(floor: u128, dt: u128) -> Option<u128> {
    halved_rate(
        floor,
        FLOOR_CRAWL_BPS,
        dt.min(SECONDS_PER_DAY),
        SECONDS_PER_DAY,
    )
}

impl Guard {
    /// Steps 1 and 4 at a slot's first update, before the books: if the Clock's `slot` is
    /// later than `last_slot`, the reference moves toward `last_close`, still the price the
    /// previous slot's trading ended at, by at most `reference_step`, `ref_time` moves to
    /// `max(ref_time, now)` and `last_slot` to the slot; then the floor is brought up to date
    /// with that reference and that close (`open_floor`). In the slot it was last brought up
    /// to date in, nothing changes, so no trade can move the reference or the floor in its own
    /// slot. `None` only on an overflow, which square-root prices at or below
    /// `MAX_SQRT_PRICE` never cause.
    pub fn follow(self, slot: u64, now: i64) -> Option<Guard> {
        if slot <= self.last_slot {
            return Some(self);
        }
        let step = reference_step(self.reference, elapsed(self.ref_time, now))?;
        Guard {
            reference: toward(self.reference, self.last_close, step),
            ref_time: self.ref_time.max(now),
            last_slot: slot,
            ..self
        }
        .open_floor(now)
    }

    /// Step 4, the floor's update at a slot's first update (`POOL4-50`), run by `follow` for a
    /// swap and by `place_wall` itself when no swap has run in the slot yet: if the floor is
    /// below the reference it crawls up by at most `floor_crawl` of the time since
    /// `floor_time`, never above the reference; then it drops to `last_close`, the price the
    /// slot opened at, if that is lower, and `floor_time` moves to `max(floor_time, now)`
    /// whether or not the floor crawled (`POOL4-32`). It leaves every other field alone, so
    /// `place_wall` marks no slot, and at one time it is idempotent: a swap's update after
    /// `place_wall`'s in the same slot crawls nothing and finds the floor at or below both
    /// caps. `None` only on an overflow, as for `follow`.
    pub fn open_floor(self, now: i64) -> Option<Guard> {
        let floor = if self.floor < self.reference {
            let crawl = floor_crawl(self.floor, elapsed(self.floor_time, now))?;
            self.floor.saturating_add(crawl).min(self.reference)
        } else {
            self.floor
        };
        Some(Guard {
            floor: floor.min(self.last_close),
            floor_time: self.floor_time.max(now),
            ..self
        })
    }

    /// Step 3, once the swap's price is set: `last_close` becomes `price`, and
    /// `low_since_placement` is lowered to `price` if that is lower (or takes it while it is
    /// 0, a market written before the field); no swap ever raises it, so only a placement
    /// resets it. Nothing else changes, so a swap's own price never moves the floor; the next
    /// slot's first update reads the close, and the next placement the low.
    pub fn close_at(self, price: u128) -> Guard {
        let low_since_placement = if self.low_since_placement == 0 {
            price
        } else {
            self.low_since_placement.min(price)
        };
        Guard {
            last_close: price,
            low_since_placement,
            ..self
        }
    }

    /// Steps 1, 3 and 4 of a swap that leaves the price at `price`, in the Clock's `slot` at
    /// time `now`, as `handle_swap` runs them: `follow`, then `close_at`. `None` only on an
    /// overflow, as for `follow`.
    pub fn swap_at(self, slot: u64, now: i64, price: u128) -> Option<Guard> {
        Some(self.follow(slot, now)?.close_at(price))
    }
}

// Kani proofs of the guard, in the tiers Pipeline uses (see `opening.rs`). Its steps divide
// a u128 by a constant, which CBMC finishes only for bounded inputs (a full-domain u128
// division by 86,400 ran past 25 minutes on the owner's Mac, `cap.rs`), so the default tier
// bounds the prices below 2^12 and the full tier lifts the bound to `MAX_SQRT_PRICE`;
// Proptest checks the same over every price trading can reach, and Z3 for every input
// (`proofs/guard_z3.py`).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the default tier, for prices.
    const SMALL: u128 = 1 << 12;

    fn any_guard() -> Guard {
        Guard {
            reference: kani::any(),
            ref_time: kani::any(),
            floor: kani::any(),
            floor_time: kani::any(),
            last_slot: kani::any(),
            last_close: kani::any(),
            low_since_placement: kani::any(),
        }
    }

    /// The reference moves only in a later slot, only toward the last close, never past it,
    /// and by at most `REF_STEP_BPS / 2` of itself; its clock never moves backwards. In the
    /// slot last brought up to date in nothing changes, the floor included.
    fn reference_follows_slowly(bound: u128) {
        let guard = any_guard();
        let (slot, now): (u64, i64) = (kani::any(), kani::any());
        kani::assume(guard.reference <= bound && guard.last_close <= bound);
        kani::assume(guard.floor <= bound);
        let next = guard.follow(slot, now).unwrap();
        if slot <= guard.last_slot {
            assert!(next == guard);
        } else {
            let (lo, hi) = (
                guard.reference.min(guard.last_close),
                guard.reference.max(guard.last_close),
            );
            assert!(next.reference >= lo && next.reference <= hi);
            let moved = next.reference.abs_diff(guard.reference);
            assert!(moved * 2 * 10_000 <= guard.reference * REF_STEP_BPS as u128);
            assert!(next.last_slot == slot && next.ref_time == guard.ref_time.max(now));
            assert!(next.last_close == guard.last_close);
            assert!(next.low_since_placement == guard.low_since_placement);
        }
    }

    #[kani::proof]
    fn the_reference_follows_slowly_bounded() {
        reference_follows_slowly(SMALL);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    fn the_reference_follows_slowly() {
        reference_follows_slowly(crate::config::MAX_SQRT_PRICE);
    }

    /// A slot's first update of the floor (`open_floor`, a swap's inside `follow` or
    /// `place_wall`'s) leaves it at or below the last close, the price the slot opened at,
    /// and at or below the larger of its old value and the reference, rising by at most
    /// `FLOOR_CRAWL_BPS / 2` of itself; its clock never moves backwards and nothing else
    /// changes. A swap's `close_at` moves only the last close and the low since the last
    /// placement, which it lowers to the price (or sets to it while it is 0) and never raises,
    /// so no trade moves the floor in its own slot and the low is never above the price. (That a second update at the same time changes nothing is left to Proptest and
    /// `proofs/guard_z3.py`: a second division keeps this tier past a minute.)
    fn floor_stays_below_the_slots_opening_price(bound: u128) {
        let guard = any_guard();
        let (price, now): (u128, i64) = (kani::any(), kani::any());
        kani::assume(guard.reference <= bound && guard.floor <= bound);
        let next = guard.open_floor(now).unwrap();
        assert!(next.floor <= guard.last_close);
        assert!(next.floor <= guard.floor.max(guard.reference));
        if next.floor > guard.floor {
            assert!(
                (next.floor - guard.floor) * 2 * 10_000 <= guard.floor * FLOOR_CRAWL_BPS as u128
            );
        }
        assert!(next.floor_time == guard.floor_time.max(now));
        assert!(
            next == Guard {
                floor: next.floor,
                floor_time: next.floor_time,
                ..guard
            }
        );
        let closed = next.close_at(price);
        let low = if next.low_since_placement == 0 {
            price
        } else {
            next.low_since_placement.min(price)
        };
        assert!(closed.low_since_placement <= price);
        assert!(
            next.low_since_placement == 0 || closed.low_since_placement <= next.low_since_placement
        );
        assert!(
            closed
                == Guard {
                    last_close: price,
                    low_since_placement: low,
                    ..next
                }
        );
    }

    #[kani::proof]
    fn the_floor_stays_below_the_slots_opening_price_bounded() {
        floor_stays_below_the_slots_opening_price(SMALL);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    fn the_floor_stays_below_the_slots_opening_price() {
        floor_stays_below_the_slots_opening_price(crate::config::MAX_SQRT_PRICE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{MAX_SQRT_PRICE, MIN_SQRT_PRICE};
    use proptest::prelude::*;

    /// The worked example's seed: every guard price at the opening price, in slot 10 at time
    /// 1,000.
    const OPENING: u128 = 1_844_674_407_370_955_161;
    const SEEDED: Guard = Guard {
        reference: OPENING,
        ref_time: 1_000,
        floor: OPENING,
        floor_time: 1_000,
        last_slot: 10,
        last_close: OPENING,
        low_since_placement: OPENING,
    };
    const BOUGHT_AT: u128 = 2_027_297_173_702_505_949;
    const SOLD_AT: u128 = 1_844_674_407_372_029_099;

    #[test]
    fn the_worked_examples_trades_move_the_guard_as_the_spec_writes() {
        // An hour later, the buy of 1 SOL, the first update of its slot: the reference
        // follows the last close, the opening price, so it stays; the floor, at the
        // reference, stays at the opening price, and only the last close takes the buy's.
        let buy = SEEDED.follow(9_010, 4_600).unwrap();
        assert_eq!(
            (buy.reference, buy.ref_time, buy.last_slot),
            (OPENING, 4_600, 9_010)
        );
        assert_eq!((buy.floor, buy.floor_time), (OPENING, 4_600));
        // The low since the seed, the last placement, stays at the opening price, below the
        // buy's close.
        let buy = buy.close_at(BOUGHT_AT);
        assert_eq!(
            (buy.floor, buy.last_close, buy.low_since_placement),
            (OPENING, BOUGHT_AT, OPENING)
        );
        assert_eq!(SEEDED.swap_at(9_010, 4_600, BOUGHT_AT), Some(buy));

        // 60 seconds later, the sell back, the first update of its slot: the reference moves
        // toward the buy's price by its most, ref / 100 for a window of 12 seconds or more;
        // the floor crawls 60 seconds' worth toward it, below the buy's price, the price the
        // slot opened at. The sell's own lower price leaves it there.
        let sell = buy.follow(9_160, 4_660).unwrap();
        assert_eq!(sell.reference, 1_863_121_151_444_664_712);
        assert_eq!(
            (sell.floor, sell.floor_time),
            (1_844_700_027_848_835_313, 4_660)
        );
        let sell = sell.close_at(SOLD_AT);
        assert_eq!(sell.floor, 1_844_700_027_848_835_313);
        // The sell closes just above the opening price, so the low stays there.
        const { assert!(SOLD_AT > OPENING) };
        assert_eq!(
            (sell.last_close, sell.low_since_placement),
            (SOLD_AT, OPENING)
        );
        assert_eq!(buy.swap_at(9_160, 4_660, SOLD_AT), Some(sell));

        // `place_wall` from a later slot, at the same time: the floor drops to the sell's
        // price, the price that slot opened at; the low since the seed, the opening price just
        // below it, is where the worked example's wall goes (`wall.rs`).
        let placing = sell.open_floor(4_660).unwrap();
        assert_eq!((placing.floor, placing.floor_time), (SOLD_AT, 4_660));
        assert_eq!(
            placing,
            Guard {
                floor: SOLD_AT,
                ..sell
            }
        );
        // A swap later in the same slot then leaves the floor where `place_wall` put it.
        let after = placing.follow(9_161, 4_660).unwrap();
        assert_eq!((after.floor, after.floor_time), (SOLD_AT, 4_660));
    }

    #[test]
    fn the_reference_and_the_floor_never_move_in_the_slot_they_were_last_brought_up_to_date_in() {
        let moved = Guard {
            last_close: OPENING * 2,
            ..SEEDED
        };
        // Same slot, however much later: nothing changes.
        assert_eq!(moved.follow(10, 1_000_000), Some(moved));
        // An earlier slot (never seen, but total): nothing changes.
        assert_eq!(moved.follow(9, 1_000_000), Some(moved));
        // A later slot: it moves, by 5 seconds' worth after 5 seconds.
        let next = moved.follow(11, 1_005).unwrap();
        assert_eq!(next.reference, OPENING + 7_686_143_364_045_646);
        assert_eq!((next.ref_time, next.last_slot), (1_005, 11));
        // And never past the last close, down or up.
        let close = Guard {
            last_close: OPENING - 5,
            ..SEEDED
        };
        assert_eq!(close.follow(11, 2_000).unwrap().reference, OPENING - 5);
        // A clock that went back moves nothing (the difference saturates at 0), and the
        // clocks stay where they were (SOS finding H009).
        let back = moved.follow(11, 999).unwrap();
        assert_eq!(back.reference, OPENING);
        assert_eq!((back.ref_time, back.floor_time), (1_000, 1_000));
        // A dip inside the slot never reaches the floor: two swaps in one slot, the first to
        // half the price, leave the floor where the slot's first update put it.
        let dipped = SEEDED.swap_at(11, 2_000, OPENING / 2).unwrap();
        let bought_back = dipped.swap_at(11, 2_000, OPENING).unwrap();
        assert_eq!((dipped.floor, bought_back.floor), (OPENING, OPENING));
        // The low since the last placement is the dip's, whatever came after it.
        assert_eq!(
            (dipped.low_since_placement, bought_back.low_since_placement),
            (OPENING / 2, OPENING / 2)
        );
        // The next slot's first update reads the last close: bought back, the floor stays;
        // left at the dip, it drops there.
        assert_eq!(bought_back.follow(12, 2_001).unwrap().floor, OPENING);
        assert_eq!(dipped.follow(12, 2_001).unwrap().floor, OPENING / 2);
        // A swap in a later slot does not reset it, however high it closes (code review
        // finding 1): only a placement does.
        let next = bought_back.swap_at(12, 2_001, OPENING).unwrap();
        assert_eq!(next.low_since_placement, OPENING / 2);
        let later = next.swap_at(13, 2_002, OPENING * 2).unwrap();
        assert_eq!(later.low_since_placement, OPENING / 2);
        // A market written before the field (low 0) takes its first swap's close, in any slot.
        let old = Guard {
            low_since_placement: 0,
            ..SEEDED
        };
        assert_eq!(
            old.swap_at(10, 1_000, OPENING / 3)
                .unwrap()
                .low_since_placement,
            OPENING / 3
        );
    }

    #[test]
    fn the_floor_crawls_at_most_a_days_worth_and_never_above_the_slots_opening_price() {
        let below = Guard {
            reference: OPENING * 2,
            last_close: OPENING * 2,
            ..SEEDED
        };
        // A day or more: 400 / 2 basis points of the floor, and no more.
        for later in [86_400, 86_401, 10 * 86_400] {
            let crawled = below.open_floor(1_000 + later).unwrap();
            assert_eq!(crawled.floor, 1_881_567_895_518_374_264);
        }
        // Never above the reference.
        let near = Guard {
            reference: OPENING + 3,
            ..below
        };
        assert_eq!(near.open_floor(90_000).unwrap().floor, OPENING + 3);
        // Never above the price the slot opened at, however long the quiet spell (SOS finding
        // H004): after a fall to the floor, a day's crawl is not realised at once.
        let fallen = Guard {
            last_close: OPENING,
            ..below
        };
        let quiet = fallen.open_floor(1_000 + 86_400).unwrap();
        assert_eq!((quiet.floor, quiet.floor_time), (OPENING, 87_400));
        // At or above the reference it stays, but its clock still moves.
        let level = SEEDED.open_floor(5_000).unwrap();
        assert_eq!((level.floor, level.floor_time), (OPENING, 5_000));
        // A lower opening price takes it down at once.
        let lower = Guard {
            last_close: OPENING / 2,
            ..below
        };
        assert_eq!(lower.open_floor(1_000).unwrap().floor, OPENING / 2);
        // A clock that went back crawls nothing and keeps the floor's clock.
        let back = below.open_floor(999).unwrap();
        assert_eq!((back.floor, back.floor_time), (OPENING, 1_000));
    }

    fn price() -> impl Strategy<Value = u128> {
        MIN_SQRT_PRICE..=MAX_SQRT_PRICE
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// The reference moves only in a later slot, toward the last close, never past it,
        /// and by at most `REF_STEP_BPS / 2` of itself; in the slot last brought up to date
        /// in nothing changes; its clock never moves backwards.
        #[test]
        fn the_reference_follows_slowly(
            reference in price(), last_close in price(), ref_time in 0i64..1 << 40,
            dt in -100i64..100_000, last_slot in 0u64..1 << 40, slots in 0u64..3,
        ) {
            let guard = Guard { reference, last_close, ref_time, last_slot, ..SEEDED };
            let next = guard.follow(last_slot + slots, ref_time + dt).unwrap();
            if slots == 0 {
                prop_assert_eq!(next, guard);
            } else {
                let (lo, hi) = (reference.min(last_close), reference.max(last_close));
                prop_assert!(next.reference >= lo && next.reference <= hi);
                let moved = next.reference.abs_diff(reference);
                prop_assert!(moved * 2 * 10_000 <= reference * REF_STEP_BPS as u128);
                prop_assert_eq!(next.last_slot, last_slot + slots);
                prop_assert_eq!(next.ref_time, ref_time.max(ref_time + dt));
            }
        }

        /// A slot's first update of the floor leaves it at or below the last close and the
        /// larger of its old value and the reference, rising by at most `FLOOR_CRAWL_BPS / 2`
        /// of itself; it changes nothing but the floor and its clock, which never moves
        /// backwards; and at the same time it is idempotent.
        #[test]
        fn the_floor_is_never_above_the_slots_opening_price(
            reference in price(), floor in price(), last_close in price(),
            floor_time in 0i64..1 << 40, dt in -100i64..1_000_000,
        ) {
            let guard = Guard { reference, floor, floor_time, last_close, ..SEEDED };
            let now = floor_time + dt;
            let next = guard.open_floor(now).unwrap();
            prop_assert!(next.floor <= last_close);
            prop_assert!(next.floor <= floor.max(reference));
            if next.floor > floor {
                prop_assert!((next.floor - floor) * 2 * 10_000 <= floor * FLOOR_CRAWL_BPS as u128);
            }
            prop_assert_eq!(next.floor_time, floor_time.max(now));
            prop_assert_eq!(next, Guard { floor: next.floor, floor_time: next.floor_time, ..guard });
            prop_assert_eq!(next.open_floor(now), Some(next));
        }

        /// Over a run of swaps and placements in any slots, at any prices and any clock
        /// steps (backwards included), from the seed: the floor never rises above the
        /// reference (SOS finding H091) and every slot's first update leaves it at or below
        /// the price that slot opened at; a swap in a slot already brought up to date, or its
        /// own price, never moves it; a `place_wall`, run only in a slot no swap has run in,
        /// changes only the floor and its clock, and a swap later in its slot then leaves the
        /// floor where it put it; `low_since_placement` is always the lowest close since the
        /// seed or the last placement (which resets it to the price), kept here
        /// independently; and neither clock ever moves backwards.
        #[test]
        fn the_floor_moves_only_at_a_slots_first_update(
            opening in price(),
            steps in prop::collection::vec((0u64..3, -30i64..100_000, price(), any::<bool>()), 1..40),
        ) {
            let mut guard = Guard {
                reference: opening, floor: opening, last_close: opening, low_since_placement: opening, ..SEEDED
            };
            let mut slot = SEEDED.last_slot;
            let mut now = SEEDED.ref_time;
            // The lowest close since the seed or the last placement.
            let mut low = opening;
            for (slots, seconds, price, place_wall) in steps {
                slot += slots;
                now += seconds;
                let before = guard;
                if place_wall {
                    if slot <= guard.last_slot {
                        continue; // refused: a swap already ran in this slot
                    }
                    // What `place_in_slot` stores (`wall.rs` checks it does): the floor brought
                    // up to date, and the low, which capped the placement, reset to the price.
                    let opened = guard.open_floor(now).unwrap();
                    prop_assert_eq!(opened.low_since_placement, low);
                    guard = Guard { low_since_placement: before.last_close, ..opened };
                    low = before.last_close;
                    prop_assert!(guard.floor <= before.last_close);
                    prop_assert_eq!(
                        guard,
                        Guard { floor: guard.floor, floor_time: guard.floor_time, low_since_placement: low, ..before }
                    );
                    // A swap later in the same slot leaves the floor as it is.
                    let swap = guard.follow(slot, now).unwrap();
                    prop_assert_eq!((swap.floor, swap.floor_time), (guard.floor, guard.floor_time));
                } else {
                    let followed = guard.follow(slot, now).unwrap();
                    guard = followed.close_at(price);
                    prop_assert_eq!(Some(guard), before.swap_at(slot, now, price));
                    if slot <= before.last_slot {
                        prop_assert_eq!(followed, before);
                    } else {
                        prop_assert!(guard.floor <= before.last_close);
                    }
                    prop_assert_eq!(guard.last_close, price);
                    low = low.min(price);
                }
                prop_assert_eq!(guard.low_since_placement, low);
                prop_assert!(guard.floor <= guard.reference);
                prop_assert!(guard.floor >= MIN_SQRT_PRICE);
                prop_assert!(guard.ref_time >= before.ref_time && guard.floor_time >= before.floor_time);
            }
        }
    }
}
