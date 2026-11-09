# Where the quoter runs for Canary checks

Researched 2026-11-09 for [#7](https://github.com/imDev2023/testing-pipeline/issues/7), which feeds [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13).
Pipeline's source was read from a scratchpad clone of https://github.com/MetalLegBob/pipeline at commit `a2d5bfb` (2026-11-09 07:14 UTC); file paths below are inside that clone unless they start with `/`.
Cloudflare facts come from the owner's knowledge base at `/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/cloudflare`, a snapshot dated 2026-10-05, with the official page each fact came from.
Every measurement below was made on 2026-11-09 on the owner's Mac (x86_64, 20 cores, macOS 15) with Pipeline's pinned toolchain, Rust 1.97.1.

## Answer

- Run Canary checks as native Rust in a Cloudflare Container: it builds, it runs the router and a real devnet strategy correctly, it needs about 35 MB of memory, and at our volume it costs nothing beyond the $5 a month Workers Paid plan.
- A WASM build inside a Worker is ruled out: it does not build without a wasm C compiler, it does not run without patching an Agave crate, and once both are worked around the full router swap still fails inside the 32-bit wasm VM, so the exit test cannot run there.
- A small server elsewhere works as well as a Container (native, with the JIT) and costs about the same, but it adds a second platform, a second home for the RPC key and a public endpoint to guard.
- The quoter never fetches data itself; each Canary run takes a snapshot from devnet RPC (about ten calls, about 0.9 MB, mostly program bytes) and a new strategy version is detected by the `slot` in the strategy's ProgramData header.

## What the quoter is and needs

- `pipeline-quoter` wraps one `LiteSVM` (`litesvm = "=0.18.2"`) with signature and blockhash checks off and a funded payer (`crates/pipeline-quoter/Cargo.toml`; `crates/pipeline-quoter/src/lib.rs` lines 137 and 150).
- "The quoter never talks to the network": callers load programs with `load_program_from_program_data`, accounts with `set_account` and time with `set_clock` (`src/lib.rs` lines 4 to 6, 184, 198, 225).
- `quote` runs only the strategy's `pipeline_quote`; `simulate_swap` runs the whole router `swap` for a synthetic trader and reads the router's own result, so it needs the router program, its config, the market, the market's fee account and every account the swap touches (`src/lib.rs` lines 422 and 483).
- Strategy code runs under a compute cap, 200,000 units by default (`src/lib.rs` line 34).
- `simulate_swap` only simulates; the quoter keeps its `LiteSVM` private and has no way to commit a swap (`src/lib.rs` lines 137 and 483 to 544).
  The exit test buys and then sells back with the clock moved forward, so the Canary harness has to drive `litesvm` directly with `send_transaction` (reusing `pipeline-client`'s builders), not only the `Quoter` API; that harness has the same dependencies and so the same hosting answer.
- The integrator guide says to reload a program when its ProgramData changes, since strategies can be upgraded (`docs/INTEGRATOR-GUIDE.md` line 34).
- `pipeline-quoter` depends on 330 crates (`cargo tree -p pipeline-quoter -e normal`, unique name and version), including Agave's program runtime, the sBPF VM (`solana-sbpf 0.23.0`) and C code: `blst` (BLS12-381) through `solana-bls12-381-syscall` and `solana-bls-signatures`, which `litesvm` always pulls in (`cargo tree -i blst`).
- The sBPF VM uses its JIT only on x86_64 outside Windows (`solana-sbpf-0.23.0/src/lib.rs` line 38; `solana-program-runtime 4.3.2` enables the `jit` feature); wasm32 and arm64 hosts fall back to the interpreter.
- LiteSVM's own Node package (`litesvm` 1.6.2 on npm) is a napi native addon, not wasm, so it cannot run in a Worker either (https://github.com/LiteSVM/litesvm/blob/master/crates/node-litesvm/package.json).

## What we measured

A throwaway probe crate (kept in the session scratchpad, not in this repo) recorded one live devnet market of MetalLegBob's example constant-product strategy and ran it through the quoter, natively and as wasm.
All RPC was read-only on the public devnet endpoint; no transaction was sent.

### Devnet data for one market

- `getProgramAccounts` on the router filtered by the `Market` discriminator returned 43 markets on 2026-11-09 about 08:00 UTC: 19 on `yRptCdde...` (constant product), 12 on `ETrmUegr...` (bonding curve), 8 on `4ajWF6Y3...` (4-mint pool), 4 on `9mAV3pMK...` (outside builder); `research/pipeline-router.md` counted 38 earlier the same day.
- That call failed three times with HTTP 429 "Connection rate limits exceeded" on `https://api.devnet.solana.com` and took 108 s to succeed.
- Market `LCHsnkMfToU5C9G28JikT3eP3AvnCZSsPUeYvVLBS52` needed 9 accounts (market, market state, 2 mints, 2 vaults, router config, 2 fee accounts) plus the router's and the strategy's ProgramData; `pipeline_resolve_accounts` asked for one strategy account, already among them.
- Program bytes dominate: the router's ELF is 587,412 bytes and the strategy's 329,160 bytes; the whole snapshot serialised to 919,339 bytes.
- Fetching both ProgramData accounts took 1.1 s and the market's accounts 0.25 s.

### Native build (x86_64, JIT)

- `cargo build --release -p pipeline-quoter` succeeded in 4 min 16 s from cold.
- `Quoter::new` took 15 to 18 ms; a process holding only a new quoter peaked at 13.5 MB resident (`/usr/bin/time -l`).
- Loading the router, the strategy and 9 accounts took 7.6 ms; `resolve_accounts` 0.4 to 3 ms.
- `quote` took 160 µs each over 2,000 quotes in both directions.
  The integrator guide says 10 to 20 µs for simple strategies (`docs/INTEGRATOR-GUIDE.md` line 32); why ours is slower is not verified (each quote is a full simulated transaction, which may be the cost).
- `simulate_swap` of a buy succeeded and matched the quote exactly (`received` 208,888 for 763,013,620,993 in); 500 simulations averaged 0.68 ms each.
- `simulate_swap` of the sell direction failed with router error 6002 (`0x1772`), while its quote succeeded.
  In the `a2d5bfb` source error 6002 is `ListingFeeTooHigh` (`programs/pipeline/src/lib.rs` line 1287), which a swap cannot raise, so the router deployed on devnet probably differs from that source (unverified).
- The process peaked at 33.6 MB resident after all of it.

### wasm32-unknown-unknown (what a Worker runs)

- `cargo check --target wasm32-unknown-unknown` fails first in `getrandom 0.3.4`, which needs `--cfg getrandom_backend="wasm_js"` on that target.
- With that set it fails in `blst 0.3.17`'s build script: `clang` reports "No available targets are compatible with triple wasm32-unknown-unknown"; Apple's clang and the Solana platform-tools clang (v1.57) both lack the wasm backend, and none other is installed here.
- With the C step stubbed out (a no-op compiler, for checking only), the whole quoter type-checks for wasm32, so the Rust code itself compiles.
- `spl-token-2022-interface` turns on `getrandom 0.2`'s `js` feature for wasm32, so a real build also needs `wasm-bindgen` glue, as `workers-rs` uses anyway.
- Linked with `blst`'s symbols left as imports (38 of them), the module is 7.5 MB uncompressed including the 0.9 MB snapshot; the Worker size limit is 64 MiB uncompressed (https://developers.cloudflare.com/workers/platform/limits/).
- It traps in `Quoter::new`: `std::time::Instant::now` panics on this target, called from `solana_program_runtime::invoke_context::InvokeContext::process_message` through `solana-svm-measure 4.3.2` (`src/measure.rs` line 17) during `LiteSVM::airdrop`.
  Every transaction LiteSVM runs goes through that path; fixing it means patching `solana-svm-measure` (the only crate on the runtime path that reads the clock) and carrying that patch through every Agave upgrade.

### wasm32-wasip1 (wasm with a clock)

- To see how the quoter behaves as wasm once the clock works, the same probe was built for `wasm32-wasip1` and run in Node 26.9 with a six-call WASI shim.
- `Quoter::new` took 29 ms, loading 5.5 ms, `resolve_accounts` 8.7 ms, and `quote` 217 µs each, with 15.6 MB of linear memory.
- `simulate_swap` of the same buy that succeeds natively failed inside the router: "Access violation reading 32 bytes at address 0xcce8 (in unallocated region)".
  Quotes make no cross-program calls and work; the router swap makes several (the strategy, token programs, its event self-call), and fails on the 32-bit host; the root cause was not investigated.
- Workers' WASI support is "experimental ... with only some syscalls implemented" (https://developers.cloudflare.com/workers/runtime-apis/webassembly/), so this build would not be the way into a Worker anyway.

## The three options

| | Cloudflare Container | WASM in a Worker | Small server elsewhere |
| --- | --- | --- | --- |
| Builds | Yes, native linux/amd64 image | No: needs a wasm C compiler for `blst`, `wasm-bindgen` glue and a getrandom flag | Yes, native |
| Runs Canary checks | Yes, with the JIT (x86_64) | No: clock panic without an Agave patch; router swaps fail in 32-bit wasm even with a clock | Yes, with the JIT on x86_64, interpreter on arm64 |
| Memory | About 35 MB measured; `basic` gives 1 GiB | 128 MB per isolate including the JS heap | About 35 MB; 256 MB machines are enough |
| CPU | `basic` is 1/4 vCPU; a run of a few hundred simulated swaps is well under a second of CPU at 0.7 ms each | 30 s default, 5 min max per request | Shared vCPU |
| Cold start | "often in the 1-3 second range" | Under 1 s startup limit; compile of a 7.5 MB module took 13 to 34 ms in Node | None if always on; about a minute on Render's free tier |
| Data from devnet | Fetches by RPC itself, or receives a snapshot from the Worker | Would get bytes from the Worker's `fetch` | Fetches by RPC itself |
| Monthly cost at our volume | $0 beyond Workers Paid ($5) | Would be $0 beyond Workers Paid, if it worked | From $2.19 (Fly.io) |

Sources for the table: Containers limits and instance types (https://developers.cloudflare.com/containers/platform/limits/), cold starts and linux/amd64 (https://developers.cloudflare.com/containers/concepts/architecture/), Workers memory, CPU and startup limits (https://developers.cloudflare.com/workers/platform/limits/), Fly.io and Render prices (`/Volumes/Farhan/Work Folder/Dev/AI/Research-Projects/cloudflare/alternatives.md` sections 3.6 and 3.8, from https://docs.fly.io/about/pricing and https://render.com/docs/free).

### Cloudflare Container

- Containers run any linux/amd64 image as part of a Workers app; each instance is a Firecracker microVM reached through its own Durable Object (https://developers.cloudflare.com/containers/, https://developers.cloudflare.com/containers/concepts/architecture/).
- They need the Workers Paid plan; there is no free allowance (KB `build/01-compute.md` section 3, Status).
- Instance types range from `lite` (1/16 vCPU, 256 MiB) to `standard-4` (4 vCPU, 12 GiB); `basic` is 1/4 vCPU, 1 GiB and 4 GB of disk (https://developers.cloudflare.com/containers/platform/limits/).
- There is no fixed maximum runtime, but hosts can restart instances at any time, and an instance that runs out of memory restarts; there is no swap (https://developers.cloudflare.com/containers/faq/).
- Containers can reach the internet by default; `enableInternet = false` with `allowedHosts` or an outbound handler limits it, and outbound handlers can inject auth headers, so the Helius key can stay in the Worker (https://developers.cloudflare.com/containers/configuration/outbound-traffic/).
- Scaling is manual today: address instances by id, or spread work over N instances with `getRandom` (https://developers.cloudflare.com/containers/configuration/scaling-and-routing/).

### WASM in a Worker

- Rust Workers compile to `wasm32-unknown-unknown` with `workers-rs` (https://developers.cloudflare.com/workers/languages/rust/).
- Each isolate gets 128 MB including the JavaScript heap and WebAssembly allocations, shared by concurrent requests (https://developers.cloudflare.com/workers/platform/limits/).
- Workers disallow timers for security, so even a patched clock would read the same time throughout a request unless I/O happens (https://developers.cloudflare.com/workers/languages/rust/crates/, citing https://developers.cloudflare.com/workers/reference/security-model/).
- Making it work would mean a wasm C toolchain for `blst`, a fork of `solana-svm-measure`, and debugging Agave's VM on a 32-bit host, then repeating all three at each LiteSVM or Agave upgrade; it would also lose the JIT.

### Small server elsewhere

- Fly.io's cheapest always-on machine, `shared-cpu-1x` with 256 MB, is $2.19 per 30 days plus $0.02/GB egress; Fly.io has no free tier (`alternatives.md` section 3.6, from https://docs.fly.io/about/pricing).
- Railway's Hobby plan has a $5 monthly minimum; Render's free web services spin down after 15 minutes idle and take about a minute to wake (`alternatives.md` sections 3.7 and 3.8).
- Any of these runs the same native binary as the Container; the difference is operational, not technical.

## Cost at our volume

Assumptions: 50 strategy versions and a few hundred re-runs a month, rounded up to 500 Canary runs; each run is a cold start (worst case), about 10 s of work and 2 minutes of idle before the instance sleeps, on a `basic` instance.
That is about 133 s of billed running time per run, 18.5 hours a month.

| Dimension | Used | Included with Workers Paid | Overage cost |
| --- | --- | --- | --- |
| Memory (1 GiB provisioned) | 18.5 GiB-hours | 25 GiB-hours | $0 |
| CPU (active only) | under 45 vCPU-minutes | 375 vCPU-minutes | $0 |
| Disk (4 GB provisioned) | 74 GB-hours | 200 GB-hours | $0 |
| Egress | well under 1 GB | 1 TB (North America and Europe) | $0 |

- Rates and allowances: https://developers.cloudflare.com/containers/platform/pricing/ (memory $0.0000025 per GiB-second, CPU $0.000020 per vCPU-second, disk $0.00000007 per GB-second beyond the allowance).
- Even a `standard-1` instance (4 GiB) would go 49 GiB-hours over, about $0.44 a month.
- The fronting Worker and the container's Durable Object are billed separately at their own rates (https://developers.cloudflare.com/containers/platform/pricing/).
  The Worker's few thousand requests a month sit inside Workers Paid's 10 million requests and 30 million CPU-ms (https://developers.cloudflare.com/workers/platform/pricing/).
  The Durable Objects' 500 runs of about 133 s, billed at 128 MB, come to about 8,300 GB-s against 400,000 GB-s and 1 million requests included a month (https://developers.cloudflare.com/durable-objects/platform/pricing/).
- So the cost of Canary checks is the $5 Workers Paid subscription, which Containers require and which the owner must approve before it is bought.

## Getting fresh account data from devnet

- Per Canary run, take a snapshot: the strategy's and the router's ProgramData, the market account, its market state, mints, vaults, the router config and fee accounts, then whatever `pipeline_resolve_accounts` asks for over up to four rounds, then `set_clock` from `getEpochInfo` (`crates/pipeline-quoter/src/lib.rs` lines 225 and 334; `docs/INTEGRATOR-GUIDE.md` lines 37 to 39).
  For the measured market that was about ten RPC calls and 0.9 MB.
- Load the router from its deployed ProgramData, not from a local build, so the checks test what is on chain; the probe's sell failure suggests the deployed router is not the `a2d5bfb` source.
- A strategy version is the program id plus the `slot` in its ProgramData header, the slot it was last deployed (`solana-loader-v3-interface 8.1.1`, `src/state.rs` lines 29 to 33; the header is 45 bytes, line 51).
  Pipescope's indexer can watch that account (or poll it) for each registered strategy and queue a Canary run when the slot changes.
- Discovery of strategies and markets is the indexer's job, not the quoter's: on Helius `getProgramAccounts` costs 10 credits and most other calls 1 credit, and the free plan gives 1M credits a month at 10 requests a second (`heliusKnowledge.getHeliusCreditsInfo`, from https://www.helius.dev/docs/billing, fetched 2026-11-09; `alternatives.md` section 4.2).
  500 runs of about ten calls is about 5,000 credits, 0.5% of the free plan; Helius also lists "2 credits/0.1MB" after an allowance, which may apply to the program bytes (unverified).
- The public devnet endpoint is too rate-limited to rely on for discovery (three 429s in one `getProgramAccounts` call); its published limits were not readable on 2026-11-09 (solana.com returned 429 to the fetch).
- In a Container, either the container calls Helius through an outbound handler that adds the key, or the Worker builds the snapshot and posts it in, which lets the container run with `enableInternet = false`.

## Recommendation

- Build the Canary runner as a native Rust binary on `litesvm` and Pipeline's crates (`pipeline-quoter` for quotes, `litesvm` directly for committed buy-then-sell runs), shipped as a linux/amd64 image to a Cloudflare Container on a `basic` instance.
- Drive it from Pipescope's Worker: the indexer queues one job per new strategy version, a Durable Object per strategy version runs it once, and results go to Pipescope's own storage.
- Prefer the Worker building the snapshot and the container running offline, unless the snapshot grows past what a request should carry.
- Keep a small server (Fly.io) as the fallback if Containers misbehave; the binary is the same.

## Not verified here

- A Linux build and a run inside an actual Cloudflare Container: not done, since Containers need the Workers Paid subscription; the image must be linux/amd64, which keeps the x86_64 JIT that was measured here.
- Why `simulate_swap` of the sell fails natively with router error 6002, and whether the deployed router matches `a2d5bfb`.
- Why the router swap fails in 32-bit wasm.
- Whether a quote really costs 160 µs on other strategies; only the example constant-product strategy was measured.
- The public devnet RPC's published rate limits.
