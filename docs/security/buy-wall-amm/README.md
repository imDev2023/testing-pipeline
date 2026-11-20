# Buy wall AMM: internal adversarial review

The record of the hardening of the buy wall AMM (`programs/buy-wall-amm`), done in [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55), as the engineering and security bar requires ([`docs/spec/README.md`, Internal adversarial review](../../spec/README.md#internal-adversarial-review), [`BAR-18`](../../decisions.md#bar-18-hardening-ticket)).

**This is not an audit.**
It is an internal adversarial review, run by agents inside the project's own hardening ticket with two skills from MetalLegBob's MIT-licensed Solana Vibes Kit: Stronghold of Security, which looks for attacks, and Book of Knowledge, which chooses the maths properties to prove.
It is not independent, it guarantees nothing, and it must never be presented as an audit, in metadata or anywhere else ([`BAR-19`](../../decisions.md#bar-19-code-review-and-what-reviews-are-called)).
No external review of this program has been done.
An independent external review stays on the checklist for any mainnet deployment, which waits for Pipeline's router to reach mainnet anyway.

## What was reviewed

- The program: `programs/buy-wall-amm/src/` at commit `72636ae` (30 files, about 7,400 lines), the deployed program and the scope of every finding with an `H` number.
- The release gate: `programs/buy-wall-amm/gate/` and `programs/buy-wall-amm/scripts/deploy.sh`, a host-only tool that is never deployed, for the upgrade-safety findings (H013, H020, H033, H034, H052, H058, H097, H098) and the gate re-review of round 2 (R2G-01 to R2G-09).
- As context only: the tests, the proofs, the spec ([`docs/spec/pool4-for-solana.md`](../../spec/pool4-for-solana.md)), the decision register and the glossary.
- Pipeline's router is closed source under BSL 1.1; the review read its interface crate and treated it as a trusted caller.

When: from 2026-11-16 to 2026-11-19.
Round 1 ran on 2026-11-16 and 2026-11-17, the fixes landed on 2026-11-17, round 2 and its fixes ran on 2026-11-17 and 2026-11-18, and the owner gave the answers on 2026-11-19, in the hardening session, recorded on #55: the hybrid floor (1a), H002's residual accepted as a disclosed Low (2a) and every listed Low signed off (3a).

## How

**Round 1, Stronghold of Security, at the "deep" tier** ([round-1.md](round-1.md)):

1. Scan: an index of the code, a static pre-scan (564 hot spots) and the list of knowledge-base patterns to load.
2. Analysis: nine context reviewers, one per focus area (access control, arithmetic, state machine, CPI, token economics, oracle and data, upgrade and admin, timing and ordering, the economic model), each quality-gated.
3. Strategy: one architecture document, then 111 attack hypotheses (H001 to H111; 19 in tier 1, 42 in tier 2, 50 in tier 3; 58 specific to this code), eight of them notes from the ticket's own code review.
4. Investigation: every hypothesis taken to a verdict, with exact integer models of the program's maths where money was involved and a devil's-advocate challenge of each conclusion.
5. Coverage: 13 of 13 instructions, 40 of 40 matched exploit patterns and 19 of 19 items of the AMM playbook's red-flag list reached by at least one finding.
6. Report: the findings table, severity calibration, combination analysis and attack trees.

**Book of Knowledge**, beside round 1 ([maths-properties.md](maths-properties.md)): 62 regions of maths indexed, 62 invariants proposed, 25 confirmed and built as Z3 claims, Kani harnesses, Proptest properties and fuzzer invariants.

**Fixes**: the owner settled the design-level findings on 2026-11-17; the fixes landed in this ticket, each recorded as a decision (below) and pinned by a regression test named `sos_<finding id>` where the finding called for one.

**Round 2** ([round-2.md](round-2.md)):

1. Verification of every confirmed or potential finding of round 1 (and of the not-vulnerable items the ticket hardened anyway) against the fixed code, each re-run with the round 1 attack and, where money was involved, the same exact models.
2. An adversarial re-review of the program code the fixes changed (`git diff 72636ae..e2bd509 -- programs/buy-wall-amm/src`), which found R2-01 to R2-06.
3. An adversarial re-review of the release gate's changes (`git diff 72636ae..3003439` of `gate/` and `scripts/deploy.sh`), which found R2G-01 to R2G-09.
4. Fixes for what round 2 found, and the owner's sign-off of every Low left open.

## Outcome

No Critical or High finding was found in either round.
No Medium finding is open: every Medium is fixed, and one (H002) was re-rated Low by the owner on 2026-11-19, with its residual measured and disclosed.
Every Low left open is accepted with the owner's sign-off of 2026-11-19 (answers 3a and 4a on #55), each with its reason in [sign-offs.md](sign-offs.md); no Critical, High or Medium finding is open.

Round 1 (37 confirmed or potential findings, 74 cleared):

| Severity | Found in round 1 | Fixed in #55 | Fixed, residual signed off | Re-rated Low and signed off | Signed off | Open |
| --- | --- | --- | --- | --- | --- | --- |
| Critical | 0 | - | - | - | - | 0 |
| High | 0 | - | - | - | - | 0 |
| Medium | 7 | 6 (H001, H003, H005, H020, H058, H061) | - | 1 (H002) | - | 0 |
| Low | 28 | 14 (H004, H007, H013, H022, H031, H033, H041, H048, H050, H056, H062, H065, H066, H098) | 2 (H068, H097) | - | 11 (H008, H021, H024, H025, H026, H034, H040, H059, H070, H110, H111); H096 closed upstream by Pipeline 0.2.0 | - |
| Info | 2 | 1 (H063) | - | - | - | 1, not gated (H069) |

Round 2 (new findings):

| Severity | Found in round 2 | Fixed in #55 | Signed off | Info, not gated |
| --- | --- | --- | --- | --- |
| Medium | 3 (R2-01, R2-02, the back-run regression found in VERIFY-H003) | 2 (R2-01, the back-run regression) | 1, accepted as a Low residual of the hybrid floor (R2-02) | - |
| Low | 6 (R2-03, R2G-01, R2G-02, R2G-03, R2G-06, R2G-07) | 3 (R2G-01, R2G-02, R2G-03; R2G-03's narrow remaining gap accepted) | 3 (R2-03, R2G-06 with H097, R2G-07) | - |
| Info | 7 (R2-04, R2-05, R2-06, R2G-04, R2G-05, R2G-08, R2G-09) | 2 (R2-05, R2-06) | 2 (R2G-04, R2G-08) | 3 (R2-04, R2G-05, R2G-09) |

Seven of round 1's cleared hypotheses were hardened anyway (H009, H023, H044, H064, H067, H076, H099), and round 2 confirmed each.

What the fixes changed, in one line each:

- A token's transfer hook must be fully cleared before a market can be seeded, so no seeded market can become a honeypot (H001, H061).
- The reward share is paid only on trimmed tokens the cap's own fall matched, at most one day's worth of fall at a time, so a rewards recipient cannot pay itself from dips, wall closures or recycled rewards (H005, H007, H056, R2-01), and its lifetime take is the budget the creator published.
- The wall's floor moves only at slot boundaries, `place_wall` is refused in a slot a swap ran in, and every placement is capped at the lowest close of the last slot that traded, so a dip inside a slot no longer moves the wall and a back-run of a fall no longer pays (H003, H004, H050, the VERIFY-H003 regression).
- The release gate judges a candidate against the deployed build on the same snapshot, registers markets the router never recorded, takes keeper jobs from the deployed build and always trades a market of its own, so no third party can veto upgrades and an empty cluster no longer passes any build (H013, H020, H033, H058, H097, H098, R2G-01 to R2G-03).

## Files

| File | What it holds |
| --- | --- |
| [README.md](README.md) | This summary, the decisions the fixes rest on and the owner's sign-offs |
| [round-1.md](round-1.md) | Round 1: every finding, its evidence and its disposition, the 74 cleared hypotheses, the combination analysis, the attack trees and the coverage |
| [round-2.md](round-2.md) | Round 2: the verification of each finding, the new findings R2-01 to R2-06 and R2G-01 to R2G-09, and what was done about each |
| [release-0.1.1.md](release-0.1.1.md) | The verify pass on release 0.1.1, the first upgrade on devnet: no finding reopened and no new one |
| [maths-properties.md](maths-properties.md) | Book of Knowledge: every maths property of the program and the tools that establish it |
| [sign-offs.md](sign-offs.md) | Every accepted Low, why it is accepted and what would change it |

The review's working files (the hypotheses, the per-finding notes and the exact models) are kept out of the repo; these five files are the record.
Code is cited at the commit each round read: round 1 at `72636ae`, round 2 at the commits it names.

## Decisions the fixes rest on

Each is a default that MetalLegBob may change; the register holds the full text, the alternatives weighed and how each would change.

- [`POOL4-46`](../../decisions.md#pool4-46-when-a-failed-step-counts-against-a-candidate): a step a candidate fails counts against it unless the deployed build failed the same step on the same snapshot, starting in the same program with the same error (H020, H058; the same error since 2026-11-18, R2G-01).
- [`POOL4-47`](../../decisions.md#pool4-47-markets-the-router-has-not-recorded): the gate registers a market the router never recorded, and creates a missing router fee account, as anyone may, then checks it like the rest (H013).
- [`POOL4-48`](../../decisions.md#pool4-48-a-transfer-hook-at-the-seed): both seeding paths refuse a token whose transfer hook still names a program or an authority (H001, H031, H048, H061).
- [`POOL4-49`](../../decisions.md#pool4-49-which-retired-tokens-earn-the-reward-share): the reward share is paid only on trimmed tokens the cap's own fall matched, with at most one day's fall waiting unmatched (H002, H005, H007, H056, H041's motive, R2-01).
- [`POOL4-50`](../../decisions.md#pool4-50-when-the-walls-floor-moves): the floor moves only at a slot's first update, `place_wall` is refused with `SwapThisSlot` in a slot a swap ran in, and, as amended on 2026-11-19, every placement is also capped at the lowest close since the last placement, `low_since_placement` (named `last_slot_low`, the last traded slot's lowest close, until the branch's code review of 2026-11-19), appended to the market state at offset 735, the reserve now 273 bytes from offset 751 (H003, H004, H050, the VERIFY-H003 regression).
- [`POOL4-51`](../../decisions.md#pool4-51-the-markets-clocks-never-run-backwards): the market's stored clocks become the later of themselves and the Clock's time, so no second is counted twice (H009).
- [`POOL4-52`](../../decisions.md#pool4-52-which-wallets-a-role-may-be-handed-to): a handover refuses the role's current wallet (`SameRecipient`) and the market's own addresses (`NotAWallet`) (H022, H063).
- [`POOL4-53`](../../decisions.md#pool4-53-every-gate-run-trades-a-market-of-its-own): every gate run also creates, seeds, trades and checks a market of its own with the candidate, none of its failures excused, in a world of its own since 2026-11-18, the router unpaused and its payout accounts fresh (H097, H098, R2G-02).

The fixes also changed `POOL4-12`, `POOL4-17`, `POOL4-32`, `POOL4-38`, `POOL4-41` and `POOL4-44` (on 2026-11-18, each replay asking the build it runs for a fee slot's wallet, R2G-03), as their blocks in the register record.
The gate decisions `POOL4-44`, `POOL4-46`, `POOL4-47` and `POOL4-53` are this session's defaults, not yet put to the owner, as the register's follow-ups say.

## The owner's sign-offs

The bar accepts a Low finding only with the owner's written sign-off, recorded in the report.
The owner gave the answers on 2026-11-19, in the hardening session, recorded on [#55](https://github.com/imDev2023/testing-pipeline/issues/55): 1a the hybrid floor, 2a H002's residual accepted as a disclosed Low, 3a every listed Low signed off; each is a default MetalLegBob may change.
[sign-offs.md](sign-offs.md) has one row per accepted Low with its reason and what would change it.

- H002 re-rated from Medium to Low by the owner on 2026-11-19: the rewards recipient can draw the creator's published reward budget, `reward_share x (seeded - cap_floor)`, as fast as the cap may fall, measured at about 7.8% of a 10 SOL curve's SOL over 4 days at the defaults and up to 21.7% in one day at the most extreme parameters a creator may choose; the spec's explainer risks disclose it.
- Accepted Lows: H002's residual; the hybrid floor's residuals (any dip since the last placement caps the next `place_wall` at that low once, until idle SOL refills; a dip held across a slot boundary lowers the floor, R2-02, downgraded from Medium by the owner); H034; R2G-03's remaining gap; H008, H021, H024, H025, H026, H040, H059, H068 (no full-tier Kani in CI), H070, H097 with R2G-06 (the seconds between the gate's check and the upgrade landing), H110, H111, R2-03, R2G-04, R2G-07 and R2G-08.
- Info, not gated: H069, R2-04, R2G-05, R2G-09.
