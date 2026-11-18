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
3. The cTokens a redeem burns for an amount `x` (`ctokens_for_value`, `k = floor(x x N x 2^60 /
   S)`) are worth at most `x` and less than one cToken's worth below it, so `rebalance` never
   carries the buffer past its target at the stored rate; and that function's numerator split,
   its refusal of a quotient of 2^64 or more, and its long division, whose doubled remainder may
   carry out of 128 bits since the divisor `S` may use all 128, are exact.
4. The cTokens a swap burns for its shortfall `x` (`ctokens_covering`, `k = ceil(x x N x 2^60 /
   S)`, the floor above plus one when the division leaves a remainder) are worth at least `x`
   at the stored rate, and one fewer would be worth less than `x`, so they are at most one
   cToken more than the shortfall needs (docs/spec/lending-pool.md, "Redeeming the shortfall").
5. The rate headroom (`with_rate_headroom`) taken off Kamino's limits before a redeem is planned
   is never short of `KAMINO_RATE_HEADROOM_BPS` of them, by less than one unit, and leaves
   between nothing and the whole limit.

Each division is modelled by its quotient and remainder, and each wide product by its 64-bit
digits (`p = h x 2^64 + l`, `0 <= l < 2^64`), which Z3 proves in seconds where symbolic
products time out. Kani proves the Rust meets the same statements for small values, and
Proptest checks them against an independent 256-bit reference on 10,000 random inputs each.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/lending-amm/proofs/kamino_z3.py`. Exits non-zero unless every claim is proven.
"""

import sys

from z3 import And, If, Implies, Int, Or
from z3_common import U128_MAX, constant, bounded, floor_div, prove

TWO_64 = 2**64
TWO_60 = 2**60
U64_MAX = TWO_64 - 1


HEADROOM_BPS = constant("KAMINO_RATE_HEADROOM_BPS")


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

    # 3a. k = floor(x x N x 2^60 / S) cTokens are worth v = floor(k x S / (N x 2^60)) <= x, and
    # x - v <= ceil(S / (N x 2^60)), one cToken's worth rounded up. The products are fresh
    # variables tied to their factors, which Z3's nonlinear arithmetic relates.
    x, x_ok = bounded("x", U64_MAX)
    s_total = Int("S")
    s_ok = And(s_total >= 1, s_total <= U128_MAX)
    m = n * TWO_60
    k, k_facts = floor_div("k", x * m, s_total)
    worth, worth_facts = floor_div("worth", k * s_total, m)
    one_ctoken = Int("one_ctoken")
    one_facts = And(one_ctoken * m >= s_total, (one_ctoken - 1) * m < s_total)
    ok &= prove(
        "the cTokens for an amount are worth at most it, and less than one cToken's worth below it",
        And(worth <= x, x - worth <= one_ctoken),
        x_ok,
        n_ok,
        s_ok,
        k_facts,
        worth_facts,
        one_facts,
    )

    # 3b. The numerator x x N x 2^60, with P = x x N below 2^128, is (P >> 4) x 2^64 +
    # (P mod 16) x 2^60, whose low digit fits a u64; and refusing top >= S refuses exactly the
    # quotients of 2^64 or more.
    p, p_ok = bounded("P", U128_MAX)
    top3, sixteenth = Int("top3"), Int("sixteenth")
    split = And(p == top3 * 16 + sixteenth, sixteenth >= 0, sixteenth < 16)
    low3 = sixteenth * TWO_60
    whole3, whole3_facts = floor_div("whole3", p * TWO_60, s_total)
    ok &= prove(
        "the numerator splits exactly into a u128 top and a u64 low digit",
        And(top3 * TWO_64 + low3 == p * TWO_60, low3 <= U64_MAX, top3 <= U128_MAX, top3 >= 0),
        p_ok,
        split,
    )
    ok &= prove(
        "top < S exactly when the cTokens fit a u64",
        (top3 < s_total) == (whole3 <= U64_MAX),
        p_ok,
        split,
        s_ok,
        whole3_facts,
    )

    # 3c. One step of its long division, from any remainder below S: the doubled remainder plus
    # the next bit is below 2^129; `carry` is its bit 128 and the stored value is it modulo
    # 2^128; subtracting S when either the carry is set or the stored value is at least S, with
    # wrapping, gives exactly the doubled remainder less S, below S, and the invariant carries on.
    r3, q3, y3, bit3 = Int("r3"), Int("q3"), Int("y3"), Int("bit3")
    step3_ok = And(
        s_ok,
        r3 >= 0,
        r3 < s_total,
        q3 >= 0,
        y3 == q3 * s_total + r3,
        Or(bit3 == 0, bit3 == 1),
    )
    doubled3 = 2 * r3 + bit3
    carry = If(doubled3 >= 2**128, 1, 0)
    stored = doubled3 - carry * 2**128
    subtract = Or(carry == 1, stored >= s_total)
    wrapped = If(stored - s_total < 0, stored - s_total + 2**128, stored - s_total)
    r3_next = If(subtract, wrapped, stored)
    q3_next = If(subtract, 2 * q3 + 1, 2 * q3)
    ok &= prove(
        "each step of the cToken long division is exact despite the carry, and keeps its invariant",
        And(
            doubled3 < 2**129,
            stored >= 0,
            stored <= U128_MAX,
            subtract == (doubled3 >= s_total),
            r3_next >= 0,
            r3_next < s_total,
            2 * y3 + bit3 == q3_next * s_total + r3_next,
        ),
        step3_ok,
    )

    # 4. k = floor(x x N x 2^60 / S) + (1 if the remainder is not 0) cTokens are worth
    # floor(k x S / (N x 2^60)) >= x, and k - 1 of them, for k >= 1, are worth less than x.
    kq, kq_facts = floor_div("kq", x * m, s_total)
    kr = x * m - kq * s_total
    kc = kq + If(kr > 0, 1, 0)
    covered, covered_facts = floor_div("covered", kc * s_total, m)
    fewer, fewer_facts = floor_div("fewer", (kc - 1) * s_total, m)
    ok &= prove(
        "the cTokens covering a shortfall are worth at least it, and one fewer would be worth less",
        And(covered >= x, Implies(kc >= 1, fewer < x)),
        x_ok,
        n_ok,
        s_ok,
        kq_facts,
        covered_facts,
        fewer_facts,
    )

    # 5. with_rate_headroom: amount - ceil(amount x KAMINO_RATE_HEADROOM_BPS / 10,000), for
    # every u64: the headroom is never short of its basis points' share, rounds up by less than
    # a unit, and leaves between 0 and the amount.
    amount, amount_ok = bounded("amount", U64_MAX)
    headroom, headroom_facts = floor_div("headroom", amount * HEADROOM_BPS + 10_000 - 1, 10_000)
    left = amount - headroom
    ok &= prove(
        "the rate headroom is never short of its share, by less than a unit, and leaves at most "
        "the amount",
        And(
            headroom * 10_000 >= amount * HEADROOM_BPS,
            headroom * 10_000 < amount * HEADROOM_BPS + 10_000,
            left >= 0,
            left <= amount,
        ),
        amount_ok,
        headroom_facts,
    )

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
