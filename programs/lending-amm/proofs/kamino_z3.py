"""Z3 proofs of the Kamino module's valuation (`src/kamino.rs`) for every input the reserve's
layout allows: a u64 cToken amount `c`, a u128 total supply `S` in 60-bit fixed point and a
u64 cToken supply `N` (docs/spec/lending-pool.md, "Valuing the lent side"; docs/spec/README.md,
"Test layers" 2).

1. The valuation never rounds above the redeem's payout: klend's `redeem_reserve_collateral`
   pays `floor(floor(c x S / N) / 2^60)` (its 256-bit fixed-point product, divided by the
   cToken supply, then rounded down to whole units), which equals `collateral_value`'s
   `floor(c x S / (N x 2^60))`; and a higher rate (klend refreshes the reserve inside the
   redeem, and interest only raises it) never values the same cTokens lower.
2. No intermediate value overflows: the product's 64-bit digits, the divisor, the refusal of a
   quotient of 2^64 or more, and each step of the long division all stay inside their types,
   and the long division's invariant holds at every step, so it returns the exact quotient.

Each division is modelled by its quotient and remainder, and each wide product by its 64-bit
digits (`p = h x 2^64 + l`, `0 <= l < 2^64`), which Z3 proves in seconds where symbolic
products time out. Kani proves the Rust meets the same statements for small values, and
Proptest checks them against an independent 256-bit reference on 10,000 random inputs each.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/lending-amm/proofs/kamino_z3.py`. Exits non-zero unless every claim is proven.
"""

import sys

from z3 import And, If, Implies, Int, Not, Or, Solver, sat, unsat

TWO_64 = 2**64
TWO_60 = 2**60
U64_MAX = TWO_64 - 1
U128_MAX = 2**128 - 1


def bounded(name, high):
    value = Int(name)
    return value, And(value >= 0, value <= high)


def floor_div(name, numerator, denominator):
    """`numerator / denominator` as Rust's integer division: a quotient and its remainder."""
    quotient, remainder = Int(f"{name}_q"), Int(f"{name}_r")
    facts = And(
        quotient * denominator + remainder == numerator,
        remainder >= 0,
        remainder < denominator,
    )
    return quotient, facts


def prove(name, claim, *assumptions):
    solver = Solver()
    solver.set("timeout", 600_000)
    solver.add(*assumptions)
    solver.add(Not(claim))
    result = solver.check()
    if result == unsat:
        print(f"PROVEN  {name}")
        return True
    if result == sat:
        print(f"FAILED  {name}: counterexample {solver.model()}")
    else:
        print(f"UNKNOWN {name} ({solver.reason_unknown()})")
    return False


def main():
    ok = True

    # The product c x S, as its value P (a fresh variable) for the division claims.
    product = Int("P")
    c, c_ok = bounded("c", U64_MAX)
    n = Int("N")
    n_ok = And(n >= 1, n <= U64_MAX)
    product_ok = And(product >= 0, product <= U64_MAX * U128_MAX)

    # 1a. klend's payout, floor(floor(P / N) / 2^60), is floor(P / (N x 2^60)).
    inner, inner_facts = floor_div("inner", product, n)
    payout, payout_facts = floor_div("payout", inner, TWO_60)
    value, value_facts = floor_div("value", product, n * TWO_60)
    ok &= prove(
        "the valuation equals klend's payout at the same rate, so it never rounds above it",
        value == payout,
        product_ok,
        n_ok,
        inner_facts,
        payout_facts,
        value_facts,
    )

    # 1b. A higher total supply never values the same cTokens lower: floor is monotone in the
    # numerator, and c x S grows with S.
    low, high = Int("P_low"), Int("P_high")
    v_low, low_facts = floor_div("v_low", low, n * TWO_60)
    v_high, high_facts = floor_div("v_high", high, n * TWO_60)
    ok &= prove(
        "a higher rate never values the same cTokens lower",
        v_low <= v_high,
        n_ok,
        low >= 0,
        low <= high,
        low_facts,
        high_facts,
    )

    # 2a. The product's digits. S = s_hi x 2^64 + s_lo; c x s_lo = lp_hi x 2^64 + lp_lo; and
    # top = c x s_hi + lp_hi never exceeds a u128, so `checked_add` never refuses it.
    s_hi, s_hi_ok = bounded("s_hi", U64_MAX)
    s_lo, s_lo_ok = bounded("s_lo", U64_MAX)
    high_product, high_ok = bounded("high_product", U128_MAX)
    low_product, low_ok = bounded("low_product", U128_MAX)
    lp_hi, lp_lo = Int("lp_hi"), Int("lp_lo")
    digit_facts = And(
        c_ok,
        s_hi_ok,
        s_lo_ok,
        high_ok,
        low_ok,
        high_product == c * s_hi,
        low_product == c * s_lo,
        low_product == lp_hi * TWO_64 + lp_lo,
        lp_lo >= 0,
        lp_lo < TWO_64,
    )
    top = high_product + lp_hi
    ok &= prove(
        "the product's top digits fit a u128, and with the low digit make c x S exactly",
        And(top <= U128_MAX, top * TWO_64 + lp_lo == c * (s_hi * TWO_64 + s_lo)),
        digit_facts,
    )

    # 2b. The divisor N x 2^60 is below 2^124, and refusing top >= divisor refuses exactly the
    # quotients of 2^64 or more.
    divisor = n * TWO_60
    whole, whole_facts = floor_div("whole", top * TWO_64 + lp_lo, divisor)
    ok &= prove(
        "the divisor fits in 124 bits, and top < divisor exactly when the quotient fits a u64",
        And(divisor < 2**124, (top < divisor) == (whole <= U64_MAX)),
        digit_facts,
        n_ok,
        whole_facts,
    )

    # 2c. One step of the long division, from any remainder below the divisor: the doubled
    # remainder plus the next bit stays below 2^125 (so `<< 1` loses nothing), the new
    # remainder is again below the divisor, and the invariant x = q x divisor + r carries on
    # to 2x + bit = q' x divisor + r'.
    r, q, x, bit = Int("r"), Int("q"), Int("x"), Int("bit")
    step_ok = And(
        n_ok,
        r >= 0,
        r < divisor,
        q >= 0,
        x == q * divisor + r,
        Or(bit == 0, bit == 1),
    )
    doubled = 2 * r + bit
    r_next = If(doubled >= divisor, doubled - divisor, doubled)
    q_next = If(doubled >= divisor, 2 * q + 1, 2 * q)
    ok &= prove(
        "each step of the long division stays in 125 bits and keeps its invariant",
        And(
            doubled < 2**125,
            r_next >= 0,
            r_next < divisor,
            2 * x + bit == q_next * divisor + r_next,
        ),
        step_ok,
    )

    # 2d. Starting from r = top < divisor and q = 0, after the 64 bits of the low digit the
    # invariant gives top x 2^64 + low = q x divisor + r with 0 <= r < divisor, which makes q
    # the floor; and that quotient fits a u64, so `quotient <<= 1` never drops a set bit.
    final_q, final_r = Int("final_q"), Int("final_r")
    ok &= prove(
        "after the 64 steps the quotient is the floor of c x S / divisor, and fits a u64",
        And(final_q == whole, final_q <= U64_MAX),
        digit_facts,
        n_ok,
        top < divisor,
        whole_facts,
        final_q * divisor + final_r == top * TWO_64 + lp_lo,
        final_r >= 0,
        final_r < divisor,
        final_q >= 0,
    )

    # 2e. klend's own payout overflows its 128-bit fraction only when c x S / N >= 2^128,
    # that is when the value is at least 2^68, which `collateral_value` refuses already (a
    # value above a u64): so wherever klend can pay, the valuation is defined.
    ok &= prove(
        "wherever klend's payout fits its fraction, the valuation fits a u64 or is refused cleanly",
        Implies(inner <= U128_MAX, value <= 2**68),
        product_ok,
        n_ok,
        inner_facts,
        value_facts,
    )

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
