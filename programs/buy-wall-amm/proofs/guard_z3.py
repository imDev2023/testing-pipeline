"""Z3 proofs of the buy wall's guard for every input.

Kani proves the guard in `src/guard.rs` (its `proofs` module) only for prices below 2^12 in
the default tier: its steps divide a u128 by a constant, which CBMC finishes only for bounded
inputs, and the full-tier harnesses (prices up to `MAX_SQRT_PRICE`) are not recorded as
finishing. Trading prices sit near 2^64. Here Z3 proves the guard's properties for every
input, modelling `Guard::follow`, `Guard::close_at` and the helpers they call as written, over
the integers, with each floor given by its defining inequalities (`q = floor(n / d)` exactly
when `q × d <= n < (q + 1) × d`) and every checked product given the bound its `checked_mul`
needs (docs/spec/pool4-for-solana.md, "After pricing" steps 1, 3 and 4; the Book of Knowledge
invariants WG-1, WG-2 and WG-3, `.bok/confirmed-invariants/CONFIRMED.md`):

- WG-1: `follow` never returns `None` (which `handle_swap` would turn into a refusal of every
  swap, for good) for any reference and last close up to `MAX_SQRT_PRICE` and any clock; in the
  slot it was last brought up to date in it changes nothing; in a later slot the reference
  moves toward the last close, never past it, by at most `REF_STEP_BPS / 2` of itself.
- WG-2: `close_at` never returns `None`; the floor ends at or below the swap's price, at or
  below the larger of its old value and the reference, and rises by at most `FLOOR_CRAWL_BPS /
  2` of itself; and the swap's price cannot lift it: the floor at any price is the floor at the
  highest price, capped by the price, so a pump earns exactly the floor a one-lamport trade
  would.
- WG-3: the state invariant `MIN_SQRT_PRICE <= floor <= reference <= MAX_SQRT_PRICE`, `floor
  <= last_close`, `MIN_SQRT_PRICE <= last_close <= MAX_SQRT_PRICE` holds at the seed and is
  kept by every swap (`follow`, then `close_at` at a price within the bounds, as `handle_swap`
  calls them), so every reachable state meets the preconditions of WG-1 and WG-2, and the wall,
  placed at `min(s, floor)`, never divides by 0.

ASSUMPTION, the clock rule: this model writes each of the guard's clocks as `max(stored,
now)`: `follow` sets `ref_time = max(ref_time, now)` and `close_at` sets `floor_time =
max(floor_time, now)`, so neither clock ever moves backwards. That is the rule a separate fix
brings to `src/guard.rs` (and to the cap's `decay_time`, `cap_z3.py`); today the code writes
`now` unconditionally. The time claims below are stated for a forward clock (`now` at or after
the stored time, where both rules agree: the clock becomes `now`) and for an arbitrary clock,
including one that went backwards and the i64 extremes; against today's code the arbitrary-clock
claims fail (a backward clock rewinds the stored time, so the same seconds are counted twice).
Every other claim reads no stored time back, so it holds under either rule.

The link between this model and the compiled Rust is checked by tests: Kani proves the same
statements for small prices, Proptest checks them over every price trading can reach
(`src/guard.rs`), and the invariant fuzzer checks the floor against the price after every step
through the router.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/buy-wall-amm/proofs/guard_z3.py`. Exits non-zero unless every claim is
proven.
"""

import sys
import time

from z3 import And, If, Implies, Int, Not, Or, Solver, sat, unsat

U64 = 2**64
U128 = 2**128
I64_MIN, I64_MAX = -(2**63), 2**63 - 1
BPS = 10_000
SECONDS_PER_DAY = 86_400
FLOOR_CRAWL_BPS = 400
REF_STEP_BPS = 200
REF_STEP_WINDOW = 12
MIN_SQRT_PRICE = 2**32
MAX_SQRT_PRICE = 2**96
MIN_OPENING_SQRT_PRICE = 2**40
MAX_OPENING_SQRT_PRICE = 2**88


def prove(name, claim, *assumptions):
    start = time.perf_counter()
    solver = Solver()
    solver.set("timeout", 600_000)
    solver.add(*assumptions)
    solver.add(Not(claim))
    result = solver.check()
    seconds = time.perf_counter() - start
    if result == unsat:
        print(f"PROVEN  {name} ({seconds:.2f} s)")
        return True
    if result == sat:
        print(f"FAILED  {name} ({seconds:.2f} s): counterexample {solver.model()}")
    else:
        print(f"UNKNOWN {name} ({seconds:.2f} s, {solver.reason_unknown()})")
    return False


def floor_of(q, n, d):
    """`q = floor(n / d)` for `d > 0`."""
    return And(q * d <= n, n < (q + 1) * d)


def maximum(a, b):
    return If(a >= b, a, b)


def minimum(a, b):
    return If(a <= b, a, b)


def elapsed(then, now):
    """`u128::try_from(now.saturating_sub(then)).unwrap_or(0)`: i64 saturation, then 0 for a
    negative difference."""
    d = now - then
    saturated = If(d > I64_MAX, I64_MAX, If(d < I64_MIN, I64_MIN, d))
    return If(saturated < 0, 0, saturated)


def halved_rate(name, value, bps, dt, window):
    """`halved_rate` as written: `value.checked_mul(bps)?.checked_mul(dt)?.checked_div(2 ×
    10,000 × window)`. Returns the quotient (a fresh variable tied to it), its facts, and the
    condition every checked step needs (the denominator is a constant that fits)."""
    rate = Int(name)
    numerator = value * bps * dt
    some = And(value * bps < U128, numerator < U128)
    return rate, floor_of(rate, numerator, 2 * BPS * window), some


def toward(start, to, by):
    """`toward` as written, with u128 saturation."""
    up = minimum(minimum(start + by, U128 - 1), to)
    down = maximum(maximum(start - by, 0), to)
    return If(to >= start, up, down)


def clock(stored, now):
    """The clock rule this model assumes (see the docstring): never backwards."""
    return maximum(stored, now)


class Guard:
    def __init__(self, name):
        self.reference = Int(f"{name}_reference")
        self.ref_time = Int(f"{name}_ref_time")
        self.floor = Int(f"{name}_floor")
        self.floor_time = Int(f"{name}_floor_time")
        self.last_slot = Int(f"{name}_last_slot")
        self.last_close = Int(f"{name}_last_close")

    def ranges(self):
        """Every field in its Rust type's range."""
        return And(
            *[0 <= v for v in [self.reference, self.floor, self.last_close, self.last_slot]],
            self.reference < U128,
            self.floor < U128,
            self.last_close < U128,
            self.last_slot < U64,
            *[And(I64_MIN <= t, t <= I64_MAX) for t in [self.ref_time, self.floor_time]],
        )


class After:
    """A guard's fields after a step, as expressions."""

    def __init__(self, **fields):
        self.__dict__.update(fields)


def follow(g, slot, now, name):
    """`Guard::follow` as written (with the clock rule). Returns the guard after, the facts
    tying the step's quotient, the condition for `Some`, and the step's elapsed seconds."""
    dt = elapsed(g.ref_time, now)
    step, facts, some = halved_rate(f"{name}_step", g.reference, REF_STEP_BPS, minimum(dt, REF_STEP_WINDOW), REF_STEP_WINDOW)
    later = slot > g.last_slot
    after = After(
        reference=If(later, toward(g.reference, g.last_close, step), g.reference),
        ref_time=If(later, clock(g.ref_time, now), g.ref_time),
        floor=g.floor,
        floor_time=g.floor_time,
        last_slot=If(later, slot, g.last_slot),
        last_close=g.last_close,
    )
    return after, facts, Or(Not(later), some), step, dt


def close_at(g, price, now, name):
    """`Guard::close_at` as written (with the clock rule). Returns the guard after, the floor
    before the price caps it, the crawl's facts, the condition for `Some`, and the crawl's
    elapsed seconds."""
    dt = elapsed(g.floor_time, now)
    crawl, facts, some = halved_rate(f"{name}_crawl", g.floor, FLOOR_CRAWL_BPS, minimum(dt, SECONDS_PER_DAY), SECONDS_PER_DAY)
    crawls = g.floor < g.reference
    capped = If(crawls, minimum(minimum(g.floor + crawl, U128 - 1), g.reference), g.floor)
    after = After(
        reference=g.reference,
        ref_time=g.ref_time,
        floor=minimum(capped, price),
        floor_time=clock(g.floor_time, now),
        last_slot=g.last_slot,
        last_close=price,
    )
    return after, capped, facts, Or(Not(crawls), some), dt


def i64(v):
    return And(I64_MIN <= v, v <= I64_MAX)


results = []
g = Guard("g")
slot, now = Int("slot"), Int("now")
inputs = [g.ranges(), 0 <= slot, slot < U64, i64(now)]
prices_ok = [g.reference <= MAX_SQRT_PRICE, g.last_close <= MAX_SQRT_PRICE, g.floor <= MAX_SQRT_PRICE]

# --- WG-1: follow ---------------------------------------------------------------------------
f1, f1_facts, f1_some, step, ref_dt = follow(g, slot, now, "f1")
results.append(
    prove(
        "follow: never None for every reference and last close up to MAX_SQRT_PRICE, any slots and any i64 clock",
        f1_some,
        *inputs,
        *prices_ok,
        f1_facts,
    )
)
results.append(
    prove(
        "follow: in the slot last brought up to date in, or an earlier one, nothing changes",
        Implies(
            slot <= g.last_slot,
            And(f1.reference == g.reference, f1.ref_time == g.ref_time, f1.last_slot == g.last_slot),
        ),
        *inputs,
        f1_facts,
    )
)
results.append(
    prove(
        "follow: in a later slot the reference moves toward the last close, never past it, by at most REF_STEP_BPS / 2 of itself",
        Implies(
            slot > g.last_slot,
            And(
                minimum(g.reference, g.last_close) <= f1.reference,
                f1.reference <= maximum(g.reference, g.last_close),
                (f1.reference - g.reference) * 2 * BPS <= g.reference * REF_STEP_BPS,
                (g.reference - f1.reference) * 2 * BPS <= g.reference * REF_STEP_BPS,
                f1.last_slot == slot,
            ),
        ),
        *inputs,
        *prices_ok,
        f1_facts,
    )
)
# Time, under the clock rule. For a forward clock the reference's clock becomes now, and the
# step is charged exactly the seconds since it last moved; for any clock it never moves
# backwards, the seconds charged are never more than it moved, and a clock at or before the
# stored time moves nothing. Over any sequence of swaps the seconds charged therefore sum to
# at most the time the clock truly advanced.
results.append(
    prove(
        "follow, forward clock (now >= ref_time): ref_time becomes now and the step is charged min(now - ref_time, REF_STEP_WINDOW) seconds (i64 saturation never changes it)",
        Implies(
            And(slot > g.last_slot, now >= g.ref_time),
            And(
                f1.ref_time == now,
                minimum(ref_dt, REF_STEP_WINDOW) == minimum(now - g.ref_time, REF_STEP_WINDOW),
            ),
        ),
        *inputs,
        f1_facts,
    )
)
results.append(
    prove(
        "follow, any clock (clock rule): ref_time never moves backwards, the seconds charged are at most how far it moved, and a clock at or before ref_time moves nothing",
        And(
            f1.ref_time >= g.ref_time,
            Implies(slot > g.last_slot, ref_dt <= f1.ref_time - g.ref_time),
            Implies(now <= g.ref_time, f1.reference == g.reference),
        ),
        *inputs,
        *prices_ok,
        f1_facts,
    )
)

# --- WG-2: close_at -------------------------------------------------------------------------
price = Int("price")
c1, capped, c1_facts, c1_some, floor_dt = close_at(g, price, now, "c1")
price_ok = [0 <= price, price < U128]
results.append(
    prove(
        "close_at: never None for every floor and reference up to MAX_SQRT_PRICE, any price and any i64 clock",
        c1_some,
        *inputs,
        *prices_ok,
        *price_ok,
        c1_facts,
    )
)
results.append(
    prove(
        "close_at: the floor ends at or below the price and the larger of the old floor and the reference, rising by at most FLOOR_CRAWL_BPS / 2 of itself",
        And(
            c1.floor <= price,
            c1.floor <= maximum(g.floor, g.reference),
            Implies(c1.floor > g.floor, (c1.floor - g.floor) * 2 * BPS <= g.floor * FLOOR_CRAWL_BPS),
            c1.last_close == price,
        ),
        *inputs,
        *prices_ok,
        *price_ok,
        c1_facts,
    )
)
# Independence from the swap's price: two closes of the same guard at the same time, one at
# any price and one at u128::MAX (the highest a pump could reach).
c_top, _, top_facts, _, _ = close_at(g, U128 - 1, now, "c_top")
p1, p2 = Int("p1"), Int("p2")
c_p1, _, p1_facts, _, _ = close_at(g, p1, now, "c_p1")
c_p2, _, p2_facts, _, _ = close_at(g, p2, now, "c_p2")
results.append(
    prove(
        "close_at: the floor at any price is the floor at the highest price capped by the price, so no pump lifts it",
        c1.floor == minimum(c_top.floor, price),
        *inputs,
        *prices_ok,
        *price_ok,
        c1_facts,
        top_facts,
    )
)
results.append(
    prove(
        "close_at: a higher price never gives a lower floor, and every price at or above max(floor, reference) gives the same floor",
        And(
            Implies(p1 <= p2, c_p1.floor <= c_p2.floor),
            Implies(
                And(p1 >= maximum(g.floor, g.reference), p2 >= maximum(g.floor, g.reference)),
                c_p1.floor == c_p2.floor,
            ),
        ),
        *inputs,
        *prices_ok,
        0 <= p1,
        p1 < U128,
        0 <= p2,
        p2 < U128,
        p1_facts,
        p2_facts,
    )
)
results.append(
    prove(
        "close_at, forward clock (now >= floor_time): floor_time becomes now and the crawl is charged min(now - floor_time, 86,400) seconds (i64 saturation never changes it)",
        Implies(
            now >= g.floor_time,
            And(
                c1.floor_time == now,
                minimum(floor_dt, SECONDS_PER_DAY) == minimum(now - g.floor_time, SECONDS_PER_DAY),
            ),
        ),
        *inputs,
        *price_ok,
        c1_facts,
    )
)
results.append(
    prove(
        "close_at, any clock (clock rule): floor_time never moves backwards, the crawl's seconds are at most how far it moved, and a clock at or before floor_time crawls nothing",
        And(
            c1.floor_time >= g.floor_time,
            floor_dt <= c1.floor_time - g.floor_time,
            Implies(now <= g.floor_time, c1.floor == minimum(g.floor, price)),
        ),
        *inputs,
        *prices_ok,
        *price_ok,
        c1_facts,
    )
)

# --- WG-3: the guard's state invariant ------------------------------------------------------


def invariant(floor, reference, last_close):
    return And(
        MIN_SQRT_PRICE <= floor,
        floor <= reference,
        reference <= MAX_SQRT_PRICE,
        floor <= last_close,
        MIN_SQRT_PRICE <= last_close,
        last_close <= MAX_SQRT_PRICE,
    )


s0 = Int("s0")
results.append(
    prove(
        "guard invariant: the seed (reference = floor = last_close = the opening price) meets it",
        invariant(s0, s0, s0),
        MIN_OPENING_SQRT_PRICE <= s0,
        s0 <= MAX_OPENING_SQRT_PRICE,
    )
)
# A swap: `follow` at (slot, now), then `close_at` of what it returned at the swap's price.
followed = Guard("followed")
closed, _, closed_facts, closed_some, _ = close_at(followed, price, now, "closed")
results.append(
    prove(
        "guard invariant: kept by every swap (follow, then close_at at a price within the bounds), any slot and clock, and both steps are Some",
        And(
            f1_some,
            closed_some,
            invariant(closed.floor, closed.reference, closed.last_close),
        ),
        *inputs,
        invariant(g.floor, g.reference, g.last_close),
        MIN_SQRT_PRICE <= price,
        price <= MAX_SQRT_PRICE,
        f1_facts,
        # The guard `follow` returns, field by field.
        followed.reference == f1.reference,
        followed.ref_time == f1.ref_time,
        followed.floor == f1.floor,
        followed.floor_time == f1.floor_time,
        followed.last_slot == f1.last_slot,
        followed.last_close == f1.last_close,
        closed_facts,
    )
)

print(f"{sum(results)} of {len(results)} claims proven")
sys.exit(0 if all(results) else 1)
