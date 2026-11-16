//! The buy wall's guard, in pure functions that take no accounts (docs/spec/pool4-for-solana.md,
//! "After pricing" steps 1, 3 and 4), so the proofs run against them directly.
//!
//! The wall can never be placed above its floor (`wall.rs`), so pumping the price and placing
//! the wall high earns nothing. The floor drops at once to any price the market trades at and
//! rises at most `FLOOR_CRAWL_BPS` a day toward a reference; the reference follows the price
//! by at most `REF_STEP_BPS` per `REF_STEP_WINDOW`, toward the price the previous slot's
//! trading ended at, so no trade can move it in its own slot.
//!
//! Rates are on the price, and these values are square-root prices, so each step is halved:
//! a price rising by `x` basis points is a square root rising by about `x / 2`. Every time
//! difference saturates at 0. These run after pricing, so they never change a trade or its
//! quote.

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
    /// Step 1, before the books: if the Clock's `slot` is later than `last_slot`, the
    /// reference moves toward `last_close`, still the price the previous slot's trading ended
    /// at, by at most `reference_step`, and `ref_time` and `last_slot` move to now. In the
    /// slot it was last brought up to date in, nothing changes, so no trade can move the
    /// reference in its own slot. `None` only on an overflow, which a square-root price at
    /// or below `MAX_SQRT_PRICE` never causes.
    pub fn follow(self, slot: u64, now: i64) -> Option<Guard> {
        if slot <= self.last_slot {
            return Some(self);
        }
        let step = reference_step(self.reference, elapsed(self.ref_time, now))?;
        Some(Guard {
            reference: toward(self.reference, self.last_close, step),
            ref_time: now,
            last_slot: slot,
            ..self
        })
    }

    /// Steps 3 and 4, once the swap's price is set: `last_close` becomes `price`; if the
    /// floor is below the reference it crawls up by at most `floor_crawl` of the time since
    /// `floor_time`, never above the reference; then `floor_time` is now, on every swap
    /// (`POOL4-32`), and the floor drops at once to `price` if that is lower, so it is never
    /// above the price. `None` only on an overflow, as for `follow`.
    pub fn close_at(self, price: u128, now: i64) -> Option<Guard> {
        let floor = if self.floor < self.reference {
            let crawl = floor_crawl(self.floor, elapsed(self.floor_time, now))?;
            self.floor.saturating_add(crawl).min(self.reference)
        } else {
            self.floor
        };
        Some(Guard {
            floor: floor.min(price),
            floor_time: now,
            last_close: price,
            ..self
        })
    }
}

// Kani proofs of the guard, in the tiers Pipeline uses (see `opening.rs`). Its steps divide
// a u128 by a constant, which CBMC finishes only for bounded inputs (a full-domain u128
// division by 86,400 ran past 25 minutes on the owner's Mac, `cap.rs`), so the default tier
// bounds the prices below 2^12 and the full tier lifts the bound to `MAX_SQRT_PRICE`;
// Proptest checks the same over every price trading can reach (below).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the default tier, for prices.
    const SMALL: u128 = 1 << 12;

    /// The reference moves only in a later slot, only toward the last close, never past it,
    /// and by at most `REF_STEP_BPS / 2` of itself.
    fn reference_follows_slowly(bound: u128) {
        let guard = Guard {
            reference: kani::any(),
            ref_time: kani::any(),
            floor: kani::any(),
            floor_time: kani::any(),
            last_slot: kani::any(),
            last_close: kani::any(),
        };
        let (slot, now): (u64, i64) = (kani::any(), kani::any());
        kani::assume(guard.reference <= bound && guard.last_close <= bound);
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
            assert!(next.last_slot == slot && next.ref_time == now);
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

    /// After a swap the floor is never above the price, never above the larger of its old
    /// value and the reference, and rises by at most `FLOOR_CRAWL_BPS / 2` of itself.
    fn floor_stays_below_the_price(bound: u128) {
        let guard = Guard {
            reference: kani::any(),
            ref_time: kani::any(),
            floor: kani::any(),
            floor_time: kani::any(),
            last_slot: kani::any(),
            last_close: kani::any(),
        };
        let (price, now): (u128, i64) = (kani::any(), kani::any());
        kani::assume(guard.reference <= bound && guard.floor <= bound);
        let next = guard.close_at(price, now).unwrap();
        assert!(next.floor <= price);
        assert!(next.floor <= guard.floor.max(guard.reference));
        if next.floor > guard.floor {
            assert!(
                (next.floor - guard.floor) * 2 * 10_000 <= guard.floor * FLOOR_CRAWL_BPS as u128
            );
        }
        assert!(next.last_close == price && next.floor_time == now);
    }

    #[kani::proof]
    fn the_floor_stays_below_the_price_bounded() {
        floor_stays_below_the_price(SMALL);
    }

    #[cfg(kani_full)]
    #[kani::proof]
    fn the_floor_stays_below_the_price() {
        floor_stays_below_the_price(crate::config::MAX_SQRT_PRICE);
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
    };
    const BOUGHT_AT: u128 = 2_027_297_173_702_505_949;
    const SOLD_AT: u128 = 1_844_674_407_372_029_099;

    #[test]
    fn the_worked_examples_trades_move_the_guard_as_the_spec_writes() {
        // An hour later, the buy of 1 SOL: the reference follows the last close, the
        // opening price, so it stays; the floor stays below the new, higher price.
        let buy = SEEDED.follow(9_010, 4_600).unwrap();
        assert_eq!(
            (buy.reference, buy.ref_time, buy.last_slot),
            (OPENING, 4_600, 9_010)
        );
        let buy = buy.close_at(BOUGHT_AT, 4_600).unwrap();
        assert_eq!(
            (buy.floor, buy.floor_time, buy.last_close),
            (OPENING, 4_600, BOUGHT_AT)
        );

        // 60 seconds later, the sell back: the reference moves toward the buy's price by its
        // most, ref / 100 for a window of 12 seconds or more; the floor crawls 60 seconds'
        // worth toward it, then drops to the sell's price, which is lower.
        let sell = buy.follow(9_160, 4_660).unwrap();
        assert_eq!(sell.reference, 1_863_121_151_444_664_712);
        let crawled = Guard {
            floor_time: sell.floor_time,
            ..sell
        }
        .close_at(u128::MAX, 4_660)
        .unwrap();
        assert_eq!(crawled.floor, 1_844_700_027_848_835_313);
        let sell = sell.close_at(SOLD_AT, 4_660).unwrap();
        assert_eq!(sell.floor, SOLD_AT);
        assert_eq!(sell.last_close, SOLD_AT);
    }

    #[test]
    fn the_reference_never_moves_in_the_slot_it_was_last_brought_up_to_date_in() {
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
        // A clock that went back moves nothing (the difference saturates at 0).
        assert_eq!(moved.follow(11, 999).unwrap().reference, OPENING);
    }

    #[test]
    fn the_floor_crawls_at_most_a_days_worth_and_drops_at_once() {
        let below = Guard {
            reference: OPENING * 2,
            ..SEEDED
        };
        // A day or more: 400 / 2 basis points of the floor, and no more.
        for later in [86_400, 86_401, 10 * 86_400] {
            let crawled = below.close_at(u128::MAX, 1_000 + later).unwrap();
            assert_eq!(crawled.floor, 1_881_567_895_518_374_264);
        }
        // Never above the reference.
        let near = Guard {
            reference: OPENING + 3,
            ..SEEDED
        };
        assert_eq!(near.close_at(u128::MAX, 90_000).unwrap().floor, OPENING + 3);
        // At or above the reference it stays, but its clock still moves.
        let level = SEEDED.close_at(u128::MAX, 5_000).unwrap();
        assert_eq!((level.floor, level.floor_time), (OPENING, 5_000));
        // Any lower price takes it down at once.
        assert_eq!(
            below.close_at(OPENING / 2, 1_000).unwrap().floor,
            OPENING / 2
        );
    }

    fn price() -> impl Strategy<Value = u128> {
        MIN_SQRT_PRICE..=MAX_SQRT_PRICE
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// The reference moves only in a later slot, toward the last close, never past it,
        /// and by at most `REF_STEP_BPS / 2` of itself.
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
            }
        }

        /// After a swap the floor is never above the price, and never above the larger of
        /// its old value and the reference; it rises by at most `FLOOR_CRAWL_BPS / 2` of
        /// itself.
        #[test]
        fn the_floor_is_never_above_the_price(
            reference in price(), floor in price(), price in price(),
            floor_time in 0i64..1 << 40, dt in -100i64..1_000_000,
        ) {
            let guard = Guard { reference, floor, floor_time, ..SEEDED };
            let next = guard.close_at(price, floor_time + dt).unwrap();
            prop_assert!(next.floor <= price);
            prop_assert!(next.floor <= floor.max(reference));
            if next.floor > floor {
                prop_assert!((next.floor - floor) * 2 * 10_000 <= floor * FLOOR_CRAWL_BPS as u128);
            }
            prop_assert_eq!(next.last_close, price);
        }
    }
}
