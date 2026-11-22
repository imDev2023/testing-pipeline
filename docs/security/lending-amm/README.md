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
- Every Low and Informational finding left open is accepted with the owner's sign-off of 2026-11-22 (below), each with its reason in [`verification.md`, "Every finding left open"](verification.md#every-finding-left-open-all-rounds-for-the-owners-sign-off).

## Owner's sign-off

The bar accepts a Low finding only with the owner's written sign-off, recorded in the report ([`docs/spec/README.md`, Internal adversarial review](../../spec/README.md#internal-adversarial-review), [`BAR-18`](../../decisions.md#bar-18-hardening-ticket)).
The owner signed off on 2026-11-22, in the coordinating session, recorded on [#86](https://github.com/imDev2023/testing-pipeline/issues/86): every finding left open in `verification.md`, "Every finding left open", is accepted, each with the reason given there; each acceptance is a default MetalLegBob may change.

- Accepted Lows (23): H004's residual, H015, H017, H018, H019, H020, H021, H023, H025, H035, H039, H060, H065, H068, H077, H081, H091, H102, S003, R2-02, R2-03, R2-06 and R2F-01.
- Accepted Informational findings (14): H040, H053, H075, H078, R2-05's residual, R2-08, R2-09's residual, R2-11, R2-15, R2-16's residual, R2-17, R2-18, R2F-03 and R2F-04.
- The two the sign-off names: H004's residual, that liquidity timed around the keeper's 10-minute sweeps can still force a market out of withdraw mode (with R2-02), and R2-03, that if Circle froze a market's USDC vault, `remove_lent_side` would be blocked too.

Some rows of that table name work to be done later rather than nothing; the acceptance covers the finding, and the work stays with the ticket or step it names:

- Before the devnet deploy ([#87](https://github.com/imDev2023/testing-pipeline/issues/87)): H102, check the devnet oracle accounts.
- With the keeper runner ([#96](https://github.com/imDev2023/testing-pipeline/issues/96)): R2-02 and H004's residual, sweeps with jitter; H040 and R2-18, the keeper refreshes the reserve first.
- Before the program is frozen or launched on mainnet: H039, structural anchors and a klend upgrade watcher; H075, a mainnet launch precondition.
- Smaller follow-ups in the spec and tests: H015, H019 and R2-08, a sentence each in the spec; R2-06, listing the redeem accounts when the reserve is past the trade bound; R2-05, R2-09 and R2-16's residuals and R2F-03, further test cases; R2-17, an event when a sighting is recorded or forgotten; R2F-04, wording.
