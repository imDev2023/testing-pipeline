# Lending AMM - Internal adversarial review, round 1

**Project:** lending-amm (the Aviary lending AMM, a strategy on Pipeline's router that lends part of one side to Kamino Lend)
**Review date:** 2026-11-17
**Reviewer:** Stronghold of Security v1.0 and Book of Knowledge (agent pipeline, run inside hardening ticket [#86](https://github.com/imDev2023/testing-pipeline/issues/86))
**Git ref reviewed:** `0ef0e062c00f3034b7e8d319d4f6ce0518cd7cdc` (round 1); remediation state recorded at branch `imDev2023/build-86`, `8f31e48`
**Scope:** `programs/lending-amm/src/` (the deployed program); tests, proofs, the spec (`docs/spec/lending-pool.md`) and `programs/mint-rules` as context; klend 1.28.0 read by identifier and line only (BSL).
**Nature:** an internal adversarial review under `docs/spec/README.md`, "Internal adversarial review" (`BAR-18`).
It is not an audit and must never be presented as one, in metadata or anywhere else.
Every finding file named below lives in `findings/` next to this report; the maths properties Book of Knowledge chose are in `docs/security/lending-amm/maths-properties.md`.

---

## Executive Summary

### Overall security posture

The account, signer and CPI surface held up under 112 hypotheses.
Every Kamino account the program reads or passes to klend is pinned before use, the vault authority signs only transfers, burns and klend calls out of the market's own accounts, `pipeline_swap` accepts only the router's market signer, every price and share figure comes from recorded state rather than token balances, and every rounding at every call site points at the pool.
No CRITICAL or HIGH finding was confirmed, and no finding lets a stranger take LPs' principal at a fresh Kamino rate.

The material risk sat in one place: the program trusted the Kamino reserve's stored exchange rate as current, and trusted one instant's reading of Kamino's free liquidity as the whole truth.
Five MEDIUM findings came out of round 1.
Two families account for three of them: a stale stored rate let anyone add at the old rate and leave after a refresh, taking the incumbent LPs' unbooked interest in one transaction (H001, measured at 2.84 SOL out of a 50 SOL devnet market, 5.7% of the market), and withdraw mode could be forced off by one reading lifted for a single slot, by sibling `rebalance` calls in one transaction (H003) or by klend's own deposit and redeem around a lone `rebalance` in a Jito bundle (H004), pushing about 80% of a market's lent side into a reserve in a liquidity crunch.
The fourth is the other mint's issuer: a freeze authority or transfer hook on the other mint could block every removal and trap the lent side (H006).
The fifth is H024, an add sandwich against a maximum set above the quoted ratio, which the shipped metadata invited.

All five MEDIUMs are fixed on `imDev2023/build-86` (H024 in guidance, since the program already had the primitives), each code fix with a passing `sos_<id>` regression test, and Book of Knowledge's two counterexamples (SH-6, which is H001, and SH-8, which is H005) are closed.
What remains is 25 LOW and 7 INFO findings: 10 fixed or mitigated, and 22 plus one residual (H004's) left open for the owner's written sign-off, which `BAR-18` requires before the hardening ticket closes.
Round 2 (Stronghold's verify phase and a re-review of the changed code) has not run yet; it must review the new `remove_lent_side` instruction and the exit wait, which round 1 never saw.

### Key statistics

| Metric | Count |
|--------|-------|
| Total attack hypotheses investigated | 112 (108 strategies, 4 supplemental) |
| CONFIRMED | 19 |
| POTENTIAL | 17 |
| Investigated and cleared (NOT VULNERABLE) | 76 |
| Requires manual review | 0 |
| Found outside the hypotheses and fixed | 1 (H005, Book of Knowledge's SH-8; investigated as NOT VULNERABLE at real magnitudes) |

### Severity distribution (calibrated, CONFIRMED and POTENTIAL, plus H005)

| Severity | Count | CVSS range | Requires immediate action |
|----------|-------|------------|---------------------------|
| CRITICAL | 0 | 9.0 - 10.0 | - |
| HIGH | 0 | 7.0 - 8.9 | - |
| MEDIUM | 5 | 4.0 - 6.9 | Yes: all five are fixed on `imDev2023/build-86`; round 2 verifies |
| LOW | 25 | 0.1 - 3.9 | Fixed, mitigated, or accepted with the owner's written sign-off |
| INFO | 7 | n/a | No (two fixed, the rest for sign-off) |

| Severity | CONFIRMED | POTENTIAL | Other |
|----------|-----------|-----------|-------|
| MEDIUM | 4 (H001, H003, H004, H006) | 1 (H024) | - |
| LOW | 13 (H002, H007, H016, H017, H018, H019, H025, H035, H068, H077, H087, S002, S003) | 12 (H008, H015, H020, H021, H023, H039, H048, H060, H065, H081, H091, H102) | - |
| INFO | 2 (H040, S004) | 4 (H053, H054, H075, H078) | 1 (H005) |

### Remediation at a glance

| State | Findings |
|-------|----------|
| Fixed in code, with a passing regression test | H001, H002, H003, H005, H006, H007, H008 |
| Fixed with a residual for sign-off | H004 (residual LOW) |
| Fixed in guidance or spec, no program change needed | H024 (metadata and spec), S004 (keeper refreshes first, spec) |
| Fixed by build-time asserts | H054 |
| Fixed in tests and the fuzzer | H087; S002 satisfied (the gates read `last_update.slot`, so CPI refreshes count) |
| Mitigated by another fix | H016 (by H004's exit wait), H048 (by H002's trade gate) |
| Open, pending the owner's written sign-off | H015, H017, H018, H019, H020, H021, H023, H025, H035, H039, H040, H053, H060, H065, H068, H075, H077, H078, H081, H091, H102, S003 |

The coverage gap Phase 4.5 left for this report (BPF stack frames of the large handlers, EP-086, MEDIUM) is closed: `cargo build-sbf` reports no stack offset errors.

### Root cause classes

| Class | Count | Findings |
|-------|-------|----------|
| Spec-level design | 22 | H001, H002, H004, H006, H015, H016, H017, H018, H019, H020, H023, H024, H025, H040, H048, H060, H065, H077, H078, S002, S003, S004 |
| Code defect | 10 | H003, H005, H007, H008, H021, H035, H053, H054, H068, H091 |
| External dependency (Kamino) | 2 | H039, H081 |
| Operational | 2 | H075, H102 |
| Test or proof gap | 1 | H087 |

### CVSS score summary (findings the investigators gave a vector)

Scores are computed from each investigator's CVSS 3.1 vector.
Where CVSS and the calibrated rating differ, the knowledge base's impact-times-likelihood matrix decides; the reasons are in "Severity re-calibration".

| ID | Finding | CVSS | Vector | Calibrated |
|----|---------|------|--------|------------|
| H006 | Other mint's freeze or hook traps the lent side | 6.8 | `CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:N/I:N/A:H` | MEDIUM |
| H023 | First deposit into a router-created market | 5.9 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:H/A:L` | LOW |
| S003 | Capital-free forced withdraw-mode exit | 5.4 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:N/I:L/A:L` | LOW |
| H003 | Sibling `rebalance` calls in one transaction | 4.9 | `CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:C/C:N/I:L/A:L` | MEDIUM |
| H004 | Withdraw-mode sandwich across a Jito bundle | 4.9 | `CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:C/C:N/I:L/A:L` | MEDIUM |
| H035 | klend deposit refusals revert a withdraw-mode exit | 4.8 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:L` | LOW |
| H007 | Kamino checks keyed off `LENT_MINTS`, not the recorded reserve | 4.4 | `CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:C/C:N/I:L/A:L` | LOW |
| H001 | Stale-rate add, then fee-free exit | 4.0 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:N/I:L/A:N` | MEDIUM |
| H015 | Stored-rate valuation around a write-off | 4.0 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:N/I:L/A:N` | LOW |
| H039 | klend upgrade semantic drift | 4.0 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:N/I:L/A:N` | LOW |
| S002 | One-transaction composition on a stale reserve | 4.0 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:C/C:N/I:L/A:N` | LOW |
| H002 | Swap round trip across a refresh | 3.7 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:N` | LOW |
| H018 | Withdraw mode moved by others' borrows and tickets | 3.7 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L` | LOW |
| H025 | cToken extraction at par, made sticky | 3.7 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:L/A:N` | LOW |
| H040 | Stale `V` in withdraw-mode and band decisions | 3.7 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L` | INFO |
| S004 | `rebalance` on a stale reserve | 3.7 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L` | INFO |
| H016 | Forced exit cascades across sibling markets | 3.5 | `CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:C/C:N/I:L/A:N` | LOW |
| H017 | Victim's own add inflates exposure | 3.5 | `CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:C/C:N/I:N/A:L` | LOW |
| H019 | Forced entry is durable (hysteresis) | 3.5 | `CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:C/C:N/I:N/A:L` | LOW |
| H020 | `rebalance` called to grief | 3.1 | `CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:N/A:L` | LOW |

**Average CVSS of the 16 scored CONFIRMED findings:** 4.3
**Highest CVSS:** H006 at 6.8, kept at MEDIUM because the lever belongs to the other mint's issuer, a party LPs choose to trust and Aviary shows, and the issuer gains no theft beyond what its mint authority already gives it.
H020's finding states 2.6; its own vector computes to 3.1, which changes nothing.

### Top 5 priority items

| Priority | ID | Finding | Severity | Location (at `0ef0e06`) | State |
|----------|-----|---------|----------|----------|-------|
| 1 | H001 | Stale-rate add, then fee-free exit, takes the LPs' unbooked interest | MEDIUM | `src/instructions/add_liquidity.rs:105`, `src/kamino.rs:255-261` | Fixed |
| 2 | H004 | One reading lifted for one slot in a Jito bundle takes a market out of withdraw mode | MEDIUM | `src/withdraw_mode.rs:65-75`, `src/instructions/rebalance.rs:103-126` | Fixed, residual LOW |
| 3 | H003 | Sibling `rebalance` calls move Kamino around the victim's reading | MEDIUM | `src/instructions/rebalance.rs:88-93` | Fixed |
| 4 | H006 | The other mint's freeze authority or hook blocks every removal | MEDIUM | `src/instructions/remove_liquidity.rs:266-290` | Fixed (`remove_lent_side`) |
| 5 | H024 | `min_lp` bounds shares, not the ratio, when a maximum exceeds the quote | MEDIUM | `src/shares.rs:76-83`, `metadata.json` | Fixed in guidance |

---

## Remediation on `imDev2023/build-86`

The orchestrator fixed these after round 1, on branch `imDev2023/build-86` (commits `b0c41be` to `8f31e48`).
Each regression test is in `programs/lending-amm/tests/hardening.rs` unless stated, and all pass.
Round 2 confirms each one.

| Finding | Fix | Decision | Regression test |
|---------|-----|----------|-----------------|
| H001 | Adding needs the reserve refreshed in the same slot once the market holds cTokens (`ADD_MAX_RESERVE_AGE_SLOTS = 0`, error `ReserveStale`), read from the reserve's `last_update.slot`. | `LENDING-91`, `LENDING-12` | `sos_h001_adding_at_the_stored_rate_then_leaving_takes_no_interest_from_the_lps` |
| H002 | Quotes and swaps refuse a reserve more than `TRADE_MAX_RESERVE_AGE_SLOTS = 9,000` slots (about an hour) stale once the market holds cTokens; deprecated reserves are exempt. An hour raised `V` by 8 to 11 bps on the steepest devnet curve, and the round trip from the bound's edge lost. | `LENDING-92` | `sos_h002_a_quote_or_swap_refuses_a_reserve_more_than_an_hour_stale_and_no_round_trip_pays` |
| H003 | One `rebalance` per transaction: the allowlist beside `rebalance` no longer admits another `rebalance`, on any market. | `LENDING-83` | `sos_h003_no_other_rebalance_can_move_kamino_around_a_market_in_withdraw_mode` |
| H004 | Leaving withdraw mode needs the free liquidity above the exit threshold at two `rebalance` readings at least `WITHDRAW_MODE_EXIT_DELAY_SLOTS = 9,000` apart; any reading at or below in between resets the wait (`exit_seen_slot`, the first field taken from the reserved space); the keeper's sweeps every 10 minutes are honest readings in between. | `LENDING-93`, `LENDING-07` (changed 2026-11-17) | `sos_h004_one_reading_of_kamino_cannot_take_a_market_out_of_withdraw_mode`; Proptest and Kani `a_market_leaves_withdraw_mode_only_after_the_exit_delay` |
| H005 | `totals_after_in_kind` computed without the product, so it never fails. | `LENDING-72` | `sos_h005_in_kind_totals_never_overflow` in `src/shares.rs`; Z3 claim in `proofs/shares_z3.py` |
| H006 | New instruction `remove_lent_side` burns shares for the buffer's part in the lent mint and the cTokens' part in kind, moves nothing of the other mint, reads no Kamino account, and leaves the other side's part to the LPs who stay. | `LENDING-94` | `sos_h006_an_lp_leaves_with_the_lent_side_when_the_other_mint_cannot_move` |
| H007 | `LendingAmmMarket::lent_entry` refuses unless the `LENT_MINTS` row still names the recorded reserve and collateral mint. | `LENDING-14` | `sos_h007_a_market_never_reads_a_reserve_other_than_the_one_it_recorded` |
| H008 | Reserve versions other than 1 and `u64::MAX` refused (`ReserveWrongVersion`). | `LENDING-14` | `sos_h008_a_reserve_of_a_version_this_program_was_not_written_for_is_refused` |
| H016 | Mitigated by H004's exit wait (each cascade step now takes the wait) and H003's one `rebalance` per transaction. | `LENDING-93`, `LENDING-83` | Covered by `sos_h003` and `sos_h004` |
| H024 | Metadata and spec now say both maximums are the price protection together with `min_lp`, set to the quoted amounts plus the slippage tolerance, never a whole balance; no program change, since the primitives exist. | `LENDING-46` | n/a (guidance) |
| H048 | Mitigated by H002's trade gate: the step an outside arbitrageur can take is bounded by an hour of interest. | `LENDING-92` | Covered by `sos_h002` |
| H054 | Build-time asserts in `src/config.rs` for the relations between policy constants (headroom and fee below 10,000 bps, band order). | `LENDING-04`, `LENDING-05`, `LENDING-08`, `LENDING-59` | Compile-time |
| H087 | The hardening tests and the stateful fuzzer now require `ReserveStale` refusals on a stale reserve, and the fuzzer checks a market never returns to the first-deposit path (SH-10). | `LENDING-90` | `tests/hardening.rs`, `tests/common/fuzz.rs` |
| S002 | Satisfied: both gates read the reserve's `last_update.slot`, never the transaction's instruction list, so a refresh inside an earlier klend CPI (a cash removal or a redeeming swap) counts. | `LENDING-91`, `LENDING-92` | As H001 and H002 |
| S004 | Fixed in the spec: the keeper puts klend's `refresh_reserve` before each `rebalance` in the same transaction, and refreshes each reserve whenever its last refresh is more than half of `TRADE_MAX_RESERVE_AGE_SLOTS` old. | `LENDING-80`, `LENDING-95` | n/a (keeper behaviour) |

### H004 residual (LOW, owner sign-off)

An attacker who makes both readings itself, one bundle at the start of the wait and one at its end, with no honest `rebalance` reading at or below the threshold in between, can still take a market out of withdraw mode.
That needs the keeper to make no `rebalance` call on the market for a whole hour (its sweeps run every 10 minutes and after each transaction on the market, `LENDING-16`), so the residual rests on keeper liveness, not on capital.
Holding a real deposit through the hour is the case the spec already accepts (`docs/spec/lending-pool.md:283`).

---

## Findings table

Dispositions: "Fixed" means the fix is on `imDev2023/build-86` with a passing `sos_<id>` test or the stated check; "Sign-off" means the review recommends leaving it open and recording the owner's written acceptance in this report, as `BAR-18` requires.

| ID | Title | Status | Severity | Root cause class | Disposition |
|----|-------|--------|----------|------------------|-------------|
| H001 | Stale-rate add, then fee-free exit in kind or in cash, takes the LPs' unbooked interest | CONFIRMED | MEDIUM | Spec-level design | Fixed (`LENDING-91`) |
| H002 | Swap round trip across a refresh on a stale reserve | CONFIRMED | LOW | Spec-level design | Fixed (`LENDING-92`) |
| H003 | `rebalance` admits sibling `rebalance` calls | CONFIRMED | MEDIUM | Code defect | Fixed (`LENDING-83`) |
| H004 | Withdraw-mode sandwich across transactions in one Jito bundle | CONFIRMED | MEDIUM | Spec-level design | Fixed (`LENDING-93`); residual LOW for sign-off |
| H005 | `totals_after_in_kind` can return `Overflow` and block the in-kind exit | NOT VULNERABLE as investigated; found by Book of Knowledge (SH-8) | INFO | Code defect | Fixed |
| H006 | Other mint's freeze authority or transfer hook blocks every removal | CONFIRMED | MEDIUM | Spec-level design | Fixed (`remove_lent_side`, `LENDING-94`) |
| H007 | Kamino checks key off `LENT_MINTS`, not the recorded reserve | CONFIRMED | LOW | Code defect | Fixed |
| H008 | Reserve `version` other than 1 or `u64::MAX` treated as deprecated while priced | POTENTIAL | LOW | Code defect | Fixed |
| H015 | Stored-rate valuation around a write-off and bad debt not yet written off | POTENTIAL | LOW | Spec-level design | Sign-off; correct the spec |
| H016 | Forced withdraw-mode exit cascades across sibling markets | CONFIRMED | LOW | Spec-level design | Mitigated by H003 and H004 fixes |
| H017 | The victim's own `add_liquidity` inflates exposure; a bundle toggles withdraw mode | CONFIRMED | LOW | Spec-level design | Sign-off |
| H018 | Withdraw mode moved by others' klend borrows, repays and withdrawal tickets | CONFIRMED | LOW | Spec-level design | Sign-off (exit lever closed by H004's fix) |
| H019 | Forced entry into withdraw mode is durable and costs yield | CONFIRMED | LOW | Spec-level design | Sign-off; correct the spec |
| H020 | `rebalance` called to grief: a large lent-out trade reverts | POTENTIAL | LOW | Spec-level design | Sign-off; correct the spec |
| H021 | Quote vs swap at the buffer's edge, and the redeem's rounding | POTENTIAL | LOW | Code defect | Sign-off |
| H023 | First deposit into a router-created market sets the price | POTENTIAL | LOW | Spec-level design | Sign-off |
| H024 | `add_liquidity` sandwich: `min_lp` bounds shares, not the ratio | POTENTIAL | MEDIUM | Spec-level design | Fixed in guidance |
| H025 | cToken extraction at par via add and in-kind removal, made sticky | CONFIRMED | LOW | Spec-level design | Sign-off (value part closed by H001's fix) |
| H035 | klend deposit refusals revert a withdraw-mode exit | CONFIRMED | LOW | Code defect | Sign-off, or the cap-aware `rebalance` fix |
| H039 | klend upgrade semantic drift and unanchored offsets | POTENTIAL | LOW | External dependency | Sign-off; anchors and watcher before the freeze |
| H040 | Stale `V` in withdraw-mode exposure and band decisions | CONFIRMED | INFO | Spec-level design | Sign-off (keeper refreshes first, S004) |
| H048 | Refresh-step LVR for outside arbitrage | POTENTIAL | LOW | Spec-level design | Mitigated by H002's fix |
| H053 | `STATE_VERSION` never checked on load | POTENTIAL | INFO | Code defect | Sign-off |
| H054 | Unasserted compile-time relations between policy constants | POTENTIAL | INFO | Code defect | Fixed |
| H060 | JIT LP fee capture | POTENTIAL | LOW | Spec-level design | Sign-off |
| H065 | `is_open` permanence; a market with `L = 0` but `R > 0` | POTENTIAL | LOW | Spec-level design | Sign-off |
| H068 | Rate headroom too small: quote-to-swap divergence and cash-exit failures | CONFIRMED | LOW | Code defect | Sign-off |
| H075 | Devnet upgrade authority hot key, freeze gate, register before freeze | POTENTIAL | INFO | Operational | Sign-off; mainnet launch precondition |
| H077 | Aggregate exposure across markets on one reserve | CONFIRMED | LOW | Spec-level design | Sign-off |
| H078 | Issuer mint-authority rug and honeypot hook | POTENTIAL | INFO | Spec-level design | Sign-off |
| H081 | klend reserve rewards as refresh-time rate jumps beyond the headroom | POTENTIAL | LOW | External dependency | Sign-off |
| H087 | Proof-scope gaps: fixed-rate add and remove proof, the fuzzer's stored-rate invariant | CONFIRMED | LOW | Test or proof gap | Fixed |
| H091 | Rebalance redeem sizing vs klend's limits | POTENTIAL | LOW | Code defect | Sign-off |
| H102 | `refresh_reserve` availability on the deployment (stale oracles) | POTENTIAL | LOW | Operational | Sign-off; check devnet oracles before deploy |
| S002 | One-transaction composition on a stale reserve | CONFIRMED | LOW | Spec-level design | Fixed (gates read reserve state) |
| S003 | Capital-free forced withdraw-mode exit and the victim's recovery | CONFIRMED | LOW | Spec-level design | Sign-off (both forms blunted by H003 and H004 fixes) |
| S004 | `rebalance` on a stale reserve: sizing at the stored rate | CONFIRMED | INFO | Spec-level design | Fixed in spec (`LENDING-80`, `LENDING-95`) |

---

## Medium findings

> All five are fixed on `imDev2023/build-86`; round 2 verifies each fix and its regression test.

### MEDIUM-001: Stale-rate add, then fee-free exit, takes the LPs' unbooked interest

**ID:** H001
**Severity:** MEDIUM (CVSS 4.0, calibrated up)
**Status:** CONFIRMED, spec-level design; confidence 9; also Book of Knowledge's counterexample to SH-6
**Location:** `src/instructions/add_liquidity.rs:105` -> `src/pricing.rs:81-89` -> `src/kamino.rs:255-261`; exits at `src/shares.rs:106-131`, `src/instructions/remove_liquidity.rs:243-259`
**State:** Fixed (`LENDING-91`)

#### Description

`add_liquidity` priced the market's cTokens at the reserve's stored exchange rate and never read its `last_update`, while `remove_liquidity` pays the three parts pro rata by count with no rate at all.
The cTokens an LP leaves with are worth klend's true rate: in kind they redeem later at a refreshed rate, and in cash the program's own redeem CPI makes klend refresh before paying.
Neither add nor remove charges a fee.

#### Attack scenario

1. Find a market whose reserve has interest since its last refresh.
2. Add `f` times the pool at the stored rate.
3. Remove the same shares at once, in kind or in cash.
4. **Result:** the attacker takes `f/(1+f) x c x (r_true - r_stored)` of the incumbent LPs' accrued interest in one transaction.

On mainnet the lent side is flash-fundable from another venue, though not from the market's own reserve (klend's flash borrow refreshes the reserve it lends from).

#### Impact

- **Financial:** LPs' lending yield, never principal; the orchestrator's LiteSVM run (50 SOL devnet WSOL market, reserve 800,000 slots stale, `f = 10`) took 2,844,438,901 lamports, 5.7% of the market.
- **Users affected:** every LP of a market holding cTokens on a quiet reserve.
- **Protocol state:** repeatable and, after the planned freeze, unfixable; dust per transaction on Kamino's main SOL and USDC reserves, which refresh every few seconds.

#### Fix (on `imDev2023/build-86`)

Adding refuses with `ReserveStale` unless the reserve was refreshed in the current slot once the market holds cTokens (`ADD_MAX_RESERVE_AGE_SLOTS = 0` in `src/config.rs`), the same rule klend applies to its own rate read; the depositor puts klend's `refresh_reserve` first, and the metadata form says so.

#### Verification

- [x] `sos_h001_adding_at_the_stored_rate_then_leaving_takes_no_interest_from_the_lps` on klend's bytes.
- [x] The fuzzer requires `ReserveStale` on a stale reserve (H087).
- [ ] Round 2: a refresh by an earlier klend CPI in the same transaction counts (S002), and no path prices an add at `V` without the gate.

---

### MEDIUM-002: Sibling `rebalance` calls move Kamino around the victim's reading

**ID:** H003
**Severity:** MEDIUM (CVSS 4.9)
**Status:** CONFIRMED, code defect; confidence 9
**Location:** `src/instructions/rebalance.rs:88-93`, `:118-124`, `:193-208`
**State:** Fixed (`LENDING-83`)

#### Description

`require_alone` exists so nothing in `rebalance`'s transaction can move Kamino's free liquidity around the withdraw-mode measurement, but its allowlist admitted `rebalance` on any other market, and every `rebalance` CPIs klend's deposit or redeem.

#### Attack scenario

1. Order `[rebalance(A_1..A_n): deposits] [rebalance(victim)] [rebalance(C): redeem]` in one transaction.
2. The deposits lift free liquidity past `10 X_v` at the victim's one reading; the victim leaves withdraw mode and lends `B - t` (about 80% of its lent side).
3. C's withdraw-mode redeem takes that liquidity straight back out.
4. **Result:** the victim's lent side sits as cTokens in a reserve with little free liquidity, the outcome withdraw mode exists to prevent; the reverse direction forces entry with one market.

S003 shows the deposit legs need not be the attacker's markets: any third-party sibling above its band will do, for zero capital.

#### Impact

- **Financial:** principal at risk only if the crunch ends in `socialize_loss`; the attacker gains exit liquidity for its own stuck position.
- **Users affected:** LPs of any market in withdraw mode on a reserve shared with other lending AMM markets.
- **Protocol state:** withdraw mode defeated within one transaction.

#### Fix (on `imDev2023/build-86`)

`allowed_beside_rebalance` no longer admits this program's `rebalance`, and `require_alone` checks every index except the current one, so `rebalance` runs once per transaction beside only compute-budget instructions and klend's `refresh_reserve`.

#### Verification

- [x] `sos_h003_no_other_rebalance_can_move_kamino_around_a_market_in_withdraw_mode`.

---

### MEDIUM-003: Withdraw-mode sandwich across one Jito bundle

**ID:** H004
**Severity:** MEDIUM (CVSS 4.9)
**Status:** CONFIRMED, spec-level design; confidence 8
**Location:** `src/instructions/rebalance.rs:103-126`, `:153`; `src/withdraw_mode.rs:65-75`, `:110-119`; `src/kamino.rs:272-284`
**State:** Fixed (`LENDING-93`), residual LOW for sign-off

#### Description

`require_alone` sees only `rebalance`'s own transaction, and `rebalance` decided the mode from one instantaneous reading of Kamino's free liquidity with no memory of earlier readings.

#### Attack scenario

1. Bundle `[tx1: klend deposit D] [tx2: rebalance(victim)] [tx3: klend redeem D]`; the bundle lands whole, in order, in one slot, or not at all.
2. tx2 reads `free > 10X`, leaves withdraw mode and deposits about `0.8 L` in the same call.
3. tx3 redeems `D` back with no fee, and the victim's fresh deposit is there for any trapped Kamino lender to take.
4. **Result:** as H003, with no attacker market and no role; capital `10X - f + 1` for one slot, which S003 shows can be flash-levered in tx1 and tx3.

#### Impact

- **Financial:** high on the victim's lent side, but only during a real crunch deep enough to have the market in withdraw mode.
- **Users affected:** LPs of any market in withdraw mode.
- **Protocol state:** withdraw mode defeated across transactions; H003's fix alone does not touch it.

#### Fix (on `imDev2023/build-86`)

The first `rebalance` that sees the free liquidity above the exit threshold records its slot in `exit_seen_slot` and stays in withdraw mode, redeeming what it can and never depositing; the market leaves only at a `rebalance` at least 9,000 slots later that sees it above too, and any reading at or below in between resets the wait.
A bundle cannot span the hour.
See "H004 residual" above for what remains.

#### Verification

- [x] `sos_h004_one_reading_of_kamino_cannot_take_a_market_out_of_withdraw_mode`.
- [x] Proptest and Kani `a_market_leaves_withdraw_mode_only_after_the_exit_delay` (Kani's first run found a first sighting at slot 0 would read as none; a sighting is now recorded as slot 1 at the earliest).
- [ ] Round 2: an armed market whose liquidity falls back cannot leave on a later high reading without a fresh wait; a wait-resetting lever cannot be used to hold a recovering market in withdraw mode for free (see "Exit-wait reset lever" under Combination attack analysis).

---

### MEDIUM-004: The other mint's freeze authority or transfer hook blocks every removal

**ID:** H006
**Severity:** MEDIUM (CVSS 6.8, calibrated down)
**Status:** CONFIRMED, spec-level design; confidence 9
**Location:** `src/instructions/remove_liquidity.rs:266-290`, `:292-326`; `programs/mint-rules/src/lib.rs:7-8`, `:42-52`, `:109-117`
**State:** Fixed (`remove_lent_side`, `LENDING-94`)

#### Description

`remove_liquidity` pays the other side first and reverts whole if any transfer fails.
The mint rules let the other mint keep a freeze authority and a transfer hook with any hook program, and run once, at creation.
So the holder of the other mint's freeze authority or hook authority could make every removal of every LP fail, cash and in kind alike, trapping each LP's buffer part and cTokens, which is principal.
The block can be made permanent (freeze, then drop the authority), and a destination-selective hook lets insiders out while others stay trapped.

#### Impact

- **Financial:** possibly permanent freeze of a whole market's lent side.
- **Users affected:** every LP of a market whose other mint has a live freeze or hook authority.
- **Protocol state:** swaps stop in both directions too.

#### Fix (on `imDev2023/build-86`)

`remove_lent_side` burns shares for the buffer's part in the lent mint and the cTokens' part in kind, moves nothing of the other mint, reads no Kamino account, and leaves the other side's part to the LPs who stay.
It is ungated, since a hook veto shows only when a transfer is attempted, so the LP decides.
Residual: it still pays the buffer part in the lent mint, so a frozen USDC buffer vault (Circle's freeze authority) would block it whenever that part is not zero; only the cToken leg cannot be frozen.

#### Verification

- [x] `sos_h006_an_lp_leaves_with_the_lent_side_when_the_other_mint_cannot_move`.
- [ ] Round 2: `remove_lent_side` is a new instruction round 1 never saw; review it in full (share burn, rounding, `totals_after_in_kind`, the locked minimum, events, metadata and IDL).

---

### MEDIUM-005: `add_liquidity` sandwich when a maximum exceeds the quote

**ID:** H024
**Severity:** MEDIUM
**Status:** POTENTIAL, spec-level design; confidence 8
**Location:** `src/shares.rs:76-83`; `metadata.json` (`add_liquidity` form)
**State:** Fixed in guidance (`LENDING-46`)

#### Description

With both maximums at the quoted ratio, `min_lp` alone bounds a front-run to second order and no sandwich pays.
But the program takes "only the amounts those shares are worth", and the shipped `min_lp` description promised protection "against the price moving first", inviting maximums set as caps or balances.
A front-run that makes the excess side cheaper leaves the binding side's share count unchanged, so `min_lp` still passes and the victim pays up to its whole excess maximum at the skewed price.
Modelled on a 100 SOL a side pool, a 3x lent maximum lost 40% of the deposit and a 10x one lost 67%.

#### Fix (on `imDev2023/build-86`)

The metadata and spec now say both maximums are the price protection together with `min_lp`, set to the quoted amounts plus the slippage tolerance and never a whole balance.
The program already has the primitives, so no program change; Aviary's panel (#88) and any SDK helper must compute `max_i = ceil(quote_i x (1 + sl))` and `min_lp = floor(q x (1 - sl))` from one snapshot.
The demo's second-wallet deposit (`scripts/demo.ts:1487`) uses fixed plan amounts; it runs on test tokens, but the panel must not copy that pattern.

---

## Low findings

> Each is fixed, mitigated, or accepted with the owner's written sign-off (see "Owner sign-off required").

| ID | Title | Location (at `0ef0e06`) | Issue | Recommendation |
|----|-------|----------|-------|----------------|
| H002 | Swap round trip across a refresh | `src/pricing.rs:147-148`, `src/kamino.rs:255-261` | Sell lent before a refresh step, buy back after; profitable at LP fee 0 once the step exceeds 0.5006% (`(1 + rho)^2 - 1`), about 5.5 to 7.8 hours of devnet interest, 39 days at 6% mainnet APY. | Fixed: 9,000-slot trade gate (`LENDING-92`). |
| H007 | `LENT_MINTS` row, not the recorded reserve | `src/kamino.rs:142-162`, `:224-231`, `:591-631` | An upgrade editing a row would make live markets value `m0` cTokens at `r1`'s rate; a third party then profits; trigger is the trusted upgrade key. | Fixed: `lent_entry` refuses a mismatch. |
| H008 | Unknown reserve version priced | `src/kamino.rs:136-196`, `:265-267` | A klend version bump with moved fields would price a garbage `V` on a frozen market. | Fixed: `ReserveWrongVersion`. |
| H015 | Write-off sandwich | `src/pricing.rs`, `src/kamino.rs:255-261` | A trader able to order swaps around the Kamino owner's `socialize_loss` makes the cash buffer bear the write-off (up to `lambda x B` from LPs) and takes Kamino depositors' loss on pre-loss shortfall redeems; first order, not the second order the contexts assumed. | Sign-off; correct the spec and register sentence that Kamino's losses fall only pro rata on LPs (`LENDING-13`); optional off-chain watcher for liquidated obligations with debt left. |
| H016 | Forced exit cascade across siblings | `src/withdraw_mode.rs:65-75`, `src/buffer.rs:70-81` | Each fully redeemed victim that exits deposits its exposure into the reserve the next one reads; amplification below `1.1^(n-1)`; the keeper's honest sweeps can ladder the same way. | Mitigated by H003 and H004 fixes; the honest aggregate is H077. |
| H017 | Victim's own add inflates exposure | `src/withdraw_mode.rs:57-60`, `src/instructions/add_liquidity.rs:117-119` | `[add][rebalance][remove]` in one bundle forces entry with no Kamino position and a quarter of E-7's capital; yield only. | Sign-off; do not add an entry confirmation (H019); correct spec `:283`. |
| H018 | Others' borrows, repays and tickets | `src/kamino.rs:272-284` | Borrow-around forces entry (yield only, bounded by klend's utilisation limit); repay-around forces exit (closed by the exit wait); withdrawal tickets would make both free (flags off on Kamino's main market and our devnet market). | Sign-off; monitor Kamino's ticket flags. |
| H019 | Forced entry is durable | `src/withdraw_mode.rs:65-75`, `src/instructions/rebalance.rs:182`, `:214` | A redeem and re-deposit bundle forces entry at no cost; the market stays out while `F <= 11X`; the spec's "costs the borrower interest" premise does not hold under a bundle. | Sign-off; correct spec `:283` and add a register entry; optional bundle-signature flag in Aviary's indexer. |
| H020 | `rebalance` griefing above the band | `src/instructions/resolve_accounts.rs:57-82`, `src/buffer.rs:80` | A lent-out trade resolved without redeem accounts reverts if a `rebalance` deposits first; no funds move; the honest keeper causes the same race. | Sign-off; list redeem accounts when the band is `Above` and `out > target(L)`; correct spec `:292`. |
| H021 | Quote vs swap at the buffer's edge | `src/kamino.rs:320-337`, `:474-481` | No edge pays more than quoted; the quote passes and the swap reverts when rate drift exceeds the 10 bps headroom; liveness only. | Sign-off; size against klend's paid-amount check; document prepending `refresh_reserve`. |
| H023 | First deposit sets the price | `src/instructions/add_liquidity.rs:101-103`, `src/instructions/init_market.rs:148-162` | A creator who splits creation from the first deposit, or recomputes `min_lp` from a squatted pool, joins at the squatter's ratio; 201 fee tiers can be squatted for about 3 SOL. | Sign-off; never split creation from the first deposit; optional `expect_first` flag before the freeze. |
| H025 | cToken extraction at par, made sticky | `src/instructions/add_liquidity.rs:117-156`, `src/buffer.rs:80` | Add then in-kind removal converts the market's cTokens to buffer cash at par; while Kamino refuses deposits (`block_ctoken_usage` or `deposit_limit`) the LPs earn no yield on it. | Sign-off, or the cap-aware `rebalance` (same change as H035). |
| H035 | Deposit refusals revert a mode exit | `src/withdraw_mode.rs:109-130`, `src/instructions/rebalance.rs:194-200` | `deposit_limit`, `Obsolete` status and permissioned deposits are not modelled, so the exit's planned deposit reverts the whole call and the recorded mode lags Kamino. | Sign-off, or decode `deposit_limit` and `status`, deposit `min(B - t, room)`, and record the mode when the deposit cannot land. |
| H039 | klend semantic drift | `src/kamino.rs:136-185`, `:363-375` | klend has twice changed a field's meaning at the same offset without a version bump; a drift that lowers `V` would let anyone extract through H001's mechanism on a frozen program. | Sign-off; before the freeze add the cheap structural anchors (`fee_vault`, `collateral.supply_vault`, `mint_decimals`, `token_program`, `LendingMarket.version`) and an off-chain watcher on klend upgrades. |
| H048 | Refresh-step LVR | `src/pricing.rs:147-148` | Outside arbitrage takes `L x (g - c)^2 / 4` per stale interval; negligible on mainnet reserves. | Mitigated by H002's gate. |
| H060 | JIT LP fee capture | `src/instructions/add_liquidity.rs`, `src/instructions/remove_liquidity.rs` | `[add][victim swap][remove]` takes `f/(1+f)` of one swap's LP fee; bounded by the fee. | Sign-off. |
| H065 | `L = 0` with `R > 0` | `src/state.rs:135-137`, `src/kamino.rs:393-395` | After a total write-off the market is dead for trading and adds; exits still pay `R` pro rata and cTokens worth 0 in kind. | Sign-off. |
| H068 | Rate headroom too small | `src/kamino.rs:325-337`, `:352-357` | The free-liquidity term needs `d x (1 + Q r / F)` of headroom; in a crunch 10 bps covers about 1 bp of drift; swaps, `rebalance` and cash removals revert, nothing moves. | Sign-off; size against `total_available - floor(Q x r x (1 + h))` plus one cToken; keep the keeper's refresh prepend. |
| H077 | Aggregate exposure | `src/withdraw_mode.rs:57-75` | Per-market thresholds: N markets can each see 10X of their own exposure while the reserve holds about 10X for all. | Sign-off; or a per-reserve exposure account, decided before the freeze. |
| H081 | Reward jumps beyond the headroom | `src/kamino.rs:241-261`, `src/config.rs:40` | If Kamino's owner funds reserve rewards, refresh-time growth can reach about 0.075% of supply an hour; enlarges H001 and H002 (now gated) and H068's liveness gap. | Sign-off. |
| H087 | Proof and fuzzer scope | `proofs/*.py`, `tests/common/fuzz.rs:34-36` | No proof composed add, rate rise, remove; the fuzzer's invariant could not see H001 or H002. | Fixed: fuzzer and hardening tests require stale-rate refusals; SH-6 established on klend's bytes. |
| H091 | Rebalance redeem sizing | `src/buffer.rs:81`, `src/withdraw_mode.rs:85` | H068's edge from `rebalance` and withdraw mode's `min(V, can_pay)`; reverts, self-healing. | Sign-off; the keeper prepends `refresh_reserve` (`LENDING-80`). |
| H102 | Refresh availability on dead oracles | klend `refresh_reserve`; `src/kamino.rs:92` | A dead or re-pointed oracle makes the standalone refresh fail for everyone; after the fixes, adds and (after an hour) swaps refuse on such a reserve until a deposit or redeem refreshes it. | Sign-off; check the devnet reserves' oracle accounts before the devnet deploy and have the keeper alert on a failed refresh. |
| S002 | One-transaction composition | `src/instructions/remove_liquidity.rs:243-259`, `src/instructions/swap.rs:82-97` | A cash removal or redeeming swap can itself be the refresh source; the composition is sub-additive (92.2% of the step against H001's 90.9%). | Fixed: gates read `last_update.slot`. |
| S003 | Capital-free forced exit | `src/instructions/rebalance.rs:46-47`, `:88-93`, `:103-126` | Flash-levered deposits in the bundle's other transactions, or third-party sibling markets as the lift, cut H004's capital to little or none. | Sign-off; both forms blunted by the fixes; the keeper should react to `WithdrawModeLeft` and to free liquidity below `5X` at once. |

---

## Owner sign-off required

`BAR-18` accepts a Low finding only with the owner's written sign-off, recorded in this report.
The review recommends leaving these open; each line gives the reason and the decisions it rests on, which MetalLegBob may change.

| ID | Status | Severity | Reason to accept | Owner sign-off |
|----|--------|----------|------------------|----------------|
| H004 residual | CONFIRMED | LOW | Forcing an exit now needs an hour with no honest `rebalance` reading on the market, which the keeper's 10-minute sweeps and event triggers provide; it rests on keeper liveness, not capital (`LENDING-93`, `LENDING-16`, `LENDING-95`). | pending |
| H015 | POTENTIAL | LOW | Needs the Kamino owner's rare, privileged write-off and ordering around it; bounded by `lambda x B` from LPs; LPs bear Kamino's losses by design (`LENDING-13`); the fix is a corrected spec sentence. | pending |
| H017 | CONFIRMED | LOW | Yield only; entering withdraw mode is the safe direction, and confirming entry over time would hand H004's attacker a principal risk (`LENDING-07`, `LENDING-33`). | pending |
| H018 | CONFIRMED | LOW | Borrow-forced entry is yield only and bounded by klend's utilisation limit; the exit lever is closed by the exit wait (`LENDING-93`); the ticket lever is latent while Kamino keeps its ticket flags off. | pending |
| H019 | CONFIRMED | LOW | Yield only; the durability is intrinsic to the hysteresis the spec chose (`LENDING-07`), and the obvious fix is worse; the spec sentence on its cost needs correcting. | pending |
| H020 | POTENTIAL | LOW | A reverted transaction, no funds move; the honest keeper causes the same race (`LENDING-15`, `LENDING-60`). | pending |
| H021 | POTENTIAL | LOW | Liveness only: the swap reverts and nothing moves; prepending `refresh_reserve` heals it, and the trade gate narrows it (`LENDING-59`, `LENDING-62`, `LENDING-92`). | pending |
| H023 | POTENTIAL | LOW | The documented one-transaction creation closes the window; the loss needs a client default that does not exist; seeded markets are immune (`LENDING-10`, `LENDING-22`, `LENDING-25`). | pending |
| H025 | CONFIRMED | LOW | Yield only, in Kamino states that are rare on the listed reserves; at a fresh rate the exchange is at par, and H001's fix closes the value part (`LENDING-77`). | pending |
| H035 | CONFIRMED | LOW | The stuck direction is the safe one; `withdraw_mode` is read only by `rebalance`; no principal or value transfer (`LENDING-77`). | pending |
| H039 | POTENTIAL | LOW | External and rare: klend's supply formula is unchanged from 1.7.1 to 1.28.0, and in-kind exits never read the reserve; the offsets are hand-written by decision (`LENDING-29`, `LENDING-14`). | pending |
| H040 | CONFIRMED | INFO | The caller chooses only between the stored and the fresh state, a band of width `i`; the keeper refreshes before each `rebalance` (`LENDING-80`, `LENDING-95`). | pending |
| H053 | POTENTIAL | INFO | No code path depends on the version byte; the layout is final (`LENDING-44`); it matters only to a future upgrade, which the freeze ends (`LENDING-26`). | pending |
| H060 | POTENTIAL | LOW | Bounded by one swap's LP fee (at most 2%, default 0.30%); a standard constant-product property; no add or remove fee by design (`LENDING-08`, `LENDING-09`, `LENDING-20`). | pending |
| H065 | POTENTIAL | LOW | Reached only after a total write-off, when the lent side is already lost; exits still pay `R` pro rata (`LENDING-13`). | pending |
| H068 | CONFIRMED | LOW | Liveness only: the transaction reverts and nothing moves; the keeper's refresh prepend heals it (`LENDING-59`, `LENDING-80`). | pending |
| H075 | POTENTIAL | INFO | The devnet hot key is an accepted risk (`BAR-23`); the freeze, with registration and the final metadata URI before it, is a mainnet launch precondition (`LENDING-26`, `BAR-25`). | pending |
| H077 | CONFIRMED | LOW | Per-market thresholds are a design trade-off; the attacker-driven forms are closed by the H003 and H004 fixes (`LENDING-07`, `LENDING-73`). | pending |
| H078 | POTENTIAL | INFO | Inherent to any permissionless AMM listing issuer-controlled tokens; authorities are allowed by decision and shown to LPs (`LENDING-23`, `CANARY-17`). | pending |
| H081 | POTENTIAL | LOW | Needs the Kamino owner to enable and fund rewards; bounded; the value side is closed by the freshness gates, the liveness side is H068's (`LENDING-92`). | pending |
| H091 | POTENTIAL | LOW | Liveness only and self-healing; the keeper prepends `refresh_reserve` (`LENDING-80`, `LENDING-95`). | pending |
| H102 | POTENTIAL | LOW | Operational: exits are unaffected (in kind, `remove_lent_side`, and cash removals that refresh inside klend); the keeper refreshes reserves (`LENDING-95`); the devnet oracle accounts need checking before deploy (`LENDING-40`). | pending |
| S003 | CONFIRMED | LOW | No new class: the third-party-sibling form is closed by one `rebalance` per transaction, and the levered form must hold its deposit through the hour's wait (`LENDING-83`, `LENDING-93`). | pending |

Nine of these are CONFIRMED (the H004 residual, H017, H018, H019, H025, H035, H040, H077, S003).
`BAR-18` says every confirmed finding gets a fix and a regression test, so accepting them needs the owner's explicit sign-off rather than a default.
H025 and H035 share one code fix (a cap-aware `rebalance` that decodes `deposit_limit` and `status` and records the mode when the deposit cannot land); if the owner prefers fixing to accepting, it is cheap before the freeze and moves both to "fixed".

---

## Informational notes

> No action required for funds; most are cheap hygiene, disclosure or spec items worth folding into #86.

- **H005 (INFO, fixed)**: Book of Knowledge's SH-8 counterexample; `totals_after_in_kind` refused with `Overflow` when the net amount lent times the cTokens paid passed 2^128, which would have blocked an LP's last-resort exit over a reporting-only figure; unreachable at real magnitudes and splittable, now computed without the product.
- **H040 (INFO, CONFIRMED)**: `rebalance` has no freshness gate of its own; the keeper's refresh prepend makes the stale choice moot; a same-slot gate on `rebalance` (H040, S004 option 1) would make it deterministic.
- **H053 (INFO, POTENTIAL)**: `STATE_VERSION` is written once and never read; harmless today; a future migration should check it.
- **H054 (INFO, fixed)**: build-time asserts now guard the constants' relations.
- **H075 (INFO, POTENTIAL)**: nothing in code or CI enforces the mainnet freeze, and freezing before `register_strategy` and the final `update_metadata` would make the listing permanently unfixable; belongs to the mainnet launch effort's checked freeze script.
- **H078 (INFO, POTENTIAL)**: Aviary's market page should show the other mint's mint, freeze and hook authorities beside the add-liquidity button.
- **S004 (INFO, fixed in spec)**: the burn-every-cToken branch of withdraw mode's redeem has no headroom, and a revert drops a withdraw-mode entry; the keeper's refresh prepend covers it.
- **Spec sentences to correct**: `docs/spec/lending-pool.md:283` (forced entry "costs the borrower interest": false under a bundle, H017, H018, H019); `:292` ("cannot be used to grief a market": true inside the band only, H020); "Kamino's losses fall on LPs" (`LENDING-13`; a trader can make the buffer bear part of a write-off, H015); `:176` (the reserve check refuses structural changes; a change of meaning at the same layout is caught only off chain, H039).
- **Kamino's withdrawal-ticket flags (H018, S003)**: off on the main market and our devnet market today; if Kamino turns them on, forced entry becomes capital-free and queued lenders could drain a victim's fresh deposit ahead of the queue; the keeper or Aviary should watch the flags.
- **H006 residual**: `remove_lent_side` still moves the lent mint for the buffer part, so a frozen USDC buffer vault blocks it whenever that part is not zero.
- **H034**: the mint rules accept the reserve's own cToken mint, another market's LP mint, or the other listed lent mint as the other side; cleared, but worth a line in Aviary's risk panel.
- **H037**: draining Kamino's withdrawal cap blocks cash exits and redeeming swaps; in-kind exits and `remove_lent_side` remain.
- **H093**: events are `emit!` log lines; the indexer must attribute them by invoke frames.

---

## Combination attack analysis

### Chain 1: Taking LPs' unbooked Kamino interest

**Combined severity:** MEDIUM (yield, never principal)

| ID | Individual severity | Role in chain |
|----|---------------------|---------------|
| H001 | MEDIUM | Add at the stored rate, leave after the refresh, fee-free |
| H025 | LOW | Loop form: `1 - 1/(1+f)^k` of the step with transient capital of `f` pools |
| S002 | LOW | An AMM cash removal or redeeming swap is itself the refresh source; one refresh serves every market on the reserve |
| H002 | LOW | Round trip across the step, bounded by two router fees |
| H048 | LOW | One-way outside arbitrage of the same step |
| H081 | LOW | Funded reserve rewards enlarge the step |
| H102 | LOW | A dead oracle lengthens the stale window |
| H087 | LOW | No proof or fuzz invariant could see the chain |
| H007, H039 | LOW | Same add-and-leave mechanism with a low `V` from a re-pointed reserve or a drifted layout instead of staleness |

**Combined attack:** on a quiet reserve, stale adds on every market of the reserve, exits in kind, and a lent-only attacker's sell-add-exit-buy variant (S002) together take up to about 92% of each market's unbooked interest in one transaction.
**Mitigation:** the freshness gates (H001, H002) are the critical node, reading reserve state so CPI refreshes count (S002); H007's fix closes the re-pointed reserve; H039 remains an off-chain watch.

### Chain 2: Pushing LPs' lent side into a crunched reserve

**Combined severity:** MEDIUM (principal at risk only if the crunch ends in a write-off)

| ID | Individual severity | Role in chain |
|----|---------------------|---------------|
| H003 | MEDIUM | Sibling `rebalance` lift in one transaction |
| H004 | MEDIUM | klend deposit and redeem around a lone `rebalance` in a bundle |
| S003 | LOW | Zero or flash-levered capital for either form |
| H016 | LOW | Cascade: each exiting victim lifts the next |
| H018 | LOW | Repay-around and (if enabled) ticket-cancel levers |
| H077 | LOW | Per-market thresholds count the same liquidity many times |
| H035 | LOW | A deposit refusal can revert the exit (limits the chain) |

**Combined attack:** an attacker with stuck cTokens in a crunched reserve forces every recovering market on it out of withdraw mode, laddered by exposure, and redeems their fresh deposits as its own exit liquidity.
**Mitigation:** H004's exit wait is the critical node (it alone breaks the bundle, cascade and levered forms); H003's one `rebalance` per transaction breaks the in-transaction and third-party-sibling forms.
What survives is the H004 residual (an hour without an honest reading).

### Chain 3: Switching a market's lending off (yield grief)

**Combined severity:** LOW (yield only)

| ID | Individual severity | Role in chain |
|----|---------------------|---------------|
| H017 | LOW | Victim's own add inflates exposure; no Kamino position needed |
| H019 | LOW | Redeem and re-deposit of one's own cTokens; durable by hysteresis |
| H018 | LOW | Borrow-around, bounded by the utilisation limit |
| H025, H035 | LOW | Kamino deposit refusals keep the market in cash and its mode stuck |
| H004 fix | - | The exit wait resets on any reading at or below the threshold |

**Exit-wait reset lever (new with H004's fix):** a market that has entered withdraw mode now leaves only after an hour of readings above `10X`, and any reading at or below `10X` restarts the wait.
So holding a recovering market out of Kamino needs only one bundle an hour that pushes the reading to `10X` or below (H017's add or H019's redeem-around), where forcing entry needs `5X`; before the fix the attacker had to re-force entry after every 10-minute sweep once the reserve recovered past `11X`.
The harm stays yield only, and an all-cash market is the safest state for its LPs, so this stays LOW; it is part of the H017 and H019 sign-off and round 2 should state it in the spec.
**Mitigation:** none recommended on-chain (an entry confirmation would be worse, H019); Aviary's indexer can flag `WithdrawModeEntered` readings far below the reserve's liquidity a slot before and after.

### Chain 4: Trapping or mispricing LPs' principal through outside parties

**Combined severity:** MEDIUM before the fixes, LOW after

| ID | Individual severity | Role in chain |
|----|---------------------|---------------|
| H006 | MEDIUM | Other mint's freeze or hook blocks every removal |
| H078 | INFO | The same issuer's mint authority and honeypot hook |
| H007 | LOW | A row edit leaves only the in-kind exit correct, which H006 then blocks |
| H015 | LOW | Write-off sandwich makes the buffer bear the loss |
| H065 | LOW | A total write-off leaves a dead market |
| H008, H039 | LOW | Kamino layout or version change misprices a frozen market |

**Combined attack:** an issuer with a live freeze authority on the other mint freezes the other vault while a row edit (H007) has broken the cash path, trapping LPs completely.
**Mitigation:** `remove_lent_side` (H006) and `lent_entry` (H007) are fixed; H008's version check is in; H039's anchors and watcher are recommended before the freeze.

### Chain 5: Liveness at Kamino's limits

**Combined severity:** LOW (reverts; nothing moves)
**Component findings:** H068 (headroom sizing), H091 (`rebalance` redeem), H021 (quote vs swap), S004 (stale `rebalance`), H020 (resolution race), H081 (rewards drift), H102 (dead oracle).
**Combined effect:** in a crunch on a stale reserve, quotes pass and swaps, cash removals and `rebalance` revert, and a stale `rebalance` that should enter withdraw mode reverts instead.
**Mitigation:** the keeper's refresh prepend (S004, `LENDING-80`, `LENDING-95`) is the critical node; sizing against klend's paid-amount check (H068) is the code fix if the owner wants it.

### Findings that enable others

| Finding | Enables | Combined impact |
|---------|---------|-----------------|
| H102 | H001, H002, H048 | A dead oracle keeps the stale window open longer |
| H087 | H001, H002 | No test could catch the stale-rate transfer |
| H003, H004 | H016, S003 | Cascade and capital-free forms of the forced exit |
| H004 fix | H017, H019 | The exit wait's reset makes a forced hold cheaper (yield only) |
| H015 | H065 | A total write-off leaves a dead market |
| H075 | H007, H054 | Only the upgrade key can edit `LENT_MINTS` or constants |
| H007 | H006 | Only the in-kind exit stays correct, and the issuer can block it |

### Combination matrix

Rows and columns are finding numbers (H001 is `001`, supplementals keep their `S` prefix), grouped by family: stale rate and valuation, withdraw mode and `rebalance`, issuer, operations.
Codes: E = one enables the other, A = combined impact above either alone, C = shared code path or the same fix, S = shared state.
Blank cells were checked and have no relation.

| | 001 | 002 | 025 | S002 | 048 | 081 | 102 | 087 | 015 | 065 | 039 | 007 | 008 | 060 | 024 | 023 | 003 | 004 | 016 | 017 | 018 | 019 | S003 | 077 | 035 | 040 | S004 | 020 | 091 | 068 | 021 | 006 | 078 | 075 | 053 | 054 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **001** | - | CS | CA | CA | CS | A | E | E |  |  | C | C |  | CS |  |  | A |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **002** | CS | - |  | CA | CS | A | E | E | C |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | S | S |  |  |  |  |  |
| **025** | CA |  | - | S |  |  |  |  |  |  |  |  |  | C |  |  |  |  |  | S |  |  |  |  | CS |  |  |  |  |  |  |  |  |  |  |  |
| **S002** | CA | CA | S | - |  |  | S |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **048** | CS | CS |  |  | - |  | E |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **081** | A | A |  |  |  | - |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A | A | A |  |  |  |  |  |
| **102** | E | E |  | S | E |  | - |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | S |  |  |  |  |  |  |  |  |  |
| **087** | E | E |  |  |  |  |  | - |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **015** |  | C |  |  |  |  |  |  | - | E |  |  | S |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | S |  |  |  |  |  |
| **065** |  |  |  |  |  |  |  |  | E | - |  |  | S |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **039** | C |  |  |  |  |  |  |  |  |  | - | S | C |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |
| **007** | C |  |  |  |  |  |  |  |  |  | S | - | C |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  | E |  |  |
| **008** |  |  |  |  |  |  |  |  | S | S | C | C | - |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **060** | CS |  | C |  |  |  |  |  |  |  |  |  |  | - |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **024** |  |  |  |  |  |  |  |  |  |  |  |  |  |  | - | C |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **023** |  |  |  |  |  |  |  |  |  |  |  |  |  |  | C | - |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **003** | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | - | CS | E |  |  |  | EC | S | S |  |  |  |  |  |  |  |  |  |  |  |
| **004** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | CS | - | E | SA | C | SA | EA |  | S | S |  |  |  |  |  |  |  |  |  |  |
| **016** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | E | E | - |  |  |  | S | CS |  |  |  |  |  |  |  |  |  |  |  |  |
| **017** | A |  | S |  |  |  |  |  |  |  |  |  |  |  |  |  |  | SA |  | - | S | CS | S |  |  |  |  | S |  |  |  |  |  |  |  |  |
| **018** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | C |  | S | - | S |  |  |  | S |  |  |  |  |  |  |  |  |  |  |
| **019** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | SA |  | CS | S | - |  |  |  | S |  |  |  |  |  |  |  |  |  |  |
| **S003** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | EC | EA | S | S |  |  | - |  |  |  |  |  |  |  |  |  |  |  |  |  |
| **077** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | S |  | CS |  |  |  |  | - |  |  |  |  |  |  |  |  |  |  |  |  |
| **035** |  |  | CS |  |  |  |  |  |  |  |  |  |  |  |  |  | S | S |  |  |  |  |  |  | - |  |  |  |  |  |  |  |  |  |  |  |
| **040** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | S |  |  | S | S |  |  |  | - | C |  |  |  |  |  |  |  |  |  |
| **S004** |  |  |  |  |  |  | S |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | C | - |  | C | C |  |  |  |  |  |  |
| **020** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | S |  |  |  |  |  |  |  | - | S |  | S |  |  |  |  |  |
| **091** |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | C | S | - | C | C |  |  |  |  |  |
| **068** |  | S |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | C |  | C | - | C |  |  |  |  |  |
| **021** |  | S |  |  |  | A |  |  | S |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | S | C | C | - |  |  |  |  |  |
| **006** |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | - | CS |  |  |  |
| **078** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | CS | - |  |  |  |
| **075** |  |  |  |  |  |  |  |  |  |  | A | E |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | - | S | E |
| **053** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | S | - | C |
| **054** |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | E | C | - |

---

## Attack trees

### Goal A: Take LPs' unbooked Kamino interest

```
GOAL: Move interest accrued since the last refresh from incumbent LPs to the attacker
+-- PATH A: Stale add, fee-free exit (H001) [CONFIRMED, FIXED]
|   +-- STEP 1: add f x pool at the stored rate
|   +-- STEP 2: remove in kind (no refresh needed) or in cash (klend refreshes)
+-- PATH B: Loop (H001 -> H025) [CONFIRMED, value part FIXED]
|   +-- LEAF: repeat add + in-kind remove k times
+-- PATH C: One-transaction composition (S002) [CONFIRMED, FIXED]
|   +-- STEP 1: stale adds on every market of the reserve
|   +-- STEP 2: an AMM cash removal or redeeming swap refreshes the reserve
|   +-- STEP 3: exits and round trips at the fresh rate
+-- PATH D: Round trip across a refresh (H002) [CONFIRMED, FIXED]
+-- PATH E: Outside one-way arbitrage (H048) [POTENTIAL, MITIGATED]
+-- PATH F: Low V from a re-pointed reserve or drifted layout (H007, H039) [H007 FIXED; H039 OPEN]

CRITICAL NODE: the reserve freshness gates (H001, H002 fixes) break A, B, C, D and bound E.
F is broken for H007 by lent_entry; H039 needs off-chain detection.
Atomicity: A to D fit in one transaction; E needs no atomicity.
```

### Goal B: Push a market's lent side into a crunched reserve

```
GOAL: Force a market out of withdraw mode during a Kamino liquidity crunch
+-- PATH A: Sibling rebalance lift (H003) [CONFIRMED, FIXED]
|   +-- STEP 1: rebalance(A_1..A_n) deposits
|   +-- STEP 2: rebalance(victim) leaves and lends 0.8 L
|   +-- STEP 3: rebalance(C) redeems it
+-- PATH B: Third parties' siblings as the lift (S003 form 2) [CONFIRMED, FIXED by H003's fix]
+-- PATH C: klend deposit / rebalance / redeem in one bundle (H004) [CONFIRMED, FIXED]
+-- PATH D: Flash-levered deposit in the bundle's other transactions (S003 form 1) [CONFIRMED, blunted by H004's fix]
+-- PATH E: Cascade across siblings (H016) [CONFIRMED, MITIGATED]
+-- PATH F: Repay-around or ticket-cancel-around (H018) [CONFIRMED, exit CLOSED by H004's fix]
+-- PATH G: Two attacker readings an hour apart, no honest reading between (H004 residual) [OPEN, LOW]

CRITICAL NODE: H004's exit wait breaks C, D, E and F; H003's one rebalance per transaction breaks A and B.
Atomicity: A and B single transaction; C to F one bundle; G needs a keeper outage of an hour.
```

### Goal C: Switch a market's lending off

```
GOAL: Keep a market all cash, costing its LPs yield
+-- PATH A: Victim's own add inflates exposure (H017) [CONFIRMED, OPEN]
+-- PATH B: Redeem and re-deposit around rebalance (H019) [CONFIRMED, OPEN]
+-- PATH C: Borrow-around (H018) [CONFIRMED, OPEN; bounded by klend's utilisation limit]
+-- PATH D: Kamino deposit refusal keeps cash and mode stuck (H025, H035) [CONFIRMED, OPEN]
+-- PATH E: Reset the exit wait once an hour with A or B (H004 fix) [OPEN, LOW]

CRITICAL NODE: none worth fixing on-chain; entry is the safe direction (LENDING-07), and an entry
confirmation would reopen Goal B. A cap-aware rebalance would close D.
Atomicity: A, B, C one bundle each; E one bundle per hour.
```

### Goal D: Trap or misprice LPs' principal

```
GOAL: LPs cannot leave with their share, or leave at a wrong value
+-- PATH A: Freeze or hook on the other mint (H006) [CONFIRMED, FIXED by remove_lent_side]
|   +-- residual: frozen USDC buffer vault blocks remove_lent_side's buffer part [OPEN, INFO]
+-- PATH B: Row edit, then H006 (H007 -> H006) [FIXED]
+-- PATH C: Unknown reserve version priced (H008) [FIXED]
+-- PATH D: Write-off sandwich (H015) [POTENTIAL, OPEN]
+-- PATH E: Total write-off leaves a dead market (H015 -> H065) [POTENTIAL, OPEN; exits still work]
+-- PATH F: Issuer mints and sells into the pool (H078) [POTENTIAL, OPEN; inherent]

CRITICAL NODE: H006's remove_lent_side (A and B).
D, E and F rest on Kamino's owner or the issuer.
Atomicity: A and F multi-transaction; D needs ordering around the Kamino owner's transaction.
```

### Critical fix nodes (summary)

| Fix | Attack paths broken | State |
|-----|---------------------|-------|
| Reserve freshness gates (H001, H002) | 5 of 6 in Goal A, and the value side of H081 | Fixed |
| Exit wait (H004) | 4 of 7 in Goal B, and H016 | Fixed |
| One `rebalance` per transaction (H003) | 2 of 7 in Goal B | Fixed |
| `remove_lent_side` (H006) | 2 of 6 in Goal D | Fixed |
| Keeper refresh prepend (S004) | Most of Chain 5's reverts | Fixed in spec |
| Cap-aware `rebalance` (H025, H035) | 1 of 5 in Goal C | Open (sign-off or fix) |

---

## Severity re-calibration

Investigators rated related items separately; after reading all findings together, these ratings were set or confirmed.

| Finding | Investigator's rating | Calibrated | Reason |
|---------|-----------------------|------------|--------|
| H001 | MEDIUM (CVSS 4.0) | MEDIUM | CVSS's low integrity score understates a no-role, repeatable, flash-fundable transfer that would be unfixable after the freeze; yield only and dust on the listed mainnet reserves, so not HIGH. |
| H006 | MEDIUM (CVSS 6.8) | MEDIUM | The knowledge base lists permanent freezing of significant funds as HIGH, but the lever is a party LPs choose to trust and Aviary shows, so likelihood is Unlikely: Severe x Unlikely = MEDIUM. |
| H024 | MEDIUM | MEDIUM | Kept above H023 (same client-dependent shape, LOW) because the shipped metadata actively promised protection that did not hold; fixed in that metadata. |
| H023 | LOW (CVSS 5.9) | LOW | The program offers a sufficient primitive and the one-transaction creation closes the window; MEDIUM only if a client defaults to a split flow or `min_lp = 0`. |
| S003 | LOW (CVSS 5.4) | LOW | Lowers H004's capital but adds no class; its severity is H004's family, rated there. |
| H035 | LOW (CVSS 4.8) | LOW | The stuck direction is the safe one; no value moves. |
| H002 | LOW | LOW | Same root as H001 but bounded by two router fees; profitable only after hours of devnet staleness or weeks on mainnet. |
| H016 | LOW | LOW | An increment below `1.1^(n-1)` over H003 and H004, which carry the family's MEDIUM. |
| H040, S004 | INFO (CVSS 3.7) | INFO | The caller picks only between stale and fresh; liveness detail of H068. |
| H005 | NOT VULNERABLE (INFO) | INFO, fixed | The knowledge base warns against rating overflow low because "values are usually small"; here the operation is checked (it refuses, never wraps), the refusal hits only a reporting field at magnitudes beyond any real history, and a smaller exit still succeeds, so INFO holds; it is fixed anyway because it sat on the guaranteed exit. |
| H087 | LOW | LOW | A coverage gap whose cost is counted in H001 and H002. |

No finding was raised for chain effects: no chain reaches HIGH, because every chain that moves value either takes yield bounded by interest since the last refresh (Chain 1), needs a real Kamino crunch and then a write-off before principal is lost (Chain 2), or needs a privileged outside party (the other mint's issuer, Kamino's owner, or our own upgrade key).
Checked against `common-false-positives.md`: H075 matches FP-011's "flag if" clause (one key, no timelock, not frozen) and stays a real, accepted devnet item; no finding rests on a check Anchor already makes (H033 and H096 were cleared on exactly that ground).

---

## Requires manual expert review

No finding has the NEEDS MANUAL REVIEW status, and no confidence score is below 5 (lowest: 7, for H015, H018, H039, H048, H060, H065, H081, H087, H091, H102, S003 and S004).
Three items would benefit from a human read:

| ID | Title | Uncertainty | Recommended expertise |
|----|-------|-------------|----------------------|
| H004 residual, H017, H019 | Withdraw mode's exit wait and its reset | Whether the hour and the reset rule are the right balance between forced exits (principal) and forced holds (yield), or a ramped re-lend would be better | Economic design (owner and MetalLegBob) |
| H015 | Write-off sandwich | How often Kamino's owner writes off on the listed reserves, and whether a per-slot `L` move limit is worth its liveness edge | Kamino operations, Solana MEV |
| H102 | Devnet oracle health | Whether the devnet reserves' oracle accounts are readable, which decides whether the freshness gates halt adds and swaps on devnet | Devnet operations (owner) |

---

## Investigated and cleared

<details>
<summary>Click to expand cleared items (76 total, including H005, which was then fixed)</summary>

| ID | Hypothesis | Protection mechanism |
|----|------------|---------------------|
| H005 | `totals_after_in_kind` overflow blocks the in-kind exit | Unreachable at real magnitudes and splittable; fixed anyway (SH-8) |
| H009 | Kamino account substitution in `rebalance` | Every account pinned to one key before use |
| H010 | Kamino account substitution in the swap redeem path | Redeem accounts checked before the CPI; positional parsing sound |
| H011 | Substitution in the cash removal's optional accounts | The vault authority signs one klend CPI, only with checked accounts |
| H012 | Fake reserve in read-only pricing paths | The reserve check runs on every read path |
| H013 | The in-kind exit in every Kamino state | Never reads the reserve; holds in every state (the issuer case is H006) |
| H014 | A transfer hook gains the vault authority's signature | Forwarded accounts are forced non-signer |
| H022 | Share inflation and donations | Every figure comes from recorded state, never balances |
| H026 | Router market-signer gate | Only the router's market PDA for this state can call |
| H027 | Seeded market address spoofing and collisions | Seed concatenations have pairwise distinct lengths |
| H028 | `register_existing_market` on a foreign account | The strategy's `pipeline_market_info` refuses it |
| H029 | Hooked other mint reorders or reads extra accounts | Hook accounts are appended, non-signer, after fixed metas |
| H030 | Issuer's hook acts inside victims' swaps before pricing | Pricing reads recorded state; no balance read |
| H031 | Remaining-accounts parsing: hook vs redeem accounts | Sound split; no shape desynchronises accounting |
| H032 | Unchecked payout destinations alias market accounts | Token program checks the mint; aliasing gains nothing |
| H033 | Duplicate mutable accounts | Anchor 1.2.2 refuses duplicates among write-back types; others checked |
| H034 | Other mint is a cToken, an LP mint or the other lent mint | Allowed by the mint rules; no value path opens |
| H036 | klend rate falls besides `socialize_loss` | Interest and rewards only raise it |
| H037 | Draining Kamino's cap and liquidity to block cash exits | In-kind exits remain; Kamino-level, not a redistribution |
| H038 | Lending-market emergency ignored by `can_pay_by_itself` | By design; error-code difference only |
| H041 | `require_alone` bypass vectors | Holds against every vector besides H003 |
| H042 | klend flash loans against rebalance, add and remove | Nothing beyond H001, H002 and H025 |
| H043 | Rounding of each Kamino conversion | Matches klend or rounds for the pool |
| H044 | LP rounding drain and the virtual minimum | Every rounding points at the pool |
| H045 | klend CPI layout | Matches klend 1.28.0 exactly |
| H046 | `lp_shares`, lock account and ATA creation griefing | No third party can block the created addresses |
| H047 | Router trust: amounts, indices, upgrades | Bounded by measured credit and the signer gate |
| H049 | `credited_input` credits stranded vault excess | Bounded by `amount_sent` |
| H050 | Seeding records requested, not measured, amounts | Escrow delta equals the request by construction |
| H051 | Raw balance and decimals reads without owner checks | Every call site passes a pinned account |
| H052 | `create_pda_account` top-up hijack | Allocate fails on reuse; PDA signer seeds |
| H055 | Reserve offsets, sizes and discriminators | Recomputed against klend 1.28.0 |
| H056 | Long-division exactness at real magnitudes | Exact over the full domain |
| H057 | `lent_value` overflow halts trading | Unreachable for listed mints; fails closed |
| H058 | `freely_available` returns 0 and forces entry | Only on corrupt reserve data; fails safe |
| H059 | Cash removal forfeits cTokens worth 0 | They stay recorded for the remaining LPs; no loss to the leaver |
| H061 | Swap sandwich around a refresh; no deadline | The router enforces `min_amount_out` |
| H062 | Removal sandwich | Removals execute no trade |
| H063 | Fee rounding at fee 0 and tiny trades | Fee rounds up; zero only when intended |
| H064 | `exact_in` edge refusals | Every edge refuses cleanly |
| H066 | InitParams validation | Every listed vector closed |
| H067 | Market pairing WSOL and USDC | Both orientations sound |
| H069 | Clock edges in the withdrawal-cap port | Matches klend's count |
| H070 | Return-data spoofing | The program never consumes return data |
| H071 | `resolve_accounts` vs swap bump | Stored bumps are canonical |
| H072 | CPI depth from wrappers | Within Solana's limit of 5 |
| H073 | `require_alone` strictness vs keeper liveness | Tips and nonces can sit in separate transactions |
| H074 | Reserve write-lock griefing | Ordinary Solana contention; no state harm |
| H076 | Wrong cluster feature at deploy | Exactly one feature forced at build time |
| H079 | Token-2022 extra accounts as multisig signers | Appended accounts are never signers |
| H080 | WSOL `sync_native` donations | Unrecorded excess is never priced |
| H082 | Compute exhaustion in cash removal | Within measured ceilings (`LENDING-88`) |
| H083 | Lock account integrity | No authority-signed CPI can name it as a source |
| H084 | LP mint supply reads around CPIs | Pre-CPI snapshots adjusted by hand |
| H085 | Swap input equals output | `trade_sides` refuses equal or out-of-range indices |
| H086 | In-kind cToken ATA pre-created or wrong program | Address derived with SPL Token's id |
| H088 | Seeding hook runs with state unwritten | The window H028 traced; nothing new |
| H089 | `deposited` and `redeemed` distorted | Written only from measured deltas |
| H090 | `RedeemPaidShort` through rounding | klend pays at least the shortfall |
| H092 | `isqrt`, u128 products, share bounds | Every cast bounded or checked |
| H093 | Event and log integrity | One `emit!` per instruction; indexer note |
| H094 | Withdraw-mode entry blocked during an emergency | `KaminoStopped` first, by design |
| H095 | `min_lent` semantics in the cash path | Measured payout, as specified |
| H096 | Type cosplay | One `#[account]` type |
| H097 | PDA seed collisions | Fixed-length seed components |
| H098 | Bump canonicalization | Every stored bump from a canonical derivation |
| H099 | Mixed `in_kind` and present Kamino accounts | Full truth table; no unsafe combination |
| H100 | klend redeem destination, confused deputy | Destination pinned to the market's buffer vault |
| H101 | `transfer_checked` mint or decimals substitution | Decimals from the same mint the token program checks |
| H103 | `MIN_REBALANCE` floors and the last-position rule | Every cToken can always be emptied |
| H104 | klend fee configuration changes | klend 1.28.0 has no deposit or redeem fee |
| H105 | Positional `output_vault` and `authority` substitution | Checked against the market's recorded addresses |
| H106 | Read-only instructions with writable accounts | `ReadTrade` declares nothing mutable |
| H107 | Removal from any LP token account | Burn signed by the LP; delegates refused |
| H108 | Kamino owner powers against the AMM | Each fails an instruction whole or is covered elsewhere |
| S001 | Stale stored rate on the exit side | Exits pay by count or measure klend's payout |

</details>

---

## Recommendations summary

### In #86, before the hardening ticket closes (critical nodes first)

1. [ ] **Round 2**: run Stronghold's verify phase on every fix above, then a re-review of the code the fixes changed, with `remove_lent_side` (new, never reviewed), the exit wait and the freshness gates in full.
2. [ ] **Sign-off**: record the owner's written acceptance of each row in "Owner sign-off required", including the nine CONFIRMED rows, or move H025 and H035 to a cap-aware `rebalance` fix.
3. [ ] **Spec corrections**: `lending-pool.md:283` (forced entry costs nothing under a bundle; the exit wait's reset), `:292` (griefing above the band), `LENDING-13`'s wording (write-off sandwich), `:176` (structural vs semantic changes).
4. [ ] **Devnet oracles (H102)**: confirm the devnet reserves' oracle accounts are readable, so the keeper's refresh (`LENDING-95`) keeps the gated adds and swaps live; alert on a failed refresh.
5. [ ] **Report location**: copy this report to `docs/security/lending-amm/adversarial-review.md`; the maths properties report already links there and `docs/spec/README.md` puts reports in `docs/security/<program>/`.

### Before any mainnet deployment

1. [ ] Add H039's cheap structural anchors and decide on padding pins, then run a klend-upgrade watcher that compares `V` with klend's payout on live state.
2. [ ] Decide H077's per-reserve exposure account and H020's resolution change, both interface-level and cheap only before the freeze.
3. [ ] Freeze with a checked script: registration and the final metadata URI first, the `mainnet` feature, then `SetAuthority(None)` (H075, `LENDING-26`).
4. [ ] Aviary's lending panel computes both maximums from the quote (H024), never offers `min_lp = 0` (H023), and shows the other mint's authorities (H078, H006).
5. [ ] Keep an independent external security review on the launch checklist (`BAR-26`); this internal review does not replace one.

### Ongoing

- **Code review**: every build PR keeps `/code-review` at high effort.
- **Monitoring**: the keeper reacts to `WithdrawModeLeft` and to free liquidity below `5X` at once (S003), flags bundle-shaped `WithdrawModeEntered` readings (H019), and watches Kamino's ticket and reward flags (H018, H081).
- **Disclosure**: Aviary's panel says that withdraw mode can be held on by others at the cost of yield, and that `remove_lent_side` forfeits the other side's part.
- **Periodic review**: re-run Stronghold of Security whenever Kamino ships a klend release or the spec's economics change.

---

## Coverage

### Files analyzed

<details>
<summary>Click to expand file list (25 program files at `0ef0e06`; `src/instructions/remove_lent_side.rs` was added after round 1)</summary>

| File | Findings |
|------|----------|
| `src/buffer.rs` | H016, H020, H025, H035, H054, H091 |
| `src/config.rs` | H007, H054, H068, H075, H081 |
| `src/errors.rs` | - |
| `src/events.rs` | H093 |
| `src/instructions/add_liquidity.rs` | H001, H017, H023, H024, H025, H060 |
| `src/instructions/init_market.rs` | H006, H007, H023, H053, H066, H067 |
| `src/instructions/lock_lp.rs` | H046, H083 |
| `src/instructions/market_info.rs` | H070, H106 |
| `src/instructions/mod.rs` | - |
| `src/instructions/quote.rs` | H002, H021 |
| `src/instructions/rebalance.rs` | H003, H004, H016, H017, H018, H019, H020, H035, H040, H041, S003, S004 |
| `src/instructions/remove_liquidity.rs` | H001, H006, H025, H059, H099, S002 |
| `src/instructions/resolve_accounts.rs` | H020, H071 |
| `src/instructions/seed_liquidity.rs` | H050, H088 |
| `src/instructions/swap.rs` | H021, H049, H085, S002 |
| `src/instructions/trade_accounts.rs` | H020, H105, H106 |
| `src/interface.rs` | H047 |
| `src/kamino.rs` | H001, H002, H007, H008, H018, H021, H039, H057, H058, H068, H081, H091 |
| `src/lib.rs` | H076 |
| `src/params.rs` | H054, H066 |
| `src/pricing.rs` | H002, H015, H048, H054, H063, H064 |
| `src/shares.rs` | H005, H024, H044, H062, H092 |
| `src/state.rs` | H053, H065, H085, H096 |
| `src/token.rs` | H051, H052, H079, H101 |
| `src/withdraw_mode.rs` | H004, H016, H017, H019, H035, H040, H077 |

</details>

### Analysis depth by area

| Focus area | Context agent | CONFIRMED or POTENTIAL findings |
|------------|---------------|---------------------------------|
| Access control | 01 | H007 |
| Arithmetic | 02 | H005, H021, H054, H068, H091 |
| State machine | 03 | H003, H035, H053, H065 |
| CPI and external | 04 | H006, H008, H039, H081 |
| Token and economic | 05 | H024, H025, H060, H078 |
| Oracle and data | 06 | H001, H002, H015, H040, H048, H102, S002, S004 |
| Upgrade and admin | 07 | H075 |
| Timing and ordering | 08 | H004, H016, H017, H018, H019, H020, S003 |
| Economic model | 09 | H023, H077, H087 |

Coverage verification found 10 of 10 instructions, 76 of 95 relevant exploit patterns by precedent (the other 19 covered in substance) and 58 of 58 playbook items covered, with no CRITICAL or HIGH gap.
Its one MEDIUM gap, BPF stack frames of the large handlers (EP-086), is closed: `cargo build-sbf` reports no stack offset errors.

---

## Methodology

This review used Stronghold of Security and Book of Knowledge from MetalLegBob's Solana Vibes Kit, installed in `.claude/skills` at a pinned commit:

1. **Scan**: codebase scan (25 files, about 7,000 lines, about 4,500 production), knowledge-base manifest, static pre-scan (472 hot spots, 12 priority leads); Semgrep was not installed.
2. **Analyze**: nine focus-area agents (access control, arithmetic, state machine, CPI, token economics, oracle and data, upgrade and admin, timing and ordering, economic model), quality-gated (eight at 8/8, one at 7/8).
3. **Strategize**: synthesis into `ARCHITECTURE.md`, then 108 attack hypotheses (Tier 1: 15, Tier 2: 32, Tier 3: 61; 29 novel), including eight orchestrator leads (H001 to H008) found by hand.
4. **Investigate**: 18 batches, every hypothesis with invariant-first analysis, exact models where economics were involved and a devil's-advocate challenge; Tier 1 and 2 on Opus, Tier 3 on Sonnet; four supplementals (S001 to S004) after Batch 1.
5. **Coverage verification**: instructions, exploit patterns and playbook items checked.
6. **Book of Knowledge**: 30 maths properties chosen, 20 already established and 10 added, with Proptest, Kani (48 default-tier harnesses in 4 minutes 37 seconds), 43 Z3 claims and the fuzzer; two counterexamples found (SH-6 = H001, SH-8 = H005), both fixed.
7. **Synthesis**: this report, with the combination matrix, attack trees and severity re-calibration.

Round 2 is Stronghold's verify phase on the fixes, then a re-review of the code the fixes changed, as `docs/spec/README.md` requires.

---

## Review lineage

| # | Date | Git ref | Confirmed | Potential | Files scanned | Notes |
|---|------|---------|-----------|-----------|---------------|-------|
| 1 | 2026-11-17 | `0ef0e06` | 19 | 17 | 25 | First review; fixes on `imDev2023/build-86` up to `8f31e48` |

All 36 findings are new in this round; there is no earlier round to compare against.

---

## Disclaimer

This is an internal adversarial review run by agents inside the project's own hardening ticket.
It is not an audit, it is not independent, and it must never be presented as one.
It does not guarantee the absence of vulnerabilities, and it should be complemented by the project's proofs and fuzzing, round 2's verification, an independent external review before mainnet, and ongoing monitoring.
The program is devnet-only until Pipeline's router is on mainnet and is frozen before any mainnet deployment (`LENDING-26`); severities are rated for the code as written, as if on mainnet, with devnet meaning noted where it matters.

---

## Report metadata

| Field | Value |
|-------|-------|
| Report generated | 2026-11-17 |
| Stronghold of Security version | 1.0.0 |
| Review number | 1 |
| Previous reviews | 0 |
| Context files generated | 9 |
| Strategies investigated | 112 |

**End of report**
