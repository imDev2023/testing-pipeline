"""What the lending AMM's Z3 proofs share (`*_z3.py` beside this file): reading a constant from
`src/config.rs`, bounded integer variables, Rust's integer division as a quotient and remainder,
and proving a claim. Not a proof itself, so CI's loop over `*_z3.py` does not run it.
"""

import re
import sys
from pathlib import Path

from z3 import And, Int, Not, Solver, sat, unsat

U64_MAX = 2**64 - 1
U128_MAX = 2**128 - 1


def constant(name):
    """A constant's value as `src/config.rs` defines it, so the proofs follow any change there."""
    config = (Path(__file__).resolve().parent.parent / "src" / "config.rs").read_text()
    match = re.search(rf"pub const {name}: \w+ = ([\d_]+);", config)
    if not match:
        sys.exit(f"no {name} in src/config.rs")
    return int(match.group(1).replace("_", ""))


def bounded(name, high):
    value = Int(name)
    return value, And(value >= 0, value <= high)


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
