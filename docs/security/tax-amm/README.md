# Tax AMM: internal adversarial review

The record of the hardening of the tax AMM (`programs/tax-amm`), done in [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67), as the engineering and security bar requires ([`docs/spec/README.md`, Internal adversarial review](../../spec/README.md#internal-adversarial-review)).

**This is not an audit.**
It is an internal adversarial review, run by agents inside the project's own hardening ticket with two skills from MetalLegBob's MIT-licensed Solana Vibes Kit: Stronghold of Security, which looks for attacks, and Book of Knowledge, which chooses the maths properties to prove.
It is not independent, it guarantees nothing, and it must never be presented as an audit, in metadata or anywhere else ([`BAR-19`](../../decisions.md#bar-19-code-review-and-what-reviews-are-called)); the program's `security.txt` names no auditors and its metadata's `security.audits` stays empty.
No external review of this program has been done.
An independent external review stays on the checklist for any mainnet deployment, which waits for Pipeline's router to reach mainnet anyway.

## What was reviewed

- **Round 1** ([round-1.md](round-1.md)), 2026-11-20, at `77b6ddc`, the build then deployed on devnet: Stronghold of Security at its "deep" tier, 100 hypotheses, 15 confirmed and 22 potential findings, no Critical or High, seven Mediums, each of them spec-level design: the program did what the spec said, and what the spec permitted did harm.
- **The owner's answers**, 2026-11-22: 1a (only a cleared hook or the containment hook, and no mint or freeze authority at the seed but on a quote mint), 2a (a change of rates waits 300 slots), 3a (a slot still owed tax keeps its wallet), 4a (the seed names the market's terms by their hash) and 5a (every Low left open signed off).
- **Book of Knowledge** ([maths-properties.md](maths-properties.md)): the 22 properties of [the maths proofs](https://github.com/imDev2023/testing-pipeline/issues/64) re-checked against the final code, and seven added, each proven with Kani, Z3 or Proptest and run in CI.
- **Round 2** ([round-2.md](round-2.md)), 2026-11-22: every finding verified against the fixed code and the changed code re-reviewed; no Critical, High or Medium, three Lows (one fixed at once, two signed off on 2026-11-23) and four Info notes.
- **The owner's sign-offs** ([sign-offs.md](sign-offs.md)): every accepted Low with what remains, why it is accepted and what would change it.

## What changed in the program

Each change is a decision in the register, a default MetalLegBob may change:

- `TAX-16` (changed): a mint's transfer hook must be cleared or be the containment hook with the mint's unlock PDA as its authority, checked at creation and at the seed, and at the seed no mint but a quote mint (`TAX-58`) may keep a mint or freeze authority; `HOOK-12` changed with it, so a contained launch revokes its mint authority between `bind` and the seed.
- `TAX-05` (changed): a change of rates waits `RATE_CHANGE_DELAY_SLOTS` (300 slots) as pending rates, kept in 12 of the market state's reserved bytes without moving any field the containment hook reads.
- `TAX-39` (changed): `set_recipients` refuses to hand a slot still owed tax to another wallet.
- `TAX-59` (new): `seed` takes the hash of the market's terms and refuses a mismatch.
- `TAX-55`, `TAX-56` and `TAX-57` (new): tax recipients are never the market's own addresses, a market state a newer build wrote is refused, and a release gate quotes every market on the cluster before an upgrade.

Every confirmed finding has a LiteSVM regression test named `sos_<finding id>` that fails without its fix (`programs/tax-amm/tests/`).

## How it was run

- The working files (every hypothesis, finding, model and verification) stay out of the repo, in `programs/tax-amm/.audit/`, which is gitignored; this folder is the committed record.
- Each phase ran as its own agents, read only, with exact-integer Python models instead of builds; the fixes were written test first in the ticket's own session.
