"""Z3 proofs of the buy wall's guard for every input.

Kani proves the guard in `src/guard.rs` (its `proofs` module) only for prices below 2^12 in
the default tier: its steps divide a u128 by a constant, which CBMC finishes only for bounded
inputs, and the full-tier harnesses (prices up to `MAX_SQRT_PRICE`) are not recorded as
finishing. Trading prices sit near 2^64. Here Z3 proves the guard's properties for every
input, modelling `Guard::follow`, `Guard::open_floor`, `Guard::close_at` and the helpers they
call as written, over the integers, with each floor given by its defining inequalities (`q =
floor(n / d)` exactly when `q × d <= n < (q + 1) × d`) and every checked product given the
bound its `checked_mul` needs (docs/spec/pool4-for-solana.md, "After pricing" steps 1, 3 and
4 and "`place_wall`"; the Book of Knowledge invariants WG-1, WG-2 and WG-3,
`.bok/confirmed-invariants/CONFIRMED.md`, as `POOL4-50` restates them):

- WG-1: `follow` never returns `None` (which `handle_swap` would turn into a refusal of every
  swap, for good) for any reference, floor and last close up to `MAX_SQRT_PRICE` and any
  clock; in the slot it was last brought up to date in it changes nothing, the floor
  included; in a later slot the reference moves toward the last close, never past it, by at
  most `REF_STEP_BPS / 2` of itself, and the floor is brought up to date (`open_floor`).
- WG-2: `open_floor`, a slot's first update of the floor (a swap's, inside `follow`, or
  `place_wall`'s), never returns `None`; the floor ends at or below the last close, the price
  the slot opened at, at or below the larger of its old value and the reference, and rises by
  at most `FLOOR_CRAWL_BPS / 2` of itself; it is idempotent at one time, and a swap's update
  after `place_wall`'s in the same slot leaves the floor as `place_wall` left it. `close_at`
  changes only the last close, so a swap's own price never moves the floor: no pump lifts
  it and no dip drags it down in the swap's slot (SOS findings H003 and H004).
- WG-3: the state invariant `MIN_SQRT_PRICE <= floor <= reference <= MAX_SQRT_PRICE`,
  `MIN_SQRT_PRICE <= last_close <= MAX_SQRT_PRICE` holds at the seed and is kept by every
  swap (`follow`, then `close_at` at a price within the bounds, as `handle_swap` calls them)
  and every `place_wall` (`open_floor` in a slot later than `last_slot`), so every reachable
  state meets the preconditions of WG-1 and WG-2; and the floor `place_wall` places under is
  at or below the price at placement (the last close, since only a swap moves either), so the
  wall, placed at `min(s, floor)`, never divides by 0 and never sits above the price.

The clock rule: each of the guard's clocks is written as `max(stored, now)`: `follow` sets
`ref_time = max(ref_time, now)` and `open_floor` sets `floor_time = max(floor_time, now)`, so
neither clock ever moves backwards (SOS finding H009's hardening; the cap's `decay_time` is
`cap_z3.py`'s). The time claims below are stated for a forward clock (`now` at or after the
stored time, where the clock becomes `now`) and for an arbitrary clock, including one that
went backwards and the i64 extremes, where the same seconds are never counted twice.

The link between this model and the compiled Rust is checked by tests: Kani proves the same
statements for small prices, Proptest checks them over every price trading can reach
(`src/guard.rs`), and the invariant fuzzer checks the floor and the wall after every step
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


def open_floor(g, now, name):
    """`Guard::open_floor` as written (with the clock rule), on the guard `g` (expressions):
    the floor crawls toward the reference, never above it, then drops to the last close if
    that is lower. Returns the guard after, the crawl's facts, the condition for `Some`, and
    the crawl's elapsed seconds."""
    dt = elapsed(g.floor_time, now)
    crawl, facts, some = halved_rate(f"{name}_crawl", g.floor, FLOOR_CRAWL_BPS, minimum(dt, SECONDS_PER_DAY), SECONDS_PER_DAY)
    crawls = g.floor < g.reference
    capped = If(crawls, minimum(minimum(g.floor + crawl, U128 - 1), g.reference), g.floor)
    after = After(
        reference=g.reference,
        ref_time=g.ref_time,
        floor=minimum(capped, g.last_close),
        floor_time=clock(g.floor_time, now),
        last_slot=g.last_slot,
        last_close=g.last_close,
    )
    return after, facts, Or(Not(crawls), some), dt


FIELDS = ["reference", "ref_time", "floor", "floor_time", "last_slot", "last_close"]


def follow(g, slot, now, name):
    """`Guard::follow` as written (with the clock rule): in a slot later than `last_slot`, the
    reference steps toward the last close, then `open_floor` with that reference. Returns the
    guard after, the facts tying both quotients, the condition for `Some`, the step's elapsed
    seconds and the crawl's."""
    dt = elapsed(g.ref_time, now)
    step, facts, some = halved_rate(f"{name}_step", g.reference, REF_STEP_BPS, minimum(dt, REF_STEP_WINDOW), REF_STEP_WINDOW)
    later = slot > g.last_slot
    stepped = After(
        reference=toward(g.reference, g.last_close, step),
        ref_time=clock(g.ref_time, now),
        floor=g.floor,
        floor_time=g.floor_time,
        last_slot=slot,
        last_close=g.last_close,
    )
    opened, o_facts, o_some, floor_dt = open_floor(stepped, now, f"{name}_open")
    after = After(**{k: If(later, getattr(opened, k), getattr(g, k)) for k in FIELDS})
    return after, And(facts, o_facts), Or(Not(later), And(some, o_some)), dt, floor_dt


def close_at(g, price):
    """`Guard::close_at` as written: only the last close changes."""
    return After(**{**{k: getattr(g, k) for k in FIELDS}, "last_close": price})


def same(a, b, fields=FIELDS):
    return And(*[getattr(a, k) == getattr(b, k) for k in fields])


def i64(v):
    return And(I64_MIN <= v, v <= I64_MAX)


results = []
g = Guard("g")
slot, now = Int("slot"), Int("now")
inputs = [g.ranges(), 0 <= slot, slot < U64, i64(now)]
prices_ok = [g.reference <= MAX_SQRT_PRICE, g.last_close <= MAX_SQRT_PRICE, g.floor <= MAX_SQRT_PRICE]

# --- WG-1: follow ---------------------------------------------------------------------------
f1, f1_facts, f1_some, ref_dt, f1_floor_dt = follow(g, slot, now, "f1")
results.append(
    prove(
        "follow: never None for every reference, floor and last close up to MAX_SQRT_PRICE, any slots and any i64 clock",
        f1_some,
        *inputs,
        *prices_ok,
        f1_facts,
    )
)
results.append(
    prove(
        "follow: in the slot last brought up to date in, or an earlier one, nothing changes, the floor and its clock included",
        Implies(slot <= g.last_slot, same(f1, g)),
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
                f1.last_close == g.last_close,
            ),
        ),
        *inputs,
        *prices_ok,
        f1_facts,
    )
)
results.append(
    prove(
        "follow: in a later slot the floor ends at or below the last close (the price the slot opened at) and the new reference, rising by at most FLOOR_CRAWL_BPS / 2 of itself",
        Implies(
            And(slot > g.last_slot, g.floor <= g.reference),
            And(
                f1.floor <= g.last_close,
                f1.floor <= f1.reference,
                Implies(f1.floor > g.floor, (f1.floor - g.floor) * 2 * BPS <= g.floor * FLOOR_CRAWL_BPS),
            ),
        ),
        *inputs,
        *prices_ok,
        f1_facts,
    )
)
# Time, under the clock rule. For a forward clock each clock becomes now, and each step is
# charged exactly the seconds since that clock last moved; for any clock neither moves
# backwards, the seconds charged are never more than it moved, and a clock at or before the
# stored time moves nothing. Over any sequence of updates the seconds charged therefore sum
# to at most the time the clock truly advanced.
results.append(
    prove(
        "follow, forward clock (now >= ref_time, now >= floor_time): in a later slot both clocks become now and each step is charged min(now - its clock, its window) seconds (i64 saturation never changes it)",
        Implies(
            And(slot > g.last_slot, now >= g.ref_time, now >= g.floor_time),
            And(
                f1.ref_time == now,
                f1.floor_time == now,
                minimum(ref_dt, REF_STEP_WINDOW) == minimum(now - g.ref_time, REF_STEP_WINDOW),
                minimum(f1_floor_dt, SECONDS_PER_DAY) == minimum(now - g.floor_time, SECONDS_PER_DAY),
            ),
        ),
        *inputs,
        f1_facts,
    )
)
results.append(
    prove(
        "follow, any clock (clock rule): neither clock moves backwards, the seconds charged are at most how far each moved, and a clock at or before ref_time moves no reference",
        And(
            f1.ref_time >= g.ref_time,
            f1.floor_time >= g.floor_time,
            Implies(slot > g.last_slot, ref_dt <= f1.ref_time - g.ref_time),
            Implies(slot > g.last_slot, f1_floor_dt <= f1.floor_time - g.floor_time),
            Implies(now <= g.ref_time, f1.reference == g.reference),
        ),
        *inputs,
        *prices_ok,
        f1_facts,
    )
)

# --- WG-2: open_floor (place_wall's update, and a swap's inside follow) and close_at --------
o1, o1_facts, o1_some, o1_dt = open_floor(g, now, "o1")
results.append(
    prove(
        "open_floor: never None for every floor and reference up to MAX_SQRT_PRICE and any i64 clock",
        o1_some,
        *inputs,
        *prices_ok,
        o1_facts,
    )
)
results.append(
    prove(
        "open_floor: the floor ends at or below the last close and the larger of the old floor and the reference, rising by at most FLOOR_CRAWL_BPS / 2 of itself; only the floor and its clock change",
        And(
            o1.floor <= g.last_close,
            o1.floor <= maximum(g.floor, g.reference),
            Implies(g.floor <= g.reference, o1.floor <= g.reference),
            Implies(o1.floor > g.floor, (o1.floor - g.floor) * 2 * BPS <= g.floor * FLOOR_CRAWL_BPS),
            same(o1, g, ["reference", "ref_time", "last_slot", "last_close"]),
        ),
        *inputs,
        *prices_ok,
        o1_facts,
    )
)
# Idempotent at one time: `place_wall` twice in a slot, and a swap after `place_wall` in the
# same slot, leave the floor where the first update put it.
oo, oo_facts, _, _ = open_floor(o1, now, "oo")
results.append(
    prove(
        "open_floor: idempotent at one time (a second update at the same time changes nothing)",
        same(oo, o1),
        *inputs,
        *prices_ok,
        o1_facts,
        oo_facts,
    )
)
of, of_facts, of_some, _, _ = follow(o1, slot, now, "of")
results.append(
    prove(
        "place_wall then a swap in the same slot at the same time: the swap's follow is Some and leaves the floor and its clock as place_wall left them",
        And(of_some, of.floor == o1.floor, of.floor_time == o1.floor_time),
        *inputs,
        *prices_ok,
        g.floor <= g.reference,
        slot > g.last_slot,
        o1_facts,
        of_facts,
    )
)
results.append(
    prove(
        "open_floor, forward clock (now >= floor_time): floor_time becomes now and the crawl is charged min(now - floor_time, 86,400) seconds (i64 saturation never changes it)",
        Implies(
            now >= g.floor_time,
            And(
                o1.floor_time == now,
                minimum(o1_dt, SECONDS_PER_DAY) == minimum(now - g.floor_time, SECONDS_PER_DAY),
            ),
        ),
        *inputs,
        o1_facts,
    )
)
results.append(
    prove(
        "open_floor, any clock (clock rule): floor_time never moves backwards, the crawl's seconds are at most how far it moved, and a clock at or before floor_time crawls nothing",
        And(
            o1.floor_time >= g.floor_time,
            o1_dt <= o1.floor_time - g.floor_time,
            Implies(now <= g.floor_time, o1.floor == minimum(g.floor, g.last_close)),
        ),
        *inputs,
        *prices_ok,
        o1_facts,
    )
)
# A swap: `follow` at (slot, now), then `close_at` at the swap's price. The swap's own price
# never reaches the floor: swaps at any two prices leave the same floor, the one brought up
# to date with the price the slot opened at, so no pump lifts it and no dip drags it down.
price, p1, p2 = Int("price"), Int("p1"), Int("p2")
price_ok = [0 <= price, price < U128]
results.append(
    prove(
        "close_at: only the last close changes, to the price",
        And(close_at(g, price).last_close == price, same(close_at(g, price), g, FIELDS[:5])),
        *inputs,
        *price_ok,
    )
)
results.append(
    prove(
        "a swap's own price never moves the floor: swaps at any two prices leave the same floor and floor clock",
        And(
            close_at(f1, p1).floor == close_at(f1, p2).floor,
            close_at(f1, p1).floor_time == close_at(f1, p2).floor_time,
        ),
        *inputs,
        *prices_ok,
        f1_facts,
        0 <= p1,
        p1 < U128,
        0 <= p2,
        p2 < U128,
    )
)
# Two swaps in one slot: the second leaves the floor where the first did, whatever prices.
first = Guard("first")
f2, f2_facts, _, _, _ = follow(first, slot, now, "f2")
results.append(
    prove(
        "a second swap in the slot the first brought up to date leaves the floor, its clock and the reference as they are",
        same(f2, first, ["reference", "ref_time", "floor", "floor_time", "last_slot"]),
        first.ranges(),
        0 <= slot,
        slot < U64,
        i64(now),
        first.last_slot == slot,
        f2_facts,
    )
)

# --- WG-3: the guard's state invariant ------------------------------------------------------


def invariant(floor, reference, last_close):
    return And(
        MIN_SQRT_PRICE <= floor,
        floor <= reference,
        reference <= MAX_SQRT_PRICE,
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
closed = close_at(f1, price)
results.append(
    prove(
        "guard invariant: kept by every swap (follow, then close_at at a price within the bounds), any slot and clock, and follow is Some",
        And(f1_some, invariant(closed.floor, closed.reference, closed.last_close)),
        *inputs,
        invariant(g.floor, g.reference, g.last_close),
        MIN_SQRT_PRICE <= price,
        price <= MAX_SQRT_PRICE,
        f1_facts,
    )
)
results.append(
    prove(
        "guard invariant: kept by every place_wall (open_floor in a slot later than last_slot), any clock, and the floor it places under is at or below the price at placement (the last close)",
        And(
            o1_some,
            invariant(o1.floor, o1.reference, o1.last_close),
            o1.floor <= g.last_close,
        ),
        *inputs,
        invariant(g.floor, g.reference, g.last_close),
        o1_facts,
    )
)

print(f"{sum(results)} of {len(results)} claims proven")
sys.exit(0 if all(results) else 1)
