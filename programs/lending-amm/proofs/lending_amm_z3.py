"""Z3 proofs of the lending AMM's division and rounding properties for every u64 input.

Kani proves the same properties in `src/pricing.rs` and `src/shares.rs` (their `proofs`
modules), but its SAT back end cannot relate a division's output to its inputs over the full
range, so its proofs about quotients finish only for small values. Here Z3 proves them over
the integers, for every input, by modelling each division as Rust computes it, by its
quotient and remainder (n = q x d + r, 0 <= r < d), and proving each claim by showing its
negation unsatisfiable (docs/spec/README.md, "Test layers" 2).

The link between this model and the compiled Rust is checked by tests: Kani proves the Rust
meets the same statements for small values, and Proptest checks them on 10,000 random inputs
each.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/lending-amm/proofs/lending_amm_z3.py`. Exits non-zero unless every claim is
proven.
"""

import sys

from z3 import And, If, Int, Not, Solver, sat, unsat

U64_MAX = 2**64 - 1
BPS = 10_000
# The claims hold for any LP fee up to a whole (MAX_LP_FEE_BPS in src/config.rs is below it).
MAX_FEE_BPS = BPS
# MINIMUM_LIQUIDITY in src/config.rs.
MINIMUM_LIQUIDITY = 1_000


def u64(name):
    value = Int(name)
    return value, And(value >= 0, value <= U64_MAX)


def floor_div(name, numerator, denominator):
    """`numerator / denominator` as Rust's integer division: a quotient and its remainder."""
    quotient, remainder = Int(f"{name}_q"), Int(f"{name}_r")
    facts = And(
        quotient * denominator + remainder == numerator,
        remainder >= 0,
        remainder < denominator,
    )
    return quotient, facts


def ceil_div(name, numerator, denominator):
    """`numerator.div_ceil(denominator)`: floor((n + d - 1) / d)."""
    return floor_div(name, numerator + denominator - 1, denominator)


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

    # pricing::exact_in: fee = ceil(a x f / 10,000), net = a - fee,
    # out = floor(E_o x net / (E_i + net)).
    a, a_ok = u64("a")
    f = Int("f")
    fee, fee_facts = ceil_div("fee", a * f, BPS)
    ok &= prove(
        "the fee never rounds in the trader's favour, and by less than one unit",
        And(fee * BPS >= a * f, fee * BPS < a * f + BPS, fee <= a),
        a_ok,
        f >= 0,
        f <= MAX_FEE_BPS,
        fee_facts,
    )

    e_in, e_in_ok = u64("e_in")
    e_out, e_out_ok = u64("e_out")
    net = Int("net")
    out, out_facts = floor_div("out", e_out * net, e_in + net)
    ok &= prove(
        "a swap never lowers the product of the reserves, and never pays out a whole side",
        And(out < e_out, (e_in + a) * (e_out - out) >= e_in * e_out),
        a_ok,
        e_in_ok,
        e_in >= 1,
        e_out_ok,
        e_out >= 1,
        # net = a - fee, with 0 <= fee <= a (proved above).
        net >= 0,
        net <= a,
        out_facts,
    )

    # shares::first_deposit: shares = isqrt(o x l) - MINIMUM_LIQUIDITY, where
    # isqrt(p)^2 <= p < (isqrt(p) + 1)^2 (shares::isqrt, checked by Proptest and Kani).
    other, other_ok = u64("other")
    lent, lent_ok = u64("lent")
    root = Int("root")
    shares = root - MINIMUM_LIQUIDITY
    ok &= prove(
        "the first deposit's shares never exceed what the two amounts back",
        And(
            shares > 0,
            (shares + MINIMUM_LIQUIDITY) * (shares + MINIMUM_LIQUIDITY) <= other * lent,
        ),
        other_ok,
        lent_ok,
        root >= 0,
        root * root <= other * lent,
        (root + 1) * (root + 1) > other * lent,
        root > MINIMUM_LIQUIDITY,
    )

    # shares::later_deposit: shares = min(floor(m_o x N / R), floor(m_l x N / L)),
    # take_o = ceil(shares x R / N), take_l = ceil(shares x L / N).
    max_other, max_other_ok = u64("max_other")
    max_lent, max_lent_ok = u64("max_lent")
    reserve_other, reserve_other_ok = u64("reserve_other")
    reserve_lent, reserve_lent_ok = u64("reserve_lent")
    n, n_ok = u64("n")
    by_other, by_other_facts = floor_div("by_other", max_other * n, reserve_other)
    by_lent, by_lent_facts = floor_div("by_lent", max_lent * n, reserve_lent)
    minted = If(by_other <= by_lent, by_other, by_lent)
    take_other, take_other_facts = ceil_div("take_other", minted * reserve_other, n)
    take_lent, take_lent_facts = ceil_div("take_lent", minted * reserve_lent, n)
    ok &= prove(
        "a later deposit never mints more than its share of either side, nor takes more than offered",
        And(
            minted * reserve_other <= take_other * n,
            minted * reserve_lent <= take_lent * n,
            take_other <= max_other,
            take_lent <= max_lent,
        ),
        max_other_ok,
        max_lent_ok,
        reserve_other_ok,
        reserve_other >= 1,
        reserve_lent_ok,
        reserve_lent >= 1,
        n_ok,
        n >= 1,
        by_other_facts,
        by_lent_facts,
        minted >= 1,
        take_other_facts,
        take_lent_facts,
    )

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
