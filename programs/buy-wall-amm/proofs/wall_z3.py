"""Z3 proofs of the buy wall's maths for every input.

Kani proves the wall in `src/wall.rs`, `src/guard.rs` and `src/pricing.rs` (their `proofs`
modules) for small inputs only: its SAT back end cannot relate a division by a square-root
price to its inputs over the full range. Here Z3 proves the wall's properties for every
input, as `pricing_z3.py` does for the curve: each floor and ceiling the code computes is
given by its defining inequalities (`q = floor(n / d)` exactly when `q × d <= n < (q + 1) ×
d`, and `c = ceil(n / d)` exactly when `(c - 1) × d < n <= c × d`), over the integers, or
over the reals where a property needs no integrality. The ticket's three proofs
(docs/spec/pool4-for-solana.md, "A sell", "A buy", "`place_wall`"; [Buy wall AMM: the buy
wall](https://github.com/imDev2023/testing-pipeline/issues/50)):

- the two-step pricing rounds against the trader at the boundary: whichever side of the
  wall's top a trade starts and ends on, ledgers that covered the curve and the wall before
  it still cover both after it, and a buy that crosses the top sold straight back never
  returns more than it cost;
- the tip never exceeds `floor(work × fee_bps / 10,000)`;
- closing and placing the wall conserves the ledgers, never finds them short of the curve's
  own holdings, and leaves them covering the curve and the new wall, placed at `min(s, floor,
  last_slot_low)`, never above the price, the floor nor a nonzero last traded slot's lowest
  close (`POOL4-50`).

And the Book of Knowledge invariant WG-5 (`.bok/confirmed-invariants/CONFIRMED.md`):
`place_wall` cannot be called twice for two tips, since right after a placement there is no
work for a second one.

The curve of liquidity `L` holds `L × Q / s` token units and `L × s / Q` lamports at price
`s`; the wall of liquidity `W` and top `t` holds `W × Q × (t - s) / (t × s)` token units
below its top (none at or above it) and `W × min(s, t) / Q` lamports. A step along
liquidity `liq` from `s` meets its rounding through the inequalities `pricing_z3.py` proves
of `sell_step` and `buy_step` (the price moves no further than the input pays for, and the
output rounds down), which hold for both kinds of step: one that reaches its target and one
that stops short.

The link between this model and the compiled Rust is checked by tests: Kani proves the same
statements for small inputs, Proptest checks them on 10,000 random markets each, the
invariant fuzzer checks the ledgers after every step through the router, and the worked
example's numbers are reproduced exactly.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/buy-wall-amm/proofs/wall_z3.py`. Exits non-zero unless every claim is
proven.
"""

import sys
import time

from z3 import And, If, Implies, Int, Not, Or, Real, Solver, sat, unsat

Q = 2**64  # Q64.64's one
BPS = 10_000


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


def ceil_of(c, n, d):
    """`c = ceil(n / d)` for `d > 0`."""
    return And((c - 1) * d < n, n <= c * d)


results = []

# --- Coverage across the wall's top (over the reals) ---------------------------------------
# P = L × Q and V = W × Q, positive, keep the polynomials low in degree.
L, W, P, V, s, t, nxt, mid = (Real(n) for n in ["L", "W", "P", "V", "s", "t", "next", "mid"])
tokens, lamports, a1, a2, g1, g2, o1, o2 = (
    Real(n) for n in ["tokens", "lamports", "a1", "a2", "g1", "g2", "o1", "o2"]
)
positive = And(L > 0, W > 0, P == L * Q, V == W * Q, s > 0, t > 0, nxt > 0, a1 >= 0, a2 >= 0)


def wall_tokens(price):
    """`W × Q × (t - price) / (t × price)` below the top, 0 at or above it, times `t × price`."""
    return If(price < t, V * (t - price), 0)


def covered(tok, lam, price):
    """The ledgers cover the curve and the wall at `price`."""
    return And(
        tok * t * price >= P * t + wall_tokens(price),
        lam * Q >= L * price + W * If(price < t, price, t),
    )


def sell_step(liq_q, liq, frm, to, used, gross):
    """A sell step along `liq` from `frm` down to `to` using `used` units and freeing `gross`
    lamports: `to × (liq × Q + used × frm) >= liq × Q × frm` and `gross × Q <= liq × (frm -
    to)` (`pricing_z3.py`)."""
    return And(to <= frm, to * (liq_q + used * frm) >= liq_q * frm, gross * Q <= liq * (frm - to), gross >= 0)


def buy_step(liq_q, liq, frm, to, used, out):
    """A buy step along `liq` from `frm` up to `to` using `used` lamports and paying `out`
    units: `(to - frm) × liq <= used × Q` and `out × to × frm <= liq × Q × (to - frm)`."""
    return And(to >= frm, (to - frm) * liq <= used * Q, out * to * frm <= liq_q * (to - frm), out >= 0)


# A sell that starts at or above the top and ends at or below it: the curve alone to the
# top, then the curve and the wall together.
results.append(
    prove(
        "sell across the top: the ledgers still cover the curve and the wall",
        covered(tokens + a1 + a2, lamports - g1 - g2, nxt),
        positive,
        s >= t,
        t >= nxt,
        covered(tokens, lamports, s),
        sell_step(P, L, s, t, a1, g1),
        sell_step(P + V, L + W, t, nxt, a2, g2),
    )
)
# Entirely above the top: the curve alone.
results.append(
    prove(
        "sell above the top: the ledgers still cover the curve and the wall",
        covered(tokens + a1, lamports - g1, nxt),
        positive,
        s >= nxt,
        nxt >= t,
        covered(tokens, lamports, s),
        sell_step(P, L, s, nxt, a1, g1),
    )
)
# Entirely at or below the top: the curve and the wall together.
results.append(
    prove(
        "sell inside the wall: the ledgers still cover the curve and the wall",
        covered(tokens + a1, lamports - g1, nxt),
        positive,
        t >= s,
        s >= nxt,
        covered(tokens, lamports, s),
        sell_step(P + V, L + W, s, nxt, a1, g1),
    )
)
# A buy that starts at or below the top and ends at or above it: the curve and the wall to
# the top, then the curve alone.
results.append(
    prove(
        "buy across the top: the ledgers still cover the curve and the wall",
        covered(tokens - o1 - o2, lamports + a1 + a2, nxt),
        positive,
        s <= t,
        t <= nxt,
        covered(tokens, lamports, s),
        buy_step(P + V, L + W, s, t, a1, o1),
        buy_step(P, L, t, nxt, a2, o2),
    )
)
results.append(
    prove(
        "buy inside the wall: the ledgers still cover the curve and the wall",
        covered(tokens - o1, lamports + a1, nxt),
        positive,
        s <= nxt,
        nxt <= t,
        covered(tokens, lamports, s),
        buy_step(P + V, L + W, s, nxt, a1, o1),
    )
)
results.append(
    prove(
        "buy above the top: the ledgers still cover the curve and the wall",
        covered(tokens - o1, lamports + a1, nxt),
        positive,
        t <= s,
        s <= nxt,
        covered(tokens, lamports, s),
        buy_step(P, L, s, nxt, a1, o1),
    )
)

# --- A buy across the top sold straight back (over the reals) ------------------------------
# The buy: from s0 below the top, `need` lamports take the curve and the wall to the top and
# `rem` more take the curve on to s1, paying o1 + o2 units. The sell of all of them back:
# from s1 the curve alone to the top needs at least P × (s1 - t) / (s1 × t) units (or stops
# above the top with fewer), and the rest moves the curve and the wall to s2.
s0, s1, s2, need, rem, u1, u2, back1, back2 = (
    Real(n) for n in ["s0", "s1", "s2", "need", "rem", "u1", "u2", "back1", "back2"]
)
trip = And(
    positive,
    s0 > 0,
    s0 <= t,
    s1 >= t,
    buy_step(P + V, L + W, s0, t, need, o1),
    buy_step(P, L, t, s1, rem, o2),
    u1 >= 0,
    u2 >= 0,
    u1 + u2 == o1 + o2,
    Or(
        # The sell back reaches the top: the first step used at least what the curve needs.
        And(u1 * s1 * t >= P * (s1 - t), sell_step(P, L, s1, t, u1, back1), sell_step(P + V, L + W, t, s2, u2, back2)),
        # It stops above the top: one step along the curve, all units used.
        And(u2 == 0, back2 == 0, s2 >= t, sell_step(P, L, s1, s2, u1, back1)),
    ),
)
results.append(
    prove(
        "round trip across the top: selling a buy's output back returns the price no lower than it started",
        s2 >= s0,
        trip,
    )
)
results.append(
    prove(
        "round trip across the top: selling a buy's output back frees no more SOL than the buy put in after its fee",
        back1 + back2 <= need + rem,
        trip,
    )
)

# --- The tip (over the integers) -----------------------------------------------------------
# The tip cap is any non-negative amount, so the claim holds whatever `KEEPER_TIP_CAP` is set to.
work, fee_bps, idle, earned, tip, cap = (Int(n) for n in ["work", "fee_bps", "idle", "earned", "tip", "cap"])
results.append(
    prove(
        "tip: min(KEEPER_TIP_CAP, floor(work × fee_bps / 10,000), idle) never exceeds the fee earned on the work, the cap or what is idle",
        And(tip * BPS <= work * fee_bps, tip <= cap, tip <= idle, tip >= 0),
        cap >= 0,
        work >= 0,
        idle >= 0,
        fee_bps >= 0,
        fee_bps <= BPS,
        floor_of(earned, work * fee_bps, BPS),
        tip == If(earned < idle, If(earned < cap, earned, cap), If(idle < cap, idle, cap)),
    )
)

# --- Closing and placing the wall (over the integers) --------------------------------------
# Before: pool ledgers `Pt`, `Ps` covering the curve (P = L × Q, at price `s`) and the old
# wall (V = W × Q, top `t`); `m` is min(s, t). Step 2 closes the wall with floors `ct`, `cs`;
# step 3 keeps the curve's holdings rounded up, `Ct`, `Cs`; step 4 tips `tip` from what is
# idle; step 5 places W' = floor(idle × Q / top') at top' = min(s, floor, low), at or below
# s, where `low` is the last traded slot's lowest close and 0 caps nothing (`POOL4-50`).
# The floor is the one `place_in_slot` brought up to date for its slot, which `guard_z3.py`
# proves is at or below the last close `lc` (`POOL4-50`); the last close is the price, since
# only a swap moves either, so here the floor is assumed at or below `lc = s`.
Pt, Ps, R, I, ct, cs, Ct, Cs = (Int(n) for n in ["Pt", "Ps", "R", "I", "ct", "cs", "Ct", "Cs"])
iL, iW, iP, iV, i_s, i_t, m, top2, W2, floor_ = (
    Int(n) for n in ["L", "W", "P", "V", "s", "t", "m", "top2", "W2", "floor"]
)
dust_t, dust_s = Pt - ct - Ct, Ps - cs - Cs
I2 = I + cs + dust_s
I3 = I2 - tip
before = And(
    iL > 0,
    iW >= 0,
    iP == iL * Q,
    iV == iW * Q,
    i_s > 0,
    i_t > 0,
    m == If(i_s < i_t, i_s, i_t),
    Pt >= 0,
    Ps >= 0,
    R >= 0,
    I >= 0,
    # The ledgers cover the curve and the old wall.
    Pt * i_t * i_s >= iP * i_t + If(i_s < i_t, iV * (i_t - i_s), 0),
    Ps * Q >= iL * i_s + iW * m,
    # Step 2's floors and step 3's ceilings, as the code computes them.
    floor_of(cs, iW * m, Q),
    If(i_s < i_t, floor_of(ct, iV * (i_t - i_s), i_t * i_s), ct == 0),
    ceil_of(Ct, iP, i_s),
    ceil_of(Cs, iL * i_s, Q),
)
results.append(
    prove(
        "place_wall: the dust is never negative (the pool, less the closed wall, holds at least the curve's own holdings rounded up)",
        And(dust_t >= 0, dust_s >= 0),
        before,
    )
)
lc, low = Int("last_close"), Int("last_slot_low")
min_s_floor = If(i_s < floor_, i_s, floor_)
placed = And(
    before,
    tip >= 0,
    tip <= I2,
    floor_ > 0,
    low >= 0,
    # `wall::placement_top` as written.
    top2 == If(low == 0, min_s_floor, If(min_s_floor < low, min_s_floor, low)),
    floor_of(W2, I3 * Q, top2),
)
in_slot = And(placed, lc == i_s, floor_ <= lc)
Pt2, Ps2, R2, I_after = Ct, Cs + I3, R + ct + dust_t, 0
results.append(
    prove(
        "place_wall: closing and placing conserves the ledgers (the token ledgers keep their sum, the SOL ledgers lose exactly the tip)",
        And(Pt2 + R2 == Pt + R, Ps2 + I_after + tip == Ps + I),
        placed,
    )
)
results.append(
    prove(
        "place_wall: the new wall's top is at or below the price, the floor and a nonzero last traded slot's low, above 0, and the ledgers cover the curve and the new wall",
        And(
            top2 <= i_s,
            top2 <= floor_,
            Implies(low != 0, top2 <= low),
            top2 > 0,
            # The wall at or above its top holds no tokens, and W' × top' / Q lamports.
            Pt2 * i_s >= iP,
            Ps2 * Q >= iL * i_s + W2 * top2,
        ),
        placed,
    )
)

results.append(
    prove(
        "place_wall in a slot (POOL4-50): under the floor brought up to date, the new wall's top is the lower of the floor and a nonzero last traded slot's low, at or below the last close, the price at placement",
        And(
            top2 == If(Or(low == 0, floor_ <= low), floor_, low),
            top2 <= lc,
            top2 <= i_s,
        ),
        in_slot,
    )
)
results.append(
    prove(
        "place_wall in a slot (POOL4-50): a last traded slot's low below the floor, a dip bought back in its slot, caps the wall at the dip",
        top2 == low,
        in_slot,
        low > 0,
        low < floor_,
    )
)

# --- WG-5: place_wall cannot be called twice for two tips ----------------------------------
# Right after a placement, with no swap in between (only a swap moves the price or the curve,
# only a swap or a placement changes `idle_sol` or the wall, and a second placement's floor
# update changes nothing at the same time and never matters to step 1; the payouts touch
# neither, `src/payouts.rs`), a second `place` sees `idle_sol = 0` and the new wall's
# `converted = wall_sol_placed - floor(W' × min(s, top') / Q)`, with `wall_sol_placed =
# floor(W' × top' / Q)` (`sol_at(top)`). Since top' <= s, both floors are the same, so
# `converted` is 0 and step 1 refuses with `BelowThreshold` before any tip; and it stays 0 at
# any price at or above the new top, so only a trade that sells into the wall makes work.
WALL_THRESHOLD = 10_000_000
wsp, at_price, s_later, at_later = Int("wsp"), Int("at_price"), Int("s_later"), Int("at_later")


def converted(W, sol_now):
    """Step 1's `converted` for wall liquidity W: 0 with no wall, else `wall_sol_placed -
    sol_at(s)` saturating at 0."""
    return If(W > 0, If(wsp - sol_now > 0, wsp - sol_now, 0), 0)


again = And(
    placed,
    floor_of(wsp, W2 * top2, Q),
    floor_of(at_price, W2 * If(i_s < top2, i_s, top2), Q),
)
results.append(
    prove(
        "place_wall twice: right after a placement converted is 0 and idle_sol is 0, so the second call is refused (BelowThreshold) and tips nothing",
        And(
            converted(W2, at_price) == 0,
            And(I_after < WALL_THRESHOLD, converted(W2, at_price) < WALL_THRESHOLD),
        ),
        again,
    )
)
results.append(
    prove(
        "place_wall: the new wall's converted stays 0 at every price at or above its top",
        converted(W2, at_later) == 0,
        again,
        s_later >= top2,
        floor_of(at_later, W2 * If(s_later < top2, s_later, top2), Q),
    )
)

if not all(results):
    sys.exit(1)
print(f"all {len(results)} claims proven")
