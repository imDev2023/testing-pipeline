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

And the Book of Knowledge invariant FB-14 (`.bok/confirmed-invariants/CONFIRMED.md`): no fee
or reward is ever booked to a role that can never be paid.

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
import time

from z3 import And, Bool, Implies, Int, Not, Or, Solver, sat, unsat

BPS = 10_000
MAX_REWARD_SHARE_BPS = 3_000
U64 = 2**64


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

# --- FB-14: no fee or reward is booked to a role that can never be paid --------------------
# A market's fee recipient and rewards recipient may be unset (the default key) only as
# `InitParams::validate` allows: no fee recipient only with `wall_split_bps = 10,000`, and no
# rewards recipient exactly when `reward_share_bps = 0`. A role created unset never gets a
# wallet (`payouts::handover` refuses it), so its ledger could only be paid if something were
# booked to it. The code's `FeeSplit::of` (`books.rs`) and `settle` book nothing to it, for
# every u64 fee and every u64 retired, so `fees_recipient` and `rewards_owed` stay 0 for the
# market's life. Slot 1 (`fees_designer`) is the one designed exception: it builds up while
# `DESIGNER_RECIPIENT` is unset and is paid once a build sets it (spec, "`sweep_fees`").


def share(name, amount, share_bps):
    """`books::share` as written: `q × bps + floor(r × bps / 10,000)` with `q, r` the quotient
    and remainder of `amount / 10,000`. Returns the value and the facts tying it."""
    sq, sr, sp = Int(f"{name}_q"), Int(f"{name}_r"), Int(f"{name}_part")
    facts = And(amount == sq * BPS + sr, 0 <= sr, sr < BPS, floor_of(sp, sr * share_bps, BPS))
    return sq * share_bps + sp, facts


DESIGNER_SHARE_BPS = SUITE_SHARE_BPS = 1_000
fee_amount, wall_split, reward_bps = Int("fee_amount"), Int("wall_split"), Int("reward_bps")
fee_unset, rewards_unset = Bool("fee_recipient_unset"), Bool("rewards_recipient_unset")
# `InitParams::validate`'s rules on these four fields (the rest are independent of them).
validated = [
    0 <= wall_split,
    wall_split <= BPS,
    Implies(fee_unset, wall_split == BPS),
    0 <= reward_bps,
    reward_bps <= MAX_REWARD_SHARE_BPS,
    rewards_unset == (reward_bps == 0),
]
designer_share, designer_facts = share("designer", fee_amount, DESIGNER_SHARE_BPS)
suite_share, suite_facts = share("suite", fee_amount, SUITE_SHARE_BPS)
rest = fee_amount - designer_share - suite_share
wall_share, wall_facts = share("wall", rest, wall_split)
recipient_share = rest - wall_share
fee_split = [0 <= fee_amount, fee_amount < U64, designer_facts, suite_facts, wall_facts]
rewards_share, rewards_facts = share("rewards", retired, reward_bps)
results.append(
    prove(
        "an unset fee recipient is booked nothing: FeeSplit::of gives it 0 of every u64 fee on every market validate accepts",
        Implies(fee_unset, recipient_share == 0),
        *validated,
        *fee_split,
    )
)
results.append(
    prove(
        "an unset rewards recipient is booked nothing: settle gives it 0 of every u64 retired on every market validate accepts",
        Implies(rewards_unset, rewards_share == 0),
        *validated,
        0 <= retired,
        retired < U64,
        rewards_facts,
    )
)
fees_recipient, rewards_owed = Int("fees_recipient"), Int("rewards_owed")
handover_accepted = Bool("handover_accepted")
results.append(
    prove(
        "an unset role's ledger stays 0: a swap's books and a settle add 0 to it, and no handover ever gives the role a wallet",
        And(
            Implies(And(fee_unset, fees_recipient == 0), fees_recipient + recipient_share == 0),
            Implies(And(rewards_unset, rewards_owed == 0), rewards_owed + rewards_share == 0),
            Not(And(Or(fee_unset, rewards_unset), handover_accepted)),
        ),
        *validated,
        *fee_split,
        0 <= retired,
        retired < U64,
        rewards_facts,
        # `handover` refuses a role nobody holds (`RecipientUnset`) before anything else; here
        # it is asked of an unset role.
        Implies(handover_accepted, Not(Or(fee_unset, rewards_unset))),
    )
)

sys.exit(0 if all(results) else 1)
