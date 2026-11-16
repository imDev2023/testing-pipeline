"""Z3 proofs of the lending AMM's removal maths for every u64 input
(docs/spec/lending-pool.md, "Removing"; `shares::removal` in `src/shares.rs`).

Kani proves the same claims in `src/shares.rs` for small values, and Proptest checks them on
10,000 random inputs each, with the real cToken valuation; here Z3 proves them over the
integers for every input, modelling each division as Rust computes it, by its quotient and
remainder, and proving each claim by showing its negation unsatisfiable, as
`lending_amm_z3.py` does (docs/spec/README.md, "Test layers" 2).

The cTokens' value is klend's `floor(k x S_total_sf / (S_ctoken x 2^60))`, which for any
fixed reserve is `floor(k x a / b)` for some `a >= 0` and `b >= 1`; the claims are proven for
every such `a` and `b`, so for every reserve.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/lending-amm/proofs/removal_z3.py`. Exits non-zero unless every claim is
proven.
"""

import sys

from z3 import And, If, Int, Not, Solver, sat, unsat

U64_MAX = 2**64 - 1
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

    # shares::removal: part = floor(X x lp / N), with N = lp_supply + MINIMUM_LIQUIDITY and
    # 1 <= lp <= lp_supply.
    lp, lp_ok = u64("lp")
    lp_supply, lp_supply_ok = u64("lp_supply")
    whole, whole_ok = u64("whole")
    n = lp_supply + MINIMUM_LIQUIDITY
    part, part_facts = floor_div("part", whole * lp, n)
    ok &= prove(
        "a removal never pays more than the burned shares' part of a side, and leaves the "
        "locked minimum's part of it",
        And(
            part * n <= whole * lp,
            part <= whole,
            (whole - part) * n >= whole * MINIMUM_LIQUIDITY,
        ),
        lp_ok,
        lp >= 1,
        lp_supply_ok,
        lp <= lp_supply,
        whole_ok,
        part_facts,
    )

    # Adding, then removing the shares minted at once. shares::later_deposit on the market's
    # reserves R and L = B + V(c), with share count N:
    #   s = min(floor(m_o x N / R), floor(m_l x N / L)), o = ceil(s x R / N), l = ceil(s x L / N).
    # Then shares::removal of s on R + o, B + l, c, with share count N + s:
    #   floor((R + o) s / (N + s)), floor((B + l) s / (N + s)), k = floor(c s / (N + s)),
    # the cTokens' part worth V(k) = floor(k a / b).
    max_other, max_other_ok = u64("max_other")
    max_lent, max_lent_ok = u64("max_lent")
    r, r_ok = u64("r")
    b_, b_ok = u64("buffer")
    c, c_ok = u64("ctokens")
    n0, n0_ok = u64("n")
    a = Int("a")
    b = Int("b")
    value_c, value_c_facts = floor_div("value_c", c * a, b)
    lent = b_ + value_c
    by_other, by_other_facts = floor_div("by_other", max_other * n0, r)
    by_lent, by_lent_facts = floor_div("by_lent", max_lent * n0, lent)
    s = If(by_other <= by_lent, by_other, by_lent)
    take_other, take_other_facts = ceil_div("take_other", s * r, n0)
    take_lent, take_lent_facts = ceil_div("take_lent", s * lent, n0)
    n1 = n0 + s
    out_other, out_other_facts = floor_div("out_other", (r + take_other) * s, n1)
    out_buffer, out_buffer_facts = floor_div("out_buffer", (b_ + take_lent) * s, n1)
    out_ctokens, out_ctokens_facts = floor_div("out_ctokens", c * s, n1)
    out_value, out_value_facts = floor_div("out_value", out_ctokens * a, b)
    deposit = And(
        max_other_ok,
        max_lent_ok,
        r_ok,
        r >= 1,
        b_ok,
        c_ok,
        n0_ok,
        n0 >= MINIMUM_LIQUIDITY,
        a >= 0,
        b >= 1,
        value_c_facts,
        lent >= 1,
        by_other_facts,
        by_lent_facts,
        s >= 1,
        take_other_facts,
        take_lent_facts,
    )
    removal = And(out_other_facts, out_buffer_facts, out_ctokens_facts, out_value_facts)
    ok &= prove(
        "adding then removing at once never returns more of the other side than was put in",
        out_other <= take_other,
        deposit,
        removal,
    )
    ok &= prove(
        "adding then removing at once never returns more of the lent side than was put in, "
        "the cTokens' part at its value",
        out_buffer + out_value <= take_lent,
        deposit,
        removal,
    )

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
