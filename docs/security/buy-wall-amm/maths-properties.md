# Buy wall AMM: maths properties

The properties the buy wall AMM's arithmetic always satisfies, and how each one is established, in the format of the [tax AMM's list](../tax-amm/maths-properties.md).
Book of Knowledge chose the properties to add in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55), on 2026-11-16, beside round 1 of the review ([README.md](README.md)), at the bar's "Test layers" 2 and 3 ([`docs/spec/README.md`](../../spec/README.md#test-layers)), for the formulas of [`docs/spec/pool4-for-solana.md`](../../spec/pool4-for-solana.md).
This is an internal verification, never presented as an audit.

**Result: no counterexample is open.**
Every Z3 claim is proven (134 of 134 in seven scripts, about 11 seconds in all, run on 2026-11-19); every default-tier Kani harness verified when it was written, with the times below; every Proptest property passes its 10,000 cases; and the invariant fuzzer has no known-failing invariant.
One property failed on the code before this ticket and was fixed: the cap's decay clock could run backwards (CAP-3, review finding H009, [`POOL4-51`](../../decisions.md#pool4-51-the-markets-clocks-never-run-backwards)).
Round 2's new rules are stated too: the hybrid floor (`POOL4-50` as amended on 2026-11-19) by Z3, Kani, Proptest, unit and LiteSVM tests, and the one-day cap on the unmatched fall (R2-01) by Kani, Proptest and LiteSVM, its Z3 model not yet updated, as [Not yet in Z3](#not-yet-in-z3) says.

## How the properties were chosen

Book of Knowledge scanned 19 files and found 62 regions of maths: two-step curve and wall pricing (11), fees (8), the settlement split and payouts (7), liquidity, holdings and the wall's close and place (11), the guard's reference and floor (5), the opening price and liquidity (8), the 256-bit Q64.64 helpers (6), the decay credit's clock (2) and the cap's ratchet and trim (4).
The feature tickets had already proved much of it: 35 Kani harnesses (15 default, 20 full tier), 50 Z3 claims in five scripts and 29 Proptest properties, the stateful fuzzer among them.
It then proposed 62 invariants in five groups (`PM` pricing and 256-bit maths, `CAP` the cap and trim, `WG` the wall and guard, `FB` fees, books and payouts, `OS` opening and state), merged three duplicates, and the session confirmed 25, chosen for closing a proof gap on the trading path, restating invariants the fuzzer stated too narrowly, and CI time.

| # | Confirmed invariant | Planned tool | What landed |
| --- | --- | --- | --- |
| 1 | PM-1, PM-2: `U256::div_rem` and its limb operations exact for every 256-bit pair | Z3 loop invariant | A1, A4: `proofs/math_z3.py` |
| 2 | PM-3: `mul_u128` exact | Z3 | A3: `proofs/math_z3.py` |
| 3 | PM-11 / OS-1: `isqrt` the floor square root for every 256-bit input, with `highest_power_of_four` | Z3 loop invariant, Kani default | A5: `proofs/math_z3.py`; Kani default `highest_power_of_four_is_the_largest_at_or_below` |
| 4 | CAP-6: `checked_shr64`, `checked_ceil_shr64` exact floor and ceiling | Kani default | A1: Kani default `shr64_is_the_exact_floor_and_ceiling`, and Z3 |
| 5 | PM-12 / WG-8: `covers_checked` compares exactly | Kani default, Proptest | P10: Kani in the full tier only (past 5 minutes), two Proptests |
| 6 | PM-4: a reachable trade never refuses with `Overflow` | Z3 bit widths, Proptest | P7 |
| 7 | PM-6: a sell bought straight back never profits | Z3, Proptest | P6 |
| 8 | PM-9: two steps always suffice; `PriceBoundReached` only at a bound | Kani default | P8 |
| 9 | CAP-1: steps 5 and 6 never refuse a swap on a reachable market | Z3, Proptest | C4 |
| 10 | CAP-2: a trim never takes the wall's backing | Z3 | C5 |
| 11 | CAP-3: the cap never falls faster than its decay rate, and its clock never runs backwards | Z3, Proptest | C6 (failed before the fix) |
| 12 | WG-1, WG-2, WG-3: the guard for every input, the floor independent of the swap's price, the guard's state invariant | Z3 | G1 to G4: `proofs/guard_z3.py` |
| 13 | WG-5: `place_wall` cannot be called twice for two tips | Z3, Proptest | W4 |
| 14 | WG-7: self-dealing around `place_wall` and payouts never profits, tips and rewards counted | fuzzer | L10 |
| 15 | FB-3: the fee shares stay total for any policy values a deploy could choose | build-time `const` assert | Not landed: see [Confirmed but not landed as planned](#confirmed-but-not-landed-as-planned) |
| 16 | FB-4, FB-5: `Books::after` conserves the ledgers and books each share in its own ledger, in the default tier | Kani default | F2 |
| 17 | FB-7: `Counters::after` adds exactly the trade to the right mint | Kani default | F4 |
| 18 | FB-10, FB-11: payouts move exactly one ledger and touch nothing else | Kani default | R3, R4 |
| 19 | FB-12: the 764 s settlement harness moved to the full tier, an exhaustive remainder test in its place | re-tier | R1 (review finding H066) |
| 20 | FB-13: `params::validate` accepts exactly the spec's table | Proptest | F5 |
| 21 | FB-14: no fee or reward booked to a role that can never be paid | Z3, Kani | F6: Z3 |
| 22 | FB-15: lifetime totals never decrease and grow by exactly what moved | fuzzer | L13 |
| 23 | OS-4: `open` refuses a cap floor above the cap (defence in depth) | code guard, Kani | O5: code guard, Proptest, unit and LiteSVM tests (review finding H023) |
| 24 | OS-6: the seed writes every field the spec names and leaves every other byte zero | LiteSVM | O7 |
| 25 | OS-8: every state accessor round-trips and writes only its own bytes | Kani default | S1 |

Beyond those 25, the fixes added properties of their own: the reward budget of `POOL4-49` (C7, R2) with R2-01's one-day cap, the slot-based floor and the clock rule of `POOL4-50` and `POOL4-51` (G2, G3, W3), the hybrid floor's placement cap (G5), the handover rule of `POOL4-52` (R5), and the self-dealing and reward-ledger invariants of the fuzzer (L10, L11).

Out of scope here, because another layer owns them:

- The trader's minimum output, Pipeline's fee and the credited input are the router's, proven in Pipeline's own verification; the strategy's side of credited input is the fuzzer's value conservation.
- That a quote equals its swap holds because both call the same pricing; the fuzzer checks it after every step and `pipeline-check`'s conformance on every test market.
- Account, signer and CPI checks are the review's ([round-1.md](round-1.md)), not maths properties.

## How the properties are checked

| Tool | What it gives | Where |
| --- | --- | --- |
| **Kani** 0.67.0 | A proof of the Rust itself, for every input in the stated bound; the default tier runs in CI, the full tier (`--cfg kani_full`) only by hand | the `proofs` modules of `src/math.rs`, `opening.rs`, `pricing.rs`, `books.rs`, `cap.rs`, `guard.rs`, `wall.rs`, `payouts.rs`, `state.rs`: 34 default and 23 full-tier harnesses |
| **Z3** 5.4.1 | A proof for every input of the arithmetic, modelled step by step from the Rust; `math_z3.py` proves the 256-bit limb operations over bit vectors and the loops of `div_rem` and `isqrt` by loop invariants | `programs/buy-wall-amm/proofs/*_z3.py`: 134 claims in seven scripts |
| **Proptest** | 10,000 random cases a property against the real functions | 38 properties in `src/`; `tests/seed_state.rs` (2, through LiteSVM) |
| **Invariant fuzzer** | Random instruction sequences through the real router in LiteSVM, every invariant checked after every step | `tests/fuzz.rs`: 256 sequences of up to 31 steps by default (`PROPTEST_CASES`) |
| **LiteSVM tests** | Named attacks replayed through the router (`sos_<finding id>`) and the worked example | `tests/*.rs` |

Kani's SAT back end cannot relate a 128- or 256-bit quotient to its inputs over the full range in reasonable time, so the statements about divisions, the pricing steps and the trim are proven for every input by Z3, with Kani proving the same Rust for small inputs, and Proptest tying the Z3 models to the compiled code in CI.
Where a Kani harness needs a division loop (`div_rem`, `isqrt`), it lives in the full tier; the default tier holds what CBMC finishes in seconds to a minute.

Run them (`docs/toolchain.md` has the setup):

```sh
source scripts/toolchain-env.sh && cd programs
cargo kani -p buy-wall-amm -j --output-format=terse                     # the default tier
RUSTFLAGS="--cfg kani_full" cargo kani -p buy-wall-amm --harness <name>  # one full-tier harness
cd .. && for p in programs/buy-wall-amm/proofs/*_z3.py; do python "$p"; done   # with z3-solver 5.4.1.0
cd programs && cargo test -p buy-wall-amm --lib                           # unit tests and Proptest
cargo test -p buy-wall-amm --test fuzz                                    # the invariant fuzzer
cargo test -p buy-wall-amm --test seed_state                              # the seed's full-state Proptests
```

CI runs every program's Z3 proofs and Kani default tier in the `kani` job on every pull request that changes on-chain code, and the tests in the `rust` job; it never runs the full tier, which review finding H068 records and the owner signed off ([sign-offs.md](sign-offs.md)).

## The properties

IDs are stable within this file; the BOK column gives the Book of Knowledge ID where one exists, which the harness and claim comments carry.
"New" marks what this ticket added; the rest was proved by the feature tickets and kept.

### 256-bit arithmetic (`src/math.rs`)

| ID | BOK | Property | How | New |
| --- | --- | --- | --- | --- |
| A1 | PM-2, CAP-6 | Each limb operation is the 256-bit operation it names, `None` exactly when out of range: the derived order, `checked_add`, `checked_sub`, `checked_shr`, `checked_shl` (four branches), `leading_zeros`, `with_bit`, `checked_shr64`, `checked_ceil_shr64`, `times_q`, `to_u128` and `to_u64` | Z3 (`math_z3.py`, bit vectors, every input); Kani default `shr64_is_the_exact_floor_and_ceiling` (every 256-bit value, 2 s); Proptest `shl_is_exact`, `times_q_round_trips` | Z3, Kani |
| A2 | | `U256::mul` and `mul_u64` are exact, `mul_u64` `None` exactly past 2^256 | Z3 (`opening_z3.py`, every input); Kani default `mul_agrees_with_u128_bounded` (operands below 2^10 a half), full `mul_agrees_with_u128` | |
| A3 | PM-3 | `mul_u128` is exact and `None` exactly past 2^256 | Z3 (`math_z3.py`); Proptest `mul_u128_is_exact` | Z3 |
| A4 | PM-1 | `div_rem` is exact for every pair (`q x d + r == n`, `r < d`), division by zero is `None`, `div_floor` is the floor and `div_ceil` the ceiling | Z3 (`math_z3.py`, the loop's start, both kinds of pass and its exit, every input); Kani default `div_rem_is_exact_bounded` (n below 2^12), `div_by_zero_is_none` (every dividend), full `div_rem_is_exact` (unwind 258); Proptest `div_rem_is_exact`, `div_ceil_is_the_ceiling` | Z3 |
| A5 | PM-11, OS-1 | `isqrt` is the floor square root for every 256-bit input; `highest_power_of_four` is the largest power of four at or below its input | Z3 (`math_z3.py`, loop invariant, every input); Kani default `highest_power_of_four_is_the_largest_at_or_below` (every 256-bit value, 19 s), `isqrt_is_the_floor_square_root_bounded` (n below 2^12), full `isqrt_is_the_floor_square_root` (below 2^192); Proptest `isqrt_is_the_floor_square_root` | Z3, Kani |

### Opening a market (`src/opening.rs`, the seed)

| ID | BOK | Property | How | New |
| --- | --- | --- | --- | --- |
| O1 | | `ratio_q128(y, x)` is exactly `floor(y x 2^128 / x)`, never panics, `None` exactly when `x` is 0 | Z3 (every input); Kani default `ratio_never_panics` (every input), `ratio_is_the_exact_floor_bounded` (below 2^6); Proptest `ratio_is_the_exact_floor` | |
| O2 | | The opening liquidity is backed by both amounts at the rounded price (`L x 2^64 <= x x s`, `L x s <= y x 2^64`) | Z3 (every input); Kani default `the_opening_liquidity_is_backed_bounded`, full `the_opening_liquidity_is_backed`; Proptest `the_opening_liquidity_is_backed_by_both_amounts` | |
| O3 | | The opening price never exceeds the seeded price, so the token side binds the opening liquidity | Z3 (two claims, every input); Kani full `the_opening_price_never_exceeds_the_seeded_price_for_small_amounts`; Proptest `the_opening_price_never_exceeds_the_seeded_price` | |
| O4 | | `cap_floor` is in `[1, seeded]`; a cap floor with at least `MIN_LIQUIDITY` implies the opening liquidity has it too; the opening liquidity is below 2^88 at every price in the opening bounds | Z3 (three claims) | |
| O5 | OS-4 | `open` refuses `cap_floor_bps` above 10,000 before anything else | Code guard; Proptest `a_cap_floor_above_10000_basis_points_never_opens`; unit `sos_h023_open_refuses_a_cap_floor_above_10000_basis_points`; LiteSVM `sos_h023_the_seed_refuses_a_stored_cap_floor_above_10000_basis_points` | Yes |
| O6 | | An accepted seed is usable: it opens and trades | Proptest `an_accepted_seed_is_usable` | |
| O7 | OS-6 | Both seeding paths write every market-state field the spec names, and leave every other byte zero | Proptest through LiteSVM `every_seed_writes_the_spec_state_and_nothing_else`, `every_graduation_writes_the_spec_state_and_nothing_else` (`tests/seed_state.rs`) | Yes |

### Pricing (`src/pricing.rs`)

| ID | BOK | Property | How | New |
| --- | --- | --- | --- | --- |
| P1 | | A buy step stops short of its target only below it, moves the price no further than its input pays for, reaches the target with no more than its input, and pays out rounded down | Z3 (four claims, every input); Kani full `a_buy_step_rounds_against_the_trader_bounded` (unwind 75; bounded below 2^5 it ran over 18 minutes) | |
| P2 | | A sell step crosses its target exactly when `a >= need`, moves the price down no further than its input pays for, stops short only above the target, and frees SOL rounded down | Z3 (four claims); Kani full `a_sell_step_rounds_against_the_trader_bounded`; Proptest `the_sell_step_is_the_spec_as_written` | |
| P3 | | The fee is `ceil(amount x bps / 10,000)`: at least the exact fee, never above the amount, at least 1 on any input; a sell's output is the gross less the fee | Z3; Kani default `a_sells_fee_rounds_up_bounded` (gross below 2^12, every fee a market may charge), full `a_sells_fee_rounds_up_for_every_amount`; Proptest `outputs_round_down_and_fees_round_up` | |
| P4 | | After any trade the ledgers still cover the curve, and the curve and the wall together, across, above or inside the wall's top | Z3 (`pricing_z3.py` two claims, `wall_z3.py` six); Kani full `the_two_steps_round_against_the_trader_at_the_walls_top_bounded`; Proptest `the_ledgers_still_cover_the_curve_after_a_trade`, `the_ledgers_still_cover_the_curve_and_the_wall_after_a_trade` | |
| P5 | | A buy sold straight back returns the price no lower and frees no more SOL than the buy put in after its fee, with or without the wall | Z3 (`pricing_z3.py` two, `wall_z3.py` two); Kani full `every_trade_rounds_against_the_trader` (unwind 260); Proptest `a_buy_sold_straight_back_never_returns_more`, `a_buy_sold_straight_back_through_the_wall_never_returns_more` | |
| P6 | PM-6 | A sell bought straight back returns the price no higher and no more units than were sold, fewer once both fees are paid, with no wall, inside it or across its top | Z3 (six claims); Proptest `a_sell_bought_straight_back_never_returns_more`, `a_sell_bought_straight_back_through_the_wall_never_returns_more` | Yes |
| P7 | PM-4 | A reachable trade never refuses with `Overflow`: every product of both steps fits, `L + W` fits in a u128, a placed wall has `W x top < 2^128`, and what the steps free or pay never exceeds `pool_sol` or `pool_tokens` | Z3 (seven claims, on the reachable envelope); Proptest `a_reachable_trade_never_overflows` | Yes |
| P8 | PM-9 | Two steps always suffice, crossing at most the wall's top, and `PriceBoundReached` comes only at a bound | Kani default `two_steps_always_suffice_for_a_sell`, `two_steps_always_suffice_for_a_buy` (abstract step, every curve, wall and input; 5 s each) | Yes |
| P9 | | More input never buys less, with or without the wall | Proptest `more_input_never_buys_less`, `more_input_never_buys_less_through_the_wall` | |
| P10 | PM-12, WG-8 | The coverage oracle `covers_checked` gives exactly the spec's "Ledgers" answer over the rationals | Kani full `the_coverage_oracle_compares_exactly_bounded` (past a 5-minute limit in the default tier); Proptest `the_coverage_oracle_compares_exactly`, `the_coverage_oracle_never_answers_wrong` | Yes |

### Fees and books (`src/books.rs`, `src/params.rs`)

| ID | BOK | Property | How | New |
| --- | --- | --- | --- | --- |
| F1 | | The fee split never fails, its four parts add up to the fee, and the designer and suite shares are within their basis points | Z3; Kani default `the_split_adds_up_bounded` (small fees, every wall split), full `the_split_adds_up_for_every_fee`; Proptest `the_split_adds_up` | |
| F2 | FB-4, FB-5 | A swap's book update refuses or books each share in its own ledger, no fee ledger falls, and value is conserved | Kani default `a_swap_books_each_share_in_its_own_ledger` (every input, 5 s), full `a_swap_conserves_the_ledgers` (over 10 minutes bounded); Proptest `a_swap_conserves_the_ledgers`; fuzzer L9 | Kani default |
| F3 | | `Books::after` is `FeeSplit::of` then `Books::after_split`, exactly the body before the refactor | Kani full `after_is_the_split_then_after_split_bounded` (over 10 minutes); Proptest `after_is_the_split_then_after_split` | Yes |
| F4 | FB-7 | `Counters::after` adds exactly the trade to the right mint and nothing else, refusing exactly on overflow | Kani default `the_counters_add_exactly_the_trade_to_the_right_mint` (every input, 3 s) | Yes |
| F5 | FB-13 | `params::validate` accepts exactly the spec's table of creation parameters, stated independently | Proptest `validate_accepts_exactly_the_specs_table` | Yes |
| F6 | FB-14 | No fee or reward is ever booked to a role that can never be paid: an unset fee recipient gets 0 of every fee, an unset rewards recipient 0 of every settlement, and an unset role's ledger stays 0 | Z3 (`payouts_z3.py`, three claims) | Yes |

### The inventory cap and the trim (`src/cap.rs`)

| ID | BOK | Property | How | New |
| --- | --- | --- | --- | --- |
| C1 | | The decay credit never exceeds one day's allowance, never falls, and ignores a clock that went back | Z3; Kani default `the_decay_credit_never_exceeds_one_days_allowance_bounded`, full `the_decay_credit_never_exceeds_one_days_allowance`; Proptest `steps_5_and_6_hold_their_invariants` | |
| C2 | | The ratchet never raises the cap, never takes it below its floor or what the curve holds, spends exactly 86,400 credit per unit and lowers the cap by at most one day's decay in one swap | Z3 (five claims); Kani default `the_ratchet_never_raises_the_cap_or_passes_the_floor_bounded` (cap below 2^12), full `the_ratchet_never_raises_the_cap_or_passes_the_floor`; Proptest | |
| C3 | | A trim never changes the price, takes no more than the pool ledgers hold, keeps them covering the curve, lowers the liquidity but never below `MIN_LIQUIDITY`, and leaves the curve within the cap unless `MIN_LIQUIDITY` stopped it | Z3 (five claims); Kani full `steps_5_and_6_keep_the_price_and_the_ledgers` (unwind 75); Proptest; fuzzer L8 | |
| C4 | CAP-1 | Steps 5 and 6 never refuse a swap on a reachable market: every checked step succeeds and the market stays in the reachable envelope | Z3 (four claims); Proptest at the edges | Yes |
| C5 | CAP-2 | A trim never takes the wall's backing: ledgers that covered the curve and the wall before still cover both | Z3 (two claims) | Yes |
| C6 | CAP-3 | The cap never falls faster than its decay rate over any sequence of swaps, and `decay_time` never runs backwards | Z3 (four claims, over three swaps for the sequence); Kani full (the step's assertion); Proptest; unit `the_decay_clock_never_runs_backwards` | Yes (failed before `POOL4-51`) |
| C7 | | The reward budget of `POOL4-49`: every unit the ratchet lowers the cap joins `cap_fall_unmatched`, which never holds more than one day's allowance (R2-01); a trim makes rewardable `min(trimmed, cap_fall_unmatched)`, never more than it retires; `retired_rewardable <= retired_tokens`; a trim from a cap with no unmatched fall makes nothing rewardable | Z3 (three claims; see [Not yet in Z3](#not-yet-in-z3)); Kani full (the step's assertions, the capped rule); Proptest `steps_5_and_6_hold_their_invariants` (the capped rule); unit `a_trim_from_a_cap_that_has_not_fallen_earns_no_reward_share`; LiteSVM `sos_h002_...`, `sos_h005_...`, `sos_r2_01_a_dip_trim_draws_on_at_most_one_days_unmatched_cap_fall` (`tests/reward_share.rs`); fuzzer L11 | Yes |

### The guard: reference and floor (`src/guard.rs`)

| ID | BOK | Property | How | New |
| --- | --- | --- | --- | --- |
| G1 | WG-1 | `follow` never returns `None` for any reference, floor and last close up to `MAX_SQRT_PRICE`, any slot and any clock; in the slot last brought up to date nothing changes; in a later slot the reference moves toward the last close, never past it, by at most `REF_STEP_BPS / 2` of itself | Z3 (`guard_z3.py`, three claims); Kani default `the_reference_follows_slowly_bounded` (prices below 2^12), full `the_reference_follows_slowly` (a full-domain division by 86,400 ran past 25 minutes); Proptest `the_reference_follows_slowly` | Z3 |
| G2 | WG-2 | The floor changes only at a slot's first update (`POOL4-50`): at or below the last close and the larger of the old floor and the reference, rising by at most `FLOOR_CRAWL_BPS / 2`; idempotent at one time; a swap's own price never moves it; a second swap, or a swap after `place_wall`, in the same slot leaves it | Z3 (seven claims); Kani default `the_floor_stays_below_the_slots_opening_price_bounded`, full `the_floor_stays_below_the_slots_opening_price`; Proptest `the_floor_is_never_above_the_slots_opening_price`, `the_floor_moves_only_at_a_slots_first_update`; LiteSVM `sos_h003_...`, `sos_h004_...`, `sos_h050_...` (`tests/wall.rs`) | Yes |
| G3 | | The clock rule (`POOL4-51`): `ref_time` and `floor_time` never move backwards, the seconds charged are at most how far each moved, and a clock at or before the stored time moves nothing | Z3 (four claims); Kani (the clock assertions in G1's and G2's harnesses); Proptest | Yes |
| G4 | WG-3 | The guard's state invariant (`MIN_SQRT_PRICE <= floor <= reference <= MAX_SQRT_PRICE`, the floor at or below the last close) holds at the seed and is kept by every swap and every `place_wall`, and the floor a placement uses is at or below the price at placement | Z3 (three claims) | Yes |
| G5 | | The hybrid floor (`POOL4-50` as amended on 2026-11-19): `low_since_placement` is set to the opening price by the seed, lowered by every swap to its close and never raised, so it is the lowest close since the last placement; `place_wall` resets it to the price at placement | Z3 (`guard_z3.py`: `close_at`, a swap's low in any slot, a dip bought back then a swap in a later slot, and the seed and `place_wall` cases of the guard invariant with `low_since_placement`); Kani default and full (G1's and G2's harnesses, extended to `low_since_placement`); Proptest `the_floor_moves_only_at_a_slots_first_update` and `place_wall_runs_only_in_a_slot_no_swap_has_run_in`; fuzzer (its own invariant, and the back-run step with and without a tiny swap); LiteSVM `sos_r2v_backrun_of_a_fall_across_one_slot_never_pays` and `sos_cr1_a_tiny_swap_in_the_next_slot_does_not_clear_the_placement_cap` | Yes |

### The wall and the keeper tip (`src/wall.rs`)

| ID | BOK | Property | How | New |
| --- | --- | --- | --- | --- |
| W1 | | The tip is exactly `min(KEEPER_TIP_CAP, floor(work x fee_bps / 10,000), idle_sol)`, so never more than the fee earned on the work | Z3; Kani default `the_tip_never_exceeds_the_fee_earned_on_the_work_bounded` (small work and idle SOL; with 128-bit products it ran over 10 minutes), full `the_tip_never_exceeds_the_fee_earned_on_the_work`; Proptest `the_tip_never_exceeds_the_fee_earned_on_the_work` | |
| W2 | | Closing and placing the wall conserves the ledgers (the token sum kept, SOL less exactly the tip), its dust is never negative, nothing stays idle, the new wall's top is at or below the price and the floor, the ledgers cover the curve and the new wall, and it is refused exactly below `WALL_THRESHOLD` | Z3 (`wall_z3.py` three claims, `pricing_z3.py` one on the placed wall's widths); Kani full `closing_and_placing_the_wall_conserves_the_ledgers` (unwind 75); Proptest `closing_and_placing_the_wall_conserves_the_ledgers` | |
| W3 | | `place_wall` runs only in a slot no swap or seed ran in, and under the floor brought up to date places at most at the floor, at or below the last close; since the hybrid floor, at `min(price, floor, low_since_placement)`, a `low_since_placement` of 0 capping nothing | Z3 (`wall_z3.py`: the placement in a slot under the floor and a nonzero `low_since_placement`, and a dip's low capping the wall); Proptest `place_wall_runs_only_in_a_slot_no_swap_has_run_in`; unit `the_low_since_placement_caps_the_wall_below_the_floor_and_the_price`; fuzzer L4 and L5 | Yes |
| W4 | WG-5 | Right after a placement `converted` and `idle_sol` are 0, so a second `place_wall` is refused and tips nothing; `converted` stays 0 at every price at or above the new top | Z3 (two claims) | Yes |
| W5 | | The wall holds SOL above its top and buys tokens below it | Proptest `the_wall_holds_sol_above_its_top_and_buys_tokens_below_it` | |

### Settlement and payouts (`src/payouts.rs`)

| ID | BOK | Property | How | New |
| --- | --- | --- | --- | --- |
| R1 | FB-12 | The settlement split pays `floor(retired_rewardable x reward_share_bps / 10,000)` to rewards, burns the rest of `retired_tokens`, adds up, burns something whenever anything is retired, and fits in 64 bits | Z3 (four claims); unit `the_settlement_split_for_every_remainder` (every remainder modulo 10,000); Kani full `the_settlement_split_adds_up_and_always_burns_bounded` (764 s) and `the_settlement_split_adds_up_and_always_burns`; Proptest `the_settlement_split` | Re-tiered |
| R2 | | `settle` keeps the reward budget: rewards booked never exceed the reward share of the cap's fall, and a settlement with nothing rewardable (a dip trim, a closed wall, dust) books no reward and burns everything | Z3 (two claims); LiteSVM `sos_h005_a_dip_trimmed_from_a_tight_cap_pays_no_reward_share`, `sos_h007_a_wall_closure_pays_no_reward_share` | Yes |
| R3 | FB-10 | `pay_rewards` and `sweep_fees` each move exactly one ledger to its wallet and touch nothing else, refusing in the spec's order; each fee slot pays its own ledger to its own wallet | Kani default `paying_rewards_empties_its_own_ledger_and_nothing_else` (3 s), `a_sweep_empties_its_own_ledger_and_nothing_else` (15 s); Proptest `payouts_move_exactly_what_they_report`; unit `sos_h065_each_fee_slot_pays_its_own_ledger_to_its_own_wallet` | Kani |
| R4 | FB-11 | `settle` empties `retired_tokens` and `retired_rewardable` and leaves every other ledger alone, refusing as `NothingToSettle` exactly when nothing is retired | Kani default `settling_empties_the_retired_ledger_and_nothing_else` (12 s) | Yes |
| R5 | | A handover is allowed exactly when the role's holder signs it to a key that is not the default key, not its current wallet and not one of the market's own addresses (`POOL4-52`), each refusal the first rule broken | Kani default `a_handover_is_allowed_exactly_to_a_new_wallet_by_its_holder` (12 s); LiteSVM `sos_h022_...`, `sos_h063_...` (`tests/payouts.rs`) | Yes |

### The market state (`src/state.rs`)

| ID | BOK | Property | How | New |
| --- | --- | --- | --- | --- |
| S1 | OS-8 | Every accessor and projection round-trips and writes only its own bytes: identity and parameters, pricing and ledgers, cap, guard and totals, volumes, counters, books, inventory, wall books, owed ledgers, guard | Kani default, ten harnesses (21 to 47 s each on 2026-11-16; three were timed before the reward ledgers were added, and the guard's before `low_since_placement`) | Yes |

### The whole program (`tests/fuzz.rs`)

Checked after every step of every random sequence through the router: creation with any parameters, of tokens with or without a transfer hook in any state, seeds and graduations, donations, buys and sells, `place_wall`, round trips with each role, payouts to the right wallet or another, handovers to any key, reassigned recipient accounts, and clock jumps.

| ID | BOK | Invariant | New |
| --- | --- | --- | --- |
| L1 | | Value is conserved across every wallet, vault and router fee account, burns counted; supply falls by exactly what `settle` burned | |
| L2 | | Every holder can exit (`POOL4-36`) | |
| L3 | | Each quote equals its swap to the unit, and a refused quote is a refused swap | |
| L4 | | The spec's "Ledgers": each vault holds at least its ledgers; the pool ledgers cover the curve, and the curve and the wall; the curve within the cap after a swap; the cap never rises nor passes its floor; the floor never above the reference, changing only at a slot's first update; a placed wall's top never above the price at placement, the floor, nor `low_since_placement` | Extended |
| L5 | | `place_wall` succeeds exactly when `wall::place_in_slot` allows it, and leaves what it computes | Extended |
| L6 | | The reference and the floor never move on a trade in the slot last brought up to date | Extended |
| L7 | | The decay credit never exceeds one day's allowance | |
| L8 | | A trim never changes the price | |
| L9 | | A swap moves the ledgers by exactly its token and SOL flows | |
| L10 | WG-7 | Self-dealing never profits, everything received counted (the SOL, the tip, swept fees, rewards paid to itself): named invariants `round-trip`, `round-trip-fee-recipient`, `round-trip-rewards-recipient` and `dump-buy-back`; none is known to fail | Yes |
| L11 | | The reward share is paid only on what the cap's fall matched: `retired_rewardable <= retired_tokens`, rewards owed and paid never exceed the reward share of the cap's fall, only a swap moves the unmatched fall | Yes |
| L12 | | Only `pipeline_swap` changes the price, counters, cap, liquidity or guard, but `place_wall`, which moves only the floor and its clock | |
| L13 | FB-15 | Every lifetime total never falls and grows by exactly what moved, measured on the mint and in the accounts paid | Yes |
| L14 | | `settle`, `pay_rewards` and `sweep_fees` succeed exactly when the program's payout functions allow them, and are otherwise refused with exactly the error those functions, the wallet check or the account check give (review finding H062) | Extended |
| L15 | | Handovers succeed exactly per `POOL4-52`, and what a role is owed follows it | Extended |

## Confirmed but not landed as planned

- **FB-3** (the fee shares stay total for any policy values a deploy could choose, as a build-time `const` assert): not found in the code.
  The split is proved for the deployed constants (F1, Z3 reads `DESIGNER_SHARE_BPS` and `SUITE_SHARE_BPS` as 1,000 each), and `tests/policy_values.rs` keeps every constant defined once, but nothing refuses at build time a pair of shares that would not leave the market a part.
- **OS-4**: planned with a Kani harness; landed as a code guard, a Proptest and unit and LiteSVM tests (O5).
- **PM-12 / WG-8**: planned for the default tier; the Kani harness ran past 5 minutes and lives in the full tier, with two Proptests in CI (P10).
- **CAP-3**: planned with a Proptest over a sequence; landed as Z3 over three swaps, a single-step Proptest and unit tests (C6).

## Not yet in Z3

- **R2-01's one-day cap on the unmatched fall.** `proofs/cap_z3.py` still models `cap_fall_unmatched` growing by the whole fall, with the budget as an equality (`settled + rewardable + unmatched == seeded - cap`).
  The code now caps the unmatched fall at one day's allowance, so the budget holds as an inequality; the cap can only lower `cap_fall_unmatched`, so the lifetime bound the claims support still holds, and Kani's full tier and Proptest state the capped rule exactly.
  The Z3 model should be updated to the capped rule.
- The hybrid floor's placement cap is in Z3 (G5, W3), added to `guard_z3.py` and `wall_z3.py` by the session that built it.

## Skipped, with reasons

- PM-7 (splitting never beats one trade), PM-8 (monotone in input, refusals included), PM-10 (`buy_step` as written), CAP-9 (`held` and `held_rounded_up` bracket each other), WG-11 (the wall never pays more than its top), FB-1, FB-2 (`share` and `FeeSplit::of` as written), FB-9 and OS-9 (`recorded` sums the spec's ledgers), OS-3 (`open`'s refusal order) and OS-11 (the lowest opening bound never binds): already covered closely enough by existing Z3 claims or 10,000-case Proptests; the gain would be a restatement.
- PM-13 (a crate-wide `clippy::arithmetic_side_effects` deny): it would flag checked U256 code throughout, and no panic path exists in deployed code.
- PM-5, CAP-4, CAP-5, CAP-7, CAP-8, CAP-10, CAP-11, WG-4, WG-6, WG-9, WG-10, FB-6, FB-8, FB-16, OS-2, OS-5, OS-7 and OS-10: lower value than the confirmed set; candidates for later work.

## Harnesses in the full tier only

These never run in CI (H068, signed off); each statement is proven for every input by Z3 or checked by Proptest in CI, as its row above says.

| Harness | File | Why it is in the full tier |
| --- | --- | --- |
| `mul_agrees_with_u128` | `src/math.rs` | A 128-bit multiplier equivalence takes SAT solvers hours; Z3 proves it |
| `div_rem_is_exact` | `src/math.rs` | Unwind 258 over a division loop; Z3 proves it by loop invariant |
| `isqrt_is_the_floor_square_root` | `src/opening.rs` | Unwind 130 over the square root's loop; Z3 proves it |
| `the_opening_liquidity_is_backed` | `src/opening.rs` | Every amount; Z3 proves it |
| `the_opening_price_never_exceeds_the_seeded_price_for_small_amounts` | `src/opening.rs` | The square root's loop runs about 64 times whatever the bound; Z3 proves it |
| `the_split_adds_up_for_every_fee` | `src/books.rs` | The full domain ran over 9 minutes |
| `a_swap_conserves_the_ledgers` | `src/books.rs` | Over 10 minutes even below 2^20; F2's default harness and Proptest cover it |
| `after_is_the_split_then_after_split_bounded` | `src/books.rs` | Past a 10-minute limit; Proptest covers it |
| `the_decay_credit_never_exceeds_one_days_allowance` | `src/cap.rs` | Every input; the bounded harness runs in CI |
| `the_ratchet_never_raises_the_cap_or_passes_the_floor` | `src/cap.rs` | Every input; the bounded harness runs in CI |
| `steps_5_and_6_keep_the_price_and_the_ledgers` | `src/cap.rs` | The trim divides with `div_rem`'s loop; Z3 and Proptest cover it |
| `the_reference_follows_slowly` | `src/guard.rs` | A full-domain u128 division by 86,400 ran past 25 minutes |
| `the_floor_stays_below_the_slots_opening_price` | `src/guard.rs` | Prices up to `MAX_SQRT_PRICE`; the bounded harness runs in CI |
| `a_buy_step_rounds_against_the_trader_bounded` | `src/pricing.rs` | Over 18 minutes even below 2^5; Z3 proves it |
| `a_sell_step_rounds_against_the_trader_bounded` | `src/pricing.rs` | The same; Z3 proves it |
| `the_two_steps_round_against_the_trader_at_the_walls_top_bounded` | `src/pricing.rs` | The same; `wall_z3.py` proves it |
| `a_sells_fee_rounds_up_for_every_amount` | `src/pricing.rs` | Every amount; the bounded harness runs in CI |
| `every_trade_rounds_against_the_trader` | `src/pricing.rs` | Unwind 260; Z3 and Proptest cover it |
| `the_tip_never_exceeds_the_fee_earned_on_the_work` | `src/wall.rs` | 128-bit products ran over 10 minutes |
| `closing_and_placing_the_wall_conserves_the_ledgers` | `src/wall.rs` | Division loops; Z3 and Proptest cover it |
| `the_coverage_oracle_compares_exactly_bounded` | `src/wall.rs` | 256-bit products and two division loops ran past 5 minutes |
| `the_settlement_split_adds_up_and_always_burns_bounded` | `src/payouts.rs` | 764 s of CI's budget for what Z3 proves for every input (H066); a remainder unit test replaces it |
| `the_settlement_split_adds_up_and_always_burns` | `src/payouts.rs` | Every input; Z3 proves it |

## Run times

- **Z3** (seven scripts, z3-solver 5.4.1, run on the owner's Mac on 2026-11-19): 134 of 134 claims proven in about 11 seconds in all (24 in `cap_z3.py`, 21 in `guard_z3.py`, 28 in `math_z3.py`, 9 each in `opening_z3.py` and `payouts_z3.py`, 27 in `pricing_z3.py`, 16 in `wall_z3.py`); `math_z3.py` takes about 8 seconds, every other script about a second, and no claim more than a fraction of a second.
- **Kani, default tier**: 34 harnesses; the times recorded in the harness comments on 2026-11-16 and 2026-11-17 on the owner's Mac are 2 to 19 seconds for the arithmetic, books and payouts harnesses and 21 to 47 seconds for each state accessor harness.
  No total wall time for the default tier was recorded in this ticket.
- **Kani, full tier**: not run as a whole in this ticket; the reasons each harness sits there are in the table above.
- **Proptest**: 10,000 cases a property.
- **Fuzzer**: 256 sequences of up to 31 steps by default.
