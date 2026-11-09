# Charting brief for the wayfinder map

Written 2026-11-09 by the session that evaluated Pipeline, for the session that charts this project's wayfinder map.
It is input to `/wayfinder`, not the map: the map is a GitHub issue labelled `wayfinder:map` on `imDev2023/testing-pipeline`, created when the owner runs `/wayfinder`.
Read `research/README.md` first; everything below cites it.

## What the owner has decided (2026-11-09)

- Build all six of MetalLegBob's asks on Pipeline: the containment hook, the tax AMM, a terminal (Pipescope), Pool4 for Solana, the lending pool, and single-use AMMs as a service.
- These are new products, not features of the owner's other projects; reusing code from them is welcome (Top-pad's Workers and Durable Object indexer, candle building, Next.js on Workers through OpenNext, Codama Kit clients, solana-verify flow, Playwright end-to-end setup).

## What the evaluating session recommended (confirm in the first grilling)

- Use wayfinder to settle decisions before building, then turn the settled spec into build tickets the relay can run, as in Top-pad; the owner asked whether to use wayfinder or have tickets written directly, and this was the recommendation, because several decisions wait on the owner and on MetalLegBob.
- Order: Pipescope first, then the containment hook and tax AMM, then Pool4 for Solana, then the lending pool (`research/estimates.md`, Suggested order).

## Proposed destination

A build-ready spec (`docs/spec.md`, decisions in `docs/adr/`) for the whole suite on devnet, ordered as above, plus build tickets labelled `build` whose order the map's `## Next` section gives, so the relay can run them one at a time.
Confirm or redraw this in the first grilling.

## Notes for the map

- Domain: `GLOSSARY.md` (single context); keep its terms, sharpen it with `domain-modeling`.
- Skills every session should consult: `grilling` and `domain-modeling` for decisions; `research` for research tickets; `prototype` for screens and explainer samples; `jupiter-meteora` for anything about Jupiter or Meteora; the owner's v4-hooks knowledge base for Pool4; `cloudflare-kb` for Workers and Containers; `helius:svm` and `web3-testing` for Solana program work.
- Pipeline source: clone `https://github.com/MetalLegBob/pipeline` at `a8b1b1d` (or newer, noting the change) into a scratchpad; never vendor it.
- MetalLegBob's answers to `research/outreach.md` change scope; record them there and on the ticket they settle.
- Devnet only until Pipeline's mainnet; never hold users' keys; ask the owner before every paid call (LLM explainer, paid RPC tiers).

## Decision tickets I can already state

Types follow wayfinder: research (AFK), grilling (HITL), prototype (HITL), task.

### Tasks

1. Send the DM and reply in `research/outreach.md` and record MetalLegBob's answers (HITL: the owner sends). Blocks: which items we build, SDK stability, mainnet timing.
2. Make this project's own devnet wallet and fund it from the faucet (HITL for the faucet).
3. Clone Pipeline at the pinned commit, run its tests and `scripts/devnet/smoke.ts` against devnet, and record toolchain versions that work on this Mac (AFK).

### Research

4. Where Pipescope's indexer gets data: Helius webhooks or streams, plain RPC polling of the router, or both; free-tier limits; how Top-pad's indexer does it.
5. Where the quoter runs for Canary checks: Cloudflare Container, a WASM build, or a small server; cost and cold-start.
6. Lending market for the lending pool: Kamino, Jupiter Lend or another; their CPI surface, refresh requirements, account counts, devnet availability.
7. Token-2022 hook mechanics for the containment hook: removing the hook program through a program-owned authority, router compatibility after unlock, which accounts the hook must allow (Pipeline fee and treasury accounts, the home market's vaults).
8. Pool4 maths on a single Pipeline strategy: the cap ratchet, trim without moving price, the buy wall as a second price segment, and what MetalLegBob's own `pool4.json` strategy on devnet already is.
9. Prior art for AI explanations of contracts and for behavioural testing of Solana programs; what an explainer can say safely.
10. Legal and platform posture for a terminal that charges an integrator fee and a Telegram bot.

### Grilling

11. Destination and scope: the spec above, or something smaller first; product names; one repo for everything or several.
12. Business model: Pipescope's integrator fee rate; tax destinations for the tax AMM; Pool4 for Solana's fee split including IMD's share; prices for single-use AMMs.
13. Security bar per product: internal adversarial review, invariant tests and fuzzing for all; which products get an external audit and from what budget.
14. Containment hook policy: are wallet-to-wallet transfers allowed while contained; how the unlock goal is measured and who sets it.
15. Pipescope v1 scope: pages, wallets, mobile, what the Canary results look like to a trader, whether the explainer runs on every strategy version.

### Prototypes

16. Pipescope screens (feed, market page with chart, trade box, Canary results, explainer).
17. Explainer output on the four strategies on devnet, so the owner can judge tone and accuracy.

## Fog (not yet specified)

- Telegram bot: non-custodial flow details depend on the Pipescope decisions.
- Single-use AMMs: depend on finding a first client.
- Whether to publish Canary results on-chain as attestations, or only as a page and API, depends on whether integrators other than us ask for them.
- Mainnet launch plan, audits and liquidity seeding depend on Pipeline's mainnet date.

## Open questions for the operator

- GitHub repo: answered 2026-11-09, the owner created private `imDev2023/testing-pipeline` with `scripts/create-github-repo.sh`, `main` pushed and all eight wayfinder, build and relay labels present.
- Were the reply and DM in `research/outreach.md` sent, and has MetalLegBob answered?
- What should the suite and the repo be called, if not `testing-pipeline`? Renaming is cheapest before the map and worktrees exist.

## Out of scope (proposed)

- A custodial Telegram bot holding users' keys.
- Anything on mainnet before Pipeline's mainnet.
- A token for this suite (MetalLegBob's Pipeline has none; the owner has not asked for one).
