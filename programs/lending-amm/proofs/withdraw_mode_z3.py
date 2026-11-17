"""Z3 proofs of withdraw mode's measure and rules (`src/withdraw_mode.rs`) for every input:
a u64 buffer `B` and lent value `V` with `L = B + V` inside a u64, any u64 free liquidity and
amount Kamino can pay (docs/spec/lending-pool.md, "Withdraw mode"; docs/spec/README.md,
"Test layers" 2).

With `t = floor(L x BUFFER_TARGET_BPS / 10,000)` the target buffer and `T = L - t` the target
lent value:

1. The exposure `X = max(V, T)` is at least `V` and `T`, at most `L`, and `T` is
   `L x (10,000 - BUFFER_TARGET_BPS) / 10,000` rounded up, so a market that has lent nothing is
   measured by what it would lend.
2. The thresholds never overlap, their products fit a u128, and the mode follows them: on
   below `WITHDRAW_MODE_ENTER x X`, off above `WITHDRAW_MODE_EXIT x X`, kept between, so a market
   in withdraw mode stays in it while the free liquidity is at or below the exit threshold.
3. Outside withdraw mode a deposit happens only at or above the entry threshold, so a market
   that has lent nothing never makes its first deposit into a reserve too thin to pay it back;
   in it, the redeem `min(V, can_pay)` never asks for more than the market has lent or Kamino
   can pay, and outside it the redeem `min(t - B, can_pay)` never asks for more than the market
   has lent either.

Kani proves the same statements of the Rust (`decide`, `next_mode`, `exposure`) with the buffer
and lent value bounded, and Proptest checks them on 10,000 random inputs.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/lending-amm/proofs/withdraw_mode_z3.py`. Exits non-zero unless every claim is
proven.
"""

import sys

from z3 import And, Bool, If, Implies, Int, Not
from z3_common import U64_MAX, U128_MAX, constant, bounded, prove

BPS = 10_000


TARGET = constant("BUFFER_TARGET_BPS")
ENTER = constant("WITHDRAW_MODE_ENTER")
EXIT = constant("WITHDRAW_MODE_EXIT")


def main():
    ok = True
    if not (0 < TARGET < BPS and ENTER <= EXIT):
        sys.exit(f"constants out of shape: target {TARGET}, enter {ENTER}, exit {EXIT}")

    b, b_ok = bounded("B", U64_MAX)
    v, v_ok = bounded("V", U64_MAX)
    free, free_ok = bounded("free", U64_MAX)
    pay, pay_ok = bounded("can_pay", U64_MAX)
    lent = b + v
    inputs = And(b_ok, v_ok, free_ok, pay_ok, lent <= U64_MAX)

    t, rem = Int("t"), Int("t_rem")
    target_facts = And(t * BPS + rem == lent * TARGET, rem >= 0, rem < BPS)
    target_lent = lent - t
    x = If(v >= target_lent, v, target_lent)

    ok &= prove(
        "the exposure is at least the lent value and the target lent value, and at most L",
        And(x >= v, x >= target_lent, x <= lent, target_lent >= 0),
        inputs,
        target_facts,
    )
    ok &= prove(
        "the target lent value is L x (10,000 - target) / 10,000 rounded up",
        And(
            target_lent * BPS >= lent * (BPS - TARGET),
            (target_lent - 1) * BPS < lent * (BPS - TARGET),
        ),
        inputs,
        target_facts,
    )

    current = Bool("current")
    enter = ENTER * x
    exit_ = EXIT * x
    mode = If(free < enter, True, If(free > exit_, False, current))
    ok &= prove(
        "the thresholds never overlap and their products fit a u128",
        And(Not(And(free < enter, free > exit_)), enter <= U128_MAX, exit_ <= U128_MAX),
        inputs,
        target_facts,
    )
    ok &= prove(
        "a market in withdraw mode stays in it while the free liquidity is at or below the exit "
        "threshold, and enters it below the entry threshold",
        And(Implies(And(current, free <= exit_), mode), Implies(free < enter, mode)),
        inputs,
        target_facts,
    )
    ok &= prove(
        "outside withdraw mode the free liquidity is at or above the entry threshold, so a "
        "market that has lent nothing never deposits into a thinner reserve",
        Implies(Not(mode), free >= enter),
        inputs,
        target_facts,
    )

    in_mode_redeem = If(v < pay, v, pay)
    short = t - b
    band_redeem = If(short < pay, short, pay)
    ok &= prove(
        "in withdraw mode the redeem asks for at most what is lent and what Kamino can pay, and "
        "outside it a redeem towards the target asks for at most what is lent",
        And(
            in_mode_redeem <= v,
            in_mode_redeem <= pay,
            Implies(t > b, And(band_redeem <= v, band_redeem <= pay)),
        ),
        inputs,
        target_facts,
    )

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
