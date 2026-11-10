# Canary checks run natively in a Cloudflare Container

Canary checks run as a native Rust binary (`crates/canary`, on `litesvm` and Pipeline's crates) in a linux/amd64 Cloudflare Container on a `basic` instance with internet access off, driven by one Durable Object per strategy version that builds the RPC snapshot and posts it in.
A WASM build inside a Worker was ruled out by [Where the quoter runs for Canary checks](https://github.com/imDev2023/testing-pipeline/issues/7): `blst` needs a wasm C compiler, Agave's clock call traps on the Worker target, and even when both were worked around the full router swap crashed in the 32-bit VM.
A small server elsewhere would run the same binary for about the same cost, but adds a platform, a second home for the RPC key and a public endpoint to guard, so it stays the fallback.
Decided by the owner in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13) on 2026-11-10; Workers Paid, which Containers need, was already active on the account, so nothing was bought.

## Consequences

- The router is loaded from its deployed bytes, and the harness can switch from the router's `simulate_swap` to calling the strategy directly plus Pipeline's Apache-2.0 settlement code, because the router is BSL 1.1 with no use grant until 2028-11-08.
- The trading path never uses the Container: trade-box quotes are RPC simulations of `pipeline_quote` from the API Worker.
