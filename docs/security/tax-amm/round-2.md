# Tax AMM: review round 2

Round 2 of the internal adversarial review of `programs/tax-amm`, run on 2026-11-22 after the owner's answers to round 1 (1a, 2a, 3a, 4a and 5a, 2026-11-22) and their fixes landed on the hardening branch.
It is not an audit and no external review has been done; [README.md](README.md) says what was reviewed and how, and [round-1.md](round-1.md) describes each original finding.
Round 2 had two parts:

1. **Verification** of every confirmed or potential finding of round 1 and of the ten harness notes T01 to T10, against the fixed code at `9309b5c`, by seven verifier agents in Stronghold of Security's verify phase, each re-reading its findings' attack paths, with exact-integer models where numbers mattered.
2. **A re-review of the program code the fixes changed**, `git diff 77b6ddc..9309b5c -- programs/tax-amm/src programs/mint-rules/src`, by an independent agent looking for new weaknesses and regressions rather than checking the old findings.

The agents read code only: none built or ran anything, since the build output is shared.
Code locations are relative to `programs/tax-amm/` at `9309b5c`.

## Summary

- Of round 1's 37 findings, verification found 19 fixed, all six confirmed Mediums among them; 17 open and signed off by the owner's answer 5a, the potential Medium H036 among them; and one Info (H082) left as designed.
- All ten harness notes T01 to T10 were verified fixed.
- Verification and the re-review found no Critical, High or Medium, three Lows and four Info notes, and a list of wording and test gaps.
- R01, the one Low that let a round 1 attack back in, is fixed with `sos_r01` in `b85b6ff`; the H024 residual is fixed in the same commit; R02 and the rollback note were signed off by the owner on 2026-11-23 ([sign-offs.md](sign-offs.md)).
- Every wording and test gap listed below is closed in `b85b6ff` or the commits beside it, except the containment hook fuzzer's unasserted tallies, left to [the containment hook's hardening](https://github.com/imDev2023/testing-pipeline/issues/74).

## Verification of round 1

Status is the verifier's verdict on the code it read; the disposition is final, as of 2026-11-23.
"Signed off" means accepted as a Low with the owner's sign-off ([sign-offs.md](sign-offs.md)).

| ID | Round 1 severity | Verification status | Final disposition |
| --- | --- | --- | --- |
| H007 | Medium | FIXED | Fixed (1a), and checked again at the seed since R01 |
| H008 | Medium | FIXED | Fixed (1a) |
| H009 | Medium | FIXED | Fixed (1a, 2a); its remainder is H036 and H086, signed off |
| H010 | Medium | FIXED | Fixed (2a) |
| H019 | Medium | FIXED | Fixed (4a) |
| H023 | Medium | FIXED | Fixed (3a) |
| H036 | Medium (potential) | ACCEPTED | Signed off |
| H024 | Low | FIXED | Fixed; the containment hook added to the market's own addresses in round 2 |
| H034 | Low | ACCEPTED | Signed off |
| H035 | Low | ACCEPTED | Signed off; the rate-flip part is gone with 2a |
| H037 | Low | ACCEPTED | Signed off; the spec now says an upgrade never lowers `MAX_TAX_BPS` |
| H038 | Low | FIXED | Fixed; the gate now quotes at the snapshot's slot and is tested on a market with a pending change |
| H039 | Low | ACCEPTED | Signed off |
| H013 | Low | FIXED | Closed by 1a, with a test that a contained mint can't graduate |
| H016 | Low | FIXED | Fixed (1a) |
| H025 | Low | ACCEPTED | Signed off, with R02 |
| H026 | Low | FIXED | Closed by 1a |
| H028 | Low | FIXED | Closed by 1a and 2a |
| H030 | Low | ACCEPTED | Signed off; mostly closed by 1a |
| H041 | Low | FIXED | Fixed |
| H044 | Low | ACCEPTED | Signed off; 2a gives 300 slots to renounce against a hostile rate change |
| H055 | Low | ACCEPTED | Signed off |
| H056 | Low | ACCEPTED | Signed off |
| H061 | Low | ACCEPTED | Signed off |
| H062 | Low | ACCEPTED | Signed off; 4a closes its harmful use |
| H069 | Low | FIXED | Fixed |
| H071 | Low | ACCEPTED | Signed off; `QUOTE_MINTS` added to its mainnet item |
| H086 | Low | ACCEPTED | Signed off |
| H092 | Low | ACCEPTED | Signed off |
| H096 | Low | ACCEPTED | Signed off |
| H100 | Low | FIXED | Fixed (wording) |
| H047 | Info | FIXED | Fixed |
| H049 | Info | FIXED | Fixed |
| H050 | Info | FIXED | Documented, the dust case now said in words |
| H076 | Info | ACCEPTED | Signed off |
| H080 | Info | FIXED | Closed by 1a |
| H082 | Info | NOT_FIXED | By design: interfaces label rates by direction |

What the fixes leave of H009, the composite rug, in round 1's exact-integer market at posted rates: a sole recipient takes 17.1% of buyers' spend through its tax; with a 5 SOL buy in the seed transaction, sold first, 43.8%; adding 10% or 20% of supply kept off the seed, 64.0% or 81.4%; and 20% kept off the seed with no market role, 58.3%; against 98.7% in round 1, and no quote stays locked, since every holder can always sell.

### Harness notes

| ID | Status |
| --- | --- |
| T01 | FIXED: a refusal is the tax AMM's only when the innermost failing program is the tax AMM and the error number matches |
| T02 | FIXED: only hook-calling invocations go unmeasured; `sos_t02` now runs on a real bound contained mint, since the tax AMM's own fuzzer has no live hook under 1a |
| T03 | FIXED |
| T04 | FIXED: the tallies are asserted, now with every pending-rate state and `OwedSlotRedirected` |
| T05 | FIXED |
| T06 | FIXED: invariant 4's new words are tied to the spec |
| T07 | FIXED |
| T08 | FIXED |
| T09 | FIXED |
| T10 | FIXED |

## New findings

| ID | Title | Severity | Status | Fixed in |
| --- | --- | --- | --- | --- |
| R01 | The hook rule ran only at creation, so a market an earlier build created, still unseeded when the upgrade lands, could open with a foreign hook | Low | Fixed: the seed checks the hook again | `b85b6ff`, `sos_r01_a_market_created_before_the_hook_rule_never_opens_with_a_foreign_hook` (`tests/mint_rules.rs`) |
| H024 residual | The containment hook's id was not among the market's own addresses, so a slot naming it would strand its tax | Low | Fixed | `b85b6ff`, the H024 tests |
| R02 | A recipient that turns on required memos pins itself to its slot while owed, under 3a | Low | Signed off (2026-11-23) | [sign-offs.md](sign-offs.md) |
| Rollback | A rollback to a build before the pending rates leaves a pending change that a roll forward applies late | Low | Signed off with H039 (2026-11-23) | [sign-offs.md](sign-offs.md); the spec's "Upgrades and freezing" |
| R03 | A dust swap between a `distribute` and a later `set_recipients` books tax to the slot again, so the two belong in one transaction (one fits, about 950 bytes for four slots) | Info | Documented | The spec's "Payout" |
| R04 | The 300-slot delay does not cover a durable-nonce transaction or a multisig proposal executed later | Info | Documented | The spec's "Rates" |
| R05 | Quotes read the clock, so an off-chain quoter left behind the cluster's slot quotes the old rates | Info | Documented | The spec's "Rates" |
| R06 | Small gaps: the compute section didn't mention the unlock PDA's bump search; a contained mint never bound can be seeded single-sided into a dead market by its own seeder; renouncing does not say in its event that it cancelled a change; Circle can still freeze a USDC recipient | Info | Documented | The spec's "Compute ceilings", "Rates", `TAX-58` |

R01 was found by both the hook verifier and the re-review.
Its window was real: devnet still ran the build without the hook rule, so a market created there before the upgrade with an allow-all hook could have opened afterwards as round 1's H007 honeypot, taking 17.1%, 32.3% or 58.2% of buyers' payments for a 5%, 10% or 20% bag.

Wording and test gaps found and closed in `b85b6ff` and beside it: the spec, the metadata's `set_taxes` description and a doc comment still said a rate change applies at the next swap; the creation transaction's sizes predated the seed's 32-byte hash (a mixed pair is now 9 bytes over 1,232 and needs an address lookup table or a second transaction); "150 slots" for a blockhash's lifetime, which is 150 blocks; the cap's "never stops a holder selling" without the dust case; the exit rule's "the largest covered sale must quote" without the dust case; the fuzzer's invariant 4 checked a bound on the delay but not its exact value, and no tally showed it reached the pending-rate states; no test pinned the cancel event, an authority on a single-sided seed's empty side, a contained mint refused at graduation, or a hook with no authority; Aviary's tax panel and trade box did not show or price a pending change; and the containment hook fuzzer clamped its bind cost and built its contained mint by hand.

## What was checked and found sound

- Every instruction that writes the rates applies a due change first, nothing changes the rates in force within a slot (an exact model of 20,000 random sequences, and the fuzzer's invariant 4), and quote and swap always price at the same rates.
- The pending fields sit inside the old reserved bytes; the account is 596 bytes, the tax side at 10 and `tax_collected` at 460, and the containment hook, the keeper, the release gate and the client read both old and new markets right.
- The terms hash covers everything that decides what a seeder agrees to, is checked before anything moves, and can be changed before the seed only by the tax authority; the Rust tests' hash, the TypeScript client's and an independent Python model agree on pinned vectors.
- Each mint's hook and authorities are checked before its side's transfer, a side seeded with nothing included, and no account can be passed in place of the market's.
- The owed-slot rule holds against duplicate wallets, reordering and two calls in one transaction.
- No new panic path; the new errors are appended, so no existing code moved.
