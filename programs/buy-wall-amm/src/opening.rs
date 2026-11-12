//! The seed's maths, in pure functions that take no accounts (docs/spec/pool4-for-solana.md,
//! "The seed"), so the proofs and the worked example run against them directly.
//!
//! A seed of `x` token units and `y` lamports opens the market at
//! `sqrt_price = floor(sqrt(y × 2^128 / x))` with
//! `liquidity = min(floor(x × sqrt_price / 2^64), floor(y × 2^64 / sqrt_price))`.
//! `y × 2^128` needs 192 bits, so the maths runs on the program's checked 256-bit type
//! (`math.rs`): an overflow returns `None` (which the program turns into an error), never a
//! panic or a wrapped value.

use crate::config::{
    MAX_OPENING_SQRT_PRICE, MIN_LIQUIDITY, MIN_OPENING_SQRT_PRICE, MIN_SEED_LAMPORTS,
};
use crate::errors::StrategyError;
use crate::math::U256;
use crate::params::BPS;

#[cfg(test)]
use crate::config::{MAX_CAP_DECAY_BPS, MIN_CAP_FLOOR_BPS};

/// `floor(y × 2^128 / x)`, by long division in 64-bit digits; `None` when `x` is 0.
pub fn ratio_q128(y: u64, x: u64) -> Option<U256> {
    if x == 0 {
        return None;
    }
    let (y, x) = (y as u128, x as u128);
    let q2 = y.checked_div(x)?;
    let r2 = y.checked_rem(x)?;
    // Each remainder is below x < 2^64, so shifting it up 64 bits stays below 2^128.
    let t1 = r2 << 64;
    let q1 = t1.checked_div(x)?;
    let t0 = t1.checked_rem(x)? << 64;
    let q0 = t0.checked_div(x)?;
    Some(U256 {
        hi: q2,
        lo: (q1 << 64) | q0,
    })
}

/// `floor(sqrt(n))`, digit by digit in base 4, with only shifts, additions, subtractions
/// and comparisons.
pub fn isqrt(n: U256) -> Option<u128> {
    let mut rem = n;
    let mut root = U256::ZERO;
    let mut bit = n.highest_power_of_four()?;
    while !bit.is_zero() {
        let trial = root.checked_add(bit)?;
        if rem >= trial {
            rem = rem.checked_sub(trial)?;
            root = root.checked_shr(1)?.checked_add(bit)?;
        } else {
            root = root.checked_shr(1)?;
        }
        bit = bit.checked_shr(2)?;
    }
    if root.hi != 0 {
        return None;
    }
    Some(root.lo)
}

/// The opening square-root price, `floor(sqrt(y × 2^128 / x))`, Q64.64.
pub fn opening_sqrt_price(x: u64, y: u64) -> Option<u128> {
    isqrt(ratio_q128(y, x)?)
}

/// The opening liquidity at square-root price `s`:
/// `min(floor(x × s / 2^64), floor(y × 2^64 / s))`, the most both amounts back at `s`.
pub fn opening_liquidity(x: u64, y: u64, s: u128) -> Option<u128> {
    let token_side = U256::mul(x as u128, s)?.checked_shr64()?;
    let sol_side = ((y as u128) << 64).checked_div(s)?;
    Some(token_side.min(sol_side))
}

/// The curve's liquidity when it holds `tokens` at square-root price `s`:
/// `floor(tokens × s / 2^64)`.
pub fn liquidity_at(tokens: u64, s: u128) -> Option<u128> {
    U256::mul(tokens as u128, s)?.checked_shr64()
}

/// `floor(amount × bps / 10,000)`, or `None` if it does not fit in 64 bits (never, for bps
/// up to 10,000).
fn share(amount: u64, bps: u16) -> Option<u64> {
    let scaled = (amount as u128)
        .checked_mul(bps as u128)?
        .checked_div(BPS as u128)?;
    u64::try_from(scaled).ok()
}

/// The cap floor: `max(1, floor(x × cap_floor_bps / 10,000))`.
pub fn cap_floor(x: u64, cap_floor_bps: u16) -> Option<u64> {
    Some(share(x, cap_floor_bps)?.max(1))
}

/// The cap decay a day: `floor(x × cap_decay_bps / 10,000)`.
pub fn cap_decay_per_day(x: u64, cap_decay_bps: u16) -> Option<u64> {
    share(x, cap_decay_bps)
}

/// Whether a market may open at square-root price `s`.
pub fn opening_price_in_bounds(s: u128) -> bool {
    (MIN_OPENING_SQRT_PRICE..=MAX_OPENING_SQRT_PRICE).contains(&s)
}

/// What a seed opens a market with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Opened {
    pub sqrt_price: u128,
    pub liquidity: u128,
    /// The inventory cap, which starts at the tokens seeded.
    pub cap: u64,
    pub cap_floor: u64,
    pub cap_decay_per_day: u64,
}

/// Why a seed is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    EmptySeed,
    SeedTooSmall,
    OpeningPriceOutOfBounds,
    CapFloorTooThin,
    Overflow,
}

impl From<Refusal> for StrategyError {
    fn from(refusal: Refusal) -> Self {
        match refusal {
            Refusal::EmptySeed => StrategyError::EmptySeed,
            Refusal::SeedTooSmall => StrategyError::SeedTooSmall,
            Refusal::OpeningPriceOutOfBounds => StrategyError::OpeningPriceOutOfBounds,
            Refusal::CapFloorTooThin => StrategyError::CapFloorTooThin,
            Refusal::Overflow => StrategyError::Overflow,
        }
    }
}

/// Opens a market seeded with `x` token units and `y` lamports (what arrived), or says why
/// the seed is refused: no tokens, less than `MIN_SEED_LAMPORTS`, an opening price outside
/// the bounds, or a curve that would hold less than `MIN_LIQUIDITY` with its cap at the
/// floor.
pub fn open(x: u64, y: u64, cap_floor_bps: u16, cap_decay_bps: u16) -> Result<Opened, Refusal> {
    if x == 0 {
        return Err(Refusal::EmptySeed);
    }
    if y < MIN_SEED_LAMPORTS {
        return Err(Refusal::SeedTooSmall);
    }
    let sqrt_price = opening_sqrt_price(x, y).ok_or(Refusal::Overflow)?;
    if !opening_price_in_bounds(sqrt_price) {
        return Err(Refusal::OpeningPriceOutOfBounds);
    }
    let cap_floor = cap_floor(x, cap_floor_bps).ok_or(Refusal::Overflow)?;
    if liquidity_at(cap_floor, sqrt_price).ok_or(Refusal::Overflow)? < MIN_LIQUIDITY {
        return Err(Refusal::CapFloorTooThin);
    }
    let liquidity = opening_liquidity(x, y, sqrt_price).ok_or(Refusal::Overflow)?;
    Ok(Opened {
        sqrt_price,
        liquidity,
        cap: x,
        cap_floor,
        cap_decay_per_day: cap_decay_per_day(x, cap_decay_bps).ok_or(Refusal::Overflow)?,
    })
}

// Kani proofs of the seed's maths (`cargo kani`, docs/toolchain.md), in the tiers Pipeline
// uses. CBMC turns a division into a fresh quotient tied to its operands by a multiplier,
// and SAT solvers find relating that quotient back to its inputs very hard, so:
// - default, full domain: properties that need no such relation, such as the maths never
//   panicking for any input;
// - default, bounded: properties about quotients and roots, on small inputs;
// - `RUSTFLAGS="--cfg kani_full"`: the same properties for every input, which may not
//   finish. Z3 proves the division properties for every input instead
//   (`proofs/opening_z3.py`, docs/spec/README.md, "Test layers" 2).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// Bound of the bounded tier.
    const SMALL: u64 = 1 << 6;

    /// `ratio_q128` never panics, and is `None` exactly when `x` is 0.
    #[kani::proof]
    fn ratio_never_panics() {
        let (x, y): (u64, u64) = (kani::any(), kani::any());
        assert_eq!(ratio_q128(y, x).is_none(), x == 0);
    }

    /// `ratio_q128(y, x)` is exactly `floor(y × 2^128 / x)`: `q × x <= y × 2^128 < (q + 1) × x`.
    #[kani::proof]
    fn ratio_is_the_exact_floor_bounded() {
        let (x, y): (u64, u64) = (kani::any(), kani::any());
        kani::assume(x > 0 && x < SMALL && y < SMALL);
        let q = ratio_q128(y, x).unwrap();
        let qx = q.mul_u64(x).unwrap();
        let target = U256 {
            hi: y as u128,
            lo: 0,
        };
        assert!(qx <= target);
        assert!(qx.checked_add(U256::from(x as u128)).unwrap() > target);
    }

    /// `isqrt(n)` is the floor square root, for small `n`. Below 2^12 the loop runs at most
    /// 6 times; Kani checks the unwinding bound, so a bound too low fails the proof.
    #[kani::proof]
    #[kani::unwind(8)]
    fn isqrt_is_the_floor_square_root_bounded() {
        let n: u128 = kani::any();
        kani::assume(n < 1 << 12);
        let s = isqrt(U256::from(n)).unwrap();
        assert!(U256::square(s) <= U256::from(n));
        assert!(U256::square(s + 1) > U256::from(n));
    }

    /// `isqrt(n)` is the floor square root for every `n` below 2^192 (every
    /// `floor(y × 2^128 / x)`).
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(130)]
    fn isqrt_is_the_floor_square_root() {
        let n = U256 {
            hi: kani::any::<u64>() as u128,
            lo: kani::any(),
        };
        let s = isqrt(n).unwrap();
        assert!(U256::square(s) <= n);
        assert!(U256::square(s + 1) > n);
    }

    /// The opening liquidity never exceeds what both amounts back at the rounded price
    /// (`L × 2^64 <= x × s` and `L × s <= y × 2^64`), for small amounts and any price in
    /// the opening bounds.
    #[kani::proof]
    fn the_opening_liquidity_is_backed_bounded() {
        let (x, y): (u64, u64) = (kani::any(), kani::any());
        kani::assume(x < SMALL && y < SMALL);
        let s: u128 = kani::any();
        kani::assume(opening_price_in_bounds(s));
        let l = opening_liquidity(x, y, s).unwrap();
        assert!(U256::mul(l, 1 << 64).unwrap() <= U256::mul(x as u128, s).unwrap());
        assert!(U256::mul(l, s).unwrap() <= U256::mul(y as u128, 1 << 64).unwrap());
    }

    /// The same for every amount and every price in the opening bounds.
    #[cfg(kani_full)]
    #[kani::proof]
    fn the_opening_liquidity_is_backed() {
        let (x, y): (u64, u64) = (kani::any(), kani::any());
        let s: u128 = kani::any();
        kani::assume(opening_price_in_bounds(s));
        let l = opening_liquidity(x, y, s).unwrap();
        assert!(U256::mul(l, 1 << 64).unwrap() <= U256::mul(x as u128, s).unwrap());
        assert!(U256::mul(l, s).unwrap() <= U256::mul(y as u128, 1 << 64).unwrap());
    }

    /// The opening price never exceeds the seeded price (`s² × x <= y × 2^128`), for small
    /// amounts. Any seed's ratio has over 120 bits, so the square root's loop runs some 64
    /// times whatever the bound, which takes CBMC many minutes: this composition is proved
    /// for every input by Z3 (`proofs/opening_z3.py`) from the two halves Kani proves above,
    /// and runs here only in the full tier.
    #[cfg(kani_full)]
    #[kani::proof]
    #[kani::unwind(130)]
    fn the_opening_price_never_exceeds_the_seeded_price_for_small_amounts() {
        let (x, y): (u64, u64) = (kani::any(), kani::any());
        kani::assume(x > 0 && x < 1 << 3 && y < 1 << 3);
        let s = opening_sqrt_price(x, y).unwrap();
        assert!(
            U256::square(s).mul_u64(x).unwrap()
                <= U256 {
                    hi: y as u128,
                    lo: 0
                }
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const Q: u128 = 1 << 64;

    #[test]
    fn the_worked_example_opens_at_the_spec_numbers() {
        // 1,000,000 tokens of 6 decimals against 10 SOL, cap floor 20%, cap decay 20% a day
        // (docs/spec/pool4-for-solana.md, "Worked example", the seed row).
        let opened = open(1_000_000_000_000, 10_000_000_000, 2_000, 2_000).unwrap();
        assert_eq!(opened.sqrt_price, 1_844_674_407_370_955_161);
        assert_eq!(opened.liquidity, 99_999_999_999);
        assert_eq!(opened.cap, 1_000_000_000_000);
        assert_eq!(opened.cap_floor, 200_000_000_000);
        assert_eq!(opened.cap_decay_per_day, 200_000_000_000);
    }

    #[test]
    fn isqrt_is_the_floor_square_root_at_the_edges() {
        let max = U256 {
            hi: u64::MAX as u128,
            lo: u128::MAX,
        }; // 2^192 - 1
        for (n, root) in [
            (U256::from(0u128), 0u128),
            (U256::from(1u128), 1),
            (U256::from(3u128), 1),
            (U256::from(4u128), 2),
            (U256::from(u128::MAX), u64::MAX as u128),
            (U256 { hi: 1, lo: 0 }, 1 << 64),
            (max, (1u128 << 96) - 1),
        ] {
            assert_eq!(isqrt(n), Some(root), "isqrt({n:?})");
        }
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(10_000))]

        /// `ratio_q128(y, x)` is exactly `floor(y × 2^128 / x)`.
        #[test]
        fn ratio_is_the_exact_floor(x in 1u64.., y in any::<u64>()) {
            let q = ratio_q128(y, x).unwrap();
            // q × x <= y × 2^128 < (q + 1) × x, in 256-bit maths.
            let qx = q.mul_u64(x).unwrap();
            let y_shifted = U256 { hi: y as u128, lo: 0 };
            prop_assert!(qx <= y_shifted);
            let next = qx.checked_add(U256::from(x as u128)).unwrap();
            prop_assert!(next > y_shifted);
        }

        /// `isqrt(n)` is the largest `s` with `s² <= n`.
        #[test]
        fn isqrt_is_the_floor_square_root(hi in 0u128..(1 << 64), lo in any::<u128>()) {
            let n = U256 { hi, lo };
            let s = isqrt(n).unwrap();
            prop_assert!(U256::square(s) <= n);
            prop_assert!(U256::square(s + 1) > n);
        }

        /// The opening price never exceeds the price the two amounts set: s² × x <= y × 2^128.
        #[test]
        fn the_opening_price_never_exceeds_the_seeded_price(x in 1u64.., y in any::<u64>()) {
            let s = opening_sqrt_price(x, y).unwrap();
            let lhs = U256::square(s).mul_u64(x);
            let rhs = U256 { hi: y as u128, lo: 0 };
            // `None` would mean s² × x overflows 256 bits, which is far above y × 2^128.
            prop_assert!(lhs.is_some_and(|lhs| lhs <= rhs));
        }

        /// The opening liquidity never exceeds what the two amounts back at the rounded price:
        /// the curve's token holdings L × Q / s are at most x and its SOL L × s / Q at most y.
        #[test]
        fn the_opening_liquidity_is_backed_by_both_amounts(x in 1u64.., y in any::<u64>()) {
            let s = opening_sqrt_price(x, y).unwrap();
            prop_assume!(s > 0);
            let l = opening_liquidity(x, y, s).unwrap();
            // L × Q <= x × s and L × s <= y × Q, in 256-bit maths.
            prop_assert!(U256::mul(l, Q).unwrap() <= U256::mul(x as u128, s).unwrap());
            prop_assert!(U256::mul(l, s).unwrap() <= U256::mul(y as u128, Q).unwrap());
            // And it is the token side that binds, because the price rounds down.
            let token_side = U256::mul(x as u128, s).unwrap().checked_shr64().unwrap();
            prop_assert_eq!(l, token_side);
        }

        /// Every accepted seed opens inside the bounds with at least `MIN_LIQUIDITY`, and its
        /// cap starts at what arrived, never below the floor.
        #[test]
        fn an_accepted_seed_is_usable(
            x in 1u64..,
            y in any::<u64>(),
            floor_bps in MIN_CAP_FLOOR_BPS..=10_000u16,
            decay_bps in 0..=MAX_CAP_DECAY_BPS,
        ) {
            if let Ok(opened) = open(x, y, floor_bps, decay_bps) {
                prop_assert!(y >= MIN_SEED_LAMPORTS);
                prop_assert!((MIN_OPENING_SQRT_PRICE..=MAX_OPENING_SQRT_PRICE).contains(&opened.sqrt_price));
                prop_assert!(opened.liquidity >= MIN_LIQUIDITY);
                prop_assert_eq!(opened.cap, x);
                prop_assert!(opened.cap_floor >= 1 && opened.cap_floor <= x);
                prop_assert!(opened.cap_decay_per_day <= x);
                prop_assert!(liquidity_at(opened.cap_floor, opened.sqrt_price).unwrap() >= MIN_LIQUIDITY);
            }
        }
    }

    #[test]
    fn each_refusal_is_on_the_right_side_of_its_bound() {
        // Below MIN_SEED_LAMPORTS, and exactly at it.
        let x = 1_000_000_000_000;
        assert_eq!(
            open(x, MIN_SEED_LAMPORTS - 1, 2_000, 0),
            Err(Refusal::SeedTooSmall)
        );
        assert!(open(x, MIN_SEED_LAMPORTS, 2_000, 0).is_ok());
        assert_eq!(
            open(0, 10 * MIN_SEED_LAMPORTS, 2_000, 0),
            Err(Refusal::EmptySeed)
        );
        // The opening price bounds, one unit inside and outside each.
        assert!(!opening_price_in_bounds(MIN_OPENING_SQRT_PRICE - 1));
        assert!(opening_price_in_bounds(MIN_OPENING_SQRT_PRICE));
        assert!(opening_price_in_bounds(MAX_OPENING_SQRT_PRICE));
        assert!(!opening_price_in_bounds(MAX_OPENING_SQRT_PRICE + 1));
        // y / x = 2^48 gives s = 2^88 exactly: y = 2^48 × x.
        let x = 1 << 10;
        let highest_y = x << 48;
        assert_eq!(
            opening_sqrt_price(x, highest_y),
            Some(MAX_OPENING_SQRT_PRICE)
        );
        assert!(open(x, highest_y, 10_000, 0).is_ok());
        // One lamport more already lifts s above 2^88, by about 2^29.
        assert!(opening_sqrt_price(x, highest_y + 1).unwrap() > MAX_OPENING_SQRT_PRICE);
        assert_eq!(
            open(x, highest_y + 1, 10_000, 0),
            Err(Refusal::OpeningPriceOutOfBounds)
        );
    }

    #[test]
    fn no_seed_can_open_below_the_lowest_opening_price() {
        // With at least MIN_SEED_LAMPORTS and at most u64::MAX tokens, the lowest opening
        // price is floor(sqrt(10^8 × 2^128 / (2^64 - 1))), about 2^45.3, above 2^40: the
        // lower bound never binds a seed (reported on the ticket; it stays as a guard).
        let lowest = opening_sqrt_price(u64::MAX, MIN_SEED_LAMPORTS).unwrap();
        assert!(lowest > MIN_OPENING_SQRT_PRICE);
        assert!(lowest > 1 << 45 && lowest < 1 << 46);
        assert!(open(u64::MAX, MIN_SEED_LAMPORTS, 10_000, 0).is_ok());
    }

    #[test]
    fn a_curve_too_thin_at_the_cap_floor_is_refused_at_the_boundary() {
        // At s = 2^64 (a price of 1 lamport per unit), the liquidity at the cap floor is the
        // cap floor itself; with the floor at 100%, x = MIN_LIQUIDITY just passes.
        let x = MIN_LIQUIDITY as u64;
        let y = x; // s = 2^64 exactly
        assert_eq!(opening_sqrt_price(x, y), Some(Q));
        // But y must be at least MIN_SEED_LAMPORTS: scale both by the same factor k so the
        // price stays 1 and the cap floor share sets the floor's liquidity.
        let k = MIN_SEED_LAMPORTS / x + 1; // 101
        let (x, y) = (x * k, y * k);
        // floor = x × bps / 10,000 must reach 1,000,000: bps = ceil(10^10 / x).
        let bps = (10_000 * MIN_LIQUIDITY as u64).div_ceil(x) as u16;
        assert!(liquidity_at(cap_floor(x, bps).unwrap(), Q).unwrap() >= MIN_LIQUIDITY);
        assert!(open(x, y, bps, 0).is_ok());
        assert!(liquidity_at(cap_floor(x, bps - 1).unwrap(), Q).unwrap() < MIN_LIQUIDITY);
        assert_eq!(open(x, y, bps - 1, 0), Err(Refusal::CapFloorTooThin));
    }
}
