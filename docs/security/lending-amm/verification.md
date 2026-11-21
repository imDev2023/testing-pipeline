# Stronghold of Security - Verification Report

Internal adversarial review, round 2 (verify phase plus a re-review of every changed line); not an audit.

**Original review date:** 2026-11-17 (round 1, commit `0ef0e06`)
**Verification date:** 2026-11-17
**Code verified:** `imDev2023/build-86` at `1876bb0` (`git diff 0ef0e06 HEAD -- programs/lending-amm/src`, 1,546 diff lines)
**Findings verified:** 15 (13 fixed and 2 mitigated in round 1's remediation table)
**Method:** three parallel opus reviewers (remove_lent_side and share maths; freshness gates; withdraw mode, rebalance and Kamino checks), each writing `findings/VERIFY-*.md` and a candidate list in `round2/`, then calibrated by the orchestrating agent.
No builds or tests were run in this phase; klend 1.28.0 source was read, not copied.

## Summary

| Status | Count |
|--------|-------|
| FIXED | 12 |
| PARTIALLY_FIXED | 3 |
| NOT_FIXED | 0 |
| REGRESSION | 0 |
| CANNOT_VERIFY | 0 |

New round 2 findings: 1 MEDIUM, 5 LOW, 13 INFO.
No CRITICAL or HIGH finding.
One MEDIUM is open: R2-01.

## Verification results

| ID | Original severity | Status | Notes |
|----|-------------------|--------|-------|
| H001 | MEDIUM | FIXED | Same-slot refresh gate reads `last_update.slot`, which klend writes only at the end of `refresh_reserve`; `ctokens == 0` exemption cannot be dodged (donated cTokens are never recorded or priced) |
| H002 | LOW | FIXED | Quote and swap gate identically, before any redeem or state write; deprecated exemption sound given H008 |
| H003 | MEDIUM | FIXED | One `rebalance` per transaction; current index skipped, stack-height check still refuses CPI callers |
| H004 | MEDIUM | FIXED (LOW residual open) | Exit wait holds at slot 0, clock edges and every other edge checked; layout safe (field at 407, reserved 248, account 663 bytes); residual is cheaper than stated, see R2-02 and R2-04 |
| H005 | INFO | FIXED | `take = (net / held) x paid + (net % held) x paid / held` equals `floor(net x paid / held)` exactly, never overflows, `take <= net` |
| H006 | MEDIUM | PARTIALLY_FIXED | The other mint's freeze or hook can no longer trap the lent side; but `remove_lent_side` is sandwichable (R2-01) and a freeze of the lent vault itself still traps the cTokens (R2-03) |
| H007 | LOW | FIXED | Every Kamino read after creation goes through `lent_entry()` |
| H008 | LOW | FIXED | Only versions 1 and `u64::MAX` pass, matching klend 1.28.0 |
| H016 | LOW | FIXED (mitigated) | Reduced to H004's residual |
| H024 | MEDIUM | PARTIALLY_FIXED | Guidance in `metadata.json` and the spec; `scripts/demo.ts:234,241` still offers maximums well over the ratio (R2-07) |
| H048 | LOW | FIXED (mitigated) | Bounded by 9,000 slots of interest, below the fees; margin smaller than stated (R2-12) |
| H054 | INFO | FIXED | Asserts correct for every relation round 1 listed; one relation missing (R2-19) |
| H087 | LOW | PARTIALLY_FIXED | `ReserveStale` refusals and SH-10 in the fuzzer; no add-then-leave valuation invariant at the refreshed rate (R2-05) |
| S002 | LOW | FIXED | Both gates read reserve state, so a refresh inside an earlier klend CPI counts |
| S004 | INFO | FIXED (spec only) | No keeper code in the repo yet to check against |

## New findings (round 2)

| ID | Severity | Location | One line |
|----|----------|----------|----------|
| R2-01 | MEDIUM | `src/instructions/remove_lent_side.rs:116`, `:153-166` | `min_lent` bounds only the buffer's part; a bundle (swap other for lent, permissionless `rebalance` to restore the buffer's share, victim's `remove_lent_side`, swap back) takes up to `1 - B0 / (0.2 x L0)` of the leaver's lent payout (9% to 40% in worked examples), and H006's own hostile issuer with a selective hook can do it to every LP fleeing this way |
| R2-02 | LOW | `src/withdraw_mode.rs:101-127`, spec `:288-296` | H004's residual needs no absent keeper: capital placed in Kamino only around the keeper's predictable 10-minute sweeps (or sandwiching them) keeps any honest reading from resetting the wait |
| R2-03 | LOW | `src/instructions/remove_lent_side.rs:130-151` | With USDC as the lent mint, a freeze of the market's lent vault fails the buffer payout and traps the unfreezable cTokens too (round 1 H006 Step 7, fix 2, never dispositioned) |
| R2-04 | LOW | `src/withdraw_mode.rs:93-95` | A recorded sighting survives emergency mode, since every `rebalance` refuses with `KaminoStopped` and nothing can reset it; one bundle right after an incident longer than the wait takes the market out of withdraw mode |
| R2-05 | LOW | `tests/common/fuzz.rs` | H087 residual: no invariant values an add-then-leave at the refreshed rate, no two-rate Z3 claim, and the fuzzer judges staleness with the program's own `refreshed_within` and constants, so it cannot catch a wrong comparison or bound |
| R2-06 | LOW | `src/instructions/resolve_accounts.rs` | `pipeline_resolve_accounts` is not gated and plans the redeem at the stale rate; after the required refresh the swap can need a redeem it was not given and fails with `RedeemAccountsMissing`, and re-resolving repeats it (failed transactions only) |
| R2-07 | INFO | `scripts/demo.ts:234,241` | Demo offers the token side about 33% and 100% over the ratio, the shape H024 warned about |
| R2-08 | INFO | spec `:377-384` | Arbitrage after a thaw and liquidity added just before a lent-side exit capture part of the forfeited other side; normal AMM behaviour, needs a spec sentence |
| R2-09 | INFO | `tests/common/fuzz.rs`, `tests/hardening.rs` | The fuzzer never calls `remove_lent_side`; the hardening test covers a freeze only, no refusing hook, no market with zero cTokens |
| R2-10 | INFO | `src/shares.rs:338-339` | H005 unit test comment off by one; the assertion is right |
| R2-11 | INFO | `src/instructions/remove_lent_side.rs:56-61` | An LP who names the lent vault as their own destination loses their buffer part, left unrecorded in the vault; harms only the caller |
| R2-12 | INFO | `src/config.rs` (`TRADE_MAX_RESERVE_AGE_SLOTS`), spec | The 9,000-slot derivation uses 0.11%; klend counts 2 slots a second (about 0.143%) and the derivation omits the rewards cap and time-based interest; margin 1.7 to 3.5 times, still under the 0.5% round trip |
| R2-13 | INFO | spec `:326`, `metadata.json:263` | The spec line contradicts the emergency-mode table; metadata still says `rebalance` may sit beside "other rebalance calls", which H003's fix removed |
| R2-14 | INFO | `src/instructions/rebalance.rs` (`allowed_beside_rebalance`) | klend's `refresh_reserves_batch` with `skip_price_updates` refreshes without oracles (relevant to H102) and is refused beside `rebalance`; not checked against the deployed klend |
| R2-15 | INFO | `src/withdraw_mode.rs:131-142` | The exit wait makes holding a market in withdraw mode cheaper (one bundle an hour); yield only, already proposed for acceptance (H017 to H019) |
| R2-16 | INFO | `src/withdraw_mode.rs` proofs | The Proptest and Kani property does not pin the mode when a wait is reset with nothing moved; the fuzzer covers it |
| R2-17 | INFO | `src/instructions/rebalance.rs` | No event when a sighting is recorded or forgotten, so monitoring sees a wait only by polling |
| R2-18 | INFO | `src/withdraw_mode.rs:111-128` | A reset is recorded only if its `rebalance` succeeds, so it depends on the keeper refreshing the reserve first (S004) |
| R2-19 | INFO | `src/config.rs` | `WITHDRAW_MODE_EXIT_DELAY_SLOTS > 0` is not asserted at build time |

### Calibration notes

R2-01 was proposed as LOW by its reviewer and is raised to MEDIUM here.
Round 1 rated H024, a slippage bound that does not cover the whole payout, MEDIUM; R2-01 is the same class with no existing primitive to fall back on, and it lets the very adversary H006 was fixed against (a hostile issuer whose selective hook still passes its own transfers) take up to about half of each fleeing LP's lent payout.
It is not exploitable under a full freeze of the other vault, since the sandwich needs the other mint to move both ways.
Fix: `remove_lent_side { lp, min_lent, min_ctokens }`, refusing with a new error when `removal.ctokens < min_ctokens`; a cToken count needs no Kamino read.
With both bounds at the quote less the tolerance, neither a fall in `L` nor a shift between buffer and cTokens can pass.
Update `LENDING-94`, the metadata action and the spec, and add a hardening test that runs the bundle and expects the refusal; optionally give `remove_liquidity` in kind the same bound for symmetry.

R2-04 was proposed as INFO and is raised to LOW, since it bypasses the exit wait's protection in exactly the window after a Kamino incident; fix: when `kamino.stopped` and `exit_seen_slot != 0`, succeed with no move and reset the sighting instead of refusing.

## Detailed results

### Fixed

- H001, H002, S002, H048: `findings/VERIFY-H001.md`, `VERIFY-H002.md`, `VERIFY-S002.md`, `VERIFY-H048.md`; no bypass of either gate found (future slot, slot 0, `mark_stale`, flash loans, deprecation, donated cTokens, a market moving to 0 cTokens and back all checked).
- H003, H004, H007, H008, H016, H054, S004: `findings/VERIFY-*.md` of the same IDs.
- H005: `findings/VERIFY-H005.md`; the guard (`paid == 0 || held == 0 || paid > held`) is unreachable from both callers.

### Partially fixed

- H006: the trap by the other mint is closed (no CPI to its token program, no remaining accounts read, the mint account only deserialized); R2-01 and R2-03 remain.
- H024: program guidance complete; the demo script contradicts it (R2-07, INFO).
  The MEDIUM itself is closed in guidance.
- H087: R2-05.

### Not fixed

None.

### Regressions

None in the sense of a fix breaking previously sound behaviour.
R2-01 is a new weakness in new code (`remove_lent_side`), counted as a new finding.

### Cannot verify

None.

## Regression scan

Phase 0.5 patterns over the added lines of `src/` (1,546 diff lines):

| Pattern | Hits | Assessment |
|---------|------|------------|
| `UncheckedAccount` | 9 | All in `RemoveLentSide`; each is address-checked against the market, ATA-checked in `pay_ctokens_in_kind`, or a destination the token program checks |
| `unwrap` / `expect` | 4 | All in tests and Kani proofs |
| `as u*` casts | 25 | Widening casts in proofs and `totals_after_in_kind` |
| `saturating_*` | 3 | `refreshed_within` (a future slot reads as fresh, impossible from klend) and the exit wait's deadline (saturates at `u64::MAX`, never reached) |
| Instruction introspection | 2 | `load_current_index_checked` and `load_instruction_at_checked` on the address-checked sysvar |
| `Clock::get` | 3 | Gates and the exit wait; slots only |
| ATA creation | 1 | `create_idempotent`, payer and owner the signing LP |
| `remaining_accounts`, `invoke_signed`, `unsafe`, `close` | 0 | none |

No new hot spot beyond the findings above.

## Recommendations

1. Fix R2-01 before the freeze: add `min_ctokens` to `remove_lent_side` with a regression test of the bundle.
2. Fix R2-04 (reset the sighting under emergency mode) and R2-19 (assert the delay is positive); both are small program changes.
3. Restate H004's residual with R2-02 and make the keeper sweep markets with a sighting every few slots with jitter; emit a sighting event (R2-17).
4. Decide R2-03: a lent-side exit that pays the cTokens even when the lent vault is frozen, or the owner's written sign-off.
5. Close the test gaps: R2-05 (two-rate add-then-leave invariant and an independent staleness oracle in the fuzzer) and R2-09 (`remove_lent_side` in the fuzzer, a refusing-hook test, a zero-cToken market).
6. Fix R2-06 by listing the redeem accounts for every lent-side output when the reserve is past the trade bound.
7. Correct the documents: R2-07 (demo maximums), R2-08, R2-12, R2-13 (spec `:326`, `metadata.json:263`).
8. Add R2-02 to R2-06 and the INFO items to the sign-off list if left unfixed (BAR-18).

Candidate details, attack sequences and what each reviewer found sound are in `round2/remove-lent-side.md`, `round2/freshness-gates.md` and `round2/withdraw-mode-rebalance.md`; the reviewers' local labels (RLS-xx, F-x, R2-WM-x) map to the R2 IDs above as: RLS-01 R2-01, R2-WM-1 R2-02, H006 Step 7 R2-03, R2-WM-2 R2-04, H087 gaps R2-05, F-1 R2-06, H024 demo R2-07, RLS-02 R2-08, RLS-03 R2-09, RLS-04 R2-10, RLS-05 R2-11, F-3 R2-12, F-4 R2-13, F-2 R2-14, R2-WM-3 R2-15, R2-WM-4 R2-16, R2-WM-5 R2-17, R2-WM-6 R2-18, R2-WM-7 R2-19.

---

## Round 2 follow-up

Internal adversarial review, verify phase re-run on the fixes made after round 2; not an audit.

**Code verified:** `imDev2023/build-86` at `f71668b` (`git diff 1876bb0 HEAD -- programs/lending-amm/src programs/lending-amm/tests programs/lending-amm/metadata.json docs/spec/lending-pool.md`, plus `scripts/demo.ts`, the generated client and the IDL).
**Method:** every changed line read as an attacker would, with its regression test; klend 1.28.0 source read, not copied (`handler_refresh_reserve.rs`, `handler_refresh_reserves_batch.rs`, `lending_operations::refresh_reserve`, `lib.rs` access controls).
No builds or tests were run in this phase.

### Verdicts

| ID | Round 2 severity | Verdict | Notes |
|----|------------------|---------|-------|
| R2-01 | MEDIUM | FIXED | `min_ctokens` checked beside `min_lent` before any transfer (`remove_lent_side.rs:120-124`); see below; the bound adds a liveness lever, R2F-01 |
| R2-04 | LOW | FIXED (residual R2F-02) | The forget path records only `exit_seen_slot = 0`, keeps the mode, moves nothing and succeeds at most once per emergency; no new abuse; it cannot land through the keeper's documented transaction under the lending market's emergency mode |
| R2-05 | LOW | PARTIALLY_FIXED (residual INFO) | The fuzzer reads `last_update.slot` from the reserve's bytes at a test-side offset checked against Kamino's SDK and compares on its own (`slot > refreshed + max_age`, equivalent to the program's `saturating_sub <= max_age` at every reachable slot); it still imports both age bounds and the deprecation check from the program, and no two-rate add-then-leave invariant was added (`sos_h001` covers it as one concrete test) |
| R2-07 | INFO | FIXED | `maximumsAtRatio` buys `floor(wsol x N / L)` shares, asks each side's part rounded up plus 1%, and both later deposits use it; the second wallet's 50,000,000,000 tokens cover its ask of about 25,250,000,000 |
| R2-09 | INFO | PARTIALLY_FIXED (residual INFO) | `RemoveLentSide` step added to the fuzzer with an independent model (below); the hardening test still has no refusing hook and no market holding zero cTokens |
| R2-10 | INFO | FIXED | `(2^64 + 1)(2^64 - 2) = 2^128 - 2^64 - 2`, matching the assertion |
| R2-12 | INFO | FIXED | `10 x 9,000 / 63,072,000 = 0.1427%`, as the comment and the spec now say |
| R2-13 | INFO | FIXED | Spec now allows adding under the lending market's emergency mode only into a market holding no cTokens (klend's `emergency_mode_disabled` on `refresh_reserve` confirms why); metadata drops "other rebalance calls" |
| R2-14 | INFO | FIXED | Discriminator `[144, 110, 26, 103, 162, 204, 252, 147]` recomputed from `sha256("global:refresh_reserves_batch")`; the batch handler only loads reserves owned by klend, refuses under the lending market's emergency mode, and runs the same `lending_operations::refresh_reserve` as `refresh_reserve` (interest, rewards, price, cap timestamps); no token CPI, so it moves no liquidity |
| R2-19 | INFO | FIXED | `const _: () = assert!(WITHDRAW_MODE_EXIT_DELAY_SLOTS > 0);` in `src/config.rs` |

**R2-01 in detail.**
Both parts are now bounded in units the program can read without Kamino: buffer units and cToken counts.
The lent payout's value is `buffer part + cToken part x rate`, and within a bundle the rate only rises (only Kamino's owner can lower it, by `socialize_loss`, which is H015), so any sequence that lowers the payout must lower one of the two parts and is refused beyond the LP's tolerance.
Round 2's worked bundle (90,000 lent out of a 100,000 buffer, then `rebalance` redeeming back to 182,000) cuts the victim's cToken part from `90,000 / r` to `72,800 / r`, below a 1% tolerance of `89,100 / r`, so it refuses with `BelowMinCtokens`; the larger variant fails the same way.
Raising the share count by adding does not help either: an add lowers the cToken part per share (see R2F-01).
Error code appended last, so no existing code moved; IDL, metadata, Codama client, demo and decision `LENDING-94` all carry the new argument.
The regression test checks both refusal edges and the exact pass; it does not replay the bundle (R2F-03).
`remove_liquidity` in kind still has no cToken bound; round 2 judged it not exploitable for profit, so it stays an optional symmetry, not a finding.

**R2-04 in detail.**
`exit_seen_slot != 0` implies `withdraw_mode` (a sighting is recorded only while waiting in withdraw mode, and leaving records 0), so the forget path never touches a market outside withdraw mode.
It writes only `exit_seen_slot`, which only `rebalance` reads; quotes, swaps, adding and removing never read it or `withdraw_mode`.
`require_alone` and the account checks still run first, and nobody outside Kamino can turn on an emergency or deprecate a reserve, so the new success is reachable only while Kamino has really stopped.
Its effect is the safe direction: the market stays in withdraw mode for a full wait after the emergency ends; on a deprecated reserve it was stuck in withdraw mode already.
A second call in the same emergency refuses with `KaminoStopped` again, so keepers simulating first pay for at most one forget.
`KaminoAccounts::check` has no freshness gate, so `rebalance` reaches the forget path however stale the reserve is.
The Kani and Proptest property now pins the stopped branch (only a forget, mode unchanged, nothing moved) and the fuzzer's model was changed to match; its assertion that a reading at or below the threshold leaves no sighting now holds unconditionally, which is right.

**R2-05 and R2-09: the fuzzer's model.**
`remove_lent_side` in the fuzzer computes each part as `floor(whole x shares / N)` with `N` read from the LP mint's bytes plus `MINIMUM_LIQUIDITY`, checks the event, the other side unchanged in the books and in the LP's wallet, both lent parts leaving exactly, and the running totals by the direct formula `net x ctokens / held` rather than the program's split product.
It expects success in every Kamino state, a failed layout check included, and `ZeroRemoval` only when both lent parts round to nothing, which is the spec.
It always passes the exact parts as both minimums, so every successful step exercises both bounds at equality; it never asks for a refusal, which the hardening test covers.
The model is independent where it matters and agrees with the code.

### New findings (round 2 follow-up)

| ID | Severity | Location | One line |
|----|----------|----------|----------|
| R2F-01 | LOW | `src/instructions/remove_lent_side.rs:120-124` | Per-part minimums refuse shifts between the buffer and the cTokens that cost the leaver nothing; a fee-free `add_liquidity` before the exit lowers the cToken part per share, so the hostile issuer of H006 can keep a fleeing LP's exit failing at the price of transaction fees |
| R2F-02 | LOW | spec `:298`, `metadata.json` (`rebalance` description) | The R2-04 forget cannot land through the keeper's documented transaction while the lending market's emergency mode is on, since klend refuses the prepended `refresh_reserve` and the whole transaction fails |
| R2F-03 | INFO | `tests/hardening.rs` | `sos_h006` checks the `min_ctokens` edges but does not replay round 2's bundle; `sos_r2_04` covers the reserve's emergency mode only, not the lending market's, and sends `rebalance` without a refresh |
| R2F-04 | INFO | several | Wording: a stale fuzzer comment, a misplaced doc comment, the spec's deprecated row and "before anything else", and two over-long comment lines |

**R2F-01.**
`add_liquidity` puts the lent deposit into the buffer and mints shares, leaving `ctokens` unchanged (`add_liquidity.rs`), so an add of a fraction `g` of the pool lowers the cToken part per share by `g / (1 + g)` while raising the buffer part; the leaver's value is unchanged.
With both minimums at the quote less a tolerance `s`, an add of a little over `s / (1 - s)` of the pool before the exit (about 1% of each side for a 1% tolerance), with klend's `refresh_reserve` in its transaction as H001's gate needs, refuses the exit with `BelowMinCtokens`; the attacker removes again afterwards, fee-free.
Under H006's selective hook the issuer's own transfers into and out of the vault still pass, so the adversary that `remove_lent_side` exists for can keep refusing a fleeing LP's exit for fees and a tip, as long as it sees the LP's transaction before it lands (the same visibility R2-01's sandwich needed).
Widening the tolerance only trades the refusal for R2-01's loss within that tolerance.
An honest `rebalance` or add landing between quote and send refuses the exit the same way; a retry heals that.
Before the fix only `min_lent` could be refused this way, and only by a paid swap or a `rebalance` the band allowed.
Nothing is lost; liveness only, hence LOW.
Fix, preferred: replace the two minimums with one value bound at a rate the caller supplies, `buffer part + floor(cToken part x caller_rate / scale) >= min_lent_value`, which still reads no Kamino account, accepts any shift between the parts at the caller's rate (a caller quoting the stored or refreshed rate understates the true one, so the bound only gets stricter), and still refuses R2-01; or keep both minimums and record the owner's acceptance, with Aviary sending the exit privately (a Jito bundle) and retrying on `BelowMinCtokens`.

**R2F-02.**
klend 1.28.0 puts `emergency_mode_disabled` on `refresh_reserve` (`lib.rs:129-130`), and `refresh_reserves_batch` refuses with `GlobalEmergencyMode` itself, while the spec tells the keeper to put `refresh_reserve` before each `rebalance` (`:298`) and the metadata says to put it first.
Under the reserve's own emergency mode klend still refreshes (it only skips the price), so the forget lands; under the lending market's emergency mode the keeper's transaction fails whole and the sighting survives, which is R2-04 again for the case it was mostly about.
On a deprecated reserve the refresh fails too (`ReserveDeprecated`), but there the sighting is harmless, since `rebalance` never succeeds again.
Fix: say in the spec and the metadata that while the lending market's emergency mode is on (or whenever klend refuses the refresh) the keeper sends `rebalance` alone, and that its simulation shows whether it forgets a wait; add the `MarketEmergencyMode` case to `sos_r2_04`.
LOW, as R2-04 was; the program side is correct.

**R2F-03.**
Round 2 recommended a hardening test that runs its bundle and expects the refusal; the test checks the arithmetic edges instead, which proves the check exists but not that the bundle reaches it.
`sos_r2_04` turns on the reserve's emergency mode only; the lending market's mode is the one R2F-02 concerns.

**R2F-04.**
- `tests/common/fuzz.rs`, the comment above the rebalance assertions still says `rebalance` "refuses before reading anything else" when Kamino has stopped; it now forgets a wait.
- `tests/common/fuzz.rs:964-972`: the new doc comment for `remove_lent_side` was inserted under the head of `remove`'s, so `remove_lent_side` carries both and `remove` has none.
- Spec "When Kamino can't pay" table: the deprecated row says `rebalance` "Refuses" without "but forgets a wait", though `redeems_stopped` includes deprecation; spec `:324` still says the refusal comes "before anything else".
- `src/config.rs:55` (133 columns) and `src/instructions/rebalance.rs:87` (120 columns) are comment lines rustfmt does not wrap.

### Every finding left open (all rounds), for the owner's sign-off

No CRITICAL, HIGH or MEDIUM finding is open.
`BAR-18` accepts each line below only with the owner's written sign-off, or a fix.

| ID | Round | Severity | State | What closes it |
|----|-------|----------|-------|----------------|
| H004 residual | 1 | LOW | Sign-off | Keeper liveness; restate with R2-02 |
| H015 | 1 | LOW | Sign-off | Correct the spec sentence on Kamino's losses |
| H017 | 1 | LOW | Sign-off | Acceptance (yield only) |
| H018 | 1 | LOW | Sign-off | Acceptance; watch Kamino's ticket flags |
| H019 | 1 | LOW | Sign-off | Acceptance; correct the spec on its cost |
| H020 | 1 | LOW | Sign-off | Acceptance, or list redeem accounts above the band |
| H021 | 1 | LOW | Sign-off | Acceptance (liveness only) |
| H023 | 1 | LOW | Sign-off | Acceptance; never split creation from the first deposit |
| H025 | 1 | LOW | Sign-off | Acceptance, or the cap-aware `rebalance` (shared with H035) |
| H035 | 1 | LOW | Sign-off | Acceptance, or the cap-aware `rebalance` |
| H039 | 1 | LOW | Sign-off | Structural anchors and a klend upgrade watcher before the freeze |
| H060 | 1 | LOW | Sign-off | Acceptance (bounded by one swap's LP fee) |
| H065 | 1 | LOW | Sign-off | Acceptance (after a total write-off only) |
| H068 | 1 | LOW | Sign-off | Acceptance, or size the headroom against the free-liquidity term |
| H077 | 1 | LOW | Sign-off | Acceptance, or a per-reserve exposure account before the freeze |
| H081 | 1 | LOW | Sign-off | Acceptance |
| H091 | 1 | LOW | Sign-off | Acceptance (self-healing) |
| H102 | 1 | LOW | Sign-off | Check the devnet oracle accounts before deploy |
| S003 | 1 | LOW | Sign-off | Acceptance (blunted by H003 and H004's fixes) |
| R2-02 | 2 | LOW | Open | Keeper sweeps with jitter and the residual restated |
| R2-03 | 2 | LOW | Sign-off | Acceptance (stated in the spec), or pay the cTokens when the lent vault is frozen |
| R2-06 | 2 | LOW | Open | List the redeem accounts when the reserve is past the trade bound |
| R2F-01 | 2 follow-up | LOW | New | One value bound at a caller rate, or acceptance with private sending |

| H040 | 1 | INFO | Sign-off | Acceptance (keeper refreshes first) |
| H053 | 1 | INFO | Sign-off | Acceptance |
| H075 | 1 | INFO | Sign-off | Mainnet launch precondition |
| H078 | 1 | INFO | Sign-off | Acceptance |
| R2-05 residual | 2 | INFO | Open | Two-rate add-then-leave invariant; spec values for the age bounds in the fuzzer |
| R2-08 | 2 | INFO | Open | One spec sentence on arbitrage and liquidity added before a lent-side exit |
| R2-09 residual | 2 | INFO | Open | Hardening cases for a refusing hook and a market holding zero cTokens |
| R2-11 | 2 | INFO | Open | Acceptance (harms only the caller) |
| R2-15 | 2 | INFO | Open | Acceptance with H017 to H019 |
| R2-16 residual | 2 | INFO | Open | Pin the mode when a wait is forgotten with nothing moved outside an emergency |
| R2-17 | 2 | INFO | Open | An event when a sighting is recorded or forgotten |
| R2-18 | 2 | INFO | Open | Keeper refreshes first (S004); see R2F-02 |
| R2F-03 | 2 follow-up | INFO | New | Replay round 2's bundle; add the lending market's emergency mode |
| R2F-04 | 2 follow-up | INFO | New | Wording fixes |

Totals open: 23 LOW (19 from round 1, 3 from round 2, 1 new) and 14 INFO.
R2F-02 was fixed after this follow-up: the spec and `rebalance`'s metadata tell the keeper to send `rebalance` alone while the lending market's emergency mode is on, when klend refuses the refresh, and `sos_r2_04_a_wait_to_leave_withdraw_mode_does_not_outlast_a_kamino_emergency` now runs under both emergency modes, sending `rebalance` alone, which also covers R2F-03's lending market case.
Closed in this follow-up: R2-01 (MEDIUM), R2-04 (LOW, residual R2F-02), R2-07, R2-10, R2-12, R2-13, R2-14, R2-19; R2-05 and R2-09 drop to INFO residuals.
