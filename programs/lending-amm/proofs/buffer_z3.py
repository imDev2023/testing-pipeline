"""Z3 proofs of the buffer's rule (`src/buffer.rs`) for every input: a u64 buffer `B`, a u64
lent value `V` with `L = B + V` inside a u64, any u64 amount Kamino can pay, and any u64 floor
(docs/spec/lending-pool.md, "The rule"; docs/spec/README.md, "Test layers" 2).

With `t = floor(L x BUFFER_TARGET_BPS / 10,000)` the target buffer:

1. Above the band (`B x 10,000 > L x BUFFER_MAX_BPS`) the buffer is above its target, so the
   deposit `B - t` is positive, takes no more than the buffer holds, and leaves exactly `t`.
2. Below the band (`B x 10,000 < L x BUFFER_MIN_BPS`) the buffer is below its target, and the
   redeem `min(t - B, can_pay)` never carries it past `t`, never asks Kamino for more than it can
   pay, and lands exactly on `t` whenever Kamino can pay the whole shortfall.
3. Inside the band nothing moves, and the three cases cover every input; the band's products
   give the same band as its edges in units of the lent mint, `ceil(L x BUFFER_MIN_BPS /
   10,000)` and `floor(L x BUFFER_MAX_BPS / 10,000)`, which the Kani harness checks `band`
   against.
4. No intermediate overflows: the products fit a u128, and `t` fits a u64 (it is at most `L`).

Every division is modelled by its quotient and remainder, as in `kamino_z3.py`. Kani proves the
same statements of the Rust for small values, and Proptest checks them on 10,000 random inputs.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/lending-amm/proofs/buffer_z3.py`. Exits non-zero unless every claim is proven.
"""

import sys

from z3 import And, If, Int, Not
from z3_common import U64_MAX, U128_MAX, constant, bounded, prove

BPS = 10_000


TARGET = constant("BUFFER_TARGET_BPS")
LOW = constant("BUFFER_MIN_BPS")
HIGH = constant("BUFFER_MAX_BPS")


def main():
    ok = True
    if not (LOW < TARGET < HIGH < BPS):
        sys.exit(f"the band {LOW} < {TARGET} < {HIGH} < {BPS} does not hold")

    b, b_ok = bounded("B", U64_MAX)
    v, v_ok = bounded("V", U64_MAX)
    pay, pay_ok = bounded("can_pay", U64_MAX)
    lent = b + v
    inputs = And(b_ok, v_ok, pay_ok, lent <= U64_MAX)

    # t = floor(L x TARGET / BPS), as a quotient and its remainder.
    t, rem = Int("t"), Int("t_rem")
    target_facts = And(t * BPS + rem == lent * TARGET, rem >= 0, rem < BPS)

    above = b * BPS > lent * HIGH
    below = b * BPS < lent * LOW

    ok &= prove(
        "the products fit a u128 and the target fits a u64, at most L",
        And(b * BPS <= U128_MAX, lent * HIGH <= U128_MAX, t >= 0, t <= lent, t <= U64_MAX),
        inputs,
        target_facts,
    )

    deposit = b - t
    ok &= prove(
        "above the band the deposit is positive, within the buffer, and leaves exactly the target",
        And(deposit > 0, deposit <= b, b - deposit == t),
        inputs,
        target_facts,
        above,
    )

    redeem = If(t - b < pay, t - b, pay)
    ok &= prove(
        "below the band the redeem never passes the target or what Kamino can pay",
        And(t >= b, redeem >= 0, b + redeem <= t, redeem <= pay),
        inputs,
        target_facts,
        below,
    )
    ok &= prove(
        "below the band, when Kamino can pay the whole shortfall, the redeem lands on the target",
        b + redeem == t,
        inputs,
        target_facts,
        below,
        pay >= t - b,
    )

    ok &= prove(
        "the band's three cases never overlap",
        Not(And(above, below)),
        inputs,
    )

    # The band's edges as amounts of the lent mint, as the Kani harness states them:
    # low = ceil(L x LOW / BPS) and high = floor(L x HIGH / BPS).
    low, low_rem = Int("low"), Int("low_rem")
    low_facts = And(low * BPS - low_rem == lent * LOW, low_rem >= 0, low_rem < BPS)
    high, high_rem = Int("high"), Int("high_rem")
    high_facts = And(high * BPS + high_rem == lent * HIGH, high_rem >= 0, high_rem < BPS)
    ok &= prove(
        "the band's products and its edges in units of the lent mint give the same band",
        And(below == (b < low), above == (b > high)),
        inputs,
        low_facts,
        high_facts,
    )

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
