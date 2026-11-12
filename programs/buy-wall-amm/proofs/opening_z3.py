"""Z3 proofs of the buy wall AMM's seed maths for every input.

Kani proves the seed maths in `src/opening.rs` (its `proofs` module), but its SAT back end
cannot relate a division's output to its inputs over the full range, so its proofs about
quotients finish only for small amounts. Here Z3 proves the same statements over the
integers, for every input, by modelling `U256::mul`, `U256::mul_u64`, `ratio_q128`,
`opening_liquidity`, `liquidity_at` and `cap_floor` step by step, including the range each intermediate must stay in for its
checked operation to succeed (docs/spec/README.md, "Test layers" 2).

The link between this model and the compiled Rust is checked by tests: Kani proves the
Rust meets the same statements for small amounts, and Proptest checks them on 10,000
random inputs each (`src/opening.rs`).

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/buy-wall-amm/proofs/opening_z3.py`. Exits non-zero unless every claim is
proven.
"""

import sys

from z3 import And, If, Implies, Int, Not, Solver, sat, unsat

U64_MAX = 2**64 - 1
U128 = 2**128
Q = 2**64  # Q64.64's one
BPS = 10_000
MIN_LIQUIDITY = 1_000_000
MIN_OPENING_SQRT_PRICE = 2**40
MAX_OPENING_SQRT_PRICE = 2**88


def u64(name):
    v = Int(name)
    return v, And(v >= 0, v <= U64_MAX)


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


def ratio_q128(y, x):
    """`ratio_q128` as written: long division of y × 2^128 by x in 64-bit digits.

    Returns the 256-bit result (hi × 2^128 + lo) and the conditions each step relies on.
    """
    q2, r2 = y / x, y % x
    t1 = r2 * Q  # `r2 << 64`: no bit may be lost
    q1, r1 = t1 / x, t1 % x
    t0 = r1 * Q  # `checked_rem(..) << 64`
    q0 = t0 / x
    # `(q1 << 64) | q0` equals q1 × 2^64 + q0 only if both digits fit in 64 bits.
    steps_fit = And(t1 < U128, t0 < U128, q1 <= U64_MAX, q0 <= U64_MAX)
    return q2 * U128 + q1 * Q + q0, steps_fit


def opening_liquidity(x, y, s):
    """`opening_liquidity` as written: min(floor(x × s / 2^64), floor(y × 2^64 / s))."""
    token_side = (x * s) / Q  # `checked_shr64` of the 256-bit product
    sol_side = (y * Q) / s  # `(y << 64).checked_div(s)`
    fits = And(x * s < Q * U128, y * Q < U128)  # shr64 fits u128; y << 64 loses nothing
    return If(token_side <= sol_side, token_side, sol_side), token_side, sol_side, fits


def split(name, value):
    """`value`'s high and low 64-bit digits as fresh variables, and the facts tying them."""
    high, low = Int(f"{name}_high"), Int(f"{name}_low")
    return high, low, And(value == high * Q + low, low >= 0, low < Q, high >= 0)


def mul(a1, a0, b1, b0):
    """`U256::mul` as written, on operands given by their 64-bit halves (`a = a1 × 2^64 +
    a0`): four partial products, their low digits summed into `mid`, the carries into `hi`.

    Each `>> 64` and `& LOW_64` of a product is a variable tied to it by `split`, so the
    claim is a polynomial identity with no division, which Z3 settles at once.
    Returns the 256-bit result (hi × 2^128 + lo), the splits' facts, and the conditions each
    checked step needs.
    """
    p00, p01, p10, p11 = a0 * b0, a0 * b1, a1 * b0, a1 * b1
    h00, l00, f00 = split("p00", p00)
    h01, l01, f01 = split("p01", p01)
    h10, l10, f10 = split("p10", p10)
    mid = h00 + l01 + l10
    hm, lm, fm = split("mid", mid)
    lo = lm * Q + l00  # `((mid & LOW_64) << 64) | (p00 & LOW_64)`
    hi = p11 + h01 + h10 + hm
    facts = And(f00, f01, f10, fm)
    fits = And(p00 < U128, p01 < U128, p10 < U128, p11 < U128, mid < U128, hi < U128)
    return hi * U128 + lo, facts, fits


def mul_u64(hi, lo, x):
    """`U256::mul_u64` as written: `(hi × 2^128 + lo) × x`, or `None` past 256 bits."""
    r0 = (lo % Q) * x
    r1 = (lo / Q) * x + r0 / Q
    new_lo = (r1 % Q) * Q + r0 % Q
    new_hi = hi * x + r1 / Q
    some = And(r0 < U128, r1 < U128, hi * x < U128, new_hi < U128)
    return new_hi * U128 + new_lo, some


def main():
    ok = True
    # Every u128 operand is its two 64-bit halves.
    a1, a1_ok = u64("a1")
    a0, a0_ok = u64("a0")
    b1, b1_ok = u64("b1")
    b0, b0_ok = u64("b0")

    # 256-bit multiplication is exact, and none of its checked steps can fail.
    product, facts, fits = mul(a1, a0, b1, b0)
    ok &= prove(
        "U256::mul(a, b) == a * b, every step in range (every u128 a, b)",
        And(product == (a1 * Q + a0) * (b1 * Q + b0), fits),
        a1_ok,
        a0_ok,
        b1_ok,
        b0_ok,
        facts,
    )

    # mul_u64 is exact, and is `None` exactly when the product passes 256 bits.
    hi, lo = Int("hi"), Int("lo")
    x64 = Int("x64")
    product, some = mul_u64(hi, lo, x64)
    ok &= prove(
        "U256::mul_u64 == n * x when it fits, None exactly past 2^256 (every n, u64 x)",
        And(some == ((hi * U128 + lo) * x64 < 2**256), Implies(some, product == (hi * U128 + lo) * x64)),
        hi >= 0, hi < U128, lo >= 0, lo < U128, x64 >= 0, x64 <= U64_MAX,
    )

    x, x_ok = u64("x")
    y, y_ok = u64("y")
    s = Int("s")
    s_ok = And(s >= 1, s < U128)

    # ratio_q128 is exactly floor(y × 2^128 / x), and none of its steps overflows.
    ratio, steps_fit = ratio_q128(y, x)
    ok &= prove(
        "ratio_q128(y, x) == floor(y * 2^128 / x), every step in range (every x >= 1, y)",
        And(ratio == (y * U128) / x, steps_fit),
        x_ok,
        y_ok,
        x >= 1,
    )

    # The opening liquidity never exceeds what the two amounts back at the price s.
    liquidity, token_side, sol_side, fits = opening_liquidity(x, y, s)
    ok &= prove(
        "opening_liquidity: L * 2^64 <= x * s and L * s <= y * 2^64, no overflow (every x, y, s)",
        And(liquidity * Q <= x * s, liquidity * s <= y * Q, fits),
        x_ok,
        y_ok,
        s_ok,
    )

    # The rounded price never exceeds the seeded price: if s is the floor square root of
    # floor(y × 2^128 / x), then s² × x <= y × 2^128.
    q = Int("q")
    ok &= prove(
        "s*s <= floor(y * 2^128 / x) implies s*s * x <= y * 2^128 (every x >= 1, y, s)",
        Implies(And(q == (y * U128) / x, s * s <= q), s * s * x <= y * U128),
        x_ok,
        y_ok,
        x >= 1,
        s >= 0,
    )

    # Because the price rounds down, the token side binds: L = floor(x × s / 2^64).
    ok &= prove(
        "s*s * x <= y * 2^128 implies the token side binds the opening liquidity",
        Implies(s * s * x <= y * U128, liquidity == token_side),
        x_ok,
        y_ok,
        s_ok,
    )

    # The cap floor is between 1 and x, and its curve liquidity is at most the opening
    # liquidity, so a seed that passes the cap floor check opens with at least
    # MIN_LIQUIDITY.
    bps = Int("bps")
    share = (x * bps) / BPS
    floor_ = If(share >= 1, share, 1)
    ok &= prove(
        "cap_floor(x, bps) is in [1, x] and its share never saturates (x >= 1, bps <= 10,000)",
        And(floor_ >= 1, floor_ <= x, share <= U64_MAX),
        x_ok,
        x >= 1,
        bps >= 0,
        bps <= BPS,
    )
    ok &= prove(
        "liquidity_at(cap_floor, s) >= MIN_LIQUIDITY implies the opening liquidity is too",
        Implies(
            And((floor_ * s) / Q >= MIN_LIQUIDITY, s * s * x <= y * U128),
            liquidity >= MIN_LIQUIDITY,
        ),
        x_ok,
        y_ok,
        s_ok,
        x >= 1,
        bps >= 0,
        bps <= BPS,
    )

    # Every opening price in bounds keeps the opening liquidity within u128 with room:
    # L <= x × s / 2^64 < 2^64 × 2^88 / 2^64 = 2^88.
    ok &= prove(
        "the opening liquidity is below 2^88 for every price in the opening bounds",
        liquidity < 2**88,
        x_ok,
        y_ok,
        s >= MIN_OPENING_SQRT_PRICE,
        s <= MAX_OPENING_SQRT_PRICE,
    )

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
