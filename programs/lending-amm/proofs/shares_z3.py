"""Z3 proofs of the share maths Kani proves only for small values (`src/shares.rs`), for every
input (docs/spec/lending-pool.md, "Shares", "Adding" and "Removing"; docs/spec/README.md,
"Test layers" 2).

1. `isqrt` is the floor of the square root of every u128. Its digit-by-digit loop keeps, at the
   top of each round with `bit = b`, the invariant that for the root `r` of the digit pairs
   handled so far `root = r x 4b`, `rest = n - r^2 x 4b` and `r^2 x 4b <= n < (r + 1)^2 x 4b`;
   one round takes it to `bit = b / 4` with `r' = 2r` or `2r + 1`, every intermediate inside a
   u128; the first loop's `bit`, the highest power of four not above `n` (or the top one),
   starts it with `r = 0`; and when the round with `bit = 1` ends the loop, `root = r` with
   `r^2 <= n < (r + 1)^2` and `r < 2^64`.
2. `totals_after_in_kind`: cTokens paid in kind take `floor(net x paid / held)` off the larger
   running total, so the net amount lent keeps its sign, and what is left is at least the
   remaining cTokens' part of it and less than one unit above it; the larger total never
   falls below the smaller. The Rust computes it without the product, as
   `floor(net / held) x paid + floor((net mod held) x paid / held)`, which equals it for every
   input, with every intermediate inside a u128, so it never fails on arithmetic.
3. `share_count` is the LP supply plus the locked minimum, refused exactly when that passes a
   u64.
4. After a later deposit, which checks that `N + shares` fits a u64, the new supply's share
   count fits a u64 too, so `share_count` never refuses an exit (Book of Knowledge SH-9).

Each division is modelled by its quotient and remainder, as in `lending_amm_z3.py`. Kani
proves the same statements of the Rust for small values, and Proptest checks them on 10,000
random inputs each.

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/lending-amm/proofs/shares_z3.py`. Exits non-zero unless every claim is proven.
"""

import sys

from z3 import And, If, Int, Or
from z3_common import U64_MAX, U128_MAX, constant, bounded, floor_div, prove


MINIMUM_LIQUIDITY = constant("MINIMUM_LIQUIDITY")


def main():
    ok = True

    # 1. isqrt. A round at the top of the loop with bit = b >= 1 (a power of four, at most 2^126):
    #   if rest >= root + b { rest -= root + b; root = (root >> 1) + b } else { root >>= 1 }
    #   b >>= 2
    n, n_ok = bounded("n", U128_MAX)
    b = Int("b")
    r = Int("r")
    rest = n - r * r * 4 * b
    root = r * 4 * b
    # Every power of four up to 2^126 is 2^126 itself or at most 2^124.
    b_ok = And(b >= 1, Or(b == 2**126, b <= 2**124))
    invariant = And(r >= 0, r * r * 4 * b <= n, n < (r + 1) * (r + 1) * 4 * b)
    taken = rest >= root + b
    # root >> 1 is exact: root = r x 4b is even.
    half = r * 2 * b
    root_next = If(taken, half + b, half)
    rest_next = If(taken, rest - root - b, rest)
    r_next = If(taken, 2 * r + 1, 2 * r)
    ok &= prove(
        "each round of isqrt keeps its invariant one digit pair further, inside a u128",
        And(
            root + b <= U128_MAX,
            rest >= 0,
            rest <= U128_MAX,
            root_next == r_next * b,
            rest_next == n - r_next * r_next * b,
            r_next * r_next * b <= n,
            n < (r_next + 1) * (r_next + 1) * b,
        ),
        n_ok,
        b_ok,
        invariant,
    )
    # The first loop stops at the first power of four from 2^126 down that is not above n
    # (or at 0 for n = 0, where the root is 0): with r = 0 the invariant needs n < 4b, which
    # holds since the power of four above b was above n, or b = 2^126 and 4b = 2^128 > n.
    above = Int("above")
    ok &= prove(
        "the starting bit makes the invariant hold with nothing handled yet",
        And(r * r * 4 * b <= n, n < (r + 1) * (r + 1) * 4 * b),
        n_ok,
        b_ok,
        b <= n,
        r == 0,
        Or(And(above == 4 * b, above > n), b == 2**126),
    )
    # After the round with b = 1 the loop ends with root = r' x 1, where r'^2 <= n < (r' + 1)^2
    # by the invariant: the floor of the square root, which the final cast keeps exactly.
    last = Int("last")
    ok &= prove(
        "when the loop ends the root, the floor of the square root, fits a u64",
        last <= U64_MAX,
        n_ok,
        last >= 0,
        last * last <= n,
    )

    # 2. totals_after_in_kind, with net = |deposited - redeemed| >= 0 and 1 <= paid <= held:
    # take = floor(net x paid / held), computed as q x paid + floor(r x paid / held) with
    # q = floor(net / held) and r = net mod held.
    deposited, deposited_ok = bounded("deposited", U128_MAX)
    redeemed, redeemed_ok = bounded("redeemed", U128_MAX)
    paid, paid_ok = bounded("paid", U64_MAX)
    held, held_ok = bounded("held", U64_MAX)
    net = If(deposited >= redeemed, deposited - redeemed, redeemed - deposited)
    take, take_facts = floor_div("take", net * paid, held)
    q, q_facts = floor_div("q", net, held)
    r = net - q * held
    tail, tail_facts = floor_div("tail", r * paid, held)
    ok &= prove(
        "the in-kind take, computed without the product, is floor(net x paid / held), every "
        "intermediate inside a u128",
        And(
            q * paid + tail == take,
            q * paid <= U128_MAX,
            r * paid <= U128_MAX,
            q * paid + tail <= U128_MAX,
        ),
        deposited_ok,
        redeemed_ok,
        paid_ok,
        held_ok,
        paid >= 1,
        paid <= held,
        take_facts,
        q_facts,
        tail_facts,
    )
    d_after = If(deposited >= redeemed, deposited - take, deposited)
    r_after = If(deposited >= redeemed, redeemed, redeemed - take)
    net_after = If(deposited >= redeemed, d_after - r_after, r_after - d_after)
    ok &= prove(
        "cTokens paid in kind take their part of the net amount lent off the larger total, "
        "which keeps its sign, leaving the remaining cTokens' part to within a unit",
        And(
            take >= 0,
            take <= net,
            net_after >= 0,
            If(deposited >= redeemed, d_after >= r_after, r_after >= d_after),
            net_after * held >= net * (held - paid),
            net_after * held < net * (held - paid) + held,
        ),
        deposited_ok,
        redeemed_ok,
        paid_ok,
        held_ok,
        paid >= 1,
        paid <= held,
        take_facts,
    )

    # 3. share_count.
    supply, supply_ok = bounded("supply", U64_MAX)
    count = supply + MINIMUM_LIQUIDITY
    ok &= prove(
        "the share count is the supply plus the locked minimum, above the supply",
        Or(And(count <= U64_MAX, count > supply), supply > U64_MAX - MINIMUM_LIQUIDITY),
        supply_ok,
    )

    # 4. The share count always fits a u64 after a later deposit (Book of Knowledge SH-9): with
    # N = supply + MINIMUM_LIQUIDITY a u64 (`share_count` accepted it) and the deposit's check
    # that N + shares fits a u64, the new supply's share count, supply + shares +
    # MINIMUM_LIQUIDITY, fits a u64 too, so `share_count` never refuses an exit after it.
    shares, shares_ok = bounded("shares", U64_MAX)
    ok &= prove(
        "after a later deposit the share count still fits a u64",
        And(supply + shares <= U64_MAX, supply + shares + MINIMUM_LIQUIDITY <= U64_MAX),
        supply_ok,
        count <= U64_MAX,
        shares_ok,
        shares >= 1,
        count + shares <= U64_MAX,
    )

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
