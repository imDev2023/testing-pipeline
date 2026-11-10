# Aviary indexes Pipeline itself

Aviary runs its own indexer (a Durable Object reading Helius's free devnet RPC, ported from Top-pad's) and keeps its own record of strategies, markets and trades, although Pipeline now runs a hosted devnet API with trades, candles and a live stream (`https://pipeline-devnet.up.railway.app`).
The hosted API is a pre-release third-party service with per-IP limits that Workers' shared outbound addresses would hit, it sees only what the router emits, so it misses strategy upgrades, custom actions and bypass swaps, which Aviary must watch on the strategy programs themselves, and it gives no trigger for Canary runs.
We use it only as a parity check in our devnet tests.
Decided by the owner in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13) on 2026-11-10; the design is in `docs/spec/pipescope-architecture.md`.

## Consequences

- Swap events are inner instructions, so every reported transaction is fetched whole; no socket is complete, so reconciliation from a cursor runs whatever the live source.
- The indexer holds its socket only while someone watches an Aviary page, because an outbound socket cannot hibernate and a second always-awake indexer would push the Cloudflare account, shared with Top-pad, past its Durable Object allowance.
