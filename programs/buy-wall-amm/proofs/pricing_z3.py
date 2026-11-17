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

And two of the Book of Knowledge invariants (`.bok/confirmed-invariants/CONFIRMED.md`):

- PM-4: a reachable trade never refuses with `Overflow`, including through the widest wall
  `place_wall` can place (W near 2^96 at a top of MIN_SQRT_PRICE, with L at MIN_LIQUIDITY):
  every checked product, narrowing and sum in the steps and the walk fits;
- PM-6: a sell bought straight back never profits, without a wall and with one, whichever side
  of its top the sell starts on: the price returns no higher and no more units come back than
  were sold (fewer, once both fees are paid).

The link between this model and the compiled Rust is checked by tests: `U256::div_rem` is
proven exact (Z3 for every 256-bit pair, `math_z3.py`; Kani for small inputs; Proptest on
10,000 random 256-bit pairs), Kani proves
the steps meet the same statements for small inputs, Proptest checks them on 10,000 random
markets each, and a property test checks `sell_step` against the spec's own order of
operations (`src/math.rs`, `src/pricing.rs`).

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/buy-wall-amm/proofs/pricing_z3.py`. Exits non-zero unless every claim is
proven.
"""

import sys
import time

from z3 import And, If, Implies, Int, Not, Or, Real, Solver, sat, unsat

Q = 2**64  # Q64.64's one
BPS = 10_000
MIN_FEE_BPS, MAX_FEE_BPS = 25, 300
DESIGNER_SHARE_BPS = SUITE_SHARE_BPS = 1_000


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

# --- PM-4: a reachable trade never refuses with Overflow ------------------------------------
# Every `Refusal::Overflow` in `sell`, `buy`, `walk`, `sell_step` and `buy_step` is a checked
# step that fails only when a value outgrows its type. On every reachable market they all
# succeed (the Book of Knowledge invariant PM-4): the price within [MIN_SQRT_PRICE,
# MAX_SQRT_PRICE], the curve between MIN_LIQUIDITY and 2^88 (`opening_z3.py`, `cap_z3.py`), and
# either no wall or a wall `place_wall` placed, whose top is at or above MIN_SQRT_PRICE (the
# guard's floor never falls below it, `guard_z3.py`) and whose `W × top` is below 2^128 (the
# first claim). The worst wall is the widest: W just below 2^96 at a top of MIN_SQRT_PRICE,
# with L at MIN_LIQUIDITY; every claim quantifies over all of them. Products of 256-bit
# values are checked against 2^256 (`mul_u128`, `checked_add`; `U256::mul` of two u128s never
# fails), quotients against the type they are narrowed to, and the divisions' divisors are
# never 0 (`div_rem` is exact otherwise, `math_z3.py`).
MIN_SQRT_PRICE, MAX_SQRT_PRICE = 2**32, 2**96
MIN_LIQUIDITY = 1_000_000
U64, U128, U256 = 2**64, 2**128, 2**256
iL, iW, top, s0, nxt2, a64 = (Int(n) for n in ["iL", "iW", "top", "s0", "next2", "a64"])
reachable = [
    iL >= MIN_LIQUIDITY,
    iL < 2**88,
    s0 >= MIN_SQRT_PRICE,
    s0 <= MAX_SQRT_PRICE,
    iW >= 0,
    Implies(iW > 0, And(top >= MIN_SQRT_PRICE, top <= MAX_SQRT_PRICE, iW * top < U128)),
    a64 >= 0,
    a64 < U64,
]
I3, floor_price, top2, W2 = Int("I3"), Int("floor_price"), Int("top2"), Int("W2")
results.append(
    prove(
        "place_wall: a wall placed with idle SOL below 2^64 at top = min(s, floor) has W x top < 2^128, W < 2^96 and its top in the price bounds",
        And(W2 * top2 < U128, W2 < 2**96, top2 >= MIN_SQRT_PRICE, top2 <= MAX_SQRT_PRICE),
        I3 >= 0,
        I3 < U64,
        s0 >= MIN_SQRT_PRICE,
        s0 <= MAX_SQRT_PRICE,
        floor_price >= MIN_SQRT_PRICE,
        top2 == If(s0 < floor_price, s0, floor_price),
        floor_of(W2, I3 * Q, top2),
    )
)
results.append(
    prove(
        "sell and buy: L + W, the liquidity of the curve and the wall together, fits in u128",
        iL + iW < U128,
        *reachable,
    )
)
# A sell step from any price s0 the walk can start a step at, along the liquidity and toward
# the target `leg` picks: (L, top) while a wall is placed and s0 is above its top, else (L + W,
# MIN_SQRT_PRICE). `next` is any price the step can reach, between the target and s0.
placed = iW > 0
sell_liq = If(And(placed, s0 > top), iL, iL + iW)
sell_target = If(And(placed, s0 > top), top, MIN_SQRT_PRICE)
results.append(
    prove(
        "sell step: every product fits on a reachable market (the denominator, L*Q*s, L*Q*drop, the gross's L*fall below 2^192) and no divisor is 0",
        And(
            sell_target <= s0,  # `s.checked_sub(target)`
            sell_liq * Q + a64 * s0 < U256,  # `liq_q.checked_add(mul(remaining, s))`
            sell_liq * Q * s0 < U256,  # `liq_q.mul_u128(s)`
            sell_liq * Q * (s0 - sell_target) < U256,  # `liq_q.mul_u128(drop)`
            sell_liq * (s0 - nxt2) < 2**192,  # `mul(liq, fall).checked_shr64()`
            sell_liq * Q + a64 * s0 > 0,  # div_ceil's divisor
            s0 * sell_target > 0,  # need's divisor
        ),
        *reachable,
        nxt2 >= sell_target,
        nxt2 <= s0,
    )
)
results.append(
    prove(
        "sell step: a step that stops short ends at ceil(P*s / (P + a*s)) <= s, which fits in u128 (to_u128)",
        free <= s,
        sell_positive,
        ceil_of(free, P * s, P + a * s),
    )
)
# A buy step: (L + W, top) while a wall is placed and s0 is below its top, else (L,
# MAX_SQRT_PRICE).
buy_liq = If(And(placed, s0 < top), iL + iW, iL)
buy_target = If(And(placed, s0 < top), top, MAX_SQRT_PRICE)
step = Int("step")
results.append(
    prove(
        "buy step: every product fits on a reachable market (L*rise below 2^192, remaining*Q, L*Q*(next - s)) and no divisor is 0",
        And(
            buy_target >= s0,  # `target.checked_sub(s)`
            buy_liq * (buy_target - s0) < 2**192 - Q,  # `mul(liq, rise).checked_ceil_shr64()`
            a64 * Q < U128,  # `times_q(remaining)`, and the step it divides into fits u128
            buy_liq > 0,  # the step's divisor
            buy_liq * Q * (nxt2 - s0) < U256,  # `times_q(liq).mul_u128(rise)`
            nxt2 * s0 > 0,  # out's divisor
            nxt2 < U128,  # `s.checked_add(step)`, below the target (claim "buy: a step that stops short")
        ),
        *reachable,
        nxt2 >= s0,
        nxt2 <= buy_target,
    )
)
# Each step's output fits in a u64, and so does their sum (`walk`'s `freed.checked_add`), because
# what a trade frees is bounded by ledgers that fit in u64 (over the reals, as above; the
# ledgers cover the curve and the wall before the trade, `wall_z3.py`). `rP`, `rL` are the
# curve's L × Q and L; `rV`, `rW` the wall's.
rW, rV, rt, rs0, rs1, rm, g1, g2, o1, o2, u1, u2 = (
    Real(n) for n in ["W", "V", "t", "s0", "s1", "m", "g1", "g2", "o1", "o2", "u1", "u2"]
)
wall_positive = And(rL > 0, rW >= 0, rV == rW * Q, rt > 0, rs0 > 0, rs1 > 0)
sol_covered = lamports * Q >= rL * rs0 + rW * If(rs0 < rt, rs0, rt)
tokens_covered = tokens * rt * rs0 >= rP * rt + If(rs0 < rt, rV * (rt - rs0), 0)


def sell_piece(liq_q, liq, frm, to, used, gross):
    return And(to <= frm, to * (liq_q + used * frm) >= liq_q * frm, gross * Q <= liq * (frm - to), gross >= 0)


def buy_piece(liq_q, liq, frm, to, used, out):
    return And(to >= frm, (to - frm) * liq <= used * Q, out * to * frm <= liq_q * (to - frm), out >= 0)


results.append(
    prove(
        "sell: what the steps free never exceeds pool_sol, so each gross and their sum fit in u64 (curve and wall leg, curve leg, or across the top)",
        And(
            # One step along L + W from at or below the top (or with no wall).
            Implies(And(rs0 <= rt, sell_piece(rP + rV, rL + rW, rs0, rs1, u1, g1)), g1 <= lamports),
            # One step along L above the top, stopping at or above it.
            Implies(And(rs0 > rt, rs1 >= rt, sell_piece(rP, rL, rs0, rs1, u1, g1)), g1 <= lamports),
            # Along L to the top, then along L + W.
            Implies(
                And(rs0 > rt, rt >= rs1, sell_piece(rP, rL, rs0, rt, u1, g1), sell_piece(rP + rV, rL + rW, rt, rs1, u2, g2)),
                g1 + g2 <= lamports,
            ),
        ),
        wall_positive,
        sol_covered,
    )
)
results.append(
    prove(
        "buy: what the steps pay out never exceeds pool_tokens, so each output and their sum fit in u64 (curve and wall leg, curve leg, or across the top)",
        And(
            Implies(And(rs1 <= rt, buy_piece(rP + rV, rL + rW, rs0, rs1, u1, o1)), o1 <= tokens),
            Implies(And(rs0 >= rt, buy_piece(rP, rL, rs0, rs1, u1, o1)), o1 <= tokens),
            Implies(
                And(rs0 <= rt, rt <= rs1, buy_piece(rP + rV, rL + rW, rs0, rt, u1, o1), buy_piece(rP, rL, rt, rs1, u2, o2)),
                o1 + o2 <= tokens,
            ),
        ),
        wall_positive,
        tokens_covered,
    )
)
# With no wall, `leg` gives L + 0 = L toward MIN_SQRT_PRICE for a sell and L toward
# MAX_SQRT_PRICE for a buy: the claims above with W = 0, where every wall term vanishes (take
# the top past the trade's end, so the first case of each applies).

# --- PM-6: a sell bought straight back never profits (over the reals) ----------------------
# A sell of `a` units moves the price from s0 to s1 and frees g lamports; the trader gets g less
# its fee, and the buy back spends `rem` lamports after its own fee, so rem <= g, and rem < g
# whenever both trades are accepted (each fee is at least 1 lamport on any input, the fee
# claim above). The buy back moves the price from s1 to s2 and pays `back` units. Each step
# meets the step contracts proved above, whichever kind it is (reaching its target or stopping
# short). The claims: the price ends no higher than it started, no more units come back than
# were sold, and fewer whenever rem < g.
back, rem2, gsum = Real("back"), Real("rem2"), Real("gsum")
rs2 = Real("s2")
v1, v2 = Real("v1"), Real("v2")
# No wall (or the whole trip above the wall's top): one step each way along L.
plain = And(
    rL > 0,
    rs0 > 0,
    ra > 0,
    sell_piece(rP, rL, rs0, rs1, ra, gsum),
    rs1 > 0,
    rem2 >= 0,
    rem2 <= gsum,
    buy_piece(rP, rL, rs1, rs2, rem2, back),
)
results.append(
    prove(
        "sell then buy back, no wall (or above the top): the price returns no higher, and no more units come back than were sold",
        And(rs2 <= rs0, back <= ra),
        plain,
    )
)
results.append(
    prove(
        "sell then buy back, no wall (or above the top): with both fees paid (rem < gross) fewer units come back than were sold",
        back < ra,
        plain,
        rem2 < gsum,
    )
)
# The buy back from s1 at or below the top: along L + W, either ending at or below the top, or
# reaching it and going on along L.
buy_back = Or(
    And(rs2 <= rt, buy_piece(rP + rV, rL + rW, rs1, rs2, rem2, back)),
    And(
        rs2 >= rt,
        buy_piece(rP + rV, rL + rW, rs1, rt, v1, o1),
        buy_piece(rP, rL, rt, rs2, v2, o2),
        v1 >= 0,
        v2 >= 0,
        v1 + v2 == rem2,
        back == o1 + o2,
    ),
)
walled_trip = [
    rL > 0,
    rW > 0,
    rV == rW * Q,
    rt > 0,
    rs0 > 0,
    rs1 > 0,
    rs1 <= rt,
    ra > 0,
    rem2 >= 0,
    rem2 <= gsum,
    buy_back,
]
# The sell starts at or below the top: one step along L + W.
inside = And(rs0 <= rt, sell_piece(rP + rV, rL + rW, rs0, rs1, ra, gsum))
# The sell starts above the top: along L to the top, then along L + W.
across = And(
    rs0 > rt,
    sell_piece(rP, rL, rs0, rt, u1, g1),
    sell_piece(rP + rV, rL + rW, rt, rs1, u2, g2),
    u1 >= 0,
    u2 >= 0,
    u1 + u2 == ra,
    gsum == g1 + g2,
)
for label, sold in [("the sell inside the wall", inside), ("the sell across the top", across)]:
    results.append(
        prove(
            f"sell then buy back, {label}: the price returns no higher, and no more units come back than were sold",
            And(rs2 <= rs0, back <= ra),
            *walled_trip,
            sold,
        )
    )
    results.append(
        prove(
            f"sell then buy back, {label}: with both fees paid (rem < gross) fewer units come back than were sold",
            back < ra,
            *walled_trip,
            sold,
            rem2 < gsum,
        )
    )

if not all(results):
    sys.exit(1)
print(f"all {len(results)} claims proven")
