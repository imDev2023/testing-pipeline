"""Z3 proofs of the payouts' maths for every input.

Kani proves `settle`'s split in `src/payouts.rs` (its `proofs` module) for small retired
amounts only: its SAT back end is slow to relate a 64-bit division by 10,000 to its inputs.
Here Z3 proves the split for every u64 of retired tokens and every reward share a market may
choose ([Buy wall AMM: payouts and recipient
handovers](https://github.com/imDev2023/testing-pipeline/issues/51);
docs/spec/pool4-for-solana.md, "`settle`"):

- the code's split, `q × bps + floor(r × bps / 10,000)` with `q, r` the quotient and
  remainder of `retired / 10,000` (`books::share`), is exactly the spec's reward share
  `floor(retired × bps / 10,000)`;
- the reward share and the burn add up to the retired tokens, and neither is negative;
- anything retired burns something, since a reward share is at most `MAX_REWARD_SHARE_BPS`
  (3,000), below the whole;
- every intermediate value fits in 64 bits, so the code's checked arithmetic never refuses.

Each floor is given by its defining inequalities (`q = floor(n / d)` exactly when `q × d <= n
< (q + 1) × d`), over the integers.

The link between this model and the compiled Rust is checked by tests: Kani proves the same
statements for small inputs, Proptest checks them on 10,000 random cases, the invariant
fuzzer states the split independently after every `settle` through the router, and the
worked example's settle is reproduced exactly.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/buy-wall-amm/proofs/payouts_z3.py`. Exits non-zero unless every claim is
proven.
"""

import sys

from z3 import And, Implies, Int, Not, Solver, sat, unsat

BPS = 10_000
MAX_REWARD_SHARE_BPS = 3_000
U64 = 2**64


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


retired, bps, q, r, part, to_rewards, burned, spec = (
    Int(n) for n in ["retired", "bps", "q", "r", "part", "to_rewards", "burned", "spec"]
)
# The inputs: any u64 retired, any reward share a market may choose.
inputs = [0 <= retired, retired < U64, 0 <= bps, bps <= MAX_REWARD_SHARE_BPS]
# The code (`books::share`, then `payouts::settle`).
code = [
    retired == q * BPS + r,
    0 <= r,
    r < BPS,
    floor_of(part, r * bps, BPS),
    to_rewards == q * bps + part,
    burned == retired - to_rewards,
]
# The spec's reward share.
spec_share = floor_of(spec, retired * bps, BPS)

results = [
    prove(
        "the code's reward share is the spec's floor(retired x bps / 10,000)",
        to_rewards == spec,
        *inputs,
        *code,
        spec_share,
    ),
    prove(
        "the reward share and the burn add up to the retired tokens, neither negative",
        And(to_rewards + burned == retired, to_rewards >= 0, burned >= 0),
        *inputs,
        *code,
    ),
    prove(
        "anything retired burns something",
        Implies(retired > 0, burned > 0),
        *inputs,
        *code,
    ),
    prove(
        "every intermediate value fits in 64 bits",
        And(q * bps < U64, r * bps < U64, to_rewards < U64),
        *inputs,
        *code,
    ),
]

sys.exit(0 if all(results) else 1)
