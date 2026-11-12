# Toolchain

What this project builds, tests and runs Pipeline with, and the steps that work.
Verified on 2026-11-09 against Pipeline commit `a2d5bfb`, and on 2026-11-10 against `5ad130d` (its newest), on the owner's Mac (iMac Pro, Intel Xeon W-2150B, x86_64, 10 cores, 32 GB, macOS 15.7.3), from [Run Pipeline on this Mac and on devnet](https://github.com/imDev2023/testing-pipeline/issues/2).
Build tickets start here.

## Versions

| Tool | Version | Where it lives | Why |
| --- | --- | --- | --- |
| Rust (host) | 1.97.1 | rustup toolchain `1.97.1` | Pipeline's `rust-toolchain.toml` selects it |
| cargo-build-sbf | 4.6.0 | `~/.local/share/testing-pipeline/toolchain/cargo-build-sbf-4.6.0/bin` | sBPF v3 output; Pipeline's CI pins it |
| Platform tools | v1.57 on Intel macOS, v1.58 elsewhere (rustc 1.95.0, clang 22.1.2) | `~/.cache/solana/v1.57` | v1.58, 4.6.0's default and Pipeline's pin, ships no Intel macOS build |
| Agave CLI | 4.4.1 | `~/.local/share/testing-pipeline/toolchain/agave-v4.4.1/bin` | `solana-test-validator` for local runs; Pipeline's docs name 4.4 |
| Node | 24.4.1 (nvm) | `~/.nvm/versions/node/v24.4.1` | Node 26 breaks WebSocket confirmations on public devnet (see Known problems) |
| TypeScript SDK | `@solana/kit` 8.6.0, `@solana-program/token` 0.18.0, `@solana-program/system` 0.16.0, TypeScript 7.0.2 | each package's `node_modules` | from Pipeline's lockfiles |
| LiteSVM | 0.18.2 | Cargo | pinned by `pipeline-quoter` |
| Kani | 0.67.0, with its nightly Rust (`nightly-2025-11-21`) | `~/.local/share/testing-pipeline/toolchain/kani-0.67.0/bin`, `~/.kani/kani-0.67.0` | the bar's maths proofs; Pipeline's CI pins it |
| pnpm | 11.0.8 | Node 24's global packages | the repo's TypeScript workspace (`packageManager` in `package.json`) |
| Z3 | `z3-solver` 5.4.1.0 (Python) | a virtualenv of your choosing | the maths proofs Kani cannot finish (`programs/*/proofs/*_z3.py`) |

The machine's own defaults stay as they were, because the owner's other projects use them:

- Solana CLI 2.2.20 through agave-install's `active_release`, with its cargo-build-sbf 2.2.20 and platform tools v1.48 linked as the rustup toolchain `solana`.
- Default Node 26.9.0 (`~/.local/bin/node`) and default Rust `stable` 1.88.0.

## Install

```sh
bash scripts/install-toolchain.sh      # once per machine; safe to run again
source scripts/toolchain-env.sh        # in every shell (and every agent Bash call) that needs it
```

The install script takes the parts to install, `solana` and `kani`, and installs both when given none; CI installs each part in the job that needs it.

The install script puts Rust 1.97.1, cargo-build-sbf 4.6.0, the platform tools and the Agave 4.4.1 release side by side under `~/.local/share/testing-pipeline/toolchain` (override with `TESTING_PIPELINE_TOOLCHAIN`).
It checks the Agave tarball against the SHA-256 digest GitHub publishes for the release asset.
The env file puts those first on `PATH` for the current shell only, sets `SBF_TOOLS_VERSION` for this host, and puts Node 24 first when nvm has it.
On Intel macOS it also puts a small `cargo-build-sbf` wrapper first (`~/.local/share/testing-pipeline/toolchain/shims`, written by the install script) that adds `--tools-version v1.57` unless the caller passes one.
cargo-build-sbf takes the platform tools version only from that flag or from `[workspace.metadata.solana] tools-version` in the workspace's `Cargo.toml`, which Pipeline pins to v1.58 since `5ad130d`, and Pipeline's own scripts and strategy template call a bare `cargo build-sbf`; without the wrapper they would ask for v1.58, which cannot be installed on this Mac.
The explicit flag wins over the workspace pin: every build at `5ad130d` went through the wrapper on v1.57.
Kani's own files go to `~/.kani/kani-0.67.0`, and its first-time setup adds the nightly Rust it compiles with as a rustup toolchain of its own; neither changes a default.
Kani 0.67.0 has an Intel macOS build, so the proofs run on the owner's Mac as well as in CI: installed there on 2026-11-10.
That setup failed once on this network (a GitHub download timed out, and rustup's self-update check after it), leaving `~/.kani/kani-0.67.0` without its toolchain link; the install script now checks for a working Kani compiler rather than the folder, and running it again finished the setup.
The setup also let rustup update itself, as rustup does by default; no default toolchain changed.

After the owner ran the script on 2026-11-10, `solana --version` outside the env file still printed 2.2.20, agave-install's `active_release` still pointed at 2.2.20, and rustup still had both the `solana` and `1.95.0-sbpf-solana-v1.57` links.

Two commands from Pipeline's own docs would change every project on the machine, so never run them as written:

- `cargo install cargo-build-sbf --version 4.6.0 --locked` without `--root` puts it in `~/.cargo/bin`, which cargo searches before `PATH`, so every project's `cargo build-sbf` would become 4.6.0.
- `sh -c "$(curl -sSfL https://release.anza.xyz/v4.4.1/install)"` (in Pipeline's `docs/DEVNET.md`) switches agave-install's `active_release`, and with it the `solana` every project uses.

### How the two cargo-build-sbf versions share rustup

On its first run cargo-build-sbf 4.6.0 uninstalls rustup's `solana` toolchain link and links its own, `1.95.0-sbpf-solana-v1.57`.
cargo-build-sbf 2.2.20 only looks at toolchains whose name starts with `solana` and relinks its own when it is missing, and 4.6.0 stops at its own link (which rustup lists first), so after the first run the two leave each other alone.
The install script restores the `solana` link anyway.
Checked by building a small program with 2.2.20, then 4.6.0, then listing the links: both builds passed and both links stayed.

## Our on-chain programs

Set up by [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58) on 2026-11-10; every later on-chain ticket builds inside this layout and uses these fixtures, this CI and this local demo run.

### Layout

- `programs/` is the on-chain workspace, laid out as Pipeline lays out its own and licensed Apache-2.0 (`programs/LICENSE`, [ADR 0002](adr/0002-on-chain-source-public-under-apache-2.md)).
  Its `Cargo.toml` holds every pin the bar asks for, in one place: Anchor `=1.2.2`, Pipeline's crates by `rev = "5ad130d"`, the release profile (`overflow-checks`, fat LTO, one codegen unit), `[workspace.metadata.solana] tools-version = "v1.58"` and `[workspace.metadata.cli] solana = "4.3.0"` for `solana-verify`; `rust-toolchain.toml` selects Rust 1.97.1, and `Cargo.lock` is committed.
- `programs/tax-amm` is the tax AMM (crate `tax-amm`), generated by Pipeline's `scripts/new-strategy.sh` from a scratchpad clone at `5ad130d` and owned here from then on: the program in `src/` (`pricing.rs` is the one pricing function; `config.rs` holds the build-time values, the `security.txt` among them), its LiteSVM tests in `tests/`, `metadata.json`, and the demo script in `scripts/`.
  Its Anchor IDL is committed in `idl/` and built by `scripts/build-idl.sh` (`pnpm idl`, with anchor-cli 1.2 from avm; `Anchor.toml` exists only for that), and its TypeScript client in `scripts/client/` is generated from the IDL with Codama (`pnpm client`); since [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59) on 2026-11-12, tests fail when the IDL disagrees with the program and `pnpm typecheck` when the client disagrees with the IDL.
  Its program id is `J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t`; nothing of it is deployed or registered on devnet before [its devnet ticket](https://github.com/imDev2023/testing-pipeline/issues/66).
- `programs/mint-rules` is a library crate, not a program: the mint extension allowlist and its check, which the programs depend on ([`tax-amm.md`](spec/tax-amm.md), "Where its policy values live").
  The scripts that build, deploy or load programs take only the workspace members that build a `cdylib` (`scripts/workspace-programs.py`).
- `programs/buy-wall-amm` is the buy wall AMM (crate `buy-wall-amm`), generated the same way by `scripts/new-strategy.sh` from a scratchpad clone at `5ad130d` by [Buy wall AMM: a market opens](https://github.com/imDev2023/testing-pipeline/issues/47) and owned here: the program in `src/` (the market state's fixed layout in `state.rs`, the seed's maths in `opening.rs`, the build-time values and the `security.txt` in `config.rs`), its LiteSVM tests and invariant fuzzer in `tests/`, its Z3 proofs in `proofs/`, `metadata.json`, and the demo script in `scripts/`.
  Its IDL (`idl/`) and generated client (`scripts/client/`) are built as the tax AMM's are (`pnpm idl`, `pnpm client`), and `tests/idl.rs` also checks the IDL's market state against the spec's byte offset table.
  Its program id is `BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6`; nothing of it is deployed or registered on devnet before [its devnet ticket](https://github.com/imDev2023/testing-pipeline/issues/56).
- `fixtures/` holds what scripts fetch or build; only `fixtures/pins.env` is committed.
- TypeScript is one pnpm workspace at the repo root (`package.json`, `pnpm-workspace.yaml`): each program's `scripts/` now, Aviary's apps and packages when they are built.

### Keys

All under `~/.config/testing-pipeline/devnet/` (directory 700, files 600), never committed; `scripts/check-no-keypairs.sh` refuses any keypair in the repo.

| Key | File | Public key | Role |
| --- | --- | --- | --- |
| Devnet wallet | `wallet.json` | `9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt` | Pays for deploys and the demo's transactions |
| Upgrade authority | `upgrade-authority.json` | `Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe` | Every program's upgrade authority; signs `register_strategy` and pays its listing fee (bar, "Upgrade authority") |
| Suite treasury | `suite-treasury.json` | `CbqE9TtDJf67xFnXybBrzV6Tg4Mw71hX2VhWcm4R9VZF` | Receives the suite share (`SUITE_TREASURY`, [`tax-amm.md`](spec/tax-amm.md), "Constants") |
| Tax AMM program | `tax-amm.json` | `J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t` | The program's address, for its first devnet deploy |
| Buy wall AMM program | `buy-wall-amm.json` | `BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6` | The program's address, for its first devnet deploy |

Each program keypair was passed to `new-strategy.sh`, so nothing went into `~/.config/pipeline/keys/`.
`cargo build-sbf` also writes a `programs/target/deploy/<program>-keypair.json` (`tax_amm-keypair.json`, `buy_wall_amm-keypair.json`), which is not the program's key and is gitignored; deploy with `--program-id ~/.config/testing-pipeline/devnet/<program>.json`.

### Fixtures

- `scripts/fetch-router.sh` copies devnet's router into `fixtures/router/pipeline.so`, with its config account in `fixtures/router/config.json`, and refuses the dump unless its SHA-256 equals `ROUTER_SHA256` in `fixtures/pins.env` (`57a93bba…be6c`, the router deployed in slot 520,510,501 on 2026-11-09).
  A copy already in place that no longer matches the pin is removed; a refused dump never replaces the pinned copy.
  When the devnet router is upgraded the script fails, and a PR of its own re-pins it after the tests pass against the new bytes (bar, "Test layers").
  `scripts/test-fetch-router.sh` tests this without the network.
- `scripts/fetch-pipeline.sh [sdk] [programs]` clones Pipeline into `fixtures/pipeline/` at the `rev` `programs/Cargo.toml` pins (its one source) and builds the TypeScript SDK, which is not on npm and which the demo scripts link to, and Pipeline's test programs (`test-hook`, `test-hook-refill`, `test-strategy-cp`, `test-strategy-evil`) for hostile tests; never the router, whose source is BSL 1.1.
  Nothing of it is copied into the repo.

### Build and test

From a fresh shell at the repo root, after `scripts/install-toolchain.sh`:

```sh
source scripts/toolchain-env.sh
scripts/fetch-router.sh                  # devnet's router, checked against its pinned hash
scripts/fetch-pipeline.sh                # Pipeline's SDK and test programs, at the pinned commit
scripts/build-programs.sh                # each program by its own manifest, into programs/target/deploy
cd programs
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                   # LiteSVM through devnet's router, with pipeline-check
cargo kani --workspace -j --output-format=terse   # the maths proofs' default tiers; -j needs terse output
cd ..
for p in programs/*/proofs/*_z3.py; do python "$p"; done   # the Z3 proofs, with z3-solver installed
pnpm install && pnpm typecheck           # the TypeScript workspace
scripts/test-fetch-router.sh && scripts/test-check-no-keypairs.sh && scripts/check-no-keypairs.sh
```

On 2026-11-10 on the owner's Mac, from warm caches, everything above but Kani took 49 seconds in a fresh shell: the router matched its pin, Pipeline built at `5ad130d69e9e`, formatting and clippy were clean, and the tests passed: 3 unit tests of the pricing, the `security.txt` test and the template's 4 LiteSVM tests through devnet's router, on whose markets `pipeline-check` reported 14 pass, 0 warn and 0 fail.
On 2026-11-12, with seeding and trading, `cargo test --workspace` took 66 seconds from warm caches, 31 of them the property tests.
From cold, the SBF build took 53 seconds, the test build 60 seconds and `fetch-pipeline.sh` 2 minutes 22 seconds.
`cargo kani --workspace -j --output-format=terse` proves the tax AMM's constant-product curve in two harnesses run in parallel (`programs/tax-amm/src/pricing.rs`): `curve_out` never panics or overflows for any real and virtual reserves and amount (61 checks, 9 seconds), and it never pays out a whole output side while the input side holds anything, and buys nothing with zero input, with both sides and the amount below 16 (80 checks, 11 seconds); 80 seconds in all on this Mac on 2026-11-12, most of it compiling.
Each proof fails when its property is broken: with the zero-denominator guard removed, or the `effective_in > 0` condition dropped from the assertion, Kani finds the counterexample (checked on 2026-11-12).
They replaced the template's proofs of `out_given_in` (85 and 108 seconds), which left with its pool fee in [Tax AMM: seed a market and trade it](https://github.com/imDev2023/testing-pipeline/issues/60); the taxed pricing and the split are proved in [Tax AMM: proofs of the pricing, tax and split maths](https://github.com/imDev2023/testing-pipeline/issues/64), and Proptest checks them meanwhile (`programs/tax-amm/tests/maths.rs`, 10,000 cases a property, about 30 seconds in a debug build).
`in_given_out`, the template's exact-out maths, left with [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59) on 2026-11-12, because the tax AMM refuses exact-out; its no-panic proof, which passed before it left, took 14.5 minutes.

### Local demo run

The demo script, grown from the template's `deploy-devnet.ts`, takes the cluster and the keys as arguments and refuses any cluster other than devnet or a local validator.
It registers the strategy signed by the upgrade authority, creates two test tokens, computes the router's market and fee accounts and the tax AMM's vaults before sending anything, creates a tax market from the metadata's `init` form with a fee account for each mint and the metadata's `seed` action in one transaction, and stops unless every computed address exists afterwards and the market state, read with the generated client, holds exactly the parameters sent, open and holding the seed.
Then it buys and sells through the router with Pipeline's SDK, each swap with its quote as the minimum, and stops unless each delivered its quote, the quote is the spec's price, and the market state's reserves, owed amounts and counters equal the script's own calculation from the spec's formulas (`spec-model.ts`), to the unit.
It quotes at `confirmed`, the commitment it confirms at, since the SDK's default, `finalized`, trails a fresh local validator by about 32 slots and would quote a market that does not exist yet, or one before the last swap.
On a local validator it airdrops what the payer and the upgrade authority need; on devnet it never does.

`scripts/local-validator.sh` runs `solana-test-validator` from an empty ledger in `fixtures/test-ledger` with devnet's router (the pinned fixture bytes, and its config account as devnet has it, so the 0.01 SOL listing fee and its recipient are devnet's) and every program of the workspace from `programs/target/deploy`, at its `declare_id!` address and upgradeable by the upgrade authority, as on devnet.
It switches off SIMD-0268, as above.

```sh
source scripts/toolchain-env.sh
scripts/local-validator.sh               # stays in the foreground; agents start it with run_in_background and stop it with TaskStop
```

Then, in another shell:

```sh
source scripts/toolchain-env.sh
cd programs/tax-amm/scripts
pnpm demo --cluster localnet \
  --payer ~/.config/testing-pipeline/devnet/wallet.json \
  --upgrade-authority ~/.config/testing-pipeline/devnet/upgrade-authority.json
```

Passed on 2026-11-12 with `solana-test-validator` 4.4.1 and Node 24.4.1, in 6 seconds, by [seed a market and trade it](https://github.com/imDev2023/testing-pipeline/issues/60): the strategy registered; the tax market created and seeded with both fee accounts in one version 0 transaction of 1,212 bytes; all fourteen creation parameters read back as sent; a buy of 1,000,000,000 of token B quoted and delivered 482,900,432 of token A, with a buy tax of 30,000,000, and a sell of 300,000 of token A quoted and delivered 575,252 of token B, with a sell tax of 30,277; and the reserves, the six owed amounts, `tax_collected` (30,030,277), both volumes and `swap_count` equal to the spec's formulas.
Earlier the same day, before the seed and trading, it passed in 19 seconds.
The template's demo, before the tax AMM replaced its pool, passed on 2026-11-10, twice, the second time from fresh shells following these steps, in 8 seconds each.
The upgrade authority registered the strategy and paid the 0.01 SOL listing fee and the strategy account's rent (its balance went from 1 to 0.987 SOL); the market was created with both fee accounts in one transaction; 100,000,000,000 of token A and 200,000,000,000 of token B went in through `deposit`; and 1,000,000 of token A quoted at 1,993,980 of token B (4,876 compute units), which the router's swap delivered exactly, with Pipeline's fee of 2,500.
In the swap the router invoked the strategy, which used 8,683 of the swap's 39,862 compute units.
The demo confirms at `confirmed`, so a local run takes seconds where Pipeline's smoke script, which waits for `finalized`, takes two minutes.
Until this repo's `main` has the metadata, step 2 warns that the published copy at the default URI is not there yet, which changes nothing locally.

The buy wall AMM's demo (`programs/buy-wall-amm/scripts/demo.ts`) takes the same arguments, on the same validator:

```sh
cd programs/buy-wall-amm/scripts
pnpm demo --cluster localnet \
  --payer ~/.config/testing-pipeline/devnet/wallet.json \
  --upgrade-authority ~/.config/testing-pipeline/devnet/upgrade-authority.json
```

It registers the strategy, creates a test token with its mint authority removed and wraps the seed's SOL, then in one transaction creates the market from the metadata's `init` form, adds both fee accounts and seeds it through the metadata's `seed` action; it reads the market back through the router's record and the generated client, and checks a quote is refused, as it is until trading is built.
Passed on 2026-11-12 from a fresh validator in 5 seconds: the transaction was 1,091 bytes of the 1,232 allowed, and the worked example's seed opened at `sqrt_price` 1,844,674,407,370,955,161, `liquidity` 99,999,999,999 and cap 1,000,000,000,000, the token at index 0 and wrapped SOL at index 1, with the quote refused with `TradingNotAvailable`.

### CI

`.github/workflows/ci.yml`, on every pull request and every push to `main`:

| Job | Runs | Does |
| --- | --- | --- |
| `changes` | always | Decides whether on-chain code changed: `programs/`, `fixtures/pins.env`, the scripts that install, fetch, build or run it, the pnpm workspace files or the workflow |
| `no keypairs` | always | `scripts/test-check-no-keypairs.sh`, then `scripts/check-no-keypairs.sh` |
| `rust` | on-chain changes | The toolchain from `scripts/install-toolchain.sh solana`, the router fixture's test and fetch, `cargo fmt --check`, each program's SBF build by its manifest, clippy with `-D warnings`, the tests |
| `typescript` | on-chain changes | Pipeline's SDK from `scripts/fetch-pipeline.sh sdk`, `pnpm install --frozen-lockfile`, `pnpm typecheck` |
| `kani` | on-chain changes | Every program's Z3 proofs (`programs/*/proofs/*_z3.py`, with `z3-solver` 5.4.1.0), then Kani from `scripts/install-toolchain.sh kani` and `cargo kani --workspace -j --output-format=terse` |
| `gate` | always | Passes only if `changes` and `no keypairs` passed and, when on-chain code changed, every heavy job passed too; when none changed, they must have been skipped |

`gate` is the one check `main` requires, so a pull request that touches no on-chain code still gets a passing result in a minute.
`scripts/github-settings.sh` makes it required, through a repository ruleset that admins may bypass (so a history rewrite can still be force-pushed), and switches on private vulnerability reporting, which every program's `security.txt` names as its contact.
Both settings need the repository public on GitHub Free, so the owner runs `bash scripts/github-settings.sh` once it is.

The first run, on [the PR that added CI](https://github.com/imDev2023/testing-pipeline/pull/102) on 2026-11-12, took 9 minutes from cold caches: `rust` 9 minutes (2 minutes 13 seconds of it compiling cargo-build-sbf, then the SBF build in 44 seconds, clippy in 64 seconds and the test build in 49 seconds), `kani` 3 minutes with Kani's install, `typescript` 28 seconds, and `changes`, `no keypairs` and `gate` a few seconds each.

### Review skills

Stronghold of Security and Book of Knowledge, from MetalLegBob's MIT-licensed [Solana Vibes Kit](https://github.com/MetalLegBob/solana-vibes-kit), are in `.claude/skills/` (commands `/SOS:*` and `/BOK:*` in `.claude/commands/`) at commit `969c43d`, the newest on 2026-11-10.
`scripts/install-review-skills.sh` copies exactly what each skill's own installer copies, without running the kit's code and without the `svk-meta.json` that would make the skills check for updates; it is also how the pin moves.

## Build and test Pipeline

Clone Pipeline into a scratchpad, never into this repo, and note the commit.

These are the steps of Pipeline's CI at `5ad130d` (at `a2d5bfb`, before `scripts/build-programs.sh` and the strategy template existed, the programs were built with one `(cd programs && cargo build-sbf)`):

```sh
git clone https://github.com/MetalLegBob/pipeline.git && cd pipeline && git log -1 --format=%h
source <this repo>/scripts/toolchain-env.sh
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0

scripts/build-programs.sh            # each program on its own, as solana-verify builds them
cargo fmt --all -- --check && (cd programs && cargo fmt --all -- --check)
cargo test --workspace               # LiteSVM
cargo clippy --workspace --all-targets -- -D warnings
scripts/test-template.sh             # builds and tests templates/strategy against these sources
scripts/test-new-strategy.sh
(cd sdk/ts && npm ci && npm run build && npm test)
(cd templates/strategy/scripts && npm ci && npm run typecheck)
```

| Step | `a2d5bfb` (2026-11-09) | `5ad130d` (2026-11-10) |
| --- | --- | --- |
| Build the programs | 5 programs, sBPF v3 (ELF `e_flags` 3): `pipeline.so` 401,816 bytes, `test_strategy_cp.so` 250,792, `test_strategy_evil.so` 92,208, `test_hook_refill.so` 28,360, `test_hook.so` 25,488; 37 s from clean | the same 5, one at a time: `pipeline.so` 402,544, `test_strategy_cp.so` 250,312, the rest unchanged; 52 s |
| `cargo fmt --check` | both workspaces clean | both workspaces clean |
| `cargo test --workspace` | 425 passed, 0 failed, 0 ignored, in 82 test binaries; 399 s from clean, mostly compiling | 464 passed, 0 failed, 1 ignored (a doc example in `pipeline-check`), in 94 test binaries; 226 s on top of the earlier build |
| `cargo clippy -D warnings` | clean, 38 s | clean, 17 s |
| Strategy template, generator | did not exist | template built and its 4 tests passed (including one that runs `pipeline-check` on a Token-2022 transfer-fee market), 144 s; generator checks passed |
| TypeScript | SDK: typecheck and Prettier clean, 103 tests in 8 files, 2.4 s | SDK: 248 tests in 14 files, 13 s with `npm ci`; template scripts typecheck clean |

`cargo build-sbf` warns that each program declares both `cdylib` and `lib` crate types, which turns off LTO; that is Pipeline's choice and harmless here.

### Pipeline after `a2d5bfb`

Three commits on 2026-11-09 between 20:18 and 22:21 UTC added pieces that overlap this project's products:

- `crates/pipeline-check`, a conformance checker that quotes and trades a market through the real router in LiteSVM, from a strategy's own tests or against a deployed market (`pipeline-check --url devnet --market <MARKET>`), reporting Pass, Warn, Fail or Skip per check.
- Trust facts and a metadata standard in `pipeline-client` (`facts.rs`, `metadata.rs`).
- A strategy template (`templates/strategy`, `scripts/new-strategy.sh`) and reproducible builds with `solana-verify` (`docs/VERIFICATION.md`); `pipeline-strategy-interface` moved from `crates/` to `programs/`.
- A hosted devnet API, `https://pipeline-devnet.up.railway.app` (`docs/API.md`): strategies and markets with trust flags, quotes, unsigned swap transactions, trades, candles and a live event stream, with no keys and per-IP limits.

Devnet's router was redeployed at 21:00 UTC that day (slot 520,510,501).
Its bytes differ from both local builds, which proves nothing: Pipeline's `docs/VERIFICATION.md` says macOS builds differ from Linux ones and makes the Docker build the reference.
Checking which commit devnet runs needs `solana-verify` 0.5.2 or later (this Mac has 0.4.9 in `~/.avm/bin`) and Docker Desktop running; not done yet.
`scripts/quote-devnet` stays pinned to `a2d5bfb`'s crates, where its timings were measured.

## Devnet

### Wallet

This project's devnet wallet is `~/.config/testing-pipeline/devnet/wallet.json` (mode 600, directory 700), public key `9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt`.
It is never committed, and this project does not use Top-pad's (Heat's) devnet bank.
Pass it explicitly: `-k ~/.config/testing-pipeline/devnet/wallet.json` to the Solana CLI, `KEYPAIR=...` to Pipeline's scripts.

Fund it from the CLI, never through a web faucet (owner, 2026-11-10), with the owner's machine-wide `devnet-airdrop` (in `~/.local/bin`, not in this repo), started in the background:

```sh
devnet-airdrop ~/.config/testing-pipeline/devnet/wallet.json --target 12
```

It pulls 1 SOL per request from Alchemy's devnet RPC (key `ALCHEMY_API_KEY` in the shared env file; free tier, so not a paid call), a few per burst, and repeats every 15 minutes until the target.
That is how this wallet went from 1.94 to 12.94 SOL on 2026-11-10: eleven 1 SOL airdrops from Alchemy between 01:25 and 02:18 UTC, two or three per round.
What did not work, on 2026-11-09 and 2026-11-10:

- `solana airdrop` on public devnet: rate-limited from the first request, and now closed (HTTP 410).
- Helius devnet RPC's airdrop: rate-limited, then HTTP 500.
- `devnet-pow` (installed in `~/.cargo/bin`): every proof-of-work faucet on devnet was empty.

Spend devnet SOL only on real devnet transactions and deployments; local runs use `solana-test-validator` or LiteSVM, where SOL is free.

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

Pipeline's `docs/DEVNET.md` gives the command, adapted here to this project's wallet (the programs' upgrade authority, so the script initialises the router's config and registers the example strategy itself) and a ledger outside the clone:

```sh
source <this repo>/scripts/toolchain-env.sh
ME=$(solana-keygen pubkey ~/.config/testing-pipeline/devnet/wallet.json)
solana-test-validator --reset --ledger <scratchpad>/test-ledger \
  --deactivate-feature 6TkHkRmP7JZy1fdM6fg5uXn76wChQBWGokHBJzrLB3mj \
  --upgradeable-program PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34 programs/target/deploy/pipeline.so $ME \
  --upgradeable-program yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx programs/target/deploy/test_strategy_cp.so $ME
# in another shell (agents: start the validator with run_in_background, stop it with TaskStop)
solana -u localhost airdrop 100 $ME
cd scripts/devnet && RPC_URL=http://127.0.0.1:8899 KEYPAIR=~/.config/testing-pipeline/devnet/wallet.json node smoke.ts
```

`--deactivate-feature` switches off SIMD-0268's deeper call limit, which test validators turn on by default but devnet and mainnet do not have yet.

Passed on 2026-11-10 with `solana-test-validator` 4.4.1 and Node 24.4.1, in 126 seconds: config initialised (listing fee 0.01 SOL), strategy registered, market created and funded, quote 1,000,000 A to 1,993,980 B (4,929 CU), the swap (35,488 CU, fee 2,500) and all five event checks.
It is slower than devnet because the script confirms every transaction at `finalized`, which a fresh local validator reaches only after about 32 slots of 400 ms each.
Two things to know:

- The first airdrop, sent seconds after the validator came up, failed with "airdrop request failed"; the same request a few seconds later, and every one after it, went through.
- With a ledger path longer than macOS's 104-character socket limit (any scratchpad path), the validator logs `Unable to start admin rpc service: path must be shorter than SUN_LEN` and its terminal dashboard repeats `admin.rpc does not exist`; RPC, the faucet and the programs work regardless, so it is noise.

## Known problems

- **Node 26 and public devnet WebSockets.**
  Node 26.9.0 opens WebSockets over HTTP/2, which it marks experimental, and against `wss://api.devnet.solana.com` the fifth and every later connection on the same session fails at once (Node 24 opened ten in a row).
  `@solana/kit` opens a connection per `sendAndConfirm`, so Pipeline's smoke script failed with `SolanaError: WebSocket failed to connect` at its sixth transaction, the swap, which had landed anyway.
  Use Node 24 (`scripts/toolchain-env.sh` does) until this is fixed; Helius devnet WebSockets did not show it.
- **Public devnet throttles.**
  Once, Node 24 timed out connecting to `api.devnet.solana.com` mid-run, and sweeping all 44 markets drew HTTP 429s; `quote-devnet` retries 429s with back-off.
- **Helius devnet and the smoke script.**
  With `RPC_URL` and `WS_URL` on Helius devnet, the script sent its first transaction, which landed, and then waited for its confirmation for over ten minutes before it was stopped; not diagnosed, so use public devnet for the script.
- **Platform tools v1.58 has no Intel macOS build**, so on this Mac `cargo build-sbf` must run on v1.57, which has the same Rust (1.95.0) and builds sBPF v3; the wrapper `toolchain-env.sh` puts first does this (see Install).
- **Downloads from GitHub are flaky on this network**: `gh` calls hit TLS timeouts and connection resets; retry.
- **`Invalid syscall code 131074`.**
  `cargo build-sbf` 4.6.0 on platform tools v1.57 prints `WARN cargo_build_sbf::post_processing] Invalid syscall code 131074` for every Anchor program built here, Pipeline's own `test-strategy-cp` included (its native `test-hook` does not print it).
  CI's Linux build on platform tools v1.58 does not print it, so it belongs to v1.57, which only the owner's Intel Mac uses.
  The programs load and run in LiteSVM and on the local validator, through devnet's router, so it is noise from the toolchain, not a fault of a program.
