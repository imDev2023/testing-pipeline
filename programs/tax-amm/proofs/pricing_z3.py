"""Z3 proofs of the tax AMM's pricing, tax and split maths for every input.

Kani proves the pricing in `src/pricing.rs` and the split in `src/split.rs` (their `proofs`
modules), but its SAT back end cannot relate a division's output to its inputs over the
full range, so its proofs about quotients finish only for small amounts. Here Z3 proves the
same statements over the integers, for every input (docs/spec/README.md, "Test layers" 2;
the property list is docs/security/tax-amm/maths-properties.md, whose IDs these claims
carry).

What is modelled, step by step as the Rust is written:

- `tax_of`: Pipeline's `fees::ceil_bps`, including each checked operation's overflow;
- `mul_div`: its 256-bit product (the 64-bit halves, both overflowing additions and the
  carries into `hi`) and one step of its long division (the carry bit and the wrapping
  subtraction), which together with the base case and the conclusion below prove the
  whole loop by induction;
- `curve_out`, `exact_in` and `split_tax`, with each floor or ceiling given by the facts
  that characterise it (`q·d <= n < (q + 1)·d`), which say exactly what `/` computes.

The link between this model and the compiled Rust is checked by tests: Kani proves the
Rust meets the same statements for small amounts, and Proptest checks them on at least
10,000 random inputs each (`tests/maths.rs`).

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/tax-amm/proofs/pricing_z3.py`. Exits non-zero unless every claim is
proven.
"""

import sys
import time

from z3 import And, If, Implies, Int, Not, Or, Solver, sat, unsat

U64_MAX = 2**64 - 1
U64 = 2**64
U128 = 2**128
BPS = 10_000
# `config::MAX_TAX_BPS` and `config::SUITE_SHARE_BPS`: policy values live only in the
# program's config module, so `read_constants` reads them from there and this file never
# disagrees with the program.
MAX_TAX_BPS = None
SUITE_SHARE_BPS = None
MAX_RECIPIENTS = 4


def read_constants():
    """Reads the policy values this file needs from `src/config.rs`, their one place."""
    import pathlib
    import re

    config = (pathlib.Path(__file__).resolve().parent.parent / "src" / "config.rs").read_text()

    def constant(name):
        found = re.search(rf"pub const {name}: \w+ = ([0-9_]+);", config)
        if not found:
            sys.exit(f"{name} not found in src/config.rs")
        return int(found.group(1).replace("_", ""))

    return constant("MAX_TAX_BPS"), constant("SUITE_SHARE_BPS")


def u64(name):
    v = Int(name)
    return v, And(v >= 0, v <= U64_MAX)


def u128(name):
    v = Int(name)
    return v, And(v >= 0, v < U128)


def floor_div(q, n, d):
    """The facts that make `q` exactly `floor(n / d)`, for d > 0."""
    return And(q * d <= n, n < (q + 1) * d)


def ceil_div(c, n, d):
    """The facts that make `c` exactly `ceil(n / d)`, for d > 0."""
    return And(c * d >= n, c * d < n + d)


def ceil_bps(amount, bps):
    """Pipeline's `fees::ceil_bps` as written: returns (is_some, value)."""
    q, r = amount / BPS, amount % BPS
    bq, br = bps / BPS, bps % BPS
    whole = q * bps  # checked_mul
    middle = r * bq  # checked_mul
    rest = (r * br + BPS - 1) / BPS  # (r * br).div_ceil(BPS): below BPS², never overflows
    total = whole + middle + rest  # two checked_adds, both of non-negative terms
    return And(whole <= U64_MAX, middle <= U64_MAX, total <= U64_MAX), total


RESULTS = []


def prove(name, claim, *assumptions):
    solver = Solver()
    solver.set("timeout", 600_000)
    solver.add(*assumptions)
    solver.add(Not(claim))
    started = time.monotonic()
    result = solver.check()
    took = time.monotonic() - started
    if result == unsat:
        print(f"PROVEN  {name} ({took:.1f} s)")
        RESULTS.append(True)
        return
    if result == sat:
        print(f"FAILED  {name}: counterexample {solver.model()}")
    else:
        print(f"UNKNOWN {name} ({solver.reason_unknown()})")
    RESULTS.append(False)


def tax_proofs():
    a, a_ok = u64("amount")
    a2, a2_ok = u64("amount_2")
    b, b2 = Int("bps"), Int("bps_2")
    rate_ok = And(b >= 0, b <= MAX_TAX_BPS)
    rate2_ok = And(b2 >= 0, b2 <= MAX_TAX_BPS)
    some, tax = ceil_bps(a, b)

    prove(
        "T1 tax_of(a, r) == ceil(a * r / 10,000), never None (every u64 a, r <= MAX_TAX_BPS)",
        And(some, ceil_div(tax, a * b, BPS)),
        a_ok,
        rate_ok,
    )
    prove("T1 tax_of(a, r) <= a", tax <= a, a_ok, rate_ok)
    prove("T1 tax_of(a, r) == 0 exactly when a == 0 or r == 0", (tax == 0) == Or(a == 0, b == 0), a_ok, rate_ok)
    _, tax_more = ceil_bps(a2, b)
    _, tax_dearer = ceil_bps(a, b2)
    prove(
        "T3 tax_of never falls as the amount or the rate rises",
        And(Implies(a <= a2, tax <= tax_more), Implies(b <= b2, tax <= tax_dearer)),
        a_ok,
        a2_ok,
        rate_ok,
        rate2_ok,
    )
    # What a buy tax leaves for the curve, a - tax, never falls as the amount rises: the
    # tax rises by at most what the amount does.
    prove(
        "T3 a - tax_of(a, r) never falls as a rises",
        Implies(a <= a2, a - tax <= a2 - tax_more),
        a_ok,
        a2_ok,
        rate_ok,
    )
    # Two taxes are never less than one on the sum: ceil(x) + ceil(y) >= ceil(x + y).
    _, tax_sum = ceil_bps(a + a2, b)
    prove(
        "T4 tax_of(a1, r) + tax_of(a2, r) >= tax_of(a1 + a2, r)",
        tax + tax_more >= tax_sum,
        a_ok,
        a2_ok,
        a + a2 <= U64_MAX,
        rate_ok,
    )


def mul_div_proofs():
    """`mul_div(a, b, d)` returns floor(a * b / d) whenever that fits in a u128."""
    a1, a1_ok = u64("a1")
    a0, a0_ok = u64("a0")
    b1, b1_ok = u64("b1")
    b0, b0_ok = u64("b0")
    # `(a1 * b0).overflowing_add(a0 * b1)`: the sum wraps at 2^128, its carry a bool.
    mid, mid_carry = Int("mid"), Int("mid_carry")
    mid_facts = And(
        a1 * b0 + a0 * b1 == mid + mid_carry * U128, mid >= 0, mid < U128, Or(mid_carry == 0, mid_carry == 1)
    )
    # `mid << 64` keeps mid's low 64 bits, shifted; `mid >> 64` is its high half.
    mid_high, mid_low = Int("mid_high"), Int("mid_low")
    mid_split = And(mid == mid_high * U64 + mid_low, mid_low >= 0, mid_low < U64, mid_high >= 0)
    # `(a0 * b0).overflowing_add(mid << 64)`.
    lo, lo_carry = Int("lo"), Int("lo_carry")
    lo_facts = And(a0 * b0 + mid_low * U64 == lo + lo_carry * U128, lo >= 0, lo < U128, Or(lo_carry == 0, lo_carry == 1))
    hi = a1 * b1 + mid_high + mid_carry * U64 + lo_carry
    # The additions into `hi` are checked (overflow-checks), so every partial sum must fit.
    hi_fits = And(a1 * b1 + mid_high < U128, a1 * b1 + mid_high + mid_carry * U64 < U128, hi < U128)
    prove(
        "M1 mul_div's 256-bit product is exact, hi * 2^128 + lo == a * b, and hi never overflows",
        And(hi * U128 + lo == (a1 * U64 + a0) * (b1 * U64 + b0), hi_fits),
        a1_ok,
        a0_ok,
        b1_ok,
        b0_ok,
        mid_facts,
        mid_split,
        lo_facts,
    )

    # The long division of (hi, lo) by d, one bit of lo at a time from the top. Invariant
    # before the step for bit k: floor(N / 2^(k+1)) == quotient_so_far * d + remainder,
    # remainder < d, where N = hi * 2^128 + lo and quotient_so_far holds the bits above k.
    # One step, as written: carry = remainder >> 127; remainder = (remainder << 1) | bit;
    # if carry == 1 || remainder >= d { remainder = remainder.wrapping_sub(d); set bit k }.
    d, d_ok = u128("d")
    r = Int("remainder")
    bit = Int("bit")
    carry = r / 2**127
    shifted = (2 * r) % U128 + bit  # `<< 1` drops the top bit; the low bit was 0, so `|` adds
    take = Or(carry == 1, shifted >= d)
    new_r = If(take, (shifted - d) % U128, shifted)  # `wrapping_sub`
    whole = 2 * r + bit  # the true value the step works on
    prove(
        "M2 one long-division step: it takes d exactly when 2r + bit >= d, leaving 2r + bit - d < d",
        And(take == (whole >= d), new_r == If(whole >= d, whole - d, whole), new_r < d, new_r >= 0),
        d_ok,
        d >= 1,
        r >= 0,
        r < d,
        Or(bit == 0, bit == 1),
    )
    # The step keeps the invariant: floor(N / 2^k) == 2 * floor(N / 2^(k+1)) + bit k of N.
    above, q_so_far = Int("floor_n_above"), Int("quotient_so_far")
    prove(
        "M2 the step keeps floor(N / 2^k) == quotient * d + remainder, remainder < d",
        2 * above + bit == (2 * q_so_far + If(whole >= d, 1, 0)) * d + If(whole >= d, whole - d, whole),
        above == q_so_far * d + r,
        d >= 1,
        r >= 0,
        r < d,
        q_so_far >= 0,
        Or(bit == 0, bit == 1),
    )
    # Base: before bit 127, floor(N / 2^128) == hi == 0 * d + hi, and the loop is entered
    # only when hi < d. Conclusion: after bit 0, N == quotient * d + remainder with
    # remainder < d, so quotient == floor(N / d), and it fits in 128 bits because N < d * 2^128
    # exactly when hi < d. (`hi == 0` divides lo directly; `hi >= d` saturates.)
    n_hi, n_lo = Int("n_hi"), Int("n_lo")
    prove(
        "M3 floor((hi * 2^128 + lo) / d) < 2^128 exactly when hi < d",
        ((n_hi * U128 + n_lo) / d < U128) == (n_hi < d),
        d >= 1,
        n_hi >= 0,
        n_lo >= 0,
        n_lo < U128,
    )
    # curve_out never takes the saturating branch: E_o < 2^65 and input <= E_i + input.
    e_in, e_out, x = Int("e_in"), Int("e_out"), Int("input")
    prove(
        "M4 curve_out's mul_div never saturates: floor(E_o * x / (E_i + x)) < 2^128",
        (e_out * x) / (e_in + x) < U128,
        e_in >= 0,
        e_in <= 2 * U64_MAX,
        e_out >= 0,
        e_out <= 2 * U64_MAX,
        x >= 1,
        x <= U64_MAX,
    )


def curve(e_in, e_out, x, name):
    """`curve_out(e_in, e_out, x)` as a fresh variable and the facts that define it."""
    q = Int(name)
    return q, If(x == 0, q == 0, floor_div(q, e_out * x, e_in + x))


def nonneg(*names):
    """Fresh integer variables, each at least 0 and otherwise unbounded."""
    vs = [Int(n) for n in names]
    return vs, And(*[v >= 0 for v in vs])


def ceil_tax(name, amount, bps):
    """`tax_of(amount, bps)` as a fresh variable: ceil(amount * bps / 10,000) (T1)."""
    t = Int(name)
    return t, ceil_div(t, amount * bps, BPS)


def capped(*rates):
    return And(*[And(r >= 0, r <= MAX_TAX_BPS) for r in rates])


# Instances of the lemmas proven below. Each lemma holds for every non-negative value of its
# variables (and every capped rate), so an instance guarded by those preconditions is a true
# fact; the whole-trade claims add the instances they need as assumptions, and Z3 checks the
# claim follows. The lemma each one instantiates is named.


def c1(q, e_in, e_out, x):
    """C1: the curve pays out between nothing and its whole output side."""
    return Implies(And(e_in >= 0, e_out >= 0, x >= 0), And(q >= 0, q <= e_out))


def s3(q, x, q2, x2, e_in, e_out):
    """S3: on one curve, more input never pays out less."""
    return Implies(And(e_in >= 0, e_out >= 0, x >= 0, x <= x2), q <= q2)


def l1(a, t, a2, t2, rate):
    """L1: what is left after the tax never falls as the amount rises."""
    return Implies(And(a >= 0, a <= a2, capped(rate)), a - t <= a2 - t2)


def l2(t, t2, rate, rate2, a):
    """L2: the tax never falls as the rate rises."""
    return Implies(And(a >= 0, capped(rate, rate2), rate <= rate2), t <= t2)


def l3(t, a, rate):
    """L3: the tax is between 0 and the amount."""
    return Implies(And(a >= 0, capped(rate)), And(t >= 0, t <= a))


def l4(t1, t2, t, a1, a2, rate):
    """L4: two taxes are never less than one on the sum."""
    return Implies(And(a1 >= 0, a2 >= 0, capped(rate)), t1 + t2 >= t)


def l5(g, c, e_x, e_y):
    """L5: trading c and the whole output straight back, the curve returns at most c."""
    return Implies(And(e_x >= 0, e_y >= 0, c >= 0), g <= c)


def l6(o1, o2, o, e_in, e_out, x1, x2):
    """L6: on the curve, two legs never pay out more than their sum at once."""
    return Implies(And(e_in >= 0, e_out >= 0, x1 >= 0, x2 >= 0), o1 + o2 <= o)


def curve_proofs():
    (e_in, e_out, x, x2), ok = nonneg("e_in", "e_out", "x", "x_2")
    q, q_def = curve(e_in, e_out, x, "out")
    q2, q2_def = curve(e_in, e_out, x2, "out_2")
    prove(
        "C1 the curve never pays out its whole output side while its input side holds anything",
        And(q >= 0, q <= e_out, Implies(And(e_in > 0, e_out > 0), q < e_out)),
        ok,
        q_def,
    )
    # Covers both taxes: the curve prices c = a - tax for a buy tax and a for a sell tax,
    # and afterwards E_i grows by what it priced and E_o falls by what it paid out.
    prove(
        "S1 a swap never lowers the product of the effective reserves: (E_i + x)(E_o - out) >= E_i * E_o",
        (e_in + x) * (e_out - q) >= e_in * e_out,
        ok,
        q_def,
    )
    prove("S3 the curve's output never falls as its input rises", Implies(x <= x2, q <= q2), ok, q_def, q2_def)


def lemma_proofs():
    """The lemmas the whole-trade claims are built from, each for every non-negative input.

    A whole trade composes the tax and the curve, and Z3 does not settle the composed
    nonlinear claims directly in reasonable time, so each piece is proven here on its own.
    """
    (a, a2), ok = nonneg("a", "a_2")
    b, b2 = Int("bps"), Int("bps_2")
    t, t_def = ceil_tax("t", a, b)
    t2, t2_def = ceil_tax("t_2", a2, b)
    t3, t3_def = ceil_tax("t_3", a, b2)
    ts, ts_def = ceil_tax("t_sum", a + a2, b)
    defs = And(ok, capped(b, b2), t_def, t2_def, t3_def, ts_def)
    prove("L1 what is left after the tax, a - ceil(a * r / 10,000), never falls as a rises", Implies(a <= a2, a - t <= a2 - t2), defs)
    prove("L2 the tax never falls as the rate rises", Implies(b <= b2, t <= t3), defs)
    prove("L3 the tax is between 0 and the amount", And(t >= 0, t <= a), defs)
    prove("L4 two taxes are never less than one on the sum", t + t2 >= ts, defs)

    (e_x, e_y, c), ok = nonneg("e_x", "e_y", "c")
    y, y_def = curve(e_x, e_y, c, "y")
    g, g_def = curve(e_y - y, e_x + c, y, "g_back")
    prove("L5 trading c there and its whole output straight back, the curve returns at most c", g <= c, ok, y_def, g_def)

    (e_in, e_out, x1, x2), ok = nonneg("e_in", "e_out", "x1", "x2")
    o1, o1_def = curve(e_in, e_out, x1, "out_1")
    o2, o2_def = curve(e_in + x1, e_out - o1, x2, "out_2")
    o, o_def = curve(e_in, e_out, x1 + x2, "out_whole")
    prove("L6 the curve: out(x1) + out(x2 after x1) <= out(x1 + x2)", o1 + o2 <= o, ok, o1_def, o2_def, o_def)


def exact_in_proofs():
    """S3 for whole trades, each tax as `exact_in` takes it, on effective reserves."""
    (e_in, e_out, a, a2), ok = nonneg("e_in", "e_out", "a", "a_2")
    b, b2 = Int("bps"), Int("bps_2")
    rates = capped(b, b2)

    # Buy tax: c = a - tax_of(a, b), out = curve(c).
    t, t_def = ceil_tax("tax", a, b)
    t2, t2_def = ceil_tax("tax_2", a2, b)
    t3, t3_def = ceil_tax("tax_3", a, b2)
    out, out_def = curve(e_in, e_out, a - t, "out")
    out2, out2_def = curve(e_in, e_out, a2 - t2, "out_2")
    out3, out3_def = curve(e_in, e_out, a - t3, "out_3")
    buy = And(ok, rates, t_def, t2_def, t3_def, out_def, out2_def, out3_def)
    taxes_in_range = And(l3(t, a, b), l3(t2, a2, b), l3(t3, a, b2))
    prove(
        "S3 buy tax: the output never rises when the input falls (from L1, L3, S3)",
        Implies(a <= a2, out <= out2),
        buy,
        taxes_in_range,
        l1(a, t, a2, t2, b),
        s3(out, a - t, out2, a2 - t2, e_in, e_out),
    )
    prove(
        "S3 buy tax: the output never rises when the tax rises (from L2, L3, S3)",
        Implies(b <= b2, out3 <= out),
        buy,
        taxes_in_range,
        l2(t, t3, b, b2, a),
        s3(out3, a - t3, out, a - t, e_in, e_out),
    )

    # Sell tax: g = curve(a), out = g - tax_of(g, b).
    g, g_def = curve(e_in, e_out, a, "g")
    g2, g2_def = curve(e_in, e_out, a2, "g_2")
    s, s_def = ceil_tax("sell_tax", g, b)
    s2, s2_def = ceil_tax("sell_tax_2", g2, b)
    s3_, s3_def = ceil_tax("sell_tax_3", g, b2)
    sell = And(ok, rates, g_def, g2_def, s_def, s2_def, s3_def)
    prove(
        "S3 sell tax: the output never rises when the input falls (from C1, S3, L1)",
        Implies(a <= a2, g - s <= g2 - s2),
        sell,
        c1(g, e_in, e_out, a),
        s3(g, a, g2, a2, e_in, e_out),
        l1(g, s, g2, s2, b),
    )
    prove(
        "S3 sell tax: the output never rises when the tax rises (from C1, L2)",
        Implies(b <= b2, g - s3_ <= g - s),
        sell,
        c1(g, e_in, e_out, a),
        l2(s, s3_, b, b2, g),
    )


def split_trade_proofs():
    """S4: a trade of a1 then a2 in the same direction never returns more than a1 + a2 at once."""
    (e_in, e_out, a1, a2), ok = nonneg("e_in", "e_out", "a1", "a2")
    b = Int("bps")
    inputs = And(ok, capped(b))

    # Buy tax: the legs price p1 = a1 - t1 and p2 = a2 - t2, the whole p = a1 + a2 - t, and
    # the second leg meets E_i + p1 and E_o - out1.
    t1, t1_def = ceil_tax("t1", a1, b)
    t2, t2_def = ceil_tax("t2", a2, b)
    t, t_def = ceil_tax("t", a1 + a2, b)
    p1, p2, p = a1 - t1, a2 - t2, a1 + a2 - t  # what the curve prices
    o1, o1_def = curve(e_in, e_out, p1, "buy_out_1")
    o2, o2_def = curve(e_in + p1, e_out - o1, p2, "buy_out_2")
    o12, o12_def = curve(e_in, e_out, p1 + p2, "buy_out_legs")
    o, o_def = curve(e_in, e_out, p, "buy_out_whole")
    prove(
        "S4 buy tax: two legs never return more than the whole trade (from L3, L4, L6, S3)",
        o1 + o2 <= o,
        inputs, t1_def, t2_def, t_def, o1_def, o2_def, o12_def, o_def,
        l3(t1, a1, b), l3(t2, a2, b),
        l4(t1, t2, t, a1, a2, b),
        l6(o1, o2, o12, e_in, e_out, p1, p2),
        s3(o12, p1 + p2, o, p, e_in, e_out),
    )

    # Sell tax: the legs' curve outputs g1 + g2 <= g (L6), and the trader gets g - tax.
    g1, g1_def = curve(e_in, e_out, a1, "g1")
    g2, g2_def = curve(e_in + a1, e_out - g1, a2, "g2")
    g, g_def = curve(e_in, e_out, a1 + a2, "g")
    s1, s1_def = ceil_tax("s1", g1, b)
    s2, s2_def = ceil_tax("s2", g2, b)
    s12, s12_def = ceil_tax("s12", g1 + g2, b)
    s, s_def = ceil_tax("s", g, b)
    prove(
        "S4 sell tax: two legs never return more than the whole trade (from C1, L6, L4, L1)",
        (g1 - s1) + (g2 - s2) <= g - s,
        inputs, g1_def, g2_def, g_def, s1_def, s2_def, s12_def, s_def,
        c1(g1, e_in, e_out, a1),
        c1(g2, e_in + a1, e_out - g1, a2),
        l6(g1, g2, g, e_in, e_out, a1, a2),
        l4(s1, s2, s12, g1, g2, b),
        l1(g1 + g2, s12, g, s, b),
    )


def round_trip_proofs():
    """S5: trading a for the other side, then all of it straight back, never returns more than a.

    E_x and E_y are the effective reserves of the side traded from and the side traded to;
    the virtual reserve stays on its side, so both legs see the same virtual reserve.
    """
    (e_x, e_y, a), ok = nonneg("e_x", "e_y", "a")
    buy, sell = Int("buy_bps"), Int("sell_bps")
    rates = capped(buy, sell)

    # The tax side is x: the trip there pays the buy tax, the trip back the sell tax.
    t, t_def = ceil_tax("buy_tax", a, buy)
    c = a - t
    y, y_def = curve(e_x, e_y, c, "y")
    g, g_def = curve(e_y - y, e_x + c, y, "g_back")
    s, s_def = ceil_tax("sell_tax", g, sell)
    prove(
        "S5 tax side traded from: buy tax there, sell tax back, never more than a (from C1, L3, L5)",
        g - s <= a,
        ok, rates, t_def, y_def, g_def, s_def,
        l3(t, a, buy),
        c1(y, e_x, e_y, c),
        c1(g, e_y - y, e_x + c, y),
        l3(s, g, sell),
        l5(g, c, e_x, e_y),
    )

    # The tax side is y: the trip there pays the sell tax (which stays in y's vault, out of
    # its reserve), the trip back the buy tax.
    g1, g1_def = curve(e_x, e_y, a, "g_there")
    s1, s1_def = ceil_tax("sell_tax_there", g1, sell)
    got = g1 - s1
    t2, t2_def = ceil_tax("buy_tax_back", got, buy)
    back, back_def = curve(e_y - g1, e_x + a, got - t2, "back")
    whole_back, whole_back_def = curve(e_y - g1, e_x + a, g1, "whole_back")
    prove(
        "S5 tax side traded to: sell tax there, buy tax back, never more than a (from C1, L3, S3, L5)",
        back <= a,
        ok, rates, g1_def, s1_def, t2_def, back_def, whole_back_def,
        c1(g1, e_x, e_y, a),
        l3(s1, g1, sell),
        l3(t2, got, buy),
        s3(back, got - t2, whole_back, g1, e_y - g1, e_x + a),
        l5(whole_back, a, e_x, e_y),
    )


def split_tax_proofs():
    """P1: `split_tax` of valid shares: the suite share, the recipients' parts and the burn
    add up to the tax, no part exceeds it, and its checked subtraction never fails."""
    tax, tax_ok = u64("tax")
    shares = [Int(f"share_{i}") for i in range(MAX_RECIPIENTS)]
    burn = Int("burn_share")
    valid = And(*[s >= 0 for s in shares], burn >= 0, sum(shares) + burn == BPS)
    suite = Int("suite")
    rest = tax - suite
    parts = [Int(f"part_{i}") for i in range(MAX_RECIPIENTS)]
    burned = Int("burned")
    defs = And(
        floor_div(suite, tax * SUITE_SHARE_BPS, BPS),
        *[floor_div(p, rest * s, BPS) for p, s in zip(parts, shares)],
        floor_div(burned, rest * burn, BPS),
    )
    booked = sum(parts) + burned
    remainder = rest - booked
    slots = [parts[0] + remainder, *parts[1:], burned, suite]
    prove(
        "P1 valid shares: booked <= rest, so the split never fails, with under one unit a part left over",
        And(booked <= rest, remainder < MAX_RECIPIENTS + 1),
        tax_ok,
        valid,
        defs,
    )
    prove(
        "P1 valid shares: the parts add up to the tax and none exceeds it or is negative",
        And(sum(slots) == tax, *[And(p >= 0, p <= tax) for p in slots]),
        tax_ok,
        valid,
        defs,
    )


def main():
    global MAX_TAX_BPS, SUITE_SHARE_BPS
    MAX_TAX_BPS, SUITE_SHARE_BPS = read_constants()
    print(f"MAX_TAX_BPS = {MAX_TAX_BPS}, SUITE_SHARE_BPS = {SUITE_SHARE_BPS} (src/config.rs)")
    started = time.monotonic()
    tax_proofs()
    mul_div_proofs()
    curve_proofs()
    lemma_proofs()
    exact_in_proofs()
    split_trade_proofs()
    round_trip_proofs()
    split_tax_proofs()
    print(f"{sum(RESULTS)} of {len(RESULTS)} proven in {time.monotonic() - started:.1f} s")
    return 0 if all(RESULTS) else 1


if __name__ == "__main__":
    sys.exit(main())
