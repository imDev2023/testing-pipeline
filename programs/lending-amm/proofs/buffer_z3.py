"""Z3 proofs of the buffer's rule (`src/buffer.rs`) for every input: a u64 buffer `B`, a u64
lent value `V` with `L = B + V` inside a u64, any u64 amount Kamino can pay, and any u64 floor
(docs/spec/lending-pool.md, "The rule"; docs/spec/README.md, "Test layers" 2).

With `t = floor(L x BUFFER_TARGET_BPS / 10,000)` the target buffer:

1. Above the band (`B x 10,000 > L x BUFFER_MAX_BPS`) the buffer is above its target, so the
   deposit `B - t` is positive, takes no more than the buffer holds, and leaves exactly `t`.
2. Below the band (`B x 10,000 < L x BUFFER_MIN_BPS`) the buffer is below its target, and the
   redeem `min(t - B, can_pay)` never carries it past `t`, never asks Kamino for more than it can
   pay, and lands exactly on `t` whenever Kamino can pay the whole shortfall.
3. Inside the band nothing moves, and the three cases cover every input.
4. No intermediate overflows: the products fit a u128, and `t` fits a u64 (it is at most `L`).

Every division is modelled by its quotient and remainder, as in `kamino_z3.py`. Kani proves the
same statements of the Rust for small values, and Proptest checks them on 10,000 random inputs.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/lending-amm/proofs/buffer_z3.py`. Exits non-zero unless every claim is proven.
"""

import re
import sys
from pathlib import Path

from z3 import And, If, Int, Not, Solver, sat, unsat

U64_MAX = 2**64 - 1
U128_MAX = 2**128 - 1
BPS = 10_000


def constant(name):
    """A constant's value as `src/config.rs` defines it, so the proofs follow any change there."""
    config = (Path(__file__).resolve().parent.parent / "src" / "config.rs").read_text()
    match = re.search(rf"pub const {name}: \w+ = ([\d_]+);", config)
    if not match:
        sys.exit(f"no {name} in src/config.rs")
    return int(match.group(1).replace("_", ""))


TARGET = constant("BUFFER_TARGET_BPS")
LOW = constant("BUFFER_MIN_BPS")
HIGH = constant("BUFFER_MAX_BPS")


def bounded(name, high):
    value = Int(name)
    return value, And(value >= 0, value <= high)


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

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
