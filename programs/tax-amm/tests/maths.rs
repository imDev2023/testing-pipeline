//! Property tests of the pure pricing and split functions (docs/spec/README.md, "Test
//! layers" 2), 10,000 cases a property, over the whole range of reserves, virtual
//! reserves, amounts, rates up to `MAX_TAX_BPS` and valid splits. Kani and Z3 proofs of the
//! same maths follow in
//! [Tax AMM: proofs of the pricing, tax and split maths](https://github.com/imDev2023/testing-pipeline/issues/64).

use proptest::prelude::*;
use tax_amm::config::{MAX_TAX_BPS, SUITE_SHARE_BPS};
use tax_amm::pricing::{exact_in, Fill, Sides, Tax};
use tax_amm::split::split_tax;

const CASES: u32 = 10_000;
const BPS: u128 = 10_000;

/// `a × b` exactly, as eight 32-bit digits, most significant first, so products of
/// effective reserves, which can pass 2^128, compare exactly. Schoolbook multiplication on
/// small digits: deliberately not the program's own 256-bit product, so a mistake there
/// can't hide behind the same mistake here.
fn wide_mul(a: u128, b: u128) -> [u64; 8] {
    let digits = |x: u128| -> [u64; 4] { std::array::from_fn(|i| ((x >> (32 * i)) as u32) as u64) };
    let (a, b) = (digits(a), digits(b));
    let mut product = [0u64; 8];
    for i in 0..4 {
        let mut carry = 0u64;
        for j in 0..4 {
            let column = product[i + j] + a[i] * b[j] + carry;
            product[i + j] = column & 0xffff_ffff;
            carry = column >> 32;
        }
        product[i + 4] += carry;
    }
    product.reverse();
    product
}

#[test]
fn the_reference_product_is_exact() {
    // (2^128 - 1)^2 = 2^256 - 2^129 + 1.
    let max = 0xffff_ffff;
    assert_eq!(
        wide_mul(u128::MAX, u128::MAX),
        [max, max, max, max - 1, 0, 0, 0, 1]
    );
    assert_eq!(wide_mul(1 << 64, 1 << 64), [0, 0, 0, 1, 0, 0, 0, 0]);
    // Where the product fits in a u128, it is the u128 product.
    let (a, b) = (123_456_789_012_345_u128, 987_654_321_098_765_u128);
    let low: u128 = wide_mul(a, b)[4..]
        .iter()
        .fold(0, |total, &digit| (total << 32) | digit as u128);
    assert_eq!(wide_mul(a, b)[..4], [0, 0, 0, 0]);
    assert_eq!(low, a * b);
}

/// Any reserves and virtual reserves a market can hold: the virtual reserve on at most one
/// side, often none, and amounts spread over every magnitude.
fn sides() -> impl Strategy<Value = Sides> {
    let amount = prop_oneof![0u64..1_000, 0u64..1_000_000_000, any::<u64>(),];
    let virtual_reserve = prop_oneof![Just(0u64), any::<u64>(), 0u64..1_000_000_000];
    (amount.clone(), amount, virtual_reserve, any::<bool>()).prop_map(
        |(reserve_in, reserve_out, virtual_reserve, virtual_on_input)| Sides {
            reserve_in,
            reserve_out,
            virtual_in: if virtual_on_input { virtual_reserve } else { 0 },
            virtual_out: if virtual_on_input { 0 } else { virtual_reserve },
        },
    )
}

fn tax() -> impl Strategy<Value = Tax> {
    let rate = prop_oneof![Just(0u16), Just(MAX_TAX_BPS), 0..=MAX_TAX_BPS];
    (rate, any::<bool>()).prop_map(|(bps, buy)| if buy { Tax::Buy(bps) } else { Tax::Sell(bps) })
}

fn amount() -> impl Strategy<Value = u64> {
    prop_oneof![0u64..1_000, 0u64..1_000_000_000_000, any::<u64>()]
}

/// The shares of a valid market: one to four tax recipients, each above 0, and a burn
/// share, summing to 10,000.
fn shares() -> impl Strategy<Value = ([u16; 4], u16)> {
    (1usize..=4, prop_oneof![Just(0u16), 0u16..=9_996]).prop_flat_map(|(recipients, burn)| {
        let rest = 10_000 - burn;
        let cuts = proptest::sample::subsequence((1..rest).collect::<Vec<u16>>(), recipients - 1);
        cuts.prop_map(move |cuts| {
            let mut shares = [0u16; 4];
            let mut last = 0;
            for (i, &cut) in cuts.iter().enumerate() {
                shares[i] = cut - last;
                last = cut;
            }
            shares[recipients - 1] = rest - last;
            (shares, burn)
        })
    })
}

/// The effective reserves before and after a fill.
fn effective(sides: &Sides, fill: &Fill) -> ((u128, u128), (u128, u128)) {
    (
        (
            sides.reserve_in as u128 + sides.virtual_in as u128,
            sides.reserve_out as u128 + sides.virtual_out as u128,
        ),
        (
            fill.reserve_in as u128 + sides.virtual_in as u128,
            fill.reserve_out as u128 + sides.virtual_out as u128,
        ),
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    #[test]
    fn a_swap_never_lowers_the_product_of_the_effective_reserves(
        sides in sides(), tax in tax(), amount in amount(),
    ) {
        if let Ok(fill) = exact_in(sides, tax, amount) {
            let ((in_before, out_before), (in_after, out_after)) = effective(&sides, &fill);
            prop_assert!(wide_mul(in_after, out_after) >= wide_mul(in_before, out_before));
        }
    }

    #[test]
    fn the_tax_is_never_below_the_exact_rate_and_at_most_one_unit_above_it(
        sides in sides(), tax in tax(), amount in amount(),
    ) {
        if let Ok(fill) = exact_in(sides, tax, amount) {
            // The amount the tax is a rate of: the input for a buy tax, the curve's output
            // (what the trader gets plus the tax) for a sell tax.
            let (base, bps) = match tax {
                Tax::Buy(bps) => (fill.amount_in as u128, bps as u128),
                Tax::Sell(bps) => (fill.amount_out as u128 + fill.tax as u128, bps as u128),
            };
            let scaled = fill.tax as u128 * BPS;
            prop_assert!(scaled >= base * bps, "below the exact rate");
            prop_assert!(scaled < base * bps + BPS, "a unit or more above it");
        }
    }

    #[test]
    fn the_output_never_exceeds_the_real_reserve(
        sides in sides(), tax in tax(), amount in amount(),
    ) {
        match exact_in(sides, tax, amount) {
            Ok(fill) => {
                prop_assert!(fill.amount_out > 0);
                prop_assert!(fill.amount_out <= sides.reserve_out);
                // What left the output side's real reserve is what the trader got, plus a
                // sell tax, which stays in the vault; a buy tax never enters the curve.
                let paid = (sides.reserve_out - fill.reserve_out) as u128;
                let (tax_kept_out, tax_kept_in) = match tax {
                    Tax::Buy(_) => (0, fill.tax as u128),
                    Tax::Sell(_) => (fill.tax as u128, 0),
                };
                prop_assert_eq!(paid, fill.amount_out as u128 + tax_kept_out);
                prop_assert_eq!(
                    fill.reserve_in as u128,
                    sides.reserve_in as u128 + fill.amount_in as u128 - tax_kept_in
                );
            }
            // A refusal is only ever for an output of 0 or beyond the real reserve, or for an
            // input reserve no vault could hold, past a u64.
            Err(tax_amm::StrategyError::Overflow) => {
                prop_assert!(sides.reserve_in as u128 + amount as u128 > u64::MAX as u128)
            }
            Err(error) => prop_assert!(
                matches!(
                    error,
                    tax_amm::StrategyError::ZeroOutput
                        | tax_amm::StrategyError::InsufficientLiquidity
                ),
                "{error:?}"
            ),
        }
    }

    #[test]
    fn the_split_always_sums_to_the_tax(tax in amount(), (shares, burn) in shares()) {
        let slots = split_tax(tax, &shares, burn).unwrap();
        prop_assert_eq!(slots.iter().map(|&s| s as u128).sum::<u128>(), tax as u128);
        // The suite share first, then each part rounded down, the remainder (under one unit
        // a part) to the first recipient.
        let suite = tax as u128 * SUITE_SHARE_BPS as u128 / BPS;
        prop_assert_eq!(slots[5] as u128, suite);
        let rest = tax as u128 - suite;
        let floors: Vec<u128> = shares
            .iter()
            .chain(std::iter::once(&burn))
            .map(|&share| rest * share as u128 / BPS)
            .collect();
        for (part, floor) in slots[1..5].iter().zip(&floors[1..]) {
            prop_assert_eq!(*part as u128, *floor);
        }
        let remainder = slots[0] as u128 - floors[0];
        prop_assert!(remainder < 5);
    }
}
