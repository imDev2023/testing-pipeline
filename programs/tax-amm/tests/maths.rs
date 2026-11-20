//! Property tests of the pure pricing and split functions (docs/spec/README.md, "Test
//! layers" 2), at least 10,000 cases a property, over the whole range of reserves, virtual
//! reserves, amounts, rates up to `MAX_TAX_BPS` and valid splits, and past them where a
//! property is about refusing them. The property list, with the IDs and the Kani and Z3
//! proofs of the same statements, is docs/security/tax-amm/maths-properties.md.

use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use tax_amm::config::{MAX_TAX_BPS, SUITE_SHARE_BPS};
use tax_amm::pricing::{curve_out, exact_in, tax_of, Fill, MarketView, Sides, Tax};
use tax_amm::split::split_tax;
use tax_amm::StrategyError;

#[path = "common/wide.rs"]
mod wide;
use wide::wide_mul;

const CASES: u32 = 10_000;
/// For properties of trades that must succeed for the property to say anything: about a
/// quarter to a half of random cases price every trade they compare, so four times the
/// cases, and `run_paired` fails the test unless at least `CASES` of them did.
const PAIRED_CASES: u32 = 4 * CASES;
const BPS: u128 = 10_000;

/// The one reference product the tests compare reserves with (`common/wide.rs`), which the
/// invariant fuzzer also uses since hardening finding T09 (#67) removed its untested copy.
#[test]
fn sos_t09_the_one_reference_product_is_exact() {
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

/// A rate any market may hold, 0 and the cap included.
fn rate() -> impl Strategy<Value = u16> {
    prop_oneof![Just(0u16), Just(MAX_TAX_BPS), 0..=MAX_TAX_BPS]
}

/// The same tax at another rate.
fn at_rate(tax: Tax, bps: u16) -> Tax {
    match tax {
        Tax::Buy(_) => Tax::Buy(bps),
        Tax::Sell(_) => Tax::Sell(bps),
    }
}

/// The sides a second trade in the same direction meets after `fill`.
fn after(sides: Sides, fill: &Fill) -> Sides {
    Sides {
        reserve_in: fill.reserve_in,
        reserve_out: fill.reserve_out,
        ..sides
    }
}

/// Trades `amount` of side `from` for the other side of `market`, priced through the same
/// `MarketView::terms` as `pricing::fill`, and moves the reserves as a swap does.
fn trade(market: &mut MarketView, from: usize, amount: u64) -> Result<Fill, StrategyError> {
    let (i, o) = (from, 1 - from);
    let (sides, tax) = market.terms(i, o);
    let fill = exact_in(sides, tax, amount)?;
    market.reserves[i] = fill.reserve_in;
    market.reserves[o] = fill.reserve_out;
    Ok(fill)
}

fn market() -> impl Strategy<Value = MarketView> {
    let reserve = prop_oneof![1u64..1_000, 1u64..1_000_000_000, any::<u64>()];
    let virtual_reserve = prop_oneof![Just(0u64), 0u64..1_000_000_000, any::<u64>()];
    (
        reserve.clone(),
        reserve,
        0u8..2,
        virtual_reserve,
        0u8..2,
        rate(),
        rate(),
    )
        .prop_map(
            |(r0, r1, virtual_side, virtual_reserve, tax_side, buy_tax_bps, sell_tax_bps)| {
                MarketView {
                    reserves: [r0, r1],
                    virtual_side,
                    virtual_reserve,
                    tax_side,
                    buy_tax_bps,
                    sell_tax_bps,
                }
            },
        )
}

/// Runs a property of trades that must succeed for it to say anything: `property` returns
/// whether the case exercised it (every trade it compares priced) or fails the test, and
/// the run fails unless at least `CASES` cases exercised it.
fn run_paired<S: Strategy>(strategy: S, property: impl Fn(S::Value) -> Result<bool, TestCaseError>)
where
    S::Value: std::fmt::Debug,
{
    let exercised = std::sync::atomic::AtomicU32::new(0);
    let mut runner = TestRunner::new(Config::with_cases(PAIRED_CASES));
    runner
        .run(&strategy, |value| {
            if property(value)? {
                exercised.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            Ok(())
        })
        .unwrap();
    let exercised = exercised.into_inner();
    assert!(
        exercised >= CASES,
        "only {exercised} of {PAIRED_CASES} cases exercised the property"
    );
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
    fn no_rate_above_the_cap_is_ever_applied(
        sides in sides(),
        bps in prop_oneof![Just(MAX_TAX_BPS + 1), (MAX_TAX_BPS + 1)..=u16::MAX],
        buy in any::<bool>(),
        amount in amount(),
    ) {
        let tax = if buy { Tax::Buy(bps) } else { Tax::Sell(bps) };
        prop_assert!(matches!(
            exact_in(sides, tax, amount),
            Err(tax_amm::StrategyError::TaxAboveCap)
        ));
    }

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
        prop_assert!(slots.iter().all(|&part| part <= tax), "a part above the tax");
    }

    #[test]
    fn the_curve_is_the_exact_floor_of_its_formula(
        effective_in in prop_oneof![0u128..1_000, any::<u64>().prop_map(u128::from), 0u128..=2 * u64::MAX as u128],
        effective_out in prop_oneof![0u128..1_000, any::<u64>().prop_map(u128::from), 0u128..=2 * u64::MAX as u128],
        input in amount(),
    ) {
        // M1 to M4 and C1 on the compiled code: floor(E_o × x / (E_i + x)), checked as
        // q × d <= E_o × x < (q + 1) × d with the independent schoolbook product, over
        // operands whose product passes 2^128, so `mul_div`'s long division runs.
        let out = curve_out(effective_in, effective_out, input);
        let denominator = effective_in + input as u128;
        if input == 0 || denominator == 0 {
            prop_assert_eq!(out, 0);
        } else {
            let product = wide_mul(effective_out, input as u128);
            prop_assert!(wide_mul(out, denominator) <= product);
            prop_assert!(wide_mul(out + 1, denominator) > product);
        }
    }

    #[test]
    fn two_taxes_are_never_less_than_one_on_the_sum(first in amount(), second in amount(), bps in rate()) {
        if let Some(whole) = first.checked_add(second) {
            prop_assert!(tax_of(first, bps).unwrap() + tax_of(second, bps).unwrap() >= tax_of(whole, bps).unwrap());
        }
    }

    #[test]
    fn the_tax_is_exactly_the_rate_rounded_up(amount in amount(), bps in rate()) {
        let tax = tax_of(amount, bps).unwrap() as u128;
        let exact = amount as u128 * bps as u128;
        prop_assert!(tax * BPS >= exact && tax * BPS < exact + BPS, "ceil(amount × rate / 10,000)");
        prop_assert!(tax <= amount as u128);
        prop_assert_eq!(tax == 0, amount == 0 || bps == 0);
    }

    #[test]
    fn the_tax_never_falls_as_the_amount_or_the_rate_rises(
        (low, high) in (amount(), amount()).prop_map(|(a, b)| (a.min(b), a.max(b))),
        (slow, fast) in (rate(), rate()).prop_map(|(a, b)| (a.min(b), a.max(b))),
    ) {
        prop_assert!(tax_of(low, slow).unwrap() <= tax_of(high, slow).unwrap());
        prop_assert!(tax_of(low, slow).unwrap() <= tax_of(low, fast).unwrap());
        // What a buy tax leaves for the curve never falls as the amount rises.
        prop_assert!(low - tax_of(low, slow).unwrap() <= high - tax_of(high, slow).unwrap());
    }

    #[test]
    fn no_input_makes_the_pricing_panic(
        reserves in any::<[u64; 4]>(), bps in any::<u16>(), buy in any::<bool>(), amount in any::<u64>(),
    ) {
        let sides = Sides {
            reserve_in: reserves[0],
            reserve_out: reserves[1],
            virtual_in: reserves[2],
            virtual_out: reserves[3],
        };
        let tax = if buy { Tax::Buy(bps) } else { Tax::Sell(bps) };
        // Any outcome but a panic: a fill, or one of the pricing's refusals.
        let _ = exact_in(sides, tax, amount);
        let _ = tax_of(amount, bps);
    }

    #[test]
    fn no_shares_make_the_split_panic(tax in any::<u64>(), shares in any::<[u16; 4]>(), burn in any::<u16>()) {
        if let Ok(slots) = split_tax(tax, &shares, burn) {
            prop_assert_eq!(slots.iter().map(|&s| s as u128).sum::<u128>(), tax as u128);
            prop_assert!(slots.iter().all(|&part| part <= tax));
        }
    }
}

#[test]
fn the_output_never_rises_when_the_input_falls() {
    run_paired(
        (
            sides(),
            tax(),
            (amount(), amount()).prop_map(|(a, b)| (a.min(b), a.max(b))),
        ),
        |(sides, tax, (low, high))| {
            let (Ok(small), Ok(large)) = (exact_in(sides, tax, low), exact_in(sides, tax, high))
            else {
                return Ok(false);
            };
            prop_assert!(small.amount_out <= large.amount_out, "less input, more out");
            Ok(true)
        },
    );
}

#[test]
fn the_output_never_rises_when_the_tax_rises() {
    run_paired(
        (sides(), tax(), amount(), rate()),
        |(sides, tax, amount, other_rate)| {
            let bps = match tax {
                Tax::Buy(bps) | Tax::Sell(bps) => bps,
            };
            let (cheap, dear) = (
                at_rate(tax, bps.min(other_rate)),
                at_rate(tax, bps.max(other_rate)),
            );
            let (Ok(cheap), Ok(dear)) = (
                exact_in(sides, cheap, amount),
                exact_in(sides, dear, amount),
            ) else {
                return Ok(false);
            };
            prop_assert!(dear.amount_out <= cheap.amount_out, "more tax, more out");
            Ok(true)
        },
    );
}

#[test]
fn splitting_a_trade_in_two_never_returns_more() {
    run_paired(
        (sides(), tax(), amount(), amount()),
        |(sides, tax, first, second)| {
            let Some(whole) = first.checked_add(second) else {
                return Ok(false);
            };
            let Ok(one) = exact_in(sides, tax, first) else {
                return Ok(false);
            };
            let Ok(two) = exact_in(after(sides, &one), tax, second) else {
                return Ok(false);
            };
            let split = one.amount_out as u128 + two.amount_out as u128;
            match exact_in(sides, tax, whole) {
                Ok(single) => prop_assert!(split <= single.amount_out as u128),
                // The single trade is refused only where the split's legs could not have been
                // larger either: its curve output is past the real reserve, or its input reserve
                // past a u64.
                Err(error) => prop_assert!(
                    matches!(
                        error,
                        StrategyError::InsufficientLiquidity | StrategyError::Overflow
                    ),
                    "{error:?}"
                ),
            }
            Ok(true)
        },
    );
}

#[test]
fn buying_and_selling_straight_back_never_returns_more_than_was_put_in() {
    run_paired((market(), 0usize..2, amount()), |(market, from, amount)| {
        let mut market = market;
        let Ok(there) = trade(&mut market, from, amount) else {
            return Ok(false);
        };
        let Ok(back) = trade(&mut market, 1 - from, there.amount_out) else {
            return Ok(false);
        };
        prop_assert!(back.amount_out <= amount);
        Ok(true)
    });
}
