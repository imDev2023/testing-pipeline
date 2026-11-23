# Containment hook: internal adversarial review

The record of the hardening of the containment hook (`programs/containment-hook`), done in [Containment hook: hardening](https://github.com/imDev2023/testing-pipeline/issues/74), as the engineering and security bar requires ([`docs/spec/README.md`, Internal adversarial review](../../spec/README.md#internal-adversarial-review), [`BAR-18`](../../decisions.md#bar-18-hardening-ticket)).

**This is not an audit.**
It is an internal adversarial review, run by agents inside the project's own hardening ticket with two skills from MetalLegBob's MIT-licensed Solana Vibes Kit: Stronghold of Security, which looks for attacks, and Book of Knowledge, which chooses the maths properties to prove.
It is not independent, it guarantees nothing, and it must never be presented as an audit, in metadata or anywhere else ([`BAR-19`](../../decisions.md#bar-19-code-review-and-what-reviews-are-called)).
No external review of this program has been done.
An independent external review stays on the checklist for any mainnet deployment, which waits for Pipeline's router to reach mainnet anyway, and the hook is frozen before then.

## What was reviewed

- The program: `programs/containment-hook/src/` at commit `e4fdcd3` (13 files, about 1,000 lines of program code and about 1,330 with the proofs and tests inside them), and the shared crate it links, `programs/mint-rules/src/lib.rs`; the scope of every finding with an `H` number.
  The deployed program `aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv` is a verified build of `77b6ddc`, whose hook logic equals `e4fdcd3`'s.
- The fixes on this branch, `imDev2023/build-74`, from `96f625f` to `1b05d82`: the program diff, the release gate (`scripts/gate_snapshot.py`, `scripts/pre-deploy.sh`, `tests/release_gate.rs`), the freeze gate (`scripts/freeze-gate.ts`, `freeze.ts`), Canary's changes for contained markets, the launch script and the CI and advisory workflows, re-reviewed in round 2 (R2-01 to R2-10, R2T-01 to R2T-14).
- As context only: the tax AMM on main and on its hardening branch (#67, merged into this branch in `410f4b3` during round 2), Pipeline's router at `48a6b5f` (read from the project's fixture, never copied: it is BSL 1.1), Token-2022 6.0.0 and v11.1.0, the transfer hook interface, the spec ([`docs/spec/containment-hook.md`](../../spec/containment-hook.md)), the decision register and the glossary.
- Pipeline's router and Token-2022 were treated as trusted callers; the hook's trust in Token-2022's own upgrade authority is stated in the spec ("Depends on").

When: 2026-11-22 and 2026-11-23.
Book of Knowledge ran on 2026-11-22; round 1 ran from 2026-11-22 23:09 UTC to 2026-11-23 00:30 UTC and its first fixes landed by 00:54 UTC; the owner answered the eight questions on 2026-11-23, in the hardening session, recorded on #74 (`1a 2a 3a 4a 5a 6a 7a 8a`, the review's recommendation in each case, and the sign-off of every Low listed); round 2 and its fixes ran the same day, up to `1b05d82` at 15:31 UTC.

## How

**Round 1, Stronghold of Security, at the "deep" tier** (forced by the ticket's brief; the code's size alone would have chosen "quick") ([round-1.md](round-1.md)):

1. Scan: an index of the 14 files, a static pre-scan (109 pattern locations, 44 of them high risk) and 20 target hot spots, with the knowledge-base patterns to load.
2. Analysis: nine context reviewers, one per focus area (access control, arithmetic, state machine, CPI and external calls, token economics, oracle and data, upgrade and admin, timing and ordering, the economic model), each quality-gated.
3. Strategy: one architecture document, then 100 attack hypotheses (H001 to H100; 11 in tier 1, 19 in tier 2, 70 in tier 3; 55 specific to this code), including the ticket's four named areas and its six notes T01 to T06.
4. Investigation: every hypothesis taken to a verdict, with exact-integer models of the money paths, read-only devnet reads and simulations, and a devil's-advocate challenge of each clearance.
5. Coverage: 3 of 3 instructions, 4 of 4 named areas, 6 of 6 T-notes, 12 of 12 applicable items of the AMM playbook's red-flag list and 15 of 15 of the Token-2022 checklist; one gap check (G001).
6. Report: the calibrated findings table, severity calibration, combination analysis, attack trees, test gaps and the owner's questions.

**Book of Knowledge**, beside round 1 ([maths-properties.md](maths-properties.md)): 14 regions of maths and byte reads indexed, 30 properties proposed, 16 built as Kani harnesses, Proptest properties, fuzzer invariants and LiteSVM tests (12 at the confirm gate, TLV-6, HA-1, ST-6 and EC-3 later in this ticket), 13 existing ones checked, and the exact cost of washing a home market to its goal (T04).

**Fixes**: the session's defaults landed first, then the owner's answers; each fix is recorded as a decision (below) and pinned by a regression test named `sos_<finding id>` where the finding called for one, the refusal tests seen failing against the unfixed program.

**Round 2** ([round-2.md](round-2.md)):

1. Verification of every confirmed or potential finding of round 1, and of the cleared ones the ticket acted on, against the fixed code, each attack re-run with round 1's models.
2. An adversarial re-review of the program diff (`git diff e4fdcd3..c4fe317` of `src` and `mint-rules`), which found R2-01 to R2-05.
3. An adversarial re-review of the tooling the hardening added (the release gate, the freeze gate, Canary and CI), which found R2T-01 to R2T-14.
4. A final re-review of the changes after the first re-review (`git diff 961aa2e..d4c1a8c`: #67's merge, `bind`'s quote mint check, the launch script, the shared harnesses), which found R2-06 to R2-10; the verification passes raised R2-A to R2-C.
5. Fixes for what round 2 found.

## Outcome

No Critical finding was found in either round.
No Critical, High or Medium finding is open.
Round 1's one High (H001, an owner change moving a contained balance with no hook call) and one Medium (H011, a redeploy that could strand every contained token) are fixed; so are round 2's two Mediums, both in the tooling (R2T-01, R2T-07).
Every Low left open is accepted with the owner's sign-off of 2026-11-23 (answers 1a to 8a on #74), each with its reason in [sign-offs.md](sign-offs.md).

Round 1 (49 confirmed or potential findings, 51 cleared, of which two hardened anyway):

| Severity | Found (with #67) | Fixed in code or tests | Fixed in the spec | Accepted or signed off | Not taken | No action |
| --- | --- | --- | --- | --- | --- | --- |
| Critical | 0 | - | - | - | - | - |
| High | 1 | 1 (H001) | - | - | - | - |
| Medium | 1 | 1 (H011) | - | - | - | - |
| Low | 29 | 11 (H008, H009, H014, H015, H020, H025, H029, H030, H051, H072, H075) | - | 18, signed off | - | - |
| Info | 39 | 8 | 9 | 5 | 2 (H043, H097) | 15 |

On main's tax AMM alone H014, H022 and H030 were Medium: answer 3a fixed H014 and H030 in the hook, #67's seed rule (now merged) closes H022 for new markets, and its devnet residue is signed off.

Round 2 (new findings):

| Severity | Found in round 2 | Fixed in #74 | Not fixed, Info |
| --- | --- | --- | --- |
| Medium | 2 (R2T-01, R2T-07) | 2 | - |
| Low-Medium | 2 (R2T-02, R2T-08) | 2 | - |
| Low | 12 (R2-01, R2-06, R2-07, R2-B, R2T-03, R2T-04, R2T-05, R2T-06, R2T-09, R2T-10, R2T-12, R2T-13) | 12 | - |
| Info | 11 (R2-02 to R2-05, R2-08 to R2-10, R2-A, R2-C, R2T-11, R2T-14) | 8 | 3 (R2-05, R2-09, R2-10) |

What the fixes changed, in one line each:

- A buy may deliver a contained token only into an account whose owner can never change, so no balance can change hands with no transfer and no tax (H001, H092).
- `bind` counts the goal from zero, refuses a Token-2022-owned mint authority, a market state of another version and, by answer 3a, a quote mint with a live transfer hook or, off the tax AMM's quote list, a mint or freeze authority (H008, H009, H014, H020, H030, H051).
- No redeploy replaces the hook until its release gate has replayed every devnet config with the new build, from a census of every hook-owned account, through trades, refusals, the fee account, a fresh binding and both unlock paths (H011, H029, H072, R2-01, R2T-01 to R2T-06), and reported any balance whose owner can change (H002).
- The freeze gate checks every contained mint's hook fields and config against the chain and both programs' bytes before freezing the hook and the tax AMM together at mainnet (H016 to H018, R2-B, R2T-07 to R2T-09).
- The spec and Aviary's panel disclose what no transfer hook can see, what the goal promises against the launcher and the supply held outside the pool (H002, H003, H012, H013, H023, H024, H067).

## Files

| File | What it holds |
| --- | --- |
| [README.md](README.md) | This summary, the decisions the fixes rest on and the owner's sign-offs |
| [round-1.md](round-1.md) | Round 1: every finding, its evidence and its final disposition, the owner's answers, the four named areas, the combination analysis, the attack trees, the coverage and the cleared hypotheses |
| [round-2.md](round-2.md) | Round 2: the verification of each finding, the new findings R2-01 to R2-10, R2-A to R2-C and R2T-01 to R2T-14, and what was done about each |
| [maths-properties.md](maths-properties.md) | Book of Knowledge: every maths property of the hook and the tools that establish it, the T04 cost model and the mutation run |
| [sign-offs.md](sign-offs.md) | Every accepted Low, why it is accepted, and the Info left open |

The review's working files (the hypotheses, the per-finding notes, the exact models and the round 2 notes) are kept out of the repo; these five files are the record.
Code is cited at the commit each round read: round 1 at `e4fdcd3`, round 2 at the commits it names.

## Decisions the fixes rest on

Each is a default that MetalLegBob may change; the register holds the full text, the alternatives weighed and how each would change.

- [`HOOK-42`](../../decisions.md#hook-42-the-goal-counts-from-the-binding): `bind` refuses a market that has already collected tax, so the goal counts only tax collected under containment (H020, H025).
- [`HOOK-43`](../../decisions.md#hook-43-which-market-state-versions-the-hook-reads): the hook reads a market state only at version 1, so a newer one is refused at `bind` and left to the deadline at `unlock` (H009, H015, H057).
- [`HOOK-44`](../../decisions.md#hook-44-a-multisig-mint-authority): `bind` refuses a mint authority owned by Token-2022, which a multisig's creation key alone could otherwise sign for (H008, H050, R2-03).
- [`HOOK-45`](../../decisions.md#hook-45-executes-own-address-checks): `Execute` keeps both PDA checks, behind one helper (T01, T02; H007, H031, H032).
- [`HOOK-46`](../../decisions.md#hook-46-the-frozen-config-layout-and-the-hooks-release-gate): the config's version 1 layout is frozen while any token is bound, and no build replaces the hook until its release gate passes on the very bytes deployed (H011, H029, H072, H002, R2T-01 to R2T-06).
- [`HOOK-47`](../../decisions.md#hook-47-destinations-whose-owner-can-change): `Execute` refuses a destination other than the vault and the fee account unless its owner can never change; `pipeline-check`'s checks on its own trader accounts are known failures until it writes the extension (H001, answer 1a).
- [`HOOK-48`](../../decisions.md#hook-48-what-containment-polices): containment polices token movements, not who controls a key; programs and smart wallets as holders are disclosed (H003, answer 2a).
- [`HOOK-49`](../../decisions.md#hook-49-what-the-unlock-goal-promises): the goal binds the launcher only against third parties, with the sole recipient's cost stated in numbers and shown on Aviary's panel (H023, H024, H061, H066, answer 4a).
- [`HOOK-50`](../../decisions.md#hook-50-supply-held-outside-the-pool): supply held outside the pool is disclosed by Canary and Aviary, and the launch script now seeds the whole supply (H067, answer 5a).
- [`HOOK-51`](../../decisions.md#hook-51-the-mainnet-freeze-gate): the hook and the tax AMM are frozen together at mainnet behind a gate that checks every contained mint before and after (H016 to H018, answer 7a).
- [`HOOK-52`](../../decisions.md#hook-52-the-quote-mint-at-binding): `bind` checks the quote mint by the tax AMM's own quote list and rule (H014, H030, H051, answer 3a).
- [`BAR-46`](../../decisions.md#bar-46-dependency-advisories): a workflow of its own audits the dependencies daily and on change (H075).
- [`CANARY-47`](../../decisions.md#canary-47-supply-outside-the-pool): Canary's `outside_supply` warns when supply outside the pool could be sold into buyers' real quote (H067, R2T-12).

The fixes also changed [`HOOK-01`](../../decisions.md#hook-01-transfers-while-contained), [`HOOK-02`](../../decisions.md#hook-02-integrator-fees-on-sells), [`HOOK-11`](../../decisions.md#hook-11-what-the-unlock-does), [`HOOK-17`](../../decisions.md#hook-17-in-aviary), [`HOOK-18`](../../decisions.md#hook-18-invariants), [`HOOK-34`](../../decisions.md#hook-34-the-deadline-without-the-market-state) and [`CANARY-15`](../../decisions.md#canary-15-the-checks), as their blocks in the register record.
`HOOK-42` to `HOOK-46` and `BAR-46` are this session's defaults, listed for the owner on #74, and `CANARY-47`'s rule and threshold are the session's within the owner's answer 5a, as the register's follow-ups say.

## Devnet

Release 0.1.1, a verified build of `af01f5b` (this hardening's code on `main`), replaced the deployed build of `77b6ddc` on devnet on 2026-11-23, in slot 525,494,322 (signature `38w9XQ6P...`), executable hash `53626e3ddea4d6650951e5308aa9cff117e738a4abde67e2ac04145caa6fc584`, which `solana-verify get-program-hash -u devnet` matched; every hook test, 166 of them, had passed on those exact bytes first.
The release gate ran on those bytes inside `scripts/deploy-devnet.sh` before the upgrade: it served all six configs then on devnet, traded and unlocked by the goal and by the deadline each of the three still contained in LiteSVM, and refused a second unlock of the three unlocked (`deployments/release-gate/containment-hook/devnet.json`).
Then, on devnet, with the new build (`deployments/devnet-demo-containment-hook-0.1.1.json`):

- Tokens contained by the earlier build still trade and unlock: `5iEQzUi2...` unlocked by its deadline, `FvsouVQ3...` traded and unlocked by its goal (109,265,663 of 100,000,000 collected), and demo token 3 traded, paying Pipeline's fee in the token into its fee account through the hook; its mint authority was revoked (answer 8a).
- The launch script launched a new contained token, bought and sold it, swept Pipeline's fee, had a wallet transfer refused on chain and a sell with an integrator fee and a buy into an account whose owner can change refused, ran `pipeline-check` (11 pass, the two known failures of `HOOK-47`), unlocked it by its deadline and ran `pipeline-check` again (13 pass); a second new token was bought and sold and, traded with `contained.ts`, unlocked by its goal.

## The owner's sign-offs

The bar accepts a Low finding only with the owner's written sign-off, recorded in the report.
The owner gave the answers on 2026-11-23, in the hardening session, recorded on [#74](https://github.com/imDev2023/testing-pipeline/issues/74): `1a 2a 3a 4a 5a 6a 7a 8a`; each is a default MetalLegBob may change.
[sign-offs.md](sign-offs.md) has one row per accepted Low with its reason.

- Signed off by answer 8a (the session's list): H002, H012, H013, H022, H026, H049, H050, H065, H066, H070 and H096; H051, on the same list, is now closed outright by answer 3a.
- Accepted by the design answers: H003 (2a), H023 and H024 with H061 (4a), H067 (5a), H062 (6a) and H016 to H018 until the mainnet freeze (7a).
- By answer 8a the session also unlocks the two contained mints the devnet record omits once due, revokes demo token 3's mint authority (H022) and records them, at the hook's redeploy.
- Info, not gated: H038, H039, H043, H094, H097, R2-05, R2-09 and R2-10.
