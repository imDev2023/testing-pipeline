"""Z3 proofs of the buy wall AMM's pricing for every input.

Kani proves the pricing in `src/pricing.rs` (its `proofs` module) for small inputs only: its
SAT back end cannot relate a division's output to its inputs over the full range. Here Z3
proves the pricing's properties for every input, from the defining inequalities of each
floor and ceiling the code computes (`q = floor(n / d)` exactly when `q × d <= n < (q + 1)
× d`, and `c = ceil(n / d)` exactly when `(c - 1) × d < n <= c × d`), over the integers, or
over the reals where a property needs no integrality (every integer solution is a real one,
so a claim proved over the reals holds over the integers too). The ticket's three proofs
(docs/spec/pool4-for-solana.md, "Rules for both"; [Buy wall AMM: plain trading through the
router](https://github.com/imDev2023/testing-pipeline/issues/48)):

- outputs round down and the fee rounds up;
- the price moves no further than the input pays for: ledgers that covered the curve before
  a trade still cover it after;
- a buy sold straight back never returns more than it cost.

The link between this model and the compiled Rust is checked by tests: `U256::div_rem` is
proven exact (Kani for small inputs, Proptest on 10,000 random 256-bit pairs), Kani proves
the steps meet the same statements for small inputs, Proptest checks them on 10,000 random
markets each, and a property test checks `sell_step` against the spec's own order of
operations (`src/math.rs`, `src/pricing.rs`).

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/buy-wall-amm/proofs/pricing_z3.py`. Exits non-zero unless every claim is
proven.
"""

import sys

from z3 import And, Implies, Int, Real, Solver, Not, sat, unsat

Q = 2**64  # Q64.64's one
BPS = 10_000
MIN_FEE_BPS, MAX_FEE_BPS = 25, 300
DESIGNER_SHARE_BPS = SUITE_SHARE_BPS = 1_000


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


def floor_of(q, n, d):
    """`q = floor(n / d)` for `d > 0`."""
    return And(q * d <= n, n < (q + 1) * d)


def ceil_of(c, n, d):
    """`c = ceil(n / d)` for `d > 0`."""
    return And((c - 1) * d < n, n <= c * d)


results = []

# --- A buy step (from `s` up toward `target`, with `rem` lamports after the fee) ----------
L, s, t, rem, k, nxt, out, need = (Int(n) for n in ["L", "s", "t", "rem", "k", "next", "out", "need"])
positive = And(L > 0, s > 0, t > s, rem > 0)

# need = ceil(L × (t - s) / Q); below it, next = s + floor(rem × Q / L).
results.append(
    prove(
        "buy: a step that stops short of its target stays below it (rem < need => next < t)",
        nxt < t,
        positive,
        ceil_of(need, L * (t - s), Q),
        rem < need,
        floor_of(k, rem * Q, L),
        nxt == s + k,
    )
)
results.append(
    prove(
        "buy: the price moves no further than the input pays for ((next - s) × L <= rem × Q)",
        (nxt - s) * L <= rem * Q,
        positive,
        floor_of(k, rem * Q, L),
        nxt == s + k,
    )
)
results.append(
    prove(
        "buy: reaching the target uses no more than the input (rem >= need => need × Q >= (t - s) × L)",
        need * Q >= (t - s) * L,
        positive,
        ceil_of(need, L * (t - s), Q),
        rem >= need,
    )
)
results.append(
    prove(
        "buy: the output rounds down (out × next × s <= L × Q × (next - s))",
        out * nxt * s <= L * Q * (nxt - s),
        L > 0,
        s > 0,
        nxt >= s,
        floor_of(out, L * Q * (nxt - s), nxt * s),
    )
)

# --- A sell step (from `s` down toward `target`, with `a` token units) ---------------------
# P stands for L × Q, a positive integer, to keep the polynomials low in degree.
P, a, free, gross = (Int(n) for n in ["P", "a", "free", "gross"])
sell_positive = And(P > 0, t > 0, s > t, a > 0)
results.append(
    prove(
        "sell: a >= need exactly when ceil(P × s / (P + a × s)) <= t (the crossing test)",
        (a >= need) == (free <= t),
        sell_positive,
        ceil_of(need, P * (s - t), s * t),
        ceil_of(free, P * s, P + a * s),
    )
)
results.append(
    prove(
        "sell: the price falls no further than the input pays for (next × (P + a × s) >= P × s)",
        free * (P + a * s) >= P * s,
        sell_positive,
        ceil_of(free, P * s, P + a * s),
    )
)
results.append(
    prove(
        "sell: a step that stops short of its target stays above it (a < need => next > t)",
        free > t,
        sell_positive,
        ceil_of(need, P * (s - t), s * t),
        a < need,
        ceil_of(free, P * s, P + a * s),
    )
)
results.append(
    prove(
        "sell: the SOL freed rounds down (gross × Q <= L × (s - next))",
        gross * Q <= L * (s - nxt),
        L > 0,
        s >= nxt,
        floor_of(gross, L * (s - nxt), Q),
    )
)

# --- The fee ------------------------------------------------------------------------------
fee, amount, bps = Int("fee"), Int("amount"), Int("bps")
results.append(
    prove(
        "fee: ceil(amount × bps / 10,000) is at least the exact fee, never above the amount, and at least 1 on any input",
        And(fee * BPS >= amount * bps, fee <= amount, fee >= 1),
        amount >= 1,
        bps >= MIN_FEE_BPS,
        bps <= MAX_FEE_BPS,
        ceil_of(fee, amount * bps, BPS),
    )
)
designer, suite, wall, split = Int("designer"), Int("suite"), Int("wall"), Int("split")
results.append(
    prove(
        "fee split: the designer and suite shares fit in the fee, the wall's in the rest, and all four add up",
        And(
            designer + suite <= fee,
            wall <= fee - designer - suite,
            designer + suite + wall + (fee - designer - suite - wall) == fee,
        ),
        fee >= 0,
        split >= 0,
        split <= BPS,
        floor_of(designer, fee * DESIGNER_SHARE_BPS, BPS),
        floor_of(suite, fee * SUITE_SHARE_BPS, BPS),
        floor_of(wall, (fee - designer - suite) * split, BPS),
    )
)

# --- The ledgers still cover the curve after a trade (over the reals) ---------------------
# Before: tokens × s >= P (the curve holds P / s token units) and lamports × Q >= L × s.
rL, rs, rnext, ra, rgross, rout, rrem, tokens, lamports = (
    Real(n) for n in ["L", "s", "next", "a", "gross", "out", "rem", "tokens", "lamports"]
)
rP = rL * Q
covered_before = And(tokens * rs >= rP, lamports * Q >= rL * rs)
results.append(
    prove(
        "sell: the ledgers still cover the curve at the new price",
        And((tokens + ra) * rnext >= rP, (lamports - rgross) * Q >= rL * rnext),
        rL > 0,
        rs > 0,
        rnext > 0,
        rnext <= rs,
        ra >= 0,
        covered_before,
        rnext * (rP + ra * rs) >= rP * rs,
        rgross * Q <= rL * (rs - rnext),
    )
)
results.append(
    prove(
        "buy: the ledgers still cover the curve at the new price",
        And((tokens - rout) * rnext >= rP, (lamports + rrem) * Q >= rL * rnext),
        rL > 0,
        rs > 0,
        rnext >= rs,
        rout >= 0,
        covered_before,
        (rnext - rs) * rL <= rrem * Q,
        rout * rnext * rs <= rP * (rnext - rs),
    )
)

# --- A buy sold straight back never returns more than it cost (over the reals) ------------
# The buy: `rem` lamports after its fee move the price from s0 to s1 and pay `out` tokens.
# The sell of those `out` tokens moves it from s1 to s2 and frees `gross` lamports, of which
# the trader gets `gross - fee2 <= gross`. When the sell reaches its bound, s2 is that bound,
# which is at or below s0, and the step used `need` units with need >= P × (s1 - s2) / (s1 ×
# s2); the first claim covers both, since a crossing sell used all of `out` only when
# out >= need.
s0, s1, s2, outb = Real("s0"), Real("s1"), Real("s2"), Real("out")
trip = And(
    rL > 0,
    s0 > 0,
    s1 >= s0,
    s2 > 0,
    s2 <= s1,
    outb >= 0,
    rrem >= 0,
    (s1 - s0) * rL <= rrem * Q,
    outb * s1 * s0 <= rP * (s1 - s0),
    s2 * (rP + outb * s1) >= rP * s1,
    rgross * Q <= rL * (s1 - s2),
)
results.append(
    prove(
        "round trip: selling a buy's output back returns the price no lower than it started",
        s2 >= s0,
        trip,
    )
)
results.append(
    prove(
        "round trip: selling a buy's output back frees no more SOL than the buy put in after its fee",
        rgross <= rrem,
        trip,
    )
)

if not all(results):
    sys.exit(1)
print(f"all {len(results)} claims proven")
