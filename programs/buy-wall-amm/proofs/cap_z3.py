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

And the Book of Knowledge invariants (`.bok/confirmed-invariants/CONFIRMED.md`):

- CAP-1: steps 5 and 6 never refuse a swap on a reachable market (every checked step of
  `Inventory::after_swap` succeeds, and the market stays in the reachable envelope);
- CAP-2: a trim never takes the wall's backing: ledgers that covered the curve and the wall
  before it still cover both after it;
- CAP-3: over any sequence of swaps the cap falls by at most the starting credit plus the decay
  of the time that really passed, and the decay clock never runs backwards: the clock rule
  `decay_time = max(decay_time, now)` (`decay_time_after` below).

And the reward share's budget (`POOL4-49`): the ratchet adds every unit the cap falls to
`cap_fall_unmatched`, and a trim moves `min(trimmed tokens, cap_fall_unmatched)` from it into
`retired_rewardable`, never more than it retires, so `retired_rewardable` stays within
`retired_tokens` and every unit the cap has fallen since the seed is either unmatched or
rewardable (settled or not), never both and never lost (`payouts_z3.py` proves `settle` keeps
it, and so the rewards within the reward share of the cap's fall).

The link between this model and the compiled Rust is checked by tests: `U256::div_rem` is
proven exact for every 256-bit pair (`math_z3.py`), Proptest checks `Inventory::after_swap` against the spec's
formulas written out on 10,000 random reachable markets (`src/cap.rs`), and the worked
example's numbers are reproduced through the router (`tests/cap.rs`).

Run: `pip install z3-solver==5.4.1.0` (in a virtualenv), then
`python programs/buy-wall-amm/proofs/cap_z3.py`. Exits non-zero unless every claim is proven.
"""

import sys
import time

from z3 import And, If, Int, Not, Or, Solver, sat, unsat

Q = 2**64  # Q64.64's one
SECONDS_PER_DAY = 86_400
DECAY_CREDIT_WINDOW = 86_400
MIN_LIQUIDITY = 1_000_000
MIN_SQRT_PRICE = 2**32
MAX_SQRT_PRICE = 2**96
U64 = 2**64
U128 = 2**128
I64_MIN, I64_MAX = -(2**63), 2**63 - 1


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

# --- CAP-1: steps 5 and 6 never refuse a swap on a reachable market ------------------------
# The reachable envelope (the Book of Knowledge invariant CAP-1): the price within the trading
# bounds, the curve between MIN_LIQUIDITY and 2^88 (the opening proves it below 2^88,
# `opening_z3.py`, and a trim only lowers it, above), the cap floor between 1 and the cap, each
# vault's ledgers summing to at most u64::MAX (they are what the vault holds), the pool
# ledgers covering the curve, and the lifetime trimmed totals at most u64::MAX per swap so far,
# with fewer than u64::MAX swaps (`pricing::settle` refuses the swap whose count would pass
# it before step 5 runs). Every operation of `Inventory::after_swap` that can return `None`
# then succeeds.
retired, idle, swaps, tokens_trimmed, sol_trimmed = (
    Int(n) for n in ["retired", "idle", "swaps", "tokens_trimmed", "sol_trimmed"]
)
envelope = [
    s >= MIN_SQRT_PRICE,
    s <= MAX_SQRT_PRICE,
    L >= MIN_LIQUIDITY,
    L < 2**88,
    floor >= 1,
    floor <= cap,
    cap < U64,
    pool_tokens >= 0,
    pool_sol >= 0,
    retired >= 0,
    idle >= 0,
    pool_tokens + retired < U64,
    pool_sol + idle < U64,
    Ls == L * s,
    L * Q <= pool_tokens * s,
    Ls <= pool_sol * Q,
    swaps >= 0,
    swaps <= U64 - 2,
    tokens_trimmed >= 0,
    sol_trimmed >= 0,
    tokens_trimmed <= swaps * (U64 - 1),
    sol_trimmed <= swaps * (U64 - 1),
]
results.append(
    prove(
        "steps 5 and 6: what the curve holds, floor(L * Q / s), fits in 128 bits (held's to_u128)",
        held < 2**128,
        *envelope,
        floor_of(held, L * Q, s),
    )
)
results.append(
    prove(
        "steps 5 and 6, the ratchet (held < cap): every checked step is Some and the cap stays at or above its floor",
        And(
            new_cap <= cap,  # `cap.checked_sub(lowered)`
            (cap - new_cap) * SECONDS_PER_DAY <= credit,  # `decay_credit.checked_sub(..)`
            new_cap < U64,  # `u64::try_from(lowered)`
            held < U64,  # `u64::try_from(held)`
            new_cap >= floor,
            credit - (cap - new_cap) * SECONDS_PER_DAY <= per_day * DECAY_CREDIT_WINDOW,
        ),
        *envelope,
        *ratchet,
        per_day >= 0,
        credit <= per_day * DECAY_CREDIT_WINDOW,
    )
)
results.append(
    prove(
        "steps 5 and 6, the trim (held > cap): every checked step is Some, on any reachable market",
        And(
            cap_s < 2**192,  # `U256::mul(cap, s)?.checked_shr64()?`
            kept_tokens < 2**128,  # `held_rounded_up`'s to_u128
            kept_sol < 2**128,  # `held_rounded_up`'s checked_ceil_shr64
            curve_sol < 2**128,  # `U256::mul(L, s)?.checked_shr64()?`
            tokens < U64,  # `u64::try_from(..)`
            sol < U64,
            tokens <= pool_tokens,  # `pool_tokens.checked_sub(trim.tokens)`
            retired + tokens < U64,  # `retired_tokens.checked_add(trim.tokens)`
            sol <= pool_sol,  # `pool_sol.checked_sub(trim.sol)`
            idle + sol < U64,  # `idle_sol.checked_add(trim.sol)`
            tokens_trimmed + tokens < 2**128,  # the lifetime totals' checked_add
            sol_trimmed + sol < 2**128,
        ),
        *envelope,
        *trim,
    )
)
results.append(
    prove(
        "steps 5 and 6, the trim: the market stays in the envelope (liquidity in range, ledger sums kept, totals per swap)",
        And(
            new_L >= MIN_LIQUIDITY,
            new_L < 2**88,
            (pool_tokens - tokens) + (retired + tokens) == pool_tokens + retired,
            (pool_sol - sol) + (idle + sol) == pool_sol + idle,
            tokens_trimmed + tokens <= (swaps + 1) * (U64 - 1),
            sol_trimmed + sol <= (swaps + 1) * (U64 - 1),
        ),
        *envelope,
        *trim,
    )
)

# --- CAP-2: a trim never takes the wall's backing ------------------------------------------
# The trim sizes its take from the curve alone (`Inventory` carries no wall), so this proves
# that the pool ledgers that covered the curve and the wall before a trim still cover both
# after it, for any wall holdings: `wall_tokens` stands for the wall's token units times
# `top × s` (W × Q × (top - s) below its top, 0 at or above it) and `wall_sol` for its lamports
# times Q (W × min(s, top)), each any non-negative amount. The trim changes neither the price
# nor the wall.
top, wall_tokens, wall_sol, st = Int("top"), Int("wall_tokens"), Int("wall_sol"), Int("st")
walled = [
    top > 0,
    wall_tokens >= 0,
    wall_sol >= 0,
    st == s * top,
    L * Q * top + wall_tokens <= pool_tokens * st,
    Ls + wall_sol <= pool_sol * Q,
]
results.append(
    prove(
        "trim: the pool ledgers still cover the curve's and the wall's tokens",
        new_L * Q * top + wall_tokens <= (pool_tokens - tokens) * st,
        *trim,
        *walled,
    )
)
results.append(
    prove(
        "trim: the pool ledgers still cover the curve's and the wall's SOL",
        newLs + wall_sol <= (pool_sol - sol) * Q,
        *trim,
        *walled,
    )
)

# --- CAP-3: the cap never falls faster than its decay rate, over any sequence --------------
# Step 5 as written (`accrue`): the time since `decay_time`, i64-saturated and 0 if negative;
# the credit plus `per_day` for each of those seconds, saturating at 2^128 - 1, then at most a
# day's allowance. Step 6 spends 86,400 of credit per unit the cap falls (`by`, 0 on a trim or
# no change), which the ratchet claims above prove it can afford.
#
# The decay clock rule these claims state: the clock never runs backwards, `decay_time =
# max(decay_time, now)`, as src/cap.rs (`after_swap`) writes it.


def decay_time_after(then, now):
    """`Inventory::after_swap`'s new `decay_time`, as written in src/cap.rs: `max(then, now)`."""
    return maximum(then, now)


def elapsed(then, now):
    """`u128::try_from(now.saturating_sub(then)).unwrap_or(0)`."""
    d = now - then
    saturated = If(d > I64_MAX, I64_MAX, If(d < I64_MIN, I64_MIN, d))
    return If(saturated < 0, 0, saturated)


def accrue(credit, per_day, then, now):
    """`accrue` as written: saturating sum, then the day's limit."""
    total = credit + per_day * elapsed(then, now)
    return minimum(If(total >= U128, U128 - 1, total), per_day * DECAY_CREDIT_WINDOW)


def i64(v):
    return And(I64_MIN <= v, v <= I64_MAX)


then, now, by, credit_after = Int("then"), Int("now"), Int("by"), Int("credit_after")
swap_step = [
    i64(then),
    i64(now),
    per_day >= 0,
    per_day < U64,
    credit >= 0,
    credit < U128,
    accrued == accrue(credit, per_day, then, now),
    # The ratchet's contract (proved above): by >= 0 and 86,400 × by never more than the
    # credit; a trim or no change spends nothing (by = 0).
    by >= 0,
    by * SECONDS_PER_DAY <= accrued,
    credit_after == accrued - by * SECONDS_PER_DAY,
]
results.append(
    prove(
        "decay: one swap's credit left plus 86,400 per unit fallen never exceeds the credit before plus the decay of the seconds elapsed",
        credit_after + by * SECONDS_PER_DAY <= credit + per_day * elapsed(then, now),
        *swap_step,
    )
)
time_after = decay_time_after(then, now)
results.append(
    prove(
        "decay clock (clock rule): decay_time never runs backwards",
        time_after >= then,
        *swap_step,
    )
)
results.append(
    prove(
        "decay clock (clock rule): one swap's credit left plus 86,400 per unit fallen never exceeds the credit before plus the decay of how far the clock moved",
        credit_after + by * SECONDS_PER_DAY <= credit + per_day * (time_after - then),
        *swap_step,
    )
)
# Three swaps in a row at any clock readings: the cap falls, in all, by no more than the credit
# at the start plus the decay of the time from the first clock to the latest reading seen.
times = [Int(f"t{i}") for i in range(4)]  # t0 is the stored decay_time; t1..t3 the swaps' clocks
credits = [Int(f"credit{i}") for i in range(4)]
accrueds = [Int(f"accrued{i}") for i in range(1, 4)]
bys = [Int(f"by{i}") for i in range(1, 4)]
clocks = [times[0]]
sequence = [per_day >= 0, per_day < U64, credits[0] >= 0, credits[0] <= per_day * DECAY_CREDIT_WINDOW, i64(times[0])]
for i in range(3):
    sequence += [
        i64(times[i + 1]),
        accrueds[i] == accrue(credits[i], per_day, clocks[i], times[i + 1]),
        bys[i] >= 0,
        bys[i] * SECONDS_PER_DAY <= accrueds[i],
        credits[i + 1] == accrueds[i] - bys[i] * SECONDS_PER_DAY,
    ]
    clocks.append(decay_time_after(clocks[i], times[i + 1]))
latest = maximum(maximum(times[0], times[1]), maximum(times[2], times[3]))
results.append(
    prove(
        "decay clock (clock rule): over three swaps the cap falls by at most (credit at the start + per_day x (latest clock - first)) / 86,400",
        (bys[0] + bys[1] + bys[2]) * SECONDS_PER_DAY + credits[3] <= credits[0] + per_day * (latest - times[0]),
        *sequence,
    )
)

# --- POOL4-49: the reward share's budget -------------------------------------------------
# `unmatched` is `cap_fall_unmatched`, `rewardable` is `retired_rewardable` and `settled` the
# rewardable units every earlier `settle` emptied; `seeded` is `seeded_tokens`, the cap at the
# seed. On every reachable market `rewardable <= retired`, `unmatched <= per_day` and
# `settled + rewardable + unmatched <= seeded - cap`, all 0 at the seed (the seed writes neither
# field and sets the cap to the seeded tokens). The ratchet adds the units the cap fell to
# `unmatched`, up to one day's allowance (`unmatched_after_fall`, review finding R2-01: the
# rest of the fall is never rewarded); a trim moves `eligible = min(tokens, unmatched)` from
# `unmatched` to `rewardable` as it adds `tokens` to `retired`.
unmatched, rewardable, settled, seeded, eligible = (
    Int(n) for n in ["unmatched", "rewardable", "settled", "seeded", "eligible"]
)
budget = [
    unmatched >= 0,
    rewardable >= 0,
    settled >= 0,
    rewardable <= retired,
    unmatched <= per_day,
    settled + rewardable + unmatched <= seeded - cap,
    seeded < U64,
]
# `unmatched_after_fall`: unchanged when the cap did not fall, else the sum capped at one day's
# allowance, `per_day`, independent of `DECAY_CREDIT_WINDOW` (as `src/cap.rs` caps it).
unmatched_after = If(cap - new_cap == 0, unmatched, minimum(unmatched + (cap - new_cap), per_day))
results.append(
    prove(
        "reward budget, the ratchet: the cap's fall joins cap_fall_unmatched up to one day's allowance, so the budget is kept, the unmatched fall never exceeds the allowance and every narrowing fits",
        And(
            settled + rewardable + unmatched_after <= seeded - new_cap,
            unmatched_after <= per_day,
            unmatched_after >= 0,
            unmatched + (cap - new_cap) < 2**128,  # the u128 sum before the cap
            unmatched_after < U64,  # `u64::try_from` of the capped sum
        ),
        *envelope,
        *ratchet,
        *budget,
        per_day >= 0,
        credit <= per_day * DECAY_CREDIT_WINDOW,
    )
)
trim_rewardable = [eligible == minimum(tokens, unmatched)]
results.append(
    prove(
        "reward budget, the trim: it makes rewardable no more than it retires and no more than the cap's unmatched fall, keeps the budget, and never overflows",
        And(
            eligible >= 0,
            eligible <= tokens,
            unmatched - eligible >= 0,  # `cap_fall_unmatched.checked_sub(eligible)`
            rewardable + eligible <= retired + tokens,
            rewardable + eligible < U64,  # `retired_rewardable.checked_add(eligible)`
            settled + (rewardable + eligible) + (unmatched - eligible) <= seeded - cap,
            unmatched - eligible <= per_day,
        ),
        *envelope,
        *trim,
        *budget,
        *trim_rewardable,
    )
)
results.append(
    prove(
        "reward budget, the trim: a trim from a cap with no unmatched fall makes nothing rewardable (a dip sold into a tight cap)",
        eligible == 0,
        *envelope,
        *trim,
        *budget,
        *trim_rewardable,
        unmatched == 0,
    )
)

print(f"{sum(results)} of {len(results)} claims proven")
sys.exit(0 if all(results) else 1)
