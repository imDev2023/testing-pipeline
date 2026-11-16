"""Z3 proofs of the buy wall AMM's inventory cap for every input.

Kani proves the decay credit and the ratchet in `src/cap.rs` (its `proofs` module) for
bounded inputs in the default tier and for every input in the full tier; the trim divides by
the price with `U256::div_rem`, whose loop runs once per quotient bit, so Kani checks it in
the full tier only. Here Z3 proves the cap's properties for every input, from the defining
inequalities of each floor and ceiling the code computes (`q = floor(n / d)` exactly when
`q × d <= n < (q + 1) × d`, and `c = ceil(n / d)` exactly when `(c - 1) × d < n <= c × d`),
over the integers. The ticket's proofs (docs/spec/pool4-for-solana.md, "After pricing" steps
5 and 6; [Buy wall AMM: the inventory cap](https://github.com/imDev2023/testing-pipeline/issues/49)):

- the decay credit never exceeds one day's allowance;
- the cap never rises and never falls below the cap floor;
- a trim never changes `sqrt_price` (the trim's inputs include the price and its outputs do
  not: `cap::trim` returns only a liquidity and two amounts, and `Inventory::after_swap`
  copies the price through, which Proptest and Kani's full tier check);
- after a trim the pool ledgers still cover the curve.

The link between this model and the compiled Rust is checked by tests: `U256::div_rem` is
proven exact (`src/math.rs`), Proptest checks `Inventory::after_swap` against the spec's
formulas written out on 10,000 random reachable markets (`src/cap.rs`), and the worked
example's numbers are reproduced through the router (`tests/cap.rs`).

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/buy-wall-amm/proofs/cap_z3.py`. Exits non-zero unless every claim is proven.
"""

import sys

from z3 import And, If, Int, Not, Or, Solver, sat, unsat

Q = 2**64  # Q64.64's one
SECONDS_PER_DAY = 86_400
DECAY_CREDIT_WINDOW = 86_400
MIN_LIQUIDITY = 1_000_000


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


def maximum(a, b):
    return If(a >= b, a, b)


def minimum(a, b):
    return If(a <= b, a, b)


results = []

# --- Step 5: the decay credit -------------------------------------------------------------
credit, per_day, elapsed, accrued = (Int(n) for n in ["credit", "per_day", "elapsed", "accrued"])
limit = per_day * DECAY_CREDIT_WINDOW
results.append(
    prove(
        "credit: never above one day's allowance, and never falls",
        And(accrued <= limit, Or(accrued >= credit, credit > limit)),
        per_day >= 0,
        credit >= 0,
        elapsed >= 0,
        accrued == minimum(credit + per_day * elapsed, limit),
    )
)

# --- Step 6: the ratchet (held < cap) ------------------------------------------------------
cap, held, floor, allowance, new_cap = (Int(n) for n in ["cap", "held", "floor", "allowance", "new_cap"])
ratchet = [
    floor >= 0,
    floor <= cap,
    held >= 0,
    held < cap,
    credit >= 0,
    floor_of(allowance, credit, SECONDS_PER_DAY),
    new_cap == maximum(maximum(held, maximum(cap - allowance, 0)), floor),
]
results.append(prove("ratchet: the cap never rises", new_cap <= cap, *ratchet))
results.append(prove("ratchet: the cap never falls below its floor", new_cap >= floor, *ratchet))
results.append(prove("ratchet: the cap never falls below what the curve holds", new_cap >= held, *ratchet))
results.append(
    prove(
        "ratchet: the credit spent, 86,400 per unit fallen, is never more than the credit",
        (cap - new_cap) * SECONDS_PER_DAY <= credit,
        *ratchet,
    )
)
# With credit capped at a day's allowance, one swap lowers the cap by at most a day's decay.
results.append(
    prove(
        "ratchet: one swap lowers the cap by at most one day's decay",
        cap - new_cap <= per_day,
        *ratchet,
        per_day >= 0,
        credit <= per_day * DECAY_CREDIT_WINDOW,
    )
)

# --- Step 6: the trim (held > cap) ---------------------------------------------------------
# Products of two unknowns are fresh variables tied to their factors, as in pricing_z3.py.
s, L, pool_tokens, pool_sol = (Int(n) for n in ["s", "L", "pool_tokens", "pool_sol"])
at_cap, new_L, kept_tokens, curve_sol, kept_sol = (
    Int(n) for n in ["at_cap", "new_L", "kept_tokens", "curve_sol", "kept_sol"]
)
tokens, sol = Int("tokens"), Int("sol")
Ls, newLs, cap_s = Int("Ls"), Int("newLs"), Int("cap_s")
trim = [
    s > 0,
    L >= MIN_LIQUIDITY,
    cap >= 0,
    Ls == L * s,
    newLs == new_L * s,
    cap_s == cap * s,
    # The ledgers cover the curve before the trim: L × Q / s <= pool_tokens and L × s / Q <=
    # pool_sol.
    L * Q <= pool_tokens * s,
    Ls <= pool_sol * Q,
    floor_of(held, L * Q, s),
    held > cap,
    floor_of(at_cap, cap_s, Q),
    new_L == maximum(at_cap, MIN_LIQUIDITY),
    new_L < L,
    ceil_of(kept_tokens, new_L * Q, s),
    floor_of(curve_sol, Ls, Q),
    ceil_of(kept_sol, newLs, Q),
    tokens == maximum(held - kept_tokens, 0),
    sol == maximum(curve_sol - kept_sol, 0),
]
results.append(
    prove(
        "trim: never takes more than the pool ledgers hold",
        And(tokens <= pool_tokens, sol <= pool_sol, tokens >= 0, sol >= 0),
        *trim,
    )
)
results.append(
    prove(
        "trim: the pool ledgers still cover the curve's tokens",
        new_L * Q <= (pool_tokens - tokens) * s,
        *trim,
    )
)
results.append(
    prove(
        "trim: the pool ledgers still cover the curve's SOL",
        newLs <= (pool_sol - sol) * Q,
        *trim,
    )
)
results.append(
    prove(
        "trim: liquidity falls, never below MIN_LIQUIDITY",
        And(new_L < L, new_L >= MIN_LIQUIDITY),
        *trim,
    )
)
held_after = Int("held_after")
results.append(
    prove(
        "trim: the curve then holds no more than the cap, unless MIN_LIQUIDITY stopped it",
        Or(held_after <= cap, new_L == MIN_LIQUIDITY),
        *trim,
        floor_of(held_after, new_L * Q, s),
    )
)

print(f"{sum(results)} of {len(results)} claims proven")
sys.exit(0 if all(results) else 1)
