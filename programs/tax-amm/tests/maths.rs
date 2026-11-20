//! Property tests of the pure pricing and split functions (docs/spec/README.md, "Test
//! layers" 2), at least 10,000 cases a property, over the whole range of reserves, virtual
//! reserves, amounts, rates up to `MAX_TAX_BPS` and valid splits, and past them where a
//! property is about refusing them. The property list, with the IDs and the Kani and Z3
//! proofs of the same statements, is docs/security/tax-amm/maths-properties.md.

use anchor_lang::prelude::Pubkey;
use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use tax_amm::config::{MAX_TAX_BPS, SUITE_SHARE_BPS};
use tax_amm::params::check_split;
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

/// Whole shares with their zeros anywhere, not only after the used slots: what
/// `split_tax` itself accepts, so P2 is checked without leaning on `check_split`'s order.
fn whole_shares_in_any_order() -> impl Strategy<Value = ([u16; 4], u16)> {
    shares().prop_flat_map(|(shares, burn)| {
        (Just(shares.to_vec()).prop_shuffle(), Just(burn))
            .prop_map(|(shares, burn)| ([shares[0], shares[1], shares[2], shares[3]], burn))
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(CASES))]

    /// P2: with whole shares, a recipient slot after the first whose share is 0 is booked
    /// nothing, and so is the burn when its share is 0; slot 0 takes the remainder.
    #[test]
    fn an_unshared_slot_is_booked_nothing(tax in amount(), (shares, burn) in whole_shares_in_any_order()) {
        let slots = split_tax(tax, &shares, burn).unwrap();
        for i in 1..4 {
            if shares[i] == 0 {
                prop_assert_eq!(slots[i], 0, "slot {} booked with share 0", i);
            }
        }
        if burn == 0 {
            prop_assert_eq!(slots[4], 0, "the burn booked with share 0");
        }
    }
}

/// V2 on the compiled code: a swap's tax never exceeds what it adds to the tax side's
/// volume, the input for a buy tax and what the trader gets for a sell tax.
#[test]
fn the_tax_never_exceeds_what_the_swap_adds_to_the_tax_sides_volume() {
    run_paired((sides(), tax(), amount()), |(sides, tax, amount)| {
        let Ok(fill) = exact_in(sides, tax, amount) else {
            return Ok(false);
        };
        let counted = match tax {
            Tax::Buy(_) => fill.amount_in,
            Tax::Sell(_) => fill.amount_out,
        };
        prop_assert!(
            fill.tax <= counted,
            "tax {} above the {} counted",
            fill.tax,
            counted
        );
        Ok(true)
    });
}

/// Sides whose output has no virtual reserve and at least 1 unit of real reserve, against an
/// input side holding at least 1 unit, real or virtual: an open market's side without a
/// virtual reserve, traded into.
fn sides_without_a_virtual_output() -> impl Strategy<Value = Sides> {
    let reserve = prop_oneof![1u64..1_000, 1u64..1_000_000_000, 1u64..=u64::MAX];
    let maybe_empty = prop_oneof![Just(0u64), 0u64..1_000, any::<u64>()];
    (reserve.clone(), maybe_empty.clone(), maybe_empty, reserve).prop_map(
        |(reserve_out, reserve_in, virtual_in, fallback)| Sides {
            reserve_in: if reserve_in == 0 && virtual_in == 0 {
                fallback
            } else {
                reserve_in
            },
            reserve_out,
            virtual_in,
            virtual_out: 0,
        },
    )
}

/// S6 on the compiled code: a fill never takes the real reserve of an output side without a
/// virtual reserve to 0, and the input side's real reserve never falls.
#[test]
fn a_side_without_a_virtual_reserve_never_empties() {
    run_paired(
        (sides_without_a_virtual_output(), tax(), amount()),
        |(sides, tax, amount)| {
            let Ok(fill) = exact_in(sides, tax, amount) else {
                return Ok(false);
            };
            prop_assert!(fill.reserve_out >= 1, "the output side emptied");
            prop_assert!(fill.reserve_in >= sides.reserve_in, "the input side fell");
            Ok(true)
        },
    );
}

/// The native SOL mints, written out here so the rule below does not read the program's
/// own list: SPL Token's and Token-2022's.
fn native_sol_mints() -> [Pubkey; 2] {
    [
        "So11111111111111111111111111111111111111112"
            .parse()
            .unwrap(),
        "9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP"
            .parse()
            .unwrap(),
    ]
}

/// The spec's rule on the recipients, their shares and the burn share (docs/spec/tax-amm.md,
/// "Creation parameters"), stated independently of `params::check_split`: the first rule
/// broken, in the order at least one recipient, used slots first, each used share above 0,
/// each unused slot's share 0, the shares and the burn share summing to 10,000, and no burn
/// share when the tax side is native SOL. Used slots come first, so a slot is used when it
/// and every slot before it name a wallet, and a market has a recipient when slot 0 is used.
fn the_spec_rule_on_the_split(
    recipients: &[Pubkey; 4],
    shares: &[u16; 4],
    burn: u16,
    tax_mint: &Pubkey,
) -> Result<(), StrategyError> {
    let used = |i: usize| (0..=i).all(|j| recipients[j] != Pubkey::default());
    if !used(0) {
        return Err(StrategyError::NoRecipient);
    }
    // A wallet in a slot that is not used follows an empty one.
    if (0..4).any(|i| !used(i) && recipients[i] != Pubkey::default()) {
        return Err(StrategyError::RecipientsOutOfOrder);
    }
    if (0..4).any(|i| used(i) && shares[i] == 0) {
        return Err(StrategyError::ZeroShare);
    }
    if (0..4).any(|i| !used(i) && shares[i] != 0) {
        return Err(StrategyError::ShareWithoutRecipient);
    }
    let total = shares[0] as u64 + shares[1] as u64 + shares[2] as u64 + shares[3] as u64;
    if total + burn as u64 != 10_000 {
        return Err(StrategyError::SharesNotWhole);
    }
    if burn != 0 && native_sol_mints().contains(tax_mint) {
        return Err(StrategyError::BurnOnNativeSol);
    }
    Ok(())
}

/// A split as a creator or a tax authority might submit it: a valid one, then possibly one
/// rule broken (or several, or anything at all), against a native SOL tax mint or another.
fn submitted_split() -> impl Strategy<Value = ([Pubkey; 4], [u16; 4], u16, Pubkey)> {
    let keys = [1u8, 2, 3].map(|seed| Pubkey::new_from_array([seed; 32]));
    (
        0usize..=4,
        prop_oneof![3 => Just(0u16), 2 => 0u16..=9_996, 1 => any::<u16>()],
        any::<[u32; 4]>(),
        any::<[u8; 4]>(),
        // What breaks: 0 nothing, 1 a wallet after an unused slot, 2 a used share 0, 3 an
        // unused slot shared, 4 the sum off by a little, 5 any shares and burn, 6 any wallets.
        prop_oneof![4 => Just(0u8), 6 => 1u8..=6],
        any::<[u16; 5]>(),
        0usize..3,
        any::<u8>(),
    )
        .prop_map(
            move |(used, burn, cuts, picks, broken, noise, mint, which)| {
                let mut recipients = [Pubkey::default(); 4];
                for (i, recipient) in recipients.iter_mut().enumerate().take(used) {
                    *recipient = keys[picks[i] as usize % 3];
                }
                // Whole shares for the used slots, each at least 1.
                let mut shares = [0u16; 4];
                let mut burn = burn;
                if used > 0 {
                    burn = burn.min(10_000 - used as u16);
                    let mut left = 10_000 - burn;
                    for (i, share) in shares.iter_mut().enumerate().take(used - 1) {
                        let room = left - (used - 1 - i) as u16;
                        *share = 1 + (cuts[i] % room as u32) as u16;
                        left -= *share;
                    }
                    shares[used - 1] = left;
                }
                let slot = which as usize % 4;
                match broken {
                    1 if used < 3 => recipients[used + 1 + slot % (3 - used)] = keys[0],
                    2 if used > 0 => shares[slot % used] = 0,
                    3 if used < 4 => shares[used + slot % (4 - used)] = 1 + noise[0] % 10_000,
                    4 => {
                        let delta = 1 + noise[1] % 3;
                        burn = if noise[2] % 2 == 0 {
                            burn.wrapping_add(delta)
                        } else {
                            burn.wrapping_sub(delta)
                        };
                    }
                    5 => {
                        shares = [noise[0], noise[1], noise[2], noise[3]].map(|share| {
                            if share % 3 == 0 {
                                0
                            } else {
                                share
                            }
                        });
                        burn = noise[4];
                    }
                    6 => {
                        recipients = picks.map(|pick| match pick % 4 {
                            0 => Pubkey::default(),
                            k => keys[k as usize - 1],
                        });
                    }
                    _ => {}
                }
                let tax_mint = match mint {
                    0 | 1 => native_sol_mints()[mint],
                    _ => Pubkey::new_from_array([9; 32]),
                };
                (recipients, shares, burn, tax_mint)
            },
        )
}

/// P3, the one case the spec's words read two ways: wallets named only after an empty slot 0
/// break both "at least one recipient" (no slot is used) and "used slots first"; the first
/// rule checked, and so the error, is `NoRecipient`.
#[test]
fn wallets_named_only_after_an_empty_first_slot_are_refused_as_no_recipient() {
    let wallet = Pubkey::new_from_array([1; 32]);
    let empty = Pubkey::default();
    for recipients in [
        [empty, empty, empty, wallet],
        [empty, wallet, wallet, empty],
    ] {
        let shares = [0, 5_000, 5_000, 0];
        let mint = Pubkey::new_from_array([9; 32]);
        assert!(matches!(
            check_split(&recipients, &shares, 0, &mint),
            Err(StrategyError::NoRecipient)
        ));
    }
}

/// P3: `check_split`, the rule creation and `set_recipients` apply, accepts exactly the
/// spec's splits and refuses every other one with the error of the first rule it breaks;
/// the run fails unless acceptance and each refusal came up at least 200 times.
#[test]
fn check_split_accepts_exactly_the_specs_splits() {
    let outcomes = std::sync::Mutex::new(std::collections::BTreeMap::<String, u32>::new());
    let mut runner = TestRunner::new(Config::with_cases(CASES));
    runner
        .run(
            &submitted_split(),
            |(recipients, shares, burn, tax_mint)| {
                let expected = the_spec_rule_on_the_split(&recipients, &shares, burn, &tax_mint);
                let got = check_split(&recipients, &shares, burn, &tax_mint);
                prop_assert_eq!(
                    format!("{got:?}"),
                    format!("{expected:?}"),
                    "recipients {:?}, shares {:?}, burn {}, mint {}",
                    recipients,
                    shares,
                    burn,
                    tax_mint
                );
                *outcomes
                    .lock()
                    .unwrap()
                    .entry(format!("{got:?}"))
                    .or_default() += 1;
                Ok(())
            },
        )
        .unwrap();
    let outcomes = outcomes.into_inner().unwrap();
    for outcome in [
        "Ok(())",
        "Err(NoRecipient)",
        "Err(RecipientsOutOfOrder)",
        "Err(ZeroShare)",
        "Err(ShareWithoutRecipient)",
        "Err(SharesNotWhole)",
        "Err(BurnOnNativeSol)",
    ] {
        let seen = outcomes.get(outcome).copied().unwrap_or(0);
        assert!(
            seen >= CASES / 50,
            "{outcome} came up only {seen} times: {outcomes:?}"
        );
    }
}
