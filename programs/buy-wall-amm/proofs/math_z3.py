"""Z3 proofs of the buy wall AMM's 256-bit maths for every input.

Kani proves `U256::div_rem` and `isqrt` (`src/math.rs`, `src/opening.rs`, their `proofs`
modules) in the default tier only for dividends below 2^12, because CBMC unrolls their loops,
and their full-domain harnesses sit in the `kani_full` tier. Every pricing, trim and wall
division divides a number near 2^150 to 2^250, so the Z3 scripts' link to the compiled Rust
rested on a proof that never reached the values trading uses. Here Z3 proves the helpers for
every input, modelling `src/math.rs` and `isqrt` as written, limb by limb and loop body by loop
body (docs/spec/README.md, "Test layers" 2; the Book of Knowledge invariants PM-1, PM-2, PM-3
and PM-11, `.bok/confirmed-invariants/CONFIRMED.md`):

- PM-2: every limb operation computes the 256-bit operation it names, with `None` exactly
  where it should be: the derived `Ord`, `checked_add`, `checked_sub`, `checked_shr`,
  `checked_shl`, `leading_zeros`, `with_bit`, `highest_power_of_four`, `checked_shr64`,
  `checked_ceil_shr64`, `times_q`, `to_u128` and `to_u64`. These run over bit vectors: each
  `U256` is its two 128-bit limbs, each Rust `u128` operation is its bit-vector counterpart
  (`checked_shl(n)` is `None` for `n >= 128`, `checked_add` is `None` on a carry out, and so
  on), and the reference is the same operation on one 256-bit (or wider) bit vector.
- PM-1: `div_rem` is exact for every pair, `div_floor` is the floor and `div_ceil` the
  ceiling, by an inductive loop invariant: the start of the loop is proved over bit vectors
  (the shift and the shifted divisor, as written), and one pass of the loop body over the
  integers, with each limb operation replaced by the contract PM-2 proves of it. The loop runs
  `shift + 1 <= 256` passes, so the invariant at its exit is the result.
- PM-3: `mul_u128` is exact, and `None` exactly past 2^256, with `U256::mul` written out on
  64-bit digits as `opening_z3.py` does.
- PM-11: `isqrt` is the floor square root for every 256-bit input, by the same method: the
  start from `highest_power_of_four` (proved over bit vectors), then one pass of the loop body
  over the integers.

How the two layers meet: a bit-vector claim says, for example, that `checked_sub(a, b)` is
`Some(val(a) - val(b))` exactly when `val(a) >= val(b)`, where `val(u) = u.hi × 2^128 + u.lo`.
The loop claims read each operation through that contract, over the integers, where Z3 can
reason about `q × d`, which a 512-bit bit-vector multiplier would never finish. Facts about
powers of two and four that the loops need (`2^bit = 2 × 2^(bit - 1)`; a power of four other
than 1 is 4 times a power of four) are stated as assumptions of the integer claims and proved
over bit vectors here where they concern the code (`bit >> 2` of a power of four).

The link between this model and the compiled Rust is checked by tests: Kani proves the same
statements for small inputs, its full tier for every input, and Proptest checks every
operation on 10,000 random inputs (`src/math.rs`, `src/opening.rs`).

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/buy-wall-amm/proofs/math_z3.py`. Exits non-zero unless every claim is proven.
"""

import sys
import time

from z3 import (
    UGE,
    UGT,
    ULE,
    ULT,
    And,
    BitVec,
    BitVecVal,
    BVAddNoOverflow,
    Concat,
    Extract,
    If,
    Implies,
    Int,
    LShR,
    Not,
    Or,
    Solver,
    ZeroExt,
    sat,
    unsat,
)

Q = 2**64  # Q64.64's one
U128 = 2**128
U256 = 2**256


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


# --- Rust's u128 and u32 operations, over bit vectors ---------------------------------------


def c128(v):
    return BitVecVal(v, 128)


def c32(v):
    return BitVecVal(v, 32)


def amount(n):
    """A u32 shift amount widened to 128 bits."""
    return ZeroExt(96, n)


def shl128(x, n):
    """`x.checked_shl(n)`: `None` for `n >= 128`; bits shifted out are lost."""
    return x << amount(n), ULT(n, c32(128))


def shr128(x, n):
    """`x.checked_shr(n)`: `None` for `n >= 128`."""
    return LShR(x, amount(n)), ULT(n, c32(128))


def add128(x, y):
    """`x.checked_add(y)`: `None` on a carry out."""
    return x + y, BVAddNoOverflow(x, y, False)


def sub128(x, y):
    """`x.checked_sub(y)`: `None` on a borrow."""
    return x - y, UGE(x, y)


def sub32(x, y):
    """`x.checked_sub(y)` on u32."""
    return x - y, UGE(x, y)


def clz(x, width):
    """`leading_zeros` of a `width`-bit value, as a u32: the position of its highest set bit,
    counted from the top, and `width` for 0 (the specification of Rust's `leading_zeros`)."""
    result = c32(width)
    for i in range(width):  # the highest set bit is applied last
        result = If(Extract(i, i, x) == 1, c32(width - 1 - i), result)
    return result


# --- `U256` as written (src/math.rs), on its two limbs --------------------------------------


class U:
    """A `U256 { hi, lo }`."""

    def __init__(self, hi, lo):
        self.hi, self.lo = hi, lo


def u256(name):
    return U(BitVec(f"{name}_hi", 128), BitVec(f"{name}_lo", 128))


def val(u):
    """`hi × 2^128 + lo`, one 256-bit value."""
    return Concat(u.hi, u.lo)


ZERO = U(c128(0), c128(0))
ONE = U(c128(0), c128(1))
LOW_64 = c128(2**64 - 1)


def ge(a, b):
    """The derived `Ord`'s `a >= b`: fields compared in order, `hi` first, then `lo`."""
    return Or(UGT(a.hi, b.hi), And(a.hi == b.hi, UGE(a.lo, b.lo)))


def checked_add(a, b):
    lo = a.lo + b.lo  # `overflowing_add`
    carry = If(ULT(lo, a.lo), c128(1), c128(0))
    h1, ok1 = add128(a.hi, b.hi)
    hi, ok2 = add128(h1, carry)
    return U(hi, lo), And(ok1, ok2)


def checked_sub(a, b):
    lo = a.lo - b.lo  # `overflowing_sub`
    borrow = If(ULT(a.lo, b.lo), c128(1), c128(0))
    h1, ok1 = sub128(a.hi, b.hi)
    hi, ok2 = sub128(h1, borrow)
    return U(hi, lo), And(ok1, ok2)


def checked_shr(u, n):
    back, ok_back = sub32(c32(128), n)
    ok_filter = ULT(back, c32(128))
    hi, ok_hi = shr128(u.hi, n)
    lo_part, ok_lo = shr128(u.lo, n)
    carried, ok_carried = shl128(u.hi, back)
    return U(hi, lo_part | carried), And(ok_back, ok_filter, ok_hi, ok_lo, ok_carried)


def leading_zeros(u):
    return If(u.hi != c128(0), clz(u.hi, 128), c32(128) + clz(u.lo, 128))


def checked_shl(u, n):
    lz = leading_zeros(u)
    # n >= 128: `hi = lo.checked_shl(n.checked_sub(128)?)?`, `lo = 0`.
    wide_n, _ = sub32(n, c32(128))
    wide_hi, ok_wide = shl128(u.lo, wide_n)
    # n < 128: `hi = hi.checked_shl(n)? | lo.checked_shr(128u32.checked_sub(n)?)?`,
    # `lo = lo.checked_shl(n)?`.
    narrow_back, _ = sub32(c32(128), n)
    h, ok_h = shl128(u.hi, n)
    spill, ok_spill = shr128(u.lo, narrow_back)
    narrow_lo, ok_lo = shl128(u.lo, n)
    wide = UGE(n, c32(128))
    hi = If(n == c32(0), u.hi, If(wide, wide_hi, h | spill))
    lo = If(n == c32(0), u.lo, If(wide, c128(0), narrow_lo))
    some = If(
        n == c32(0),
        True,
        If(UGT(n, lz), False, If(wide, ok_wide, And(ok_h, ok_spill, ok_lo))),
    )
    return U(hi, lo), some


def with_bit(u, n):
    wide_n, _ = sub32(n, c32(128))
    wide_mask, ok_wide = shl128(c128(1), wide_n)
    narrow_mask, ok_narrow = shl128(c128(1), n)
    wide = UGE(n, c32(128))
    return (
        U(If(wide, u.hi | wide_mask, u.hi), If(wide, u.lo, u.lo | narrow_mask)),
        If(wide, ok_wide, ok_narrow),
    )


def highest_power_of_four(u):
    bits, ok_bits = sub32(c32(256), leading_zeros(u))
    exponent = (bits - c32(1)) & ~c32(1)  # `bits.checked_sub(1)? & !1`, bits >= 1 here
    power, ok_power = checked_shl(ONE, exponent)
    zero = bits == c32(0)
    return (
        U(If(zero, c128(0), power.hi), If(zero, c128(0), power.lo)),
        And(ok_bits, Or(zero, ok_power)),
    )


def checked_shr64(u):
    return (u.hi << 64) | LShR(u.lo, 64), LShR(u.hi, 64) == c128(0)


def checked_ceil_shr64(u):
    floor, ok_floor = checked_shr64(u)
    up, ok_up = add128(floor, c128(1))
    exact = (u.lo & LOW_64) == c128(0)
    return If(exact, floor, up), And(ok_floor, Or(exact, ok_up))


def times_q(x):
    return U(LShR(x, 64), x << 64)


def to_u128(u):
    return u.lo, u.hi == c128(0)


def to_u64(u):
    return u.lo, And(u.hi == c128(0), ULT(u.lo, c128(2**64)))


def wide(v, bits):
    """`v` zero-extended to `bits` bits."""
    return ZeroExt(bits - v.size(), v)


results = []
a, b = u256("a"), u256("b")
va, vb = val(a), val(b)
n32 = BitVec("n", 32)
x = BitVec("x", 128)

# --- PM-2: each limb operation is the 256-bit operation it names ----------------------------
results.append(
    prove(
        "Ord: the derived order of (hi, lo) is the numeric order of hi * 2^128 + lo",
        ge(a, b) == UGE(va, vb),
    )
)
total, some = checked_add(a, b)
results.append(
    prove(
        "checked_add: Some exactly below 2^256, and then the sum",
        And(
            some == ULT(wide(va, 257) + wide(vb, 257), BitVecVal(U256, 257)),
            Implies(some, val(total) == va + vb),
        ),
    )
)
difference, some = checked_sub(a, b)
results.append(
    prove(
        "checked_sub: Some exactly when a >= b, and then the difference",
        And(some == UGE(va, vb), Implies(some, val(difference) == va - vb)),
    )
)
shifted, some = checked_shr(a, n32)
results.append(
    prove(
        "checked_shr(n): Some exactly for n from 1 to 127, and then a >> n (every u32 n)",
        And(
            some == And(UGE(n32, c32(1)), ULE(n32, c32(127))),
            Implies(some, val(shifted) == LShR(va, wide(n32, 256))),
        ),
    )
)
# A shift by n loses no set bit exactly when n is at most the leading zero count. Split by the
# code's branches (n = 0, below 128, 128 to 255, past 255), each one claim, as one claim takes
# Z3 over a minute.
shifted, some = checked_shl(a, n32)
for label, branch in [
    ("n = 0", n32 == c32(0)),
    ("1 <= n <= 127", And(UGE(n32, c32(1)), ULE(n32, c32(127)))),
    ("128 <= n <= 255", And(UGE(n32, c32(128)), ULE(n32, c32(255)))),
    ("n >= 256", UGE(n32, c32(256))),
]:
    results.append(
        prove(
            f"checked_shl(n), {label}: Some exactly for n = 0 or n <= 255 losing no set bit (n <= leading zeros), and then a << n",
            And(
                some == Or(n32 == c32(0), And(ULE(n32, c32(255)), ULE(n32, clz(va, 256)))),
                Implies(some, val(shifted) == va << wide(n32, 256)),
            ),
            branch,
        )
    )
results.append(
    prove(
        "leading_zeros: the 256-bit count of leading zero bits, 256 for 0",
        leading_zeros(a) == clz(va, 256),
    )
)
set_bit, some = with_bit(a, n32)
results.append(
    prove(
        "with_bit(n): Some exactly for n <= 255, and then a | 2^n (every u32 n)",
        And(
            some == ULE(n32, c32(255)),
            Implies(some, val(set_bit) == va | (BitVecVal(1, 256) << wide(n32, 256))),
        ),
    )
)
mask = (BitVecVal(1, 256) << wide(n32, 256)) | ((BitVecVal(1, 256) << wide(n32, 256)) - 1)
results.append(
    prove(
        "with_bit(n) on a value whose bits 0 to n are clear adds exactly 2^n",
        Implies(
            And(ULE(n32, c32(255)), va & mask == BitVecVal(0, 256)),
            And(some, val(set_bit) == va + (BitVecVal(1, 256) << wide(n32, 256))),
        ),
    )
)
power, some = highest_power_of_four(a)
vp = val(power)
EVEN_BITS = BitVecVal(int("01" * 128, 2), 256)  # bits 0, 2, 4, ...
results.append(
    prove(
        "highest_power_of_four: never None; 0 for 0, else a power of four p with p <= a < 4p and 4p <= 2^256",
        And(
            some,
            Implies(va == 0, vp == 0),
            Implies(
                va != 0,
                And(
                    vp != 0,
                    vp & (vp - 1) == 0,
                    vp & EVEN_BITS == vp,
                    ULE(vp, va),
                    ULT(wide(va, 258), 4 * wide(vp, 258)),
                    ULE(4 * wide(vp, 258), BitVecVal(U256, 258)),
                ),
            ),
        ),
    )
)
# The loop of `isqrt` needs: `bit >> 2` of a power of four is 0 when it is 1, else a power of
# four a quarter of it (`checked_shr(2)`, Some by the checked_shr claim).
p4 = BitVec("p4", 256)
quarter, some = checked_shr(U(Extract(255, 128, p4), Extract(127, 0, p4)), c32(2))
vq = val(quarter)
is_power_of_four = And(p4 != 0, p4 & (p4 - 1) == 0, p4 & EVEN_BITS == p4)
results.append(
    prove(
        "bit.checked_shr(2) of a power of four: 0 for 1, else a power of four with 4 x it == bit",
        Implies(
            is_power_of_four,
            And(
                some,
                Implies(p4 == 1, vq == 0),
                Implies(p4 != 1, And(vq << 2 == p4, vq != 0, vq & (vq - 1) == 0, vq & EVEN_BITS == vq)),
            ),
        ),
    )
)
floor64, some = checked_shr64(a)
results.append(
    prove(
        "checked_shr64: Some exactly below 2^192, and then floor(a / 2^64)",
        And(
            some == ULT(va, BitVecVal(2**192, 256)),
            Implies(some, wide(floor64, 256) == LShR(va, 64)),
        ),
    )
)
ceil64, some = checked_ceil_shr64(a)
reference_ceil = LShR(wide(va, 257) + BitVecVal(Q - 1, 257), 64)
results.append(
    prove(
        "checked_ceil_shr64: Some exactly when ceil(a / 2^64) < 2^128, and then that ceiling",
        And(
            some == ULT(reference_ceil, BitVecVal(U128, 257)),
            Implies(some, wide(ceil64, 257) == reference_ceil),
        ),
    )
)
results.append(
    prove(
        "times_q: x * 2^64 exactly (every u128 x)",
        val(times_q(x)) == wide(x, 256) << 64,
    )
)
lo128, some128 = to_u128(a)
lo64, some64 = to_u64(a)
results.append(
    prove(
        "to_u128 and to_u64: Some exactly when the value fits, and then the value",
        And(
            some128 == ULT(va, BitVecVal(U128, 256)),
            Implies(some128, wide(lo128, 256) == va),
            some64 == ULT(va, BitVecVal(Q, 256)),
            Implies(some64, wide(lo64, 256) == va),
        ),
    )
)

# --- PM-1: div_rem, the start of the loop (bit vectors, as written) ------------------------
# `self >= d > 0`: `shift = d.leading_zeros().checked_sub(self.leading_zeros())?`, then
# `divisor = d.checked_shl(shift)?`. The shift is Some and at most 255 (so `with_bit` never
# refuses), and at most d's leading zero count, so by the checked_shl claims the divisor is
# Some and exactly D = d << shift = d × 2^shift, losing no bit; and the dividend is below 2D.
dn, dd = u256("n"), u256("d")
vn, vd = val(dn), val(dd)
shift, ok_shift = sub32(leading_zeros(dd), leading_zeros(dn))
results.append(
    prove(
        "div_rem start: for n >= d > 0 the shift is Some, at most 255 and at most d's leading zeros (so D = d << shift is Some and exact), and n < 2D",
        And(
            ok_shift,
            ULE(shift, c32(255)),
            ULE(shift, clz(vd, 256)),
            ULT(wide(vn, 257), 2 * wide(vd << wide(shift, 256), 257)),
        ),
        vd != 0,
        ge(dn, dd),
    )
)
results.append(
    prove(
        "div_rem: d == 0 is None (is_zero), and self < d returns (0, self) by the derived Ord",
        And((vd == 0) == And(dd.hi == 0, dd.lo == 0), Not(ge(dn, dd)) == ULT(vn, vd)),
    )
)

# --- PM-1: div_rem, one pass of the loop (integers, through the contracts above) ----------
# At the head of a pass, with p = 2^bit and D the divisor:
#   D == d × p, q == m × 2p (bits 0 to `bit` of q clear), n == q × d + rem, 0 <= rem < 2D.
# The body: `if rem >= divisor { rem = rem.checked_sub(divisor)?; quotient =
# quotient.with_bit(bit)? }`; `if bit == 0 { break }`; `bit = bit.checked_sub(1)?`; `divisor
# = divisor.checked_shr(1)?`. Through the contracts: `>=` is numeric, `checked_sub` subtracts
# (Some since rem >= D), `with_bit` adds p (Some since bit <= 255, and bit `bit` of q is clear),
# `checked_shr(1)` halves rounding down (Some), and u32 `bit - 1` is Some for bit >= 1.
n, d, D, p, p2, q, m, rem, bit = (Int(v) for v in ["n", "d", "D", "p", "p2", "q", "m", "rem", "bit"])
head = [
    d >= 1,
    n >= 0,
    n < U256,
    p >= 1,
    D == d * p,
    D < U256,
    m >= 0,
    q == m * 2 * p,
    n == q * d + rem,
    rem >= 0,
    rem < 2 * D,
    bit >= 0,
    bit <= 255,
]
take = rem >= D
rem1 = If(take, rem - D, rem)
q1 = If(take, q + p, q)
results.append(
    prove(
        "div_rem start: q = 0, rem = n, D = d * 2^shift with n < 2D meets the loop invariant",
        And(*[h for h in head]),
        d >= 1,
        n >= 0,
        n < U256,
        p >= 1,
        D == d * p,
        D < U256,
        m == 0,
        q == 0,
        rem == n,
        n < 2 * D,
        bit >= 0,
        bit <= 255,
    )
)
results.append(
    prove(
        "div_rem pass with bit = 0 (p = 1): the loop exits with q * d + rem == n, rem < d, q < 2^256",
        And(q1 * d + rem1 == n, rem1 >= 0, rem1 < d, q1 >= 0, q1 < U256),
        *head,
        bit == 0,
        p == 1,
    )
)
D2, bit2 = Int("D2"), Int("bit2")
m2 = If(take, 2 * m + 1, 2 * m)
results.append(
    prove(
        "div_rem pass with bit >= 1 (p = 2 * 2^(bit - 1)): every checked step is Some and the invariant holds at bit - 1",
        And(
            bit - 1 >= 0,  # `bit.checked_sub(1)` is Some
            D2 == d * p2,  # the halving is exact
            D2 < U256,
            q1 == m2 * 2 * p2,
            n == q1 * d + rem1,
            rem1 >= 0,
            rem1 < 2 * D2,
            bit2 >= 0,
            bit2 <= 255,
            q1 < U256,
        ),
        *head,
        bit >= 1,
        p == 2 * p2,
        p2 >= 1,
        bit2 == bit - 1,
        floor_of(D2, D, 2),  # `checked_shr(1)`
    )
)
# div_floor and div_ceil, from div_rem's (q, r).
r, c = Int("r"), Int("c")
quotient = [d >= 1, n >= 0, n < U256, q >= 0, n == q * d + r, r >= 0, r < d]
results.append(
    prove(
        "div_ceil: q + (r != 0), whose checked_add is never None, is ceil(n / d); div_floor is floor(n / d)",
        And(ceil_of(c, n, d), c < U256, floor_of(q, n, d)),
        *quotient,
        c == If(r == 0, q, q + 1),
    )
)

# --- PM-3: mul_u128 (integers, U256::mul on 64-bit digits as opening_z3.py writes it) -------


def split(name, value):
    """`value`'s high and low 64-bit digits as fresh variables, and the facts tying them."""
    high, low = Int(f"{name}_high"), Int(f"{name}_low")
    return high, low, And(value == high * Q + low, low >= 0, low < Q, high >= 0)


def mul(a1, a0, b1, b0):
    """`U256::mul` as written, on operands given by their 64-bit halves (see opening_z3.py).
    Returns the result's limbs `(hi, lo)`, the splits' facts, and the conditions each checked
    step needs."""
    p00, p01, p10, p11 = a0 * b0, a0 * b1, a1 * b0, a1 * b1
    h00, l00, f00 = split("p00", p00)
    h01, l01, f01 = split("p01", p01)
    h10, l10, f10 = split("p10", p10)
    mid = h00 + l01 + l10
    hm, lm, fm = split("mid", mid)
    lo = lm * Q + l00
    hi = p11 + h01 + h10 + hm
    facts = And(f00, f01, f10, fm)
    fits = And(p00 < U128, p01 < U128, p10 < U128, p11 < U128, mid < U128, hi < U128)
    return hi, lo, facts, fits


def digit(name):
    v = Int(name)
    return v, And(v >= 0, v < Q)


lo1, lo1_ok = digit("lo1")
lo0, lo0_ok = digit("lo0")
x1, x1_ok = digit("x1")
x0, x0_ok = digit("x0")
ahi = Int("ahi")
ahi_ok = And(ahi >= 0, ahi < U128)
low_hi, low_lo, facts, fits = mul(lo1, lo0, x1, x0)
xv = x1 * Q + x0
whole = (ahi * U128 + lo1 * Q + lo0) * xv
# `let low = U256::mul(self.lo, x)?; let hi = self.hi.checked_mul(x)?.checked_add(low.hi)?;`
hx = ahi * xv
some = And(fits, hx < U128, hx + low_hi < U128)
results.append(
    prove(
        "mul_u128: U256::mul(lo, x) never refuses, the result is Some exactly below 2^256, and then (hi * 2^128 + lo) * x",
        And(fits, some == (whole < U256), Implies(some, (hx + low_hi) * U128 + low_lo == whole)),
        lo1_ok,
        lo0_ok,
        x1_ok,
        x0_ok,
        ahi_ok,
        facts,
    )
)

# --- PM-11: isqrt (the start over bit vectors above; one pass over the integers) ------------
# `bit = n.highest_power_of_four()?` (a power of four with bit <= n < 4 bit, 4 bit <= 2^256,
# or 0 for 0, by the claim above); then `while !bit.is_zero() { trial =
# root.checked_add(bit)?; if rem >= trial { rem = rem.checked_sub(trial)?; root =
# root.checked_shr(1)?.checked_add(bit)? } else { root = root.checked_shr(1)? }; bit =
# bit.checked_shr(2)? }`, then `None` if `root.hi != 0`.
#
# At the head of a pass, with b = 4 × bit and y the root found so far:
#   root == y × b, rem == n - y² × b, 0 <= rem < (2y + 1) × b,
#   and, with B0 = 4 × the first bit = z² × b, 0 <= y < z (which keeps `trial` in 256 bits).
# `bit` is a power of four throughout: either 1, or 4 × the next `bit` (the claim on
# `checked_shr(2)` above).
# For n = 0, `highest_power_of_four` is 0, the loop never runs, and `isqrt` returns 0, the
# floor square root of 0.
y, b, root, z, B0, nbit = (Int(v) for v in ["y", "b", "root", "z", "B0", "nbit"])
sq_head = [
    n >= 1,
    n < U256,
    bit >= 1,
    b == 4 * bit,
    root == y * b,
    rem == n - y * y * b,
    rem >= 0,
    rem < (2 * y + 1) * b,
    z >= 1,
    B0 == z * z * b,
    B0 <= U256,
    y >= 0,
    y < z,
]
trial = root + bit
sq_take = rem >= trial
rem_s = If(sq_take, rem - trial, rem)
half = Int("half")  # `root.checked_shr(1)`
root_s = If(sq_take, half + bit, half)
y_s = If(sq_take, 2 * y + 1, 2 * y)
results.append(
    prove(
        "isqrt start: from bit = highest_power_of_four(n) (n >= 1), root = 0 and rem = n meet the loop invariant",
        And(*sq_head),
        n >= 1,
        n < U256,
        bit >= 1,
        bit <= n,
        n < 4 * bit,
        4 * bit <= U256,
        b == 4 * bit,
        root == 0,
        rem == n,
        y == 0,
        z == 1,
        B0 == b,
    )
)
results.append(
    prove(
        "isqrt pass: trial = root + bit and root / 2 + bit stay below 2^256 (Some), and the halving is exact",
        And(trial < U256, half * 2 == root, half + bit < U256),
        *sq_head,
        floor_of(half, root, 2),
    )
)
results.append(
    prove(
        "isqrt pass with bit = 1: the loop exits with root^2 <= n < (root + 1)^2 and root < 2^128 (root.hi == 0, Some)",
        And(root_s * root_s <= n, n < (root_s + 1) * (root_s + 1), root_s >= 0, root_s < U128),
        *sq_head,
        bit == 1,
        floor_of(half, root, 2),
    )
)
results.append(
    prove(
        "isqrt pass with bit = 4 * next bit: the invariant holds at the next bit",
        And(
            nbit >= 1,
            bit == 4 * nbit,
            root_s == y_s * bit,
            rem_s == n - y_s * y_s * bit,
            rem_s >= 0,
            rem_s < (2 * y_s + 1) * bit,
            B0 == (2 * z) * (2 * z) * bit,
            y_s >= 0,
            y_s < 2 * z,
        ),
        *sq_head,
        bit >= 4,
        bit == 4 * nbit,
        floor_of(half, root, 2),
    )
)

print(f"{sum(results)} of {len(results)} claims proven")
sys.exit(0 if all(results) else 1)
