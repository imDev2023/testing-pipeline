# Buy wall AMM: review round 2

Round 2 of the internal adversarial review of `programs/buy-wall-amm`, run on 2026-11-17 and 2026-11-18 after the round 1 fixes landed.
It is not an audit and no external review has been done; [README.md](README.md) says what was reviewed and how, and [round-1.md](round-1.md) describes each original finding.
Round 2 had three parts:

1. **Verification** of every confirmed or potential finding of round 1, and of the seven cleared hypotheses the ticket hardened anyway, against the fixed code: each attack re-run, with the same exact integer models where money was involved, and each regression test read for whether it exercises the attack.
2. **A re-review of the program code the fixes changed**, `git diff 72636ae..e2bd509 -- programs/buy-wall-amm/src`, read against `POOL4-48` to `POOL4-52` and the spec, looking for new weaknesses and regressions rather than re-checking round 1 (R2-01 to R2-06).
3. **A re-review of the release gate's changes**, `git diff 72636ae..3003439` of `gate/` and `scripts/deploy.sh`, read against `POOL4-41`, `POOL4-44` and `POOL4-46` to `POOL4-53`, with the gate's judging rules replayed in an exact model (R2G-01 to R2G-09).

Code locations are relative to `programs/buy-wall-amm/` at the commit each part read.

## Summary

- Of round 1's 37 findings, verification found 18 fixed, 6 partly fixed, 1 regression, 1 not fixed and 11 open for sign-off as round 1 recommended.
- The regression: `POOL4-50`'s slot-based floor made a back-run of a fall across one slot boundary profitable (Medium), found in the verification of H003.
- The program re-review found one confirmed Medium (R2-01), one potential Medium (R2-02), one Low and three Info.
- The gate re-review found no Critical, High or Medium, five Lows (one of them a known residual) and four Info, and no permissionless permanent veto.
- What was done: R2-01, the back-run regression (by the owner's "hybrid" amendment of `POOL4-50` on 2026-11-18), R2-05, R2-06, R2G-01, R2G-02 and R2G-03 are fixed in this ticket; R2-02 and the hybrid's other residual, R2-03, R2G-04, R2G-06, R2G-07 and R2G-08 are accepted with the owner's sign-off of 2026-11-18; R2-04, R2G-05 and R2G-09 are Info and not gated.

## Verification of round 1

Status is the verifier's verdict on the code it read; the disposition is final, as of 2026-11-18.
"Signed off" means accepted as a Low with the owner's sign-off of 2026-11-18 ([sign-offs.md](sign-offs.md)).

| ID | Round 1 severity | Verification status | Final disposition |
| --- | --- | --- | --- |
| H001 | Medium | FIXED | Fixed |
| H002 | Medium | PARTIALLY_FIXED | Amplifiers fixed; residual re-rated Low by the owner and signed off |
| H003 | Medium | REGRESSION | Fixed in this ticket by the hybrid floor; residuals signed off |
| H004 | Low | FIXED | Fixed |
| H005 | Medium | FIXED | Fixed, with R2-01 |
| H007 | Low | FIXED | Fixed |
| H008 | Low | PARTIALLY_FIXED | Cross-slot residual signed off |
| H013 | Low | FIXED | Fixed |
| H020 | Medium | FIXED | Fixed, with R2G-01 and R2G-02 |
| H021 | Low | OPEN (sign-off) | Signed off |
| H022 | Low | FIXED | Fixed |
| H024 | Low | OPEN (sign-off) | Signed off |
| H025 | Low | OPEN (sign-off) | Signed off |
| H026 | Low | OPEN (sign-off) | Signed off |
| H031 | Low | FIXED | Fixed |
| H033 | Low | PARTIALLY_FIXED | Fixed in this ticket, with R2G-03 |
| H034 | Low | OPEN (sign-off) | Awaiting the owner's sign-off |
| H040 | Low | OPEN (sign-off) | Signed off |
| H041 | Low | FIXED (the motive) | Fixed |
| H048 | Low | FIXED | Fixed |
| H050 | Low | PARTIALLY_FIXED | Fixed in this ticket by the hybrid floor |
| H056 | Low | FIXED | Fixed |
| H058 | Medium | FIXED | Fixed, with R2G-02 |
| H059 | Low | OPEN (sign-off) | Signed off |
| H061 | Medium | FIXED | Fixed |
| H062 | Low | FIXED | Fixed |
| H063 | Info | FIXED | Fixed |
| H065 | Low | FIXED | Fixed |
| H066 | Low | FIXED | Fixed |
| H068 | Low | PARTIALLY_FIXED | Docstring fixed; no full-tier Kani in CI signed off |
| H069 | Info | NOT_FIXED | Info, not gated |
| H070 | Low | OPEN (sign-off) | Signed off |
| H096 | Low | OPEN (sign-off) | Signed off |
| H097 | Low | PARTIALLY_FIXED | Vacuous pass fixed; deploy window signed off with R2G-06 |
| H098 | Low | FIXED | Fixed |
| H110 | Low | OPEN (sign-off) | Signed off |
| H111 | Low | OPEN (sign-off) | Signed off |

Cleared in round 1 and hardened anyway; each verified FIXED:

| ID | What changed |
| --- | --- |
| H009 | `decay_time`, `ref_time` and `floor_time` become `max(stored, now)` ([`POOL4-51`](../../decisions.md#pool4-51-the-markets-clocks-never-run-backwards)), stated in `proofs/cap_z3.py` and `proofs/guard_z3.py` and checked by Kani and Proptest |
| H023 | `opening::open` refuses `cap_floor_bps` above 10,000 first; `sos_h023_open_refuses_a_cap_floor_above_10000_basis_points` and `sos_h023_the_seed_refuses_a_stored_cap_floor_above_10000_basis_points` |
| H044 | `pay_rewards` and `sweep_fees` are thin wrappers over one `recipient::pay_out`; `sos_h044_sos_h064_both_payouts_refuse_the_same_substitutions` |
| H064 | `recipient::ensure` requires the real associated token program and derives the address with it |
| H067 | `check_vault_accounts` takes a `VaultSide` enum; the wildcard arm is gone |
| H076 | `token_balance` and `mint_decimals` refuse any account that is not a token account or a mint of SPL Token or Token-2022; `sos_h076_raw_reads_refuse_accounts_that_are_not_token_accounts_or_mints` |
| H099 | The unused `init-if-needed` feature and the stale Anchor version pin are removed |

### The Medium findings

**H001: FIXED.**
`check_authorities_removed` reads the TransferHook extension through `mint_rules::find_extension` and accepts only no extension or a 64-byte value that is all zeros, refusing with `TransferHookLive` (commit `33226f3`, [`POOL4-48`](../../decisions.md#pool4-48-a-transfer-hook-at-the-seed)).
The check runs at the top of `bring_seed`, the only path into `open_market` for both `seed` and `pipeline_seed_liquidity`, before either transfer.
Each live state (both set, only the program, only the authority) is refused on both paths with nothing moved; once both are cleared Token-2022's `UpdateTransferHook` and `SetAuthority` need the absent authority, so the hook can never come back.
A CREATED market whose token kept its hook program after removing the authority can never be seeded; only the creator's rent is lost, the same class as H070.

**H002: PARTIALLY_FIXED, residual signed off.**
Under [`POOL4-49`](../../decisions.md#pool4-49-which-retired-tokens-earn-the-reward-share) the wash is unchanged to the unit: its buy lowers the cap by `a`, so `cap_fall_unmatched` grows by `a`, and its sell back is trimmed by about `a`, all of it matched.
What went: sales of reward tokens into the tightened cap are no longer rewardable (H056), wall closures burn whole (H007), and a dip pays only against a cap fall that already happened (H005).
Measured residual on a 10 SOL curve:

| Market | Round 1 net | Net under `POOL4-49` |
| --- | --- | --- |
| Defaults (fee 1%, wall split 50%, reward share 15%, floor 20%, decay 20%), daily wash to the floor | +0.914 SOL (9.1%) over 4 days | +0.776 SOL (7.8%) over 4 days, +0.233 on day 1 |
| Fee 0.25%, wall split 100%, reward share 30% | +1.991 SOL (19.9%) | +1.579 SOL (15.8%) |
| Extremes: reward share 30%, fee 0.25%, floor 0.1%, decay 100%, one day after the seed | +2.854 SOL (28.5%) | +2.167 SOL (21.7%) in one day |
| Reward share 1% | -0.140 SOL | -0.140 SOL (a loss) |

The rewards paid stay within the budget in every run, and break-even is about `reward_share = 2 x (fee_bps + 25) / 10,000`.
The bounds that hold: lifetime rewards at most `floor(reward_share x (seeded - cap_floor) / 10,000)`; by time `t` after the seed at most `reward_share x min(seeded - cap_floor, cap_decay_per_day x t / 86,400)`; per transaction at most the reward share of the unmatched fall before it plus one day's allowance, which R2-01's fix now caps at one day's fall waiting.
The owner re-rated H002 from Medium to Low on 2026-11-18 and signed off the residual, which the spec's explainer risks disclose ("the rewards recipient can trade the cap down itself and take the reward share of that fall at once, though never more than the budget").
The one-slot ratchet lag (also H040's fix) remains the change that would remove the atomic, borrowed-capital form.

**H003: REGRESSION, fixed in this ticket by the hybrid floor.**
H003's own attacks are closed by [`POOL4-50`](../../decisions.md#pool4-50-when-the-walls-floor-moves) as first written: a dip bought back in its own slot leaves the floor where it was, and `place_wall` in the dip's slot is refused with `SwapThisSlot`.
But the verifier found the rule created a profitable back-run that the round 1 code made unprofitable.
A third party dumps in slot N, which at a tight cap trims the curve and leaves its SOL idle; the back-runner buys back up to the floor as slot N's last swap; in slot N+1, `place_wall` places the wall, with the dump's trimmed SOL, at `min(price, floor)`, the old floor, and the back-runner sells everything it bought into it:

| Curve | Fee | Dump to | Back-runner's net | Of curve SOL |
| --- | --- | --- | --- | --- |
| 10 SOL | 25 bps | 70% of the price | +0.0152 SOL | +0.15% |
| 10 SOL | 25 bps | 50% | +0.1172 SOL | +1.17% |
| 10 SOL | 25 bps | 25% | +0.4718 SOL | +4.72% |
| 100 SOL | 25 bps | 25% | +4.7027 SOL | +4.70% |

The same round trip with no `place_wall` between the legs loses, and under the round 1 code it lost 0.10 to 0.31 SOL, so the profit came from the slot rule; the dumper itself, or a leader holding consecutive slots, is a natural actor.
Rated Medium.
Fix: the owner amended `POOL4-50` on 2026-11-18 to a hybrid: the floor still moves only at slot boundaries, and every placement is also capped at the lowest close of the last slot that traded, kept in a new field `last_slot_low`, so after the back-run the wall goes no higher than the dump's low.
Regression test: the round 2 back-run test in `tests/wall.rs`, which asserts the wall goes up at the dump's low and the back-run returns no more than it cost.
Residuals signed off: a dip bought back in one slot lets the next `place_wall` put the wall at that low once, until idle SOL refills; and a dip held across a slot boundary lowers the floor, as any price that lasts a boundary does (R2-02).

**H005: FIXED.**
With a tight cap and nothing unmatched (right after the seed, round 1's case), a dip retires the whole sale and nothing is rewardable: every dip depth is now a loss for the recipient, where round 1 measured +2.1% and +6.2% of curve SOL.
With an unmatched fall left by organic net buyers, a dip pays the reward share of `min(trimmed, unmatched)`, confirmed to the unit in all 81 such runs; that is H002's residual reached by selling instead of washing.
The verifier noted that the unmatched fall had no ceiling, so a backlog of several days could be harvested in one transaction; that is R2-01, fixed.

**H020: FIXED.**
The snapshot replays every market with the deployed build and records each step's outcome; a failed step is excused only when the deployed build failed the same kind on the same market in the same program ([`POOL4-46`](../../decisions.md#pool4-46-when-a-failed-step-counts-against-a-candidate)); layout checks always run and always count; orphans are registered in the replay; payer, trader and keeper keys are derived, identical in both replays.
Every round 1 vector was re-run: a refusing hook on a CREATED market is cleared in the replay as a seeder must; a reassigned fee recipient ATA fails under both builds and is excused; a missing router fee account is created; an unregistered market is registered.
Two weaknesses of the fix were filed as R2G-01 and R2G-02, both fixed.

**H058: FIXED.**
Every trigger a market creator or recipient controls is excused under `POOL4-46` and no longer vetoes a release; other markets and the gate's own market still catch a uniform regression.
The fixed-wallet slots came back as a veto through the gate's own market (R2G-02, fixed).

**H061: FIXED.**
The flip, the stage that took holders' money, is impossible under `POOL4-48`; recycling the rewards now returns 5 to 7 units in total in the model, against 1.17 to 1.41 times the proceeds before; the remaining skim is H002's residual, at most the published budget (+0.78 SOL, 7.8% of curve SOL, at the defaults).

### The Low and Info findings

- **H004: FIXED.** The buy that opens its slot after a quiet day leaves the floor at the price the slot opened at, and `place_wall` in its slot is refused; round 1's gain is gone in the atomic and next-slot forms.
  With time passing between the buy and the placement the designed crawl returns in proportion to the wait (+0.0096% of curve SOL after 24 hours, with a day's price risk on the position), which is what any holder of a day earns; rated Low by design and scoped by the spec's round-trip invariant.
- **H007: FIXED.** Every wall closure retired tokens (1.7 to 49.9 billion units in the model) and none was rewardable; with the cap slack, or tight with nothing unmatched, the loop is a loss.
- **H008: PARTIALLY_FIXED, signed off.** The same-transaction loop is refused; across one boundary it still nets the fee recipient up to about 0.0008 SOL a loop at fees of about 1% or more and wall splits of about 20% or less, if it lands the next slot's first `place_wall` before our own keeper.
- **H013: FIXED.** The orphan is registered and checked; the layout builds are refused on it.
- **H021, H024, H025, H026: OPEN (sign-off).** Nothing in these paths changed; each Low holds for the reasons round 1 gave.
- **H022: FIXED.** All five of the market's own addresses refused for both roles, before the seed and on an open market; a stranger still sees `NotRecipient`.
- **H031: FIXED.** No hook runs on a seeded market, so the stack never passes the buy wall AMM to Token-2022 (height 3 under the router, 4 under an aggregator).
- **H033: PARTIALLY_FIXED, fixed in this ticket with R2G-03.** Narrowed due rules are closed; the wallet path of `sweep_fees`, which came from the candidate's tree, was R2G-03.
- **H034: OPEN (sign-off).** No fix touched it; under the new rules a moved treasury, raised shares or tip cap, an added drain instruction or a broken handover still pass.
  The verifier noted a cheap signal the relative rule now offers: a step the deployed build failed everywhere and the candidate passes is a behaviour change worth printing.
- **H040, H059: OPEN (sign-off).** The mechanisms are unchanged; under `POOL4-49` a third party's trims are matched by the fall its own buy produced, so they pay the rewards recipient as before.
- **H041: FIXED (the motive).** No wall closure is rewardable; the wall stays a buy-and-burn by design.
- **H048: FIXED.** No seeded market's token has a hook, so no hook can refuse `pay_rewards`.
- **H050: PARTIALLY_FIXED, fixed in this ticket by the hybrid floor.** H004's class is closed; the invariant still failed in the back-run class of H003, a buy that does not open its slot because a third party's fall ran first, which the hybrid closes.
- **H056: FIXED.** With a slack cap, or tight with nothing unmatched, nothing is recycled.
- **H062, H063, H065, H066: FIXED.** Exact refusal codes in the fuzzer; `SameRecipient`; the `FeeSlot` enum; the slow harness in the full tier with an exhaustive remainder test in its place.
- **H068: PARTIALLY_FIXED, signed off.** `proofs/pricing_z3.py` now says which Kani harnesses CI runs; no full-tier job was added.
- **H069: NOT_FIXED.** No `LedgerShort` error was added; Info, every path fails closed, not gated.
- **H070, H096, H110, H111: OPEN (sign-off).** Unchanged; on the gate side decoy CREATED markets no longer veto a release.
- **H097: PARTIALLY_FIXED.** A cluster with no market now executes the candidate on the gate's own market ([`POOL4-53`](../../decisions.md#pool4-53-every-gate-run-trades-a-market-of-its-own)); the deploy window is unchanged and rated in R2G-06.
- **H098: FIXED.** A build declared for another address is refused at "make a market of its own" with Anchor's 4100.

## New findings in the program (R2-01 to R2-06)

| ID | Title | Status | Severity | Disposition |
| --- | --- | --- | --- | --- |
| R2-01 | `cap_fall_unmatched` never expires, so a backlog of cap fall re-enables H005's dip harvest in one transaction | Confirmed | Medium | Fixed in this ticket |
| R2-02 | The slot-based floor is moved by a dip that straddles one slot boundary | Potential | Medium | Accepted as a Low residual of the hybrid floor, signed off |
| R2-03 | `place_wall` is starved by a swap in every slot | Potential | Low | Signed off |
| R2-04 | `place_wall`'s floor update caps the crawl at the stale reference | Confirmed | Info | Not gated |
| R2-05 | `token_balance` accepts a crafted Token-2022 multisig | Confirmed | Info | Fixed in this ticket |
| R2-06 | `transfer_hook_cleared` fails open on malformed extension entries | Confirmed (unreachable) | Info | Fixed in this ticket |

The re-review found no regression in the refactors (`FeeSlot`, `VaultSide`, `Books::after_split`, `open`'s cap floor guard) or the state layout, and checked as sound: `place_wall` cannot raise the floor at will or move the reference; the floor never ends above the reference; `retired_rewardable <= retired_tokens` on every path; the two new ledgers cannot overflow; the hook rule cannot be bypassed after the seed; and the handover and payout helper check everything from one snapshot before any CPI.

### R2-01: the unmatched cap fall never expired

Every ratchet added the whole fall to `cap_fall_unmatched` with no ceiling (`src/cap.rs:186-191` at `e2bd509`), and any later trim matched `min(trim, cap_fall_unmatched)`.
After a day or more of net buying, which leaves the cap tight and a backlog of up to `seeded - cap_floor`, the rewards recipient could run H005's dip and be paid on the whole backlog in one transaction: H005's measured +2.1% to +6.2% of curve SOL again, repeatable at every tight state.
Fix (commit `9915e36`, `POOL4-49` amended): the unmatched fall never holds more than one day's allowance, the most the decay credit holds, so no single trim draws on days of others' buying; Kani's full tier and Proptest state the capped rule.
Regression test: `sos_r2_01_a_dip_trim_draws_on_at_most_one_days_unmatched_cap_fall` (`tests/reward_share.rs`).

### R2-02: a dip across one slot boundary moves the floor

At a slot's first update the floor drops to the previous slot's close, however briefly it held, so a sell to a dip as slot N's last swap, then `place_wall` and a buy back first in slot N+1, relocates the whole wall for days, at the cost of about 400 ms of price exposure (none for a leader holding both slots).
The verifier of H003 agreed: Medium on markets with no same-slot dip buyers, Low where bots buy dips within the slot, and griefing only, since `POOL4-49` burns dip trims whole.
Disposition: the owner chose the hybrid floor on 2026-11-18 and accepted this as one of its residuals, signed off as a Low ([sign-offs.md](sign-offs.md)); options that hold the floor up for several slots were not taken, since they widen the back-run window of H003.

### R2-03: placement starved by a swap in every slot

`place_wall` is refused whenever a swap already ran in the slot, so on a busy market, or against a griefer sending a dust swap each slot with a higher priority fee, every placement fails while idle SOL accumulates, during heavy selling when the wall matters most.
No value leaves the market; the griefer pays about one transaction and the minimum swap's fees per slot.
Signed off as a Low; the keeper runner lands `place_wall` at the top of a slot.

### R2-04: the crawl capped at the stale reference (Info)

`place_in_slot` brings the floor up to date before the slot's reference step, so a keeper placing before the slot's first swap leaves the floor up to one reference step lower than a swap would have.
It can only leave the floor lower, never raise the wall; not gated.

### R2-05: a crafted Token-2022 multisig passed the token-account layout check (Info)

`is_token_layout` accepted a 355-byte Token-2022 account whose byte 165 is `2`, which a multisig's creator can arrange inside its signer keys; every caller pinned the account, so nothing read attacker data.
Fix (commit `9915e36`): refuse 355-byte Token-2022 accounts, as `mint_rules::check_mint` does; `sos_r2_05_raw_reads_refuse_a_token_2022_multisig` (`src/token.rs`).

### R2-06: the hook check failed open on a malformed extension walk (Info)

`transfer_hook_cleared` treated a `None` from `find_extension` as no hook, and `find_extension` also returns `None` on a malformed entry; unreachable, since creation already walked the same entries, but a safety check should fail closed.
Fix (commit `9915e36`): a malformed walk is refused; `sos_r2_06_a_malformed_extension_walk_is_not_taken_for_no_hook` (`src/instructions/seed.rs`).

## New findings in the release gate (R2G-01 to R2G-09)

| ID | Title | Status | Severity | Disposition |
| --- | --- | --- | --- | --- |
| R2G-01 | The relative rule compares the failing program, not the error | Confirmed | Low | Fixed in this ticket |
| R2G-02 | The gate's own market is judged absolutely in the cluster's world | Confirmed | Low (Medium once `DESIGNER_RECIPIENT` is set) | Fixed in this ticket |
| R2G-03 | The deployed build's outcomes are recorded by the candidate tree's gate | Confirmed | Low | Fixed in this ticket |
| R2G-04 | Fixture baselines are trusted with no provenance | Confirmed | Info | Signed off |
| R2G-05 | `pipeline_market_info` is checked against its own answer on markets the replay registers | Confirmed | Info | Not gated |
| R2G-06 | The window between `verify-record` and the upgrade landing | Confirmed | Low | Signed off, with H097 |
| R2G-07 | A record covers a market by its key forever | Confirmed | Low | Signed off |
| R2G-08 | `verify-record` never shows the shared failures it accepts; `own_market` is self-declared | Confirmed | Info | Signed off |
| R2G-09 | Fixed replay keys are public; the gate's own market alone still uses random keys | Not vulnerable | Info | Not gated |

The gate re-review cleared unregistered markets, cross-market divergence between the record and check replays, a deliberately failing candidate on markets the deployed build passes, and layout checks failing under the deployed build too.

### R2G-01: excused by program, not by error

`compare_with_deployed` excused a failed step when the deployed build failed the same kind on the same market in the same program, using the error only to word the note (`gate/src/check.rs:383-401` at `3003439`).
A third party who blocks a job inside the buy wall AMM on its own market (H058's reassigned ATA, about 0.1 SOL) let a candidate fail that job there with any error of its own, hiding a state-specific regression the planter could later expose by undoing the block.
Fix: when the failing program is the buy wall AMM, a failure is excused only if the error is the same; the error enum is append-only, so codes are stable across builds.

### R2G-02: the gate's own market vetoed by the cluster's configuration

The gate's own market (`POOL4-53`) was built in the cluster's world and every failure there counted, so a router pause, or a reassigned wrapped SOL ATA of `SUITE_TREASURY` (or of `DESIGNER_RECIPIENT` once set, a third party's key), refused every candidate, an emergency fix included.
Fix: the own market tests the candidate, not the cluster's configuration, so its world is readied as a seeder would ready it.

### R2G-03: wallets taken from the candidate's tree

The record run, meant to capture the deployed build's behaviour, took `sweep_fees`'s wallet from the candidate tree's `FeeSlot::wallet`; a tree that made slot 2's wallet refuse recorded a gate-side failure, left the sweep out of every list and passed, after which the suite's fee ledger could never be swept.
Fix: what the record run sends comes from outside the candidate tree, and a gate-side failure never stands in for the deployed build's answer.
This also closes the wallet path left open in H033.

### R2G-04: fixture baselines without provenance (Info)

CI replays each fixture against its recorded baseline, which nothing ties to the build it names, so an edited or re-recorded fixture could excuse a fixture-market-specific regression; the gate's own market still catches a uniform one.
Signed off: CI only, layout checks are never excused, and cluster runs always record a fresh baseline from the deployed program.

### R2G-05: `pipeline_market_info` checked against its own answer (Info)

For a market the replay registers, the router records what the candidate's `pipeline_market_info` returns, and the check then compares the candidate with that record; registered cluster markets still compare against the record the deployed build wrote on chain.
Not gated.

### R2G-06: the window before the upgrade lands

`deploy.sh` runs `verify-record`, then `solana program deploy`, which writes the whole 421,032-byte build (about 417 write transactions, roughly 10 to 40 seconds at devnet rates, plus start-up and RPC round trips) before upgrading; a market created in that window is served by a build never run on it, and after the upgrade the new build is its own baseline.
Signed off with H097: an honest creator unlucky enough to launch mid-deploy with a market kind absent from the snapshot, on devnet, recoverable while the upgrade key is held; mainnet is frozen before deployment, so the gate never governs a mainnet upgrade.

### R2G-07: records with no expiry

A record counts while the deployed hash is unchanged and every current market key is in its list, with no age limit and no comparison of any market's state, so a market that changes after the run (a CREATED market later seeded differently, an unblocked market whose steps were excused) stays covered.
Signed off as a Low; the remedy, if wanted later, is short-lived records and a gate run inside `deploy.sh` right before the upgrade.

### R2G-08: shared failures not shown at deploy (Info)

`verify-record` never prints the shared failures a record accepted, so an operator deploying from someone else's record does not see which payouts or trades were never exercised; `own_market` is an unsigned field in a committed file, the existing trust boundary.
Signed off.

### R2G-09: fixed keys (Info)

The replay's role keys are derived from a public PDA, so anyone can compute them, but they are used only inside LiteSVM and the gate's RPC client is read-only: not vulnerable.
The gate's own market still uses random keys, so its addresses, bumps and compute differ from run to run; noted, not gated.

## Notes the verifiers left

These have no security effect; they are recorded so they are not lost.

- The stale hook wording in `metadata.json`, the spec's keeper notes and `docs/spec/keeper-runner.md` that VERIFY-H001 and VERIFY-H048 named was corrected in commit `58ffde6`.
- The spec's sentence that faking work never pays is true only with H008's measured bound (VERIFY-H008).
- The spec does not yet say the wall is a buy-and-burn (VERIFY-H041).
- No test covers a MemoTransfer-required Token-2022 recipient account, on the program or the gate side (VERIFY-H058).
- Aviary's panel does not yet show the seeder or warn when roles coincide (VERIFY-H061).
- Several fixes are pinned by tests whose names carry another finding's ID (H031, H048, H056 and H061 by the `sos_h001`, `sos_h002` and `sos_h007` tests); the verifiers confirmed each exercises the attack.
