# Lending AMM: internal adversarial review

The lending AMM's hardening, [Lending AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/86), run on 2026-11-17 before the program's first deploy, as the engineering and security bar's "Internal adversarial review" asks ([`docs/spec/README.md`](../../spec/README.md#internal-adversarial-review)).
It is an internal review with Stronghold of Security and Book of Knowledge from MetalLegBob's Solana Vibes Kit, installed in `.claude/skills`; it is not an audit, and nothing presents it as one.

| Report | What it holds |
| --- | --- |
| [`adversarial-review.md`](adversarial-review.md) | Round 1: Stronghold of Security's full review of commit `0ef0e06` (112 hypotheses, 19 confirmed, 17 potential), with the remediation made on the hardening branch |
| [`verification.md`](verification.md) | Round 2: Stronghold's verify phase and a re-review of every line the fixes changed, its follow-up on the fixes made after it, and the table of every finding left open |
| [`maths-properties.md`](maths-properties.md) | Book of Knowledge's 30 properties of the pricing, valuation, share and rebalancing maths, and the proof or test that establishes each |

## Where it stands

- No Critical, High or Medium finding is open.
  The five Medium findings of round 1 (H001, H003, H004, H006, H024) and round 2's one (R2-01) are fixed, each with a regression test named `sos_<finding id>` in `programs/lending-amm/tests/hardening.rs` (H005's is in `src/shares.rs`), and every such test fails on the program as it was at `0ef0e06`.
- The Low and Informational findings left open are listed, each with the reason it is proposed for acceptance, in [`verification.md`, "Every finding left open"](verification.md#every-finding-left-open-all-rounds-for-the-owners-sign-off).
  The bar accepts a Low finding only with the owner's written sign-off, recorded here.

## Owner's sign-off

Not given yet.
The owner records it here, naming the findings accepted, with the date.
