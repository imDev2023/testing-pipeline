# Feasibility and time, first estimate (2026-11-09)

These are planning estimates made before the wayfinder map, for one build lane working one ticket at a time the way the owner's relay does: LiteSVM tests and a devnet demo per ticket, no external audit, no mainnet.
They become real only once the map's decisions are made; re-estimate per ticket then.

| # | Product | Feasible | Main problem | Estimate |
| --- | --- | --- | --- | --- |
| 1 | Containment hook | Yes; start from Pipeline's 141-line `test-hook` allowlist hook | It must allow Pipeline's fee and treasury token accounts or sells fail; the unlock needs the hook authority to be a program-owned address so anyone can trigger it once the goal is met; decide whether wallet-to-wallet transfers are allowed while contained | 4 to 6 days |
| 2 | Tax AMM | Yes, the simplest | Buys tax the SOL in, sells tax the SOL out; leave exact-out swaps out of v1 | 3 to 5 days (1 and 2 together about 1.5 to 2 weeks) |
| 3 | Pipescope | Yes | The Rust quoter cannot run inside a Cloudflare Worker, so Canary checks need a Cloudflare Container or a small server; the Telegram bot must not hold users' keys; the explainer makes paid LLM calls (ask the owner before each) | About 4 to 5 weeks: indexer, feed and charts 1 week; trading and custom-action forms 1 to 1.5 weeks; Canary checks 1 to 1.5 weeks; explainer 2 to 4 days; Telegram bot 1 week |
| 4 | Pool4 for Solana | Yes | The largest: strategy, buy wall as a second price segment, staking with streamed rewards, five keeper jobs, its own pages; holds the most user money | 3 to 4 weeks |
| 5 | Lending pool | Yes, with limits | Calling a lending market inside a swap of a hooked token exceeds the call-depth limit, so keep a buffer and rebalance by keeper; swaps larger than the buffer fail while the lending market is fully borrowed; Kamino's devnet presence is unknown, so test against cloned mainnet state | 2 to 3 weeks |
| 6 | Single-use AMMs | Yes | A service: each needs a client and a design | 3 days to 2 weeks each |

## Across all of them

- Pipeline is devnet-only and its interfaces may change; expect rework at its mainnet.
- Nothing goes live before Pipeline's mainnet.
- Products 1, 2, 4, 5 and 6 hold user money and need adversarial review, invariant tests and fuzzing before mainnet: about 30 to 50% more time; Pool4 for Solana and the lending pool deserve an external audit.
- Devnet SOL: this project needs its own devnet wallet; each program deploy costs about 1.5 to 3 devnet SOL, so plan 10 to 15 SOL from the faucet.

## Totals

- One lane, products 1 to 5: about 11 to 14 weeks of build plus 2 to 3 weeks of hardening, roughly 3 to 4 months.
- Two or three parallel lanes: about 6 to 8 weeks of calendar time.
- If MetalLegBob builds 1 and 2 himself, subtract about 2 weeks.

## Suggested order

1. Pipescope, which he asked for, earns the integrator fee from the first swap and holds no pool money.
2. Containment hook and tax AMM, which give Pipescope something new to launch with.
3. Pool4 for Solana, the largest upside and the most security work.
4. Lending pool, last, because Meteora has done it before and it depends on an outside protocol.
