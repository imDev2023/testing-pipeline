# Toolchain

What this project builds, tests and runs Pipeline with, and the steps that work.
Verified on 2026-11-09 against Pipeline commit `a2d5bfb` on the owner's Mac (iMac Pro, Intel Xeon W-2150B, x86_64, 10 cores, 32 GB, macOS 15.7.3), from [Run Pipeline on this Mac and on devnet](https://github.com/imDev2023/testing-pipeline/issues/2).
Build tickets start here.

## Versions

| Tool | Version | Where it lives | Why |
| --- | --- | --- | --- |
| Rust (host) | 1.97.1 | rustup toolchain `1.97.1` | Pipeline's `rust-toolchain.toml` selects it |
| cargo-build-sbf | 4.6.0 | `~/.local/share/testing-pipeline/toolchain/cargo-build-sbf-4.6.0/bin` | sBPF v3 output; Pipeline's CI pins it |
| Platform tools | v1.57 on Intel macOS, v1.58 elsewhere (rustc 1.95.0, clang 22.1.2) | `~/.cache/solana/v1.57` | v1.58, 4.6.0's default, ships no Intel macOS build |
| Agave CLI | 4.4.1 | `~/.local/share/testing-pipeline/toolchain/agave-v4.4.1/bin` | `solana-test-validator` for local runs; Pipeline's docs name 4.4 |
| Node | 24.4.1 (nvm) | `~/.nvm/versions/node/v24.4.1` | Node 26 breaks WebSocket confirmations on public devnet (see Known problems) |
| TypeScript SDK | `@solana/kit` 8.6.0, `@solana-program/token` 0.18.0, `@solana-program/system` 0.16.0, TypeScript 7.0.2 | each package's `node_modules` | from Pipeline's lockfiles |
| LiteSVM | 0.18.2 | Cargo | pinned by `pipeline-quoter` |

The machine's own defaults stay as they were, because the owner's other projects use them:

- Solana CLI 2.2.20 through agave-install's `active_release`, with its cargo-build-sbf 2.2.20 and platform tools v1.48 linked as the rustup toolchain `solana`.
- Default Node 26.9.0 (`~/.local/bin/node`) and default Rust `stable` 1.88.0.

## Install

```sh
bash scripts/install-toolchain.sh      # once per machine; safe to run again
source scripts/toolchain-env.sh        # in every shell (and every agent Bash call) that needs it
```

The install script puts Rust 1.97.1, cargo-build-sbf 4.6.0, the platform tools and the Agave 4.4.1 release side by side under `~/.local/share/testing-pipeline/toolchain` (override with `TESTING_PIPELINE_TOOLCHAIN`).
It checks the Agave tarball against the SHA-256 digest GitHub publishes for the release asset.
The env file puts those first on `PATH` for the current shell only, sets `SBF_TOOLS_VERSION` for this host, and puts Node 24 first when nvm has it.

Two commands from Pipeline's own docs would change every project on the machine, so never run them as written:

- `cargo install cargo-build-sbf --version 4.6.0 --locked` without `--root` puts it in `~/.cargo/bin`, which cargo searches before `PATH`, so every project's `cargo build-sbf` would become 4.6.0.
- `sh -c "$(curl -sSfL https://release.anza.xyz/v4.4.1/install)"` (in Pipeline's `docs/DEVNET.md`) switches agave-install's `active_release`, and with it the `solana` every project uses.

### How the two cargo-build-sbf versions share rustup

On its first run cargo-build-sbf 4.6.0 uninstalls rustup's `solana` toolchain link and links its own, `1.95.0-sbpf-solana-v1.57`.
cargo-build-sbf 2.2.20 only looks at toolchains whose name starts with `solana` and relinks its own when it is missing, and 4.6.0 stops at its own link (which rustup lists first), so after the first run the two leave each other alone.
The install script restores the `solana` link anyway.
Checked by building a small program with 2.2.20, then 4.6.0, then listing the links: both builds passed and both links stayed.

## Build and test Pipeline

Clone Pipeline into a scratchpad, never into this repo, and note the commit.

```sh
git clone https://github.com/MetalLegBob/pipeline.git && cd pipeline && git log -1 --format=%h
source <this repo>/scripts/toolchain-env.sh

(cd programs && cargo build-sbf --tools-version "$SBF_TOOLS_VERSION")
cargo fmt --all -- --check && (cd programs && cargo fmt --all -- --check)
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo clippy --workspace --all-targets -- -D warnings
CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0 cargo test --workspace
(cd sdk/ts && npm ci && npm run build && npm test)
```

Results at `a2d5bfb`:

| Step | Result | Time on this Mac |
| --- | --- | --- |
| `cargo build-sbf` | 5 programs, sBPF v3 (ELF `e_flags` 3): `pipeline.so` 401,816 bytes, `test_strategy_cp.so` 250,792, `test_strategy_evil.so` 92,208, `test_hook_refill.so` 28,360, `test_hook.so` 25,488 | 37 s from clean |
| `cargo fmt --check` | both workspaces clean | seconds |
| `cargo clippy -D warnings` | clean | 38 s after the tests had built |
| `cargo test --workspace` (LiteSVM) | 425 passed, 0 failed, 0 ignored, in 82 test binaries | 399 s from clean, mostly compiling |
| SDK `npm test` | typecheck and Prettier clean; 103 tests passed in 8 files | 2.4 s |

`cargo build-sbf` warns that each program declares both `cdylib` and `lib` crate types, which turns off LTO; that is Pipeline's choice and harmless here.

## Devnet

### Wallet

This project's devnet wallet is `~/.config/testing-pipeline/devnet/wallet.json` (mode 600, directory 700), public key `9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt`.
It is never committed, and this project does not use Top-pad's (Heat's) devnet bank.
Pass it explicitly: `-k ~/.config/testing-pipeline/devnet/wallet.json` to the Solana CLI, `KEYPAIR=...` to Pipeline's scripts.

Funding, as tried on 2026-11-09:

- `solana airdrop` on public devnet and on Helius devnet RPC: rate-limited from the first request.
- `devnet-pow` (installed in `~/.cargo/bin`): every proof-of-work faucet on devnet was empty.
- Alchemy devnet RPC (`https://solana-devnet.g.alchemy.com/v2/$ALCHEMY_API_KEY`, key in the shared env file): 1 SOL per request, then rate-limited for a while; it gave 1 SOL twice, about 45 minutes apart.
- https://faucet.solana.com signed in with GitHub: the way to the 10 to 15 SOL a deploying ticket needs (the owner does this).

### RPC

Public devnet (`https://api.devnet.solana.com`) with Node 24 is what works for Pipeline's scripts.
Devnet now finalizes in about a second: each of the smoke script's six transactions, confirmed at `finalized`, landed one second after the last.

### Smoke swap

```sh
(cd sdk/ts && npm ci && npm run build)
cd scripts/devnet && npm ci
RPC_URL=https://api.devnet.solana.com KEYPAIR=$HOME/.config/testing-pipeline/devnet/wallet.json node smoke.ts
```

Passed with Node 24.4.1 in 6 seconds: two fresh mints, a constant-product market and its fee accounts, liquidity, account resolution, a quote by RPC simulation (1,000,000 A to 1,993,980 B, 4,927 CU), the swap, and all five event checks (output equals the quote, `net_sent` equals the input, fee 2,500 is 0.25% rounded up, the market matches).
Swap signature: [`5GC4aG6oEphMyrLng9bRb2NLqr3NNPKg1e3XezPSypi4fbyj6aqctZwRVCR6Ynz5ejWMjCSNVfs5nMTHxkvxNn3n`](https://explorer.solana.com/tx/5GC4aG6oEphMyrLng9bRb2NLqr3NNPKg1e3XezPSypi4fbyj6aqctZwRVCR6Ynz5ejWMjCSNVfs5nMTHxkvxNn3n?cluster=devnet) (35,478 CU).
A run costs about 0.015 devnet SOL.

### Quoting with pipeline-quoter

`pipeline-quoter` never touches the network, so `scripts/quote-devnet` feeds it from RPC: it lists the router's markets, or fetches one market, its strategy's bytecode, the accounts the trade reads and the clock, resolves the strategy's accounts, then times the first quote and 10,000 warm quotes.
It takes Pipeline's crates from Pipeline's repository at `a2d5bfb` and calls only `Quoter::quote`, never `simulate_swap`, which runs the BSL-licensed router.

```sh
cd scripts/quote-devnet
cargo run --release -- https://api.devnet.solana.com list
cargo run --release -- https://api.devnet.solana.com <MARKET> [AMOUNT] [INPUT_INDEX] [OUTPUT_INDEX]
```

On this Mac, quoting 1,000,000 units of mint 0 into mint 1:

| Market | Strategy | Fetch (RPC) | Load program | Resolve | First quote | Warm quote mean, p50, p99 | Strategy CU |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `35H28SveyPAVr64VHYYZBif8cbhiXyALPghRxFZcVDSz` | constant product `yRptCd...` | 391 ms, 3 calls | 2.1 ms | 2.8 ms | 188 us | 139, 124, 343 us | 4,902 |
| `2u5ep2aLFzp2SACkG5ZLUrAkEY7vCzm2vL56Q6YiQxb9` | outside builder `9mAV3p...` | 410 ms, 4 calls | 8.6 ms | 59 ms (one RPC round) | 457 us | 216, 195, 495 us | 39,826 |

Warm quotes take about 100 to 220 microseconds on this 2017 Xeon, against the 10 to 20 microseconds Pipeline's integrator guide quotes; a market's first quote costs a few hundred milliseconds of RPC, then nothing more while its accounts stay cached.
The same quote by RPC simulation through the TypeScript SDK (`quoteStrategy`) took 21 ms on a warm connection and 229 ms on a cold one, plus 36 to 286 ms to resolve accounts, and several seconds or connect timeouts while public devnet was throttling.
Both ways gave the same output to the unit (6,946,345,550,466 and 1,993,940); the SDK reports about 25 more compute units because it counts the whole simulated transaction.

Of the 44 markets on devnet at 08:45 UTC, quoting 1,000,000 units of mint 0 into mint 1:

| Strategy | Markets | Quote | Do not quote |
| --- | --- | --- | --- |
| Constant product (example) `yRptCd...` | 20 | 18 (6 of them quote 0 out: their pools are so lopsided, such as 763 trillion units of A against 210 million of B, that the input is worth less than one unit out) | 2: `AccountDidNotDeserialize` (3003) on the `pool` account during account resolution |
| Outside builder `9mAV3p...` | 4 | 4 | none |
| Bonding curve `ETrmUe...` | 12 | none | 9 `WrongStatus` (6004, "Not allowed in the curve's current status"), 3 `CannotFill` (6006, "The curve cannot fill that trade") |
| Pool4 `4ajWF6...` | 8 | none | 6 `AccountDidNotDeserialize` (3003) on `pool` during account resolution, 2 `CannotFill` (6006, "The pool cannot fill that trade") |

RPC simulation through the SDK fails the same way, so these are the markets' own states, not the quoter.
`AccountDidNotDeserialize` on `pool` suggests markets created by an older version of the strategy program, whose state the upgraded program can no longer read.

## Local validator

Not yet run: it needs the Agave 4.4.1 CLI, which `scripts/install-toolchain.sh` installs.
Pipeline's `docs/DEVNET.md` gives the command (load the router and the example strategy with `--upgradeable-program`, and pass `--deactivate-feature 6TkHkRmP7JZy1fdM6fg5uXn76wChQBWGokHBJzrLB3mj` because devnet and mainnet do not have SIMD-0268's deeper call limit yet).

## Known problems

- **Node 26 and public devnet WebSockets.**
  Node 26.9.0 opens WebSockets over HTTP/2, which it marks experimental, and against `wss://api.devnet.solana.com` the fifth and every later connection on the same session fails at once (Node 24 opened ten in a row).
  `@solana/kit` opens a connection per `sendAndConfirm`, so Pipeline's smoke script failed with `SolanaError: WebSocket failed to connect` at its sixth transaction, the swap, which had landed anyway.
  Use Node 24 (`scripts/toolchain-env.sh` does) until this is fixed; Helius devnet WebSockets did not show it.
- **Public devnet throttles.**
  Once, Node 24 timed out connecting to `api.devnet.solana.com` mid-run, and sweeping all 44 markets drew HTTP 429s; `quote-devnet` retries 429s with back-off.
- **Helius devnet and the smoke script.**
  With `RPC_URL` and `WS_URL` on Helius devnet, the script sent its first transaction, which landed, and then waited for its confirmation for over ten minutes before it was stopped; not diagnosed, so use public devnet for the script.
- **Platform tools v1.58 has no Intel macOS build**, so on this Mac pass `--tools-version "$SBF_TOOLS_VERSION"` (v1.57) to every `cargo build-sbf`; v1.57 has the same Rust (1.95.0) and builds sBPF v3.
- **Downloads from GitHub are flaky on this network**: `gh` calls hit TLS timeouts and connection resets; retry.
