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
| solana-verify | 0.5.2 | `~/.local/share/testing-pipeline/toolchain/solana-verify-0.5.2/bin` | Docker verified builds for devnet deploys; the bar asks 0.5.2 or later, and the machine's own is 0.4.9 |
| Z3 | `z3-solver` 5.4.1.0 (Python) | a virtualenv of your choosing | the maths proofs Kani cannot finish (`programs/*/proofs/*_z3.py`) |

The machine's own defaults stay as they were, because the owner's other projects use them:

- Solana CLI 2.2.20 through agave-install's `active_release`, with its cargo-build-sbf 2.2.20 and platform tools v1.48 linked as the rustup toolchain `solana`.
- Default Node 26.9.0 (`~/.local/bin/node`) and default Rust `stable` 1.88.0.

## Install

```sh
bash scripts/install-toolchain.sh      # once per machine; safe to run again
source scripts/toolchain-env.sh        # in every shell (and every agent Bash call) that needs it
```

The install script takes the parts to install, `solana`, `kani` and `verify`, and installs the first two when given none; CI installs each part in the job that needs it, and never `verify`, solana-verify for devnet deploys ("Deploy to devnet").

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
  Its `Cargo.toml` holds every pin the bar asks for, in one place: Anchor `=1.2.2`, Pipeline's crates by `rev = "48a6b5f"` (Pipeline 0.3.0, since 2026-11-22; `3fd85ce` from 2026-11-19 and `5ad130d` before, "Pipeline 0.2" and "Pipeline 0.3"), the release profile (`overflow-checks`, fat LTO, one codegen unit), `[workspace.metadata.solana] tools-version = "v1.58"` and `[workspace.metadata.cli] solana = "4.3.0"` for `solana-verify`; `rust-toolchain.toml` selects Rust 1.97.1, and `Cargo.lock` is committed.
- `programs/tax-amm` is the tax AMM (crate `tax-amm`), generated by Pipeline's `scripts/new-strategy.sh` from a scratchpad clone at `5ad130d` and owned here from then on: the program in `src/` (`pricing.rs` is the one pricing function; `config.rs` holds the build-time values, the `security.txt` among them), its LiteSVM tests in `tests/` (the invariant fuzzer in `tests/fuzz.rs`, on the harness in `tests/common/fuzz/`, and the compute ceilings in `tests/common/ceilings.rs`), `metadata.json`, and the demo script in `scripts/`.
  Its Anchor IDL is committed in `idl/` and built by `scripts/build-idl.sh` (`pnpm idl`, with anchor-cli 1.2 from avm; `Anchor.toml` exists only for that), and its TypeScript client in `scripts/client/` is generated from the IDL with Codama (`pnpm client`); since [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59) on 2026-11-12, tests fail when the IDL disagrees with the program and `pnpm typecheck` when the client disagrees with the IDL.
  Its program id is `J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t`, deployed on devnet since 2026-11-20 by [its devnet ticket](https://github.com/imDev2023/testing-pipeline/issues/66) from `274038e`, registered with the router, its deploy recorded in `deployments/devnet.json` and its demo market `C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w`, with every signature, in `deployments/devnet-demo-tax-amm.json`; a redeploy repeats all three steps of "Deploy to devnet": `scripts/deploy-devnet.sh tax-amm` from a clean checkout of `main` upgrades it and records the new commit, then the report and the metadata are taken and pinned again and `--register-only` points the router at them.
- `programs/containment-hook` is the containment hook (crate `containment-hook`), a Token-2022 transfer hook started from Pipeline's `test-hook` by [Containment hook: bind a token to its home market](https://github.com/imDev2023/testing-pipeline/issues/68) on 2026-11-12: the program in `src/` (`config.rs` holds its build-time values and its `security.txt`, `terms.rs` the deadline rule and the unlock rule with their Proptest and Kani proofs), its LiteSVM tests in `tests/`, which share the tax AMM's test support (`tax-amm/tests/common`; the invariant fuzzer in `tests/fuzz.rs` on `tests/support/fuzz.rs`, and the compute ceilings in `tests/support/ceilings.rs`), its IDL in `idl/`, and in `scripts/` its Codama client and `launch.ts`, the launch script.
  It depends on the tax AMM's crate (with `no-entrypoint`) for the tax AMM's program id and market state offsets, so neither is written twice.
  Its program id is `aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv`; nothing of it is deployed on devnet before [its devnet ticket](https://github.com/imDev2023/testing-pipeline/issues/73).
  Its tests that need a second strategy load Pipeline's `test-strategy-cp`, so `scripts/fetch-pipeline.sh programs` comes before `cargo test`.
- `programs/mint-rules` is a library crate, not a program: the mint extension allowlist and its check, which the programs depend on ([`tax-amm.md`](spec/tax-amm.md), "Where its policy values live").
  The scripts that build, deploy or load programs take only the workspace members that build a `cdylib` (`scripts/workspace-programs.py`).
- `programs/buy-wall-amm` is the buy wall AMM (crate `buy-wall-amm`), generated the same way by `scripts/new-strategy.sh` from a scratchpad clone at `5ad130d` by [Buy wall AMM: a market opens](https://github.com/imDev2023/testing-pipeline/issues/47) and owned here: the program in `src/` (the market state's fixed layout in `state.rs`, the seed's maths in `opening.rs`, the build-time values and the `security.txt` in `config.rs`), its LiteSVM tests and invariant fuzzer in `tests/`, its Z3 proofs in `proofs/`, `metadata.json`, and the demo script in `scripts/`.
  Its IDL (`idl/`) and generated client (`scripts/client/`) are built as the tax AMM's are (`pnpm idl`, `pnpm client`), and `tests/idl.rs` also checks the IDL's market state against the spec's byte offset table.
  Its program id is `BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6`; nothing of it is deployed or registered on devnet before [its devnet ticket](https://github.com/imDev2023/testing-pipeline/issues/56).
- `programs/lending-amm` is the lending AMM (crate `lending-amm`), generated the same way by [Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78) on 2026-11-12, from a scratchpad clone at `5ad130d`, laid out as the tax AMM is: the program in `src/` (`config.rs` holds every constant and the per-cluster `LENT_MINTS`, `pricing.rs` and `shares.rs` the maths), its LiteSVM tests and invariant fuzzer in `tests/`, its Z3 proofs in `proofs/` (run as the buy wall AMM's are), `metadata.json`, the IDL in `idl/`, and the demo script and generated client in `scripts/`.
  It is built for one cluster by the feature `devnet` (the default) or `mainnet` (`--no-default-features --features mainnet`); its program id is `Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG`, and nothing of it is deployed or registered on devnet before [its devnet ticket](https://github.com/imDev2023/testing-pipeline/issues/87).
  Its release gate is `programs/lending-amm/gate` ("The lending AMM's release gate" below), and its `README.md` is what the metadata's `links.docs` names.
- `programs/test-programs/` holds test-only programs, never deployed to devnet: `stand-in-launchpad` (crate `stand-in-launchpad`, program id `StandinLaunchpad111111111111111111111111111`, whose keypair nobody holds), a launchpad that graduates two escrowed mints into any strategy through `pipeline_seed_liquidity` with its seeder PDA `["seeder", creator]` signing and a payer PDA it funds with a bounded amount of SOL, built by [Tax AMM: seeding from another program](https://github.com/imDev2023/testing-pipeline/issues/63) for every strategy's seeding tests.
  Each is a workspace member marked `[package.metadata.testing-pipeline] test-program = true`, so fmt, clippy and the pins cover it, while `scripts/workspace-programs.py` leaves it out of the deployable programs (`--test-programs` lists only these), `scripts/build-programs.sh` builds it into `fixtures/test-programs`, and no deploy script names it.
  The tax AMM's test support drives it from Rust (`tax-amm/tests/common/launchpad.rs`), and the demo from TypeScript (`tax-amm/scripts/launchpad.ts`).
- `crates/` is Aviary's native Rust, a Cargo workspace of its own apart from `programs/` (Rust 1.97.1 by its own `rust-toolchain.toml`), so nothing in it can change a program's bytes.
  Its one crate, `crates/canary`, is the Canary checks' binary, on Pipeline's crates from crates.io at exact versions; how to build, run and test it is `crates/canary/README.md`.
  Its tests load the same fixtures as the programs' (`fetch-router.sh`, `fetch-pipeline.sh programs`).
- `fixtures/` holds what scripts fetch or build; only `fixtures/pins.env` is committed.
- TypeScript is one pnpm workspace at the repo root (`package.json`, `pnpm-workspace.yaml`): each program's `scripts/`, the shared packages in `packages/` (`strategy-actions`, which validates and builds the custom actions our strategies describe under `aviary_actions`, `BAR-41`), and Aviary's apps when they are built.

### Keys

All under `~/.config/testing-pipeline/devnet/` (directory 700, files 600), never committed; `scripts/check-no-keypairs.sh` refuses any keypair in the repo.

| Key | File | Public key | Role |
| --- | --- | --- | --- |
| Devnet wallet | `wallet.json` | `9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt` | Pays for deploys and the demo's transactions |
| Upgrade authority | `upgrade-authority.json` | `Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe` | Every program's upgrade authority; signs `register_strategy` and pays its listing fee (bar, "Upgrade authority") |
| Suite treasury | `suite-treasury.json` | `CbqE9TtDJf67xFnXybBrzV6Tg4Mw71hX2VhWcm4R9VZF` | Receives the suite share (`SUITE_TREASURY`, [`tax-amm.md`](spec/tax-amm.md), "Constants") |
| Tax AMM program | `tax-amm.json` | `J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t` | The program's address, for its first devnet deploy |
| Buy wall AMM program | `buy-wall-amm.json` | `BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6` | The program's address, for its first devnet deploy |
| Containment hook program | `containment-hook.json` | `aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv` | The hook's address, for its first devnet deploy |
| Lending AMM program | `lending-amm.json` | `Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG` | The program's address, for its first devnet deploy |

Each program keypair was passed to `new-strategy.sh`, so nothing went into `~/.config/pipeline/keys/`.
`cargo build-sbf` also writes a `programs/target/deploy/<program>-keypair.json` (`tax_amm-keypair.json`, `buy_wall_amm-keypair.json`), which is not the program's key and is gitignored; deploy with `--program-id ~/.config/testing-pipeline/devnet/<program>.json`.

### Fixtures

- `scripts/fetch-router.sh` copies devnet's router into `fixtures/router/pipeline.so`, with its config account in `fixtures/router/config.json`, and refuses the dump unless its SHA-256 equals `ROUTER_SHA256` in `fixtures/pins.env` (`17407a0d…3dca`, the router deployed in slot 524,761,925 on 2026-11-21, Pipeline's `48a6b5f`, Release 0.3.0; until 2026-11-22 `6a516360…3eec`, deployed in slot 523,772,247 on 2026-11-18, Pipeline's `3fd85ce`; until 2026-11-19 `57a93bba…be6c`, deployed in slot 520,510,501 on 2026-11-09).
  A copy already in place that no longer matches the pin is removed; a refused dump never replaces the pinned copy.
  When the devnet router is upgraded the script fails with exit status 3 (1 when the router could not be downloaded at all), and a PR of its own re-pins it after the tests pass against the new bytes (bar, "Test layers").
  `scripts/test-fetch-router.sh` tests this without the network.
- The daily router pin check, `.github/workflows/router-pin.yml` (`BAR-43`), runs `scripts/fetch-router.sh` at 06:17 UTC every day, on demand (`gh workflow run router-pin.yml`), and on a PR that changes it, the script or the pins.
  It installs only the Agave CLI (`scripts/install-toolchain.sh agave`), writes the dump's outcome to the run's summary, and when the router no longer matches the pin fails and runs `scripts/report-router-pin.sh`, which opens an issue titled "Devnet's Pipeline router no longer matches the pin" or comments on the one already open; a failed download fails the run without an issue, and a PR's run never opens one.
  `scripts/test-report-router-pin.sh` tests the reporting without the network, and the job runs both scripts' tests before the dump.
- `scripts/fetch-pipeline.sh [sdk] [programs]` clones Pipeline into `fixtures/pipeline/` at the `rev` `programs/Cargo.toml` pins (its one source) and builds the TypeScript SDK, which is not on npm and which the demo scripts link to, and Pipeline's test programs (`test-hook`, `test-hook-refill`, `test-strategy-cp`, `test-strategy-evil`) for hostile tests; never the router, whose source is BSL 1.1.
  Nothing of it is copied into the repo.
  The lending AMM's tests load the `test-hook` built here for their hooked-mint cases.
- `programs/lending-amm/scripts/fetch-klend.sh` copies Kamino Lend (klend) from mainnet and devnet into `fixtures/klend/mainnet.so` and `devnet.so`, refused unless each matches `KLEND_MAINNET_SHA256` or `KLEND_DEVNET_SHA256` in `fixtures/pins.env` (both read on 2026-11-12; mainnet's re-pinned on 2026-11-23 after Kamino upgraded klend in slot 472,935,074, with the mainnet accounts dumped again); its header says how to re-pin after a Kamino upgrade, and `programs/lending-amm/scripts/test-fixture-scripts.sh` tests it without the network.
  The lending AMM's tests load the cluster build's klend and its Kamino accounts, dumped at one slot by `programs/lending-amm/scripts/kamino_accounts.py` and committed in `programs/lending-amm/tests/fixtures/kamino/<cluster>/` ([`lending-pool.md`](spec/lending-pool.md), "Building it").
- `programs/lending-amm/scripts/fetch-accounts.sh` clones the accounts of our Kamino lending market from devnet at one slot (its reserves, mints, token accounts and lending market, from `deployments/kamino-devnet.json`) into `fixtures/accounts/`, with `fixtures/accounts/warp-slot`, and, for the Kamino-side commands the demo calls, the reserves' two Pyth price accounts with their publish time moved 50 years ahead and klend's global config (`kamino_accounts.py local`); `scripts/local-validator.sh` loads every account file there at its address, warps to that slot when the file exists, and runs devnet's klend from `fixtures/klend/devnet.so` when it has been fetched (refused unless it matches its pin).

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
cargo run -p buy-wall-gate -- test-builds   # the buy wall release gate's stranding test builds, which the tests need
python3 lending-amm/scripts/broken-builds.py   # the lending AMM's broken builds, which its fuzzer and its release gate must catch
cargo test --workspace                   # LiteSVM through devnet's router, with pipeline-check
cargo kani --workspace -j --output-format=terse   # the maths proofs' default tiers; -j needs terse output
cd ..
for p in programs/*/proofs/*_z3.py; do python "$p"; done   # the Z3 proofs, with z3-solver installed
pnpm install && pnpm typecheck           # the TypeScript workspace
scripts/test-fetch-router.sh && scripts/test-check-no-keypairs.sh && scripts/check-no-keypairs.sh
cargo build-sbf --manifest-path programs/lending-amm/Cargo.toml --no-default-features --features mainnet --sbf-out-dir programs/target/deploy-mainnet
```

The lending AMM's tests ([Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78), 2026-11-12) need `scripts/fetch-pipeline.sh programs` for Pipeline's `test-hook`, and since [Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79) `bash programs/lending-amm/scripts/fetch-klend.sh` for klend.
Its `mainnet` build is tested on the cloned mainnet reserves with `SBF_OUT_DIR="$PWD/target/deploy-mainnet" cargo test -p lending-amm --no-default-features --features mainnet`, from `programs/`, after the `mainnet` SBF build above.
On the owner's Mac the workspace's tests then passed in 100 seconds, the lending AMM's stateful invariant fuzzer taking 48 of them for its default 24 sequences (`PROPTEST_CASES` sets more; 200 took 7 minutes); `pipeline-check` reported 13 pass, 0 warn, 0 fail and only `exact_out_refund` skipped on every market they create; all eight Kani harnesses, the tax AMM's and the lending AMM's, took 93 seconds; and the four Z3 proofs took under a second.

Since [Tax AMM: invariant fuzzing across every instruction](https://github.com/imDev2023/testing-pipeline/issues/65) (2026-11-12), test builds optimize every dependency and none of our crates (`[profile.dev.package."*"]` in `programs/Cargo.toml`), because the invariant fuzzers send tens of thousands of LiteSVM transactions: a tax AMM sequence of up to 50 steps took about 7 seconds with unoptimized dependencies and about 0.14 seconds with them, and the lending AMM's fuzzer went from 48 seconds to 2.
Building the dependencies so takes longer once: about 5 minutes from cold on the owner's Mac, after which they stay built; CI's cargo cache is keyed on `programs/Cargo.toml` as well as the lock file, so a change to the profile rebuilds it once.
The tax AMM's fuzzer, `programs/tax-amm/tests/fuzz.rs`, runs 1,000 sequences of up to 50 steps in a plain `cargo test` (about 2.5 minutes on the owner's Mac); `PROPTEST_CASES` and `FUZZ_STEPS` change that, `FUZZ_INVARIANTS=<name>,...` checks only the invariants named, and a failure prints its minimised shape and steps as Rust, to paste into a regression test that replays them.
Its harness, in `programs/tax-amm/tests/common/fuzz/`, says how another product adds its steps and invariants.
The containment hook's fuzzer, `programs/containment-hook/tests/fuzz.rs` on `tests/support/fuzz.rs`, is built on it that way ([Containment hook: invariant fuzzing of contained tokens](https://github.com/imDev2023/testing-pipeline/issues/71), 2026-11-16): every tax market shape made the home market of a contained token, with the hook's own steps and its five invariants beside the tax AMM's.
Its sequences cost about three times the tax AMM's, so it runs them with the harness's `fuzz_in_parallel` on every core (`FUZZ_THREADS` sets how many): its default 1,000 sequences of up to 50 steps took 31 seconds on the owner's Mac on 20 threads.
The lending AMM's fuzzer, `programs/lending-amm/tests/fuzz.rs` on `tests/common/fuzz.rs`, runs 24 sequences of up to 32 steps against a moving Kamino in a plain `cargo test` (about 6 seconds); `PROPTEST_CASES`, `FUZZ_STEPS` and `FUZZ_SEED` change that, and every run prints its seed ([Lending AMM: the fuzzer against a moving Kamino, and the proofs completed](https://github.com/imDev2023/testing-pipeline/issues/85), 2026-11-16).
Its `tests/broken_builds.rs` needs `python3 programs/lending-amm/scripts/broken-builds.py` first, which builds the twelve broken builds into `programs/target/lending-broken-builds` (80 seconds on the owner's Mac once their dependencies are built, which takes 40 seconds more the first time); the fuzzer then catches all twelve in about 6 seconds.
With it, `cargo test --workspace` took 3 minutes 16 seconds on the owner's Mac on 2026-11-12, the tax AMM's fuzzer 2 minutes 37 of them, beside the other test binaries.

On 2026-11-10 on the owner's Mac, from warm caches, everything above but Kani took 49 seconds in a fresh shell: the router matched its pin, Pipeline built at `5ad130d69e9e`, formatting and clippy were clean, and the tests passed: 3 unit tests of the pricing, the `security.txt` test and the template's 4 LiteSVM tests through devnet's router, on whose markets `pipeline-check` reported 14 pass, 0 warn and 0 fail.
On 2026-11-12, with seeding and trading, `cargo test --workspace` took 66 seconds from warm caches, 31 of them the property tests.
From cold, the SBF build took 53 seconds, the test build 60 seconds and `fetch-pipeline.sh` 2 minutes 22 seconds.
`cargo kani --workspace -j --output-format=terse` runs every program's default tier; the tax AMM's is 14 harnesses over its pricing, tax, split and rate rules (`programs/tax-amm/src/pricing.rs`, `split.rs`, `params.rs`), 137 seconds wall in parallel on this Mac on 2026-11-20, the build included, and its Z3 proofs (`programs/tax-amm/proofs/pricing_z3.py`) take under 10 seconds.
[Tax AMM: proofs of the pricing, tax and split maths](https://github.com/imDev2023/testing-pipeline/issues/64) built them; `docs/security/tax-amm/maths-properties.md` lists every property with the tool that establishes it, each harness's time, the harnesses that did not finish and the mutation checks, and Proptest checks every property on at least 10,000 cases (`programs/tax-amm/tests/maths.rs`, about 41 seconds in a debug build).
`in_given_out`, the template's exact-out maths, left with [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59) on 2026-11-12, because the tax AMM refuses exact-out; its no-panic proof, which passed before it left, took 14.5 minutes.

### Local demo run

The demo script, grown from the template's `deploy-devnet.ts`, takes the cluster and the keys as arguments and refuses any cluster other than devnet or a local validator.
It registers the strategy signed by the upgrade authority, creates two test tokens, computes the router's market and fee accounts and the tax AMM's vaults before sending anything, creates a tax market from the metadata's `init` form with a fee account for each mint and the metadata's `seed` action in one transaction, and stops unless every computed address exists afterwards and the market state, read with the generated client, holds exactly the parameters sent, open and holding the seed.
Then it buys and sells through the router with Pipeline's SDK, each swap with its quote as the minimum, and stops unless each delivered its quote, the quote is the spec's price, and the market state's reserves, owed amounts and counters equal the script's own calculation from the spec's formulas (`spec-model.ts`), to the unit.
It quotes at `confirmed`, the commitment it confirms at, since the SDK's default, `finalized`, trails a fresh local validator by about 32 slots and would quote a market that does not exist yet, or one before the last swap.
On a local validator it airdrops what the payer and the upgrade authority need; on devnet it never does.

`scripts/local-validator.sh` runs `solana-test-validator` from an empty ledger in `fixtures/test-ledger` with devnet's router (the pinned fixture bytes, and its config account as devnet has it, so the 0.01 SOL listing fee and its recipient are devnet's) and every program of the workspace from `programs/target/deploy`, at its `declare_id!` address and upgradeable by the upgrade authority, as on devnet, and the test programs from `fixtures/test-programs`, frozen.
Arguments from the first that starts with `-` go to `solana-test-validator`, after an optional ledger directory; when another project's validator holds the default ports, pass others, such as `scripts/local-validator.sh --rpc-port 8999 --faucet-port 9910 --gossip-port 8100 --dynamic-port-range 8101-8130`, and give the demo `--cluster http://127.0.0.1:8999`.
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
Since [the tax authority](https://github.com/imDev2023/testing-pipeline/issues/62), the payer then acts as the tax authority through the metadata's actions: `set_taxes` moves the rates from 300 and 500 to 600 and 900 basis points and the same two trades run again, each quote the spec's price at the new rates; `set_recipients` hands the second recipient's slot to a new wallet, which keeps the slot's owed amount; and after `renounce_tax_authority` both changes are refused in simulation with `AlreadyRenounced` (6028), the market state unchanged.
That passed on 2026-11-12 from a fresh validator, the demo in 25 seconds: the slot handed over kept its 24,323,027 owed, and `tax_collected` reached 90,085,286 after four swaps.
Since [the tax AMM's hardening](https://github.com/imDev2023/testing-pipeline/issues/67) the demo's tokens have no mint authority once their supply is minted, its seeds carry the hash of the market's terms (`TAX-59`), step 10 trades once at the old rates, waits until the change's slot `RATE_CHANGE_DELAY_SLOTS` later and then trades at the new ones (`TAX-05`), and step 11 first shows a handover of a slot still owed refused in simulation, then pays the slot out and hands it over in one transaction (`TAX-39`).
That passed on 2026-11-22 from a fresh validator with fast slots (`scripts/local-validator.sh fixtures/test-ledger-67 --rpc-port 8967 --faucet-port 9967 --gossip-port 8968 --dynamic-port-range 8801-8840 --ticks-per-slot 8`), the demo in 3 minutes 40 seconds, most of it the rate change's wait: the change set at slot 40 applied from slot 340, a trade at slot 41 paid the old rates and the trades after slot 340 the new ones; the handover of slot 1 while it was owed 32,423,170 was refused with 6043 (`OwedSlotRedirected`), and the payout and handover then landed in one transaction of 630 bytes; and `pipeline-check --fail-on-warn`, rebuilt from the Pipeline clone at `3fd85ce` (a build from before Pipeline 0.2 fails every swap with the router's 3007), reported 13 pass, 0 warn, 0 fail and `exact_out_refund` skipped on every market the demo made.
The containment hook's launch with `--unlock goal` passed after it on the same validator: the mint authority revoked after `bind`, the seed with the terms hash, the buy, the sell, the hook's refusals, and the unlock by the goal (133,135,805 of 100,000,000 collected); `pipeline-check` on its home market passes given amounts, since its single-sided virtual reserve refuses the largest default quote as the spec says.
On a local validator the demo goes on to a thirteenth step: the stand-in launchpad graduates a token into a tax market through `pipeline_seed_liquidity`, built from the metadata's `seed_liquidity` form with the SDK's `resolveInit`, the same transaction records it with `register_existing_market` and both fee accounts, and the market trades both ways as in steps 8 and 9; on devnet the step is skipped.
Passed on 2026-11-12 by [seeding from another program](https://github.com/imDev2023/testing-pipeline/issues/63), the whole demo with the tax authority's steps in 25 seconds, from a fresh validator started with flags only (`scripts/local-validator.sh --rpc-port 8999 --faucet-port 9910 --gossip-port 8100 --dynamic-port-range 8101-8130`) because another project's validator held port 8000: the graduation transaction was 1,214 of 1,232 bytes; the escrows lost exactly the seed (100,000,000,000 and 200,000,000,000), which `SeedResult.taken` reported, with `lp_amount` 0; `pipeline_seed_liquidity` used 41,357 units; the market state held the parameters sent with the launchpad's PDA as its seeder, open and holding the seed; and both swaps delivered their quotes, the spec's prices, leaving the reserves, owed amounts and counters equal to the spec's formulas.
Since [pay the tax out with distribute](https://github.com/imDev2023/testing-pipeline/issues/61), the demo ends with two more steps.
Step 14 pays out every slot of the token B market through the metadata's `distribute` action, and the burn slot through its `burn` action (the same instruction with the mint writable), giving the actions' `tax_mint` and `recipient` inputs from the market state and the suite treasury and the slot numbers from the generated client.
Step 15 creates, seeds and trades a second market from its own named block, `SOL_MARKET`: a token against wrapped SOL, taxed in SOL and so with no burn, the script wrapping its seed and its buy, with Pipeline's fee, beforehand; then it pays that market out the same way.
Each payout stops the demo unless the wallet's token account grew by exactly what its slot was owed, a fresh recipient got its token account from the payout, the burn lowered the mint's supply by exactly its owed amount, and afterwards every owed amount is 0 and the tax-side vault holds exactly the real reserve.
That passed on 2026-11-12 from a fresh validator, the whole demo in 42 seconds.
In the SOL market, a buy of 50,000,000 lamports delivered 8,846,718,322 of token A, with a buy tax of 1,500,000, and a sell of 1,000,000,000 of token A delivered 5,651,371 lamports, with a sell tax of 297,441.
`distribute` then paid the payer 970,619 and the fresh second recipient 647,078 in wrapped SOL, and the suite treasury 179,744, the last two into accounts the payouts created; the burn slot was owed nothing, the vault kept exactly its real reserve of 542,551,188, and each payout was one transaction of 446 or 478 bytes.
In the token B market, after the tax authority's steps, the payer received 48,646,057, the wallet given slot 1 received its 24,323,027 into an account the payout created, the suite treasury received 9,008,527, and the burn lowered token B's supply by exactly 8,107,675.
Since [the devnet ticket](https://github.com/imDev2023/testing-pipeline/issues/66), step 15 is the demo market, the one market the demo creates on devnet (`TAX-53`): `SOL_MARKET` holds every parameter it is created with, and it trades a fresh demo token, made in the step, with no virtual reserve, so `pipeline-check` checks it at its default amounts.
Steps 4 to 14 run on a local validator only, and `--demo-market-only` skips them there too, to run exactly what devnet runs; `--register-only` stops after step 3, and `--record <file>` writes the run's addresses and signatures to a file.
On 2026-11-16, from a validator started with `SKIP_PROGRAMS=tax-amm` and the tax AMM deployed by `scripts/deploy-devnet.sh` ("Deploy to devnet"), `--demo-market-only` passed in 13 seconds: the creation with both fee accounts and the seed was one transaction of 1,212 bytes; a buy of 50,000,000 lamports delivered its quote, 8,842,297,174 of the demo token, with a buy tax of 1,500,000, and a sell of 1,000,000,000 delivered its quote, 5,654,166 lamports, with a sell tax of 297,588; the payer received 970,698, the fresh second recipient 647,132 and the suite treasury 179,758, exactly what the market state owed each; and `pipeline-check --fail-on-warn` on the market reported 13 pass, 0 warn, 0 fail and `exact_out_refund` skipped, and `--list-markets` listed it.
The whole demo then passed on the same validator in 23 seconds, steps 4 to 14 with the numbers above.
If another validator on the machine holds gossip port 8000, `solana-test-validator` stops at start with `gossip_addr bind_to port 8000: Address already in use`; a wrapper earlier on `PATH` that adds `--gossip-port 8030 --dynamic-port-range 8031-8060` lets `scripts/local-validator.sh` start without disturbing it.
Earlier the same day, before the seed and trading, it passed in 19 seconds.
The template's demo, before the tax AMM replaced its pool, passed on 2026-11-10, twice, the second time from fresh shells following these steps, in 8 seconds each.
The upgrade authority registered the strategy and paid the 0.01 SOL listing fee and the strategy account's rent (its balance went from 1 to 0.987 SOL); the market was created with both fee accounts in one transaction; 100,000,000,000 of token A and 200,000,000,000 of token B went in through `deposit`; and 1,000,000 of token A quoted at 1,993,980 of token B (4,876 compute units), which the router's swap delivered exactly, with Pipeline's fee of 2,500.
In the swap the router invoked the strategy, which used 8,683 of the swap's 39,862 compute units.
The demo confirms at `confirmed`, so a local run takes seconds where Pipeline's smoke script, which waits for `finalized`, takes two minutes.
Until this repo's `main` has the metadata, step 2 warns that the published copy at the default URI is not there yet, which changes nothing locally.

The lending AMM's demo runs the same way, after `bash programs/lending-amm/scripts/fetch-klend.sh devnet` and `bash programs/lending-amm/scripts/fetch-accounts.sh` (before starting the validator), from `programs/lending-amm/scripts`: it registers the strategy, creates a test token and wraps SOL, creates a WSOL-lent market from the metadata's `init` form with both fee accounts and the first deposit from its `add_liquidity` action in one transaction, buys and sells through the router, and adds liquidity again, stopping unless each swap's output equals its quote and the market's reserves and share count equal its own calculation from the spec's formulas after every step.
It passed on 2026-11-12 with `solana-test-validator` 4.4.1 and Node 24.4.1, in 20 seconds from a fresh validator, and simulates quotes at `confirmed`, as it confirms transactions, since the SDK's default `finalized` lags on a fresh local validator.
Since [Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79) it also checks that klend is deployed and that the reserve is our devnet WSOL reserve in klend's layout, decodes it itself at the spec's offsets (`scripts/kamino.ts`), checks every quote against `L = B + V` from that decoding and that account resolution lists the reserve read-only, and checks that a swap built without the reserve is refused with `ReserveWrongAddress`; it passed that way on 2026-11-12 in 8 seconds, on a validator warped to devnet's slot 521,461,201.
Since [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80) it goes on to call `rebalance`, built from the metadata's action, and stops unless klend minted the cTokens and took the liquidity its own deposit maths gives (`klendDeposit` in `scripts/kamino.ts`), the market state records exactly that, the buffer is back at its target and quotes agree within rounding; then a second call must be refused with `WithinBand`, and it trades both ways again; it passed that way on 2026-11-16 in 50 seconds, on a validator warped to devnet's slot 522,878,888.
Since [Lending AMM: redeem a swap's shortfall from Kamino inside the swap](https://github.com/imDev2023/testing-pipeline/issues/81) it goes on to sell for more WSOL than the buffer holds: built from the accounts resolved for a smaller sale it must be refused with `RedeemAccountsMissing`, then with its own accounts (the reserve writable and klend's redeem accounts) the trader must receive exactly the quote, the redeem event carry the shortfall and the market's cTokens fall by the script's own `ceil(s x S_ctoken / S_total)`; a last `rebalance` brings the buffer back to its target.
It passed that way on 2026-11-16 in 9 seconds, on a validator warped to devnet's slot 522,921,712, on its own ports (`scripts/local-validator.sh fixtures/test-ledger-81 --rpc-port 8981 --faucet-port 9981 --gossip-port 8982 --dynamic-port-range 8700-8760`).
Since [Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82) a second wallet, funded by the payer, adds liquidity, removes a third of its shares in cash and a third in kind from the metadata's two removal forms, redeems the cTokens it received at klend itself and locks a tenth of its shares; the script stops unless every amount equals its own calculation, the cash removal's transaction ran klend's redeem and klend paid what its own maths gives (`klendRedeem` in `scripts/kamino.ts`), and the in-kind removal holds no account Kamino Lend owns.
It passed that way on 2026-11-16 in 13 seconds, on a validator warped to devnet's slot 522,990,794.
Since [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83) the demo market is smaller, its lent side near 0.4 SOL to fit the 5 SOL our devnet wallet keeps free in the WSOL reserve, and the script goes on with the Kamino-side commands of `scripts/kamino-devnet` (run with `npm`, so that package needs `npm ci` first, and the keys in `~/.config/testing-pipeline/devnet/`, whose wallet the script airdrops on a local validator): the test borrower borrows the reserve below 5 times the market's `max(V, T)` and `rebalance` enters withdraw mode and redeems every cToken, a second call is refused with `BelowMinRebalance`, the borrower repays and `rebalance` leaves and lends again; then, with the reserve's emergency mode on, a sale within the buffer trades, one beyond it is refused by the quote and the swap, `rebalance` is refused with `KaminoStopped` and a cash removal with `KaminoCannotPay`, the second wallet removes the rest in kind, and with emergency mode off a sale beyond the buffer redeems again.
It passed that way on 2026-11-16 in 25 seconds from a fresh validator warped to devnet's slot 523,013,748, after `fetch-accounts.sh` had copied the Pyth prices and the global config.
Since [Lending AMM: seeding by a launchpad](https://github.com/imDev2023/testing-pipeline/issues/84), on a local validator only, the demo ends with three more steps: the stand-in launchpad, through `programs/tax-amm/scripts/launchpad.ts`, graduates a new token into a second market from the metadata's `seed_liquidity` form with the market's vault authority as the LP recipient, recorded with `register_existing_market` and both fee accounts in the same transaction; the script stops unless `SeedResult.taken` and the escrows both show the seed, `lp_amount` is the spec's first-deposit shares and they sit in the lock account, and the market state holds the launchpad's PDA as its seeder; then the market trades both ways through the router at the spec's prices and `rebalance` lends its surplus by klend's own deposit maths, the locked shares untouched.
It passed that way on 2026-11-16 in 29 seconds from a fresh validator warped to devnet's slot 523,035,016, `pipeline_seed_liquidity` using 86,976 units.
Since [Lending AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/86) (2026-11-17) the second wallet's deposit puts klend's `refresh_reserve` first, after checking in simulation that the same deposit without it is refused with `ReserveStale`; the wallet then leaves with the lent side alone for a twentieth of its shares, from the metadata's `remove_lent_side` form; and leaving withdraw mode takes two `rebalance` calls `WITHDRAW_MODE_EXIT_DELAY_SLOTS` (9,000) slots apart, the first starting the wait and the demo waiting for the slot before the second.
So the validator for the whole lending demo is started with fast slots, `scripts/local-validator.sh fixtures/test-ledger-86 --rpc-port 8986 --faucet-port 9986 --gossip-port 8987 --dynamic-port-range 8700-8760 --ticks-per-slot 8` (`LENDING-96`); at 2 ticks a slot the validator dropped blocks and its root stopped advancing, while at 8 it ran 11 slots a second on the owner's Mac.
It passed that way on 2026-11-17 in 12 minutes 57 seconds from a fresh validator warped to devnet's slot 523,151,336, nearly all of it the wait, with the later deposits offering the market's ratio plus 1% slippage as their maximums; on devnet the wait is an hour.
Since [the devnet ticket](https://github.com/imDev2023/testing-pipeline/issues/87) (2026-11-22) the test token has its mint authority removed and is checked to hold neither authority, the first deposit puts 0.5 SOL on the lent side (`LENDING-82`), every state check covers withdraw mode, the lending yield is read twice with the borrower's loan held (`LENDING-97`), step 27 ends with the buffer back at its target and prints the sales at the buffer's edge, and a step 31 on devnet asks Pipeline's hosted API to list and quote the market (`LENDING-98`); `--register-only` and `--record` work as the other demos'.
It passed that way on 2026-11-22 in 18 minutes 11 seconds on a validator warped to devnet's slot 525,226,388, its slots slowed by builds running beside it: the yield rose from 22 to 74 lamports between slots 525,232,102 and 525,232,148, `rebalance` entered withdraw mode redeeming all 284,304,577 cTokens for 284,306,655 lamports and left it lending 321,367,660, and `pipeline-check --fail-on-warn` on the demo market reported 13 pass, 0 warn, 0 fail and `exact_out_refund` skipped, at its default sizes and with `--amounts 131473535805,134801893536`, sales paying out 99% and 101% of the buffer.
Its call-depth test needs the stand-in smart wallet, a test program `scripts/build-programs.sh` builds into `fixtures/test-programs` with the stand-in launchpad (`scripts/build-programs.sh test-programs/stand-in-smart-wallet` builds it alone).

The buy wall AMM's demo (`programs/buy-wall-amm/scripts/demo.ts`) takes the same arguments, on the same validator:

```sh
cd programs/buy-wall-amm/scripts
pnpm demo --cluster localnet \
  --payer ~/.config/testing-pipeline/devnet/wallet.json \
  --upgrade-authority ~/.config/testing-pipeline/devnet/upgrade-authority.json
```

It registers the strategy, creates a test token with its mint authority removed and wraps the SOL for the seed and a buy, then in one transaction creates the market from the metadata's `init` form, adds both fee accounts and seeds it through the metadata's `seed` action; it reads the market back through the router's record and the generated client.
Since [plain trading through the router](https://github.com/imDev2023/testing-pipeline/issues/48), it then buys with 1 SOL and sells what it bought, each quoted and swapped through the router with the SDK, checks each quote against the spec's formulas (recomputed in the script) and the worked example's numbers, and reads the price, ledgers and counters back against the same formulas.
Passed on 2026-11-12 from a fresh validator in 7 seconds: the seed opened at `sqrt_price` 1,844,674,407,370,955,161, `liquidity` 99,999,999,999 and cap 1,000,000,000,000 in a 1,091-byte transaction; the buy paid 90,081,892,629 units and the sell back 980,099,999 lamports, exactly the quotes and the worked example's numbers; and the market state ended at `sqrt_price` 1,844,674,407,372,029,099, with every ledger and counter equal to the spec's formulas and each vault holding exactly its ledgers.
Since [the inventory cap](https://github.com/imDev2023/testing-pipeline/issues/49), it waits until the cluster's clock is 3 seconds past the seed before the buy, so the buy lowers the cap by the decay credit built up and the sell back is trimmed; it recomputes both cap steps from the spec at the time each swap ran (the market state's `decay_time`), reads the `CapLowered` and `Trimmed` events from each swap's logs with the generated client, and checks the cap, the decay credit, the retired tokens and the trimmed totals too, reading `DECAY_CREDIT_WINDOW` and `MIN_LIQUIDITY` from the client.
Passed on 2026-11-12 from a fresh validator in 11 seconds: 4 seconds after the seed the buy lowered the cap by 9,259,259 to 999,990,740,741, and the sell back trimmed 9,259,249 units and 92,591 lamports, leaving `liquidity` 99,999,074,074 and every field equal to the spec's formulas.
Since [the buy wall](https://github.com/imDev2023/testing-pipeline/issues/50), it recomputes the wall's guard from the spec at the slot and time each swap ran, then places the buy wall through the metadata's `place_wall` action: while idle SOL is below `WALL_THRESHOLD` it simulates `place_wall` and stops unless it is refused with `WallBelowThreshold`, buys once more so the fee takes idle SOL past the threshold, places the wall and checks the tip, the wall and the dust against the spec's formulas and the `WallPlaced` event; then it sells into the wall, priced in two steps across its top, and reads the wall, the guard and the tipped total back with everything else, reading `WALL_THRESHOLD`, `KEEPER_TIP_CAP` and the guard's rates from the client (`POOL4-35`).
Passed on 2026-11-16 from a fresh validator in 21 seconds, on its own ports (`scripts/local-validator.sh fixtures/test-ledger-50 --rpc-port 8950 --faucet-port 9950 --gossip-port 8960 --dynamic-port-range 8500-8600`): `place_wall` with 8,029,443 lamports idle was refused; after the second buy it tipped 120,294 lamports, the fee on 12,029,443 lamports of work, and placed 11,909,150 lamports at `sqrt_price` 1,844,674,407,372,029,099, the floor the sell back had left, below the price, sweeping 12 units and 2 lamports of dust; the sell of 110,081,836,276 units crossed the wall's top in two steps, delivered its quote of 1,174,222,147 lamports, and left the wall having spent 233,242 lamports on 23,790,134 units; every field equalled the spec's formulas; and `pipeline-check --url http://127.0.0.1:8950 --market <the demo market>`, built from `fixtures/pipeline` with `cargo build --release -p pipeline-check`, reported 13 pass, 0 warn, 0 fail and `exact_out_refund` skipped on the market with its wall placed.
Since [payouts and recipient handovers](https://github.com/imDev2023/testing-pipeline/issues/51), three more steps follow, each built from its metadata action as Aviary's generic forms would: step 11 settles the retired tokens and stops unless the reward share joined the rewards owed, the rest was burned and the token's supply fell by exactly that; step 12 hands both recipient roles from the payer to fresh wallets, checks each `RecipientChanged` event and what the roles are owed, and simulates a further handover by the old recipient, which must be refused with `NotRecipient`; step 13 pays the rewards and fee slot 0 to the new wallets, each into an account the payout creates and receiving exactly what the role was owed, slot 2 to `SUITE_TREASURY`, simulates slot 1 (refused with `RecipientUnset` while `DESIGNER_RECIPIENT` is unset) and a second `pay_rewards` (refused with `NothingOwed`), and reads the ledgers, the lifetime totals and both vaults back, reading `DESIGNER_RECIPIENT` and `SUITE_TREASURY` from the client (`POOL4-40`).
Passed on 2026-11-16 from a fresh validator in 24 seconds, on its own ports (`scripts/local-validator.sh fixtures/test-ledger-51c --rpc-port 8951 --faucet-port 9951 --gossip-port 8961 --dynamic-port-range 8601-8700`): `settle` split 19,987,738,157 retired units into 2,998,160,723 owed as rewards and 16,989,577,434 burned, the supply falling by exactly that; after both handovers `pay_rewards` paid the new rewards recipient 2,998,160,723 units and slot 0 paid the new fee recipient 16,704,332 lamports, each into an account the payout created; slot 2 paid the suite treasury 4,176,083 lamports; slot 1's 4,176,083 lamports waited, refused; the price, the counters and every other ledger were unchanged, each vault holding exactly its ledgers; and `pipeline-check --url http://127.0.0.1:8951 --market <the demo market>` then reported 13 pass, 0 warn, 0 fail and `exact_out_refund` skipped.
On a local validator it goes on to a fourteenth step (the ninth before the buy wall's steps and the eleventh before the payouts'), which [seeding by another program](https://github.com/imDev2023/testing-pipeline/issues/53) added: the stand-in launchpad graduates a second token through `pipeline_seed_liquidity`, built from the metadata's `seed_liquidity` form with the SDK's `resolveInit` and sent with the tax AMM's `launchpad.ts`, the same transaction records the market with `register_existing_market` and both fee accounts, and the market trades both ways; on devnet the step is skipped.
Passed on 2026-11-12 from a fresh validator in 9 seconds, on other ports because one start collided (`scripts/local-validator.sh --rpc-port 8869 --faucet-port 9940 --gossip-port 8180 --dynamic-port-range 8181-8210`, the demo given `--cluster http://127.0.0.1:8869`): the graduation was one transaction of 1,094 bytes; exactly the seed left the escrows, which `SeedResult.taken` reported with `lp_amount` 0; `pipeline_seed_liquidity` used 60,847 units; the market state held the parameters sent with the launchpad's PDA as its seeder, open at the worked example's price; both trades delivered their quotes, the worked example's numbers; and `pipeline-check --url http://127.0.0.1:8869 --market <the graduated market>` reported 13 pass, 0 warn, 0 fail and `exact_out_refund` skipped.
Since [the release gate](https://github.com/imDev2023/testing-pipeline/issues/54), a fifteenth step runs the gate against the same cluster with `cargo run -p buy-wall-gate -- run`, its pass records in a scratch folder: with the program in `programs/target/deploy` it must pass on every market, and with the moved-field test build, when `cargo run -p buy-wall-gate -- test-builds` has built it, it must refuse.
Passed on 2026-11-16 from a fresh validator in 76 seconds, on its own ports (`scripts/local-validator.sh fixtures/test-ledger-54 --rpc-port 8954 --faucet-port 9954 --gossip-port 8964 --dynamic-port-range 8700-8800`): the gate found both markets the demo made, the demo market and the graduated one, and passed every step on each (resolution both ways, six quotes equal to the deployed build's, `place_wall` due on one and `settle` with fee slots 0 and 2 on the other, a buy and a sell each delivering its quote); with the moved-field build it refused, naming 17 failed steps on the two markets (every quote refused with `Custom(6025)` or `Custom(6029)`, `place_wall`, and each buy).

### The buy wall AMM's release gate

`programs/buy-wall-amm/gate` (crate `buy-wall-gate`) is the buy wall AMM's release gate, a host tool beside the program, never deployed, added by [the release gate and layout fixtures](https://github.com/imDev2023/testing-pipeline/issues/54); [`pool4-for-solana.md`](spec/pool4-for-solana.md#how-to-run-it), "How to run it", has its commands.
`cargo test --workspace` runs its checks on every fixture in `programs/buy-wall-amm/gate/fixtures/` against the current build, and on the seven stranding test builds, which `cargo run -p buy-wall-gate -- test-builds` writes to `programs/target/gate-test-builds`, from edited copies of the workspace built in a target directory of their own there.
Every gate run, on a cluster or a fixture, also makes and trades a market of its own with the candidate (`POOL4-53`), so `cargo test -p buy-wall-gate --test empty_cluster` checks that a cluster with no market passes the current build and refuses a broken one.
Kani builds the crate without its dependencies (`cfg(not(kani))` in its `Cargo.toml`), because Kani's nightly Rust refuses LiteSVM's Solana crates and the gate has no proofs.
`scripts/deploy-devnet.sh buy-wall-amm` deploys only a build the gate has passed against the cluster it deploys to: before it sends anything it runs the program's pre-deploy check, `programs/buy-wall-amm/scripts/pre-deploy.sh`, which asks `buy-wall-gate verify-record` (`POOL4-54`; "Deploy to devnet").

### The lending AMM's release gate

`programs/lending-amm/gate` (crate `lending-gate`) is the lending AMM's release gate, a host tool beside the program, never deployed, added by [the lending AMM's devnet ticket](https://github.com/imDev2023/testing-pipeline/issues/87) on 2026-11-22; [`lending-pool.md`](spec/lending-pool.md#a-release-gate), "A release gate", has what it checks and its commands.
It shares the buy wall AMM's gate records, cluster reads, release declaration and error reading through `programs/release-gate` (crate `release-gate`), which `buy-wall-gate` re-exports.
`cargo test -p lending-gate` needs `scripts/fetch-router.sh`, `programs/lending-amm/scripts/fetch-klend.sh`, the program built, and `python3 programs/lending-amm/scripts/broken-builds.py`, which also builds the gate's test builds from `programs/lending-amm/gate/test-builds.json` into the same folder; then its 10 tests take about 2 seconds.
Kani builds both crates without their dependencies, as `buy-wall-gate`'s.
`scripts/deploy-devnet.sh lending-amm` runs `programs/lending-amm/scripts/pre-deploy.sh` on the bytes it built, which refuses unless `lending-gate run` has passed that build on that cluster against the build deployed there now and every market there now (`LENDING_GATE_RECORDS` names another records folder, as for a local rehearsal).
Run against devnet on 2026-11-22, before anything of the lending AMM was deployed there, it found no market, made and traded one of its own with the build in `programs/target/deploy` (a sale beyond the buffer redeeming 6,000,169,061 lamports from Kamino, its quote) and passed, in 4.5 seconds.

### Containment hook

The launch script, `programs/containment-hook/scripts/launch.ts`, launches a contained token on a cluster where both programs are deployed and the tax AMM is registered with the router; on a local validator, `scripts/local-validator.sh` deploys both and the tax AMM's demo registers it.
It refuses any cluster other than devnet or a local validator, and takes the goal and the deadline as required flags with no default.

```sh
source scripts/toolchain-env.sh
scripts/local-validator.sh               # in the background, as above
cd programs/tax-amm/scripts && pnpm demo --cluster localnet \
  --payer ~/.config/testing-pipeline/devnet/wallet.json \
  --upgrade-authority ~/.config/testing-pipeline/devnet/upgrade-authority.json
cd ../../containment-hook/scripts && pnpm launch --cluster localnet \
  --launcher ~/.config/testing-pipeline/devnet/wallet.json \
  --goal 5000000000 --deadline 2026-12-12T07:58:31Z
```

Passed on 2026-11-12 with `solana-test-validator` 4.4.1 and Node 24.4.1, in 2.6 seconds: the mint created with only the transfer hook extension, the hook as its program and its unlock PDA as its authority, no freeze authority, and its supply minted; the tax market created with its tax on wrapped SOL and both fee accounts; `bind` in the next transaction, because with it the creation would be 1,307 of the 1,232 bytes a transaction may hold; and the config read back with the generated client holding the market, the market state, the vault, the fee account, the quote mint, the goal and the deadline expected.
Without `--goal` or `--deadline`, or with a goal too large for a `u64`, it stops before connecting; with a zero goal, a deadline already past or one beyond `MAX_UNLOCK_DEADLINE_SECS`, which it reads from the generated client (the hook publishes it in its IDL), it stops before sending anything; if `bind` fails anyway, it names the market left unbound.
Since [a contained token moves only through its home market](https://github.com/imDev2023/testing-pipeline/issues/69), it goes on to seed the market through the tax AMM's metadata `seed` action (800,000,000 tokens, single-sided on the 30 SOL virtual quote reserve), buy with 1 wrapped SOL and sell half of what it bought through the router with Pipeline's SDK, each with the hook accounts resolved from the validation account by Token-2022's own client (`resolveExtraAccountMetasForExecute` from `@solana-program/token-2022` 0.20.0, since neither Pipeline client resolves them), and then shows in simulation the hook refusing a wallet-to-wallet `transfer_checked` and a sell with a 50 basis point integrator fee.
The buy is one whole unit of the quote mint; before sending anything the script checks the launcher holds the SOL the whole launch needs, and with a quote mint other than wrapped SOL that its token account already holds the buy.
It stops unless the seed lands in the vault and opens the market, each swap delivers its quote, Pipeline's fee on the sell, in the token, lands in the fee account, and both refusals come from the hook with `TransferRefused`.
That passed on 2026-11-12 from a fresh validator, after the tax AMM's demo, in 12 seconds: the buy of 1,000,000,000 lamports delivered 25,056,506,296,415 of the token, the sell of 12,528,253,148,207 delivered 468,080,284 lamports with Pipeline's fee of 31,320,632,871 in the token, and the hook's `Execute` took 5,578 units on the buy and 5,602 and 5,603 on the sell.
Since [unlock by the goal or the deadline](https://github.com/imDev2023/testing-pipeline/issues/70), it shows `unlock` refused in simulation with `UnlockNotDue` right after the seed, and `--unlock goal` or `--unlock deadline` makes it go on to unlock the token.
By the goal, it buys with one whole unit of the quote mint and sells as much of the token back, round after round, until the home market's `tax_collected` reaches the goal, refusing up front a goal that would take more than 10 rounds.
By the deadline, it waits for the cluster's clock, refusing up front a deadline less than 60 or more than 600 seconds away, or a goal the launch's own buy and sell could reach (80,000,000 with wrapped SOL).
Then a fresh wallet the launcher funds with 0.002 SOL sends `unlock`, and the script stops unless the logs name what it waited for, the mint keeps its transfer hook extension with the program and the authority both unset, the config changed only by its unlock time, and a second `unlock` is refused in simulation with `AlreadyUnlocked`; a wallet-to-wallet `transfer_checked`, a buy and a sell, each without hook accounts, must then succeed without the hook running.

```sh
pnpm launch --cluster localnet --launcher ~/.config/testing-pipeline/devnet/wallet.json \
  --goal 100000000 --deadline <a day away> --unlock goal
pnpm launch --cluster localnet --launcher ~/.config/testing-pipeline/devnet/wallet.json \
  --goal 5000000000 --deadline <75 seconds away> --unlock deadline
```

Both passed on 2026-11-16 from a fresh validator on other ports (`scripts/local-validator.sh fixtures/test-ledger-70b --rpc-port 8979 --faucet-port 9979 --gossip-port 8970 --dynamic-port-range 8401-8440`, the script given `--cluster http://127.0.0.1:8979`), after the tax AMM's demo.
By the goal, in 13 seconds: one round after the launch's own two trades took the tax collected to 133,135,805 of the goal of 100,000,000, and `unlock` took 13,225 units.
By the deadline, in 80 seconds, most of them waiting: with 54,635,805 of the goal of 5,000,000,000 collected, `unlock` took 12,873 units.
The validator's own parser (`getAccountInfo` with `jsonParsed`, at `confirmed`; `finalized` trails a fresh validator by about 30 slots) then showed each mint's `transferHook` with `authority` and `programId` both unset.

Since [Containment hook: invariant fuzzing of contained tokens](https://github.com/imDev2023/testing-pipeline/issues/71), each launch also sweeps Pipeline's fee in the token from the fee account to Pipeline's treasury with the router's `sweep_fees` and the hook accounts (step 9), and giving `--goal` and `--deadline` again launches another token in the same run, `--unlock` then given for every token or for none.
The rehearsal of the devnet launch is one run with two tokens, the one unlocked by a short deadline first, since every deadline is checked against the cluster's time when its own token's launch starts and a token whose deadline the earlier launches outlasted stops before it sends anything:

```sh
NOW=$(date +%s)
pnpm launch --cluster localnet --launcher ~/.config/testing-pipeline/devnet/wallet.json \
  --goal 5000000000 --deadline $((NOW + 90)) --unlock deadline \
  --goal 100000000 --deadline $((NOW + 86400)) --unlock goal
```

That passed on 2026-11-16 in one run of 2 minutes 14 seconds, most of it waiting for the first token's deadline, from a fresh validator on other ports (`scripts/local-validator.sh fixtures/test-ledger-71 --rpc-port 8971 --faucet-port 9971 --gossip-port 8972 --dynamic-port-range 8441-8480`) after the tax AMM's demo.
Both tokens were launched, bought and sold through the router, swept 31,320,632,871 of the token each from their fee accounts to the treasury, and had a wallet-to-wallet transfer and a sell with an integrator fee refused by the hook; the first unlocked by its deadline with 54,635,805 of 5,000,000,000 collected (12,873 units), the second by its goal with 133,135,805 of 100,000,000 collected (13,225 units), and each then sent and traded without hook accounts.
The other order, with the deadline only 70 seconds away, stopped as it should before the second token sent anything, its deadline 37 seconds away by then.

Since [Containment hook: deploy on devnet and launch a contained token](https://github.com/imDev2023/testing-pipeline/issues/73), the script also does these:

- `--record <file>` writes every signature and address of the run as JSON, also when it stops part way.
- The wallet-to-wallet transfer, and for a token unlocked by its goal an `unlock` sent while the tax collected is still below the goal, are sent past the preflight, so each refusal lands on chain with a signature (`HOOK-39`).
- `--pipeline-check <binary>` runs `pipeline-check --fail-on-warn` on each home market while the token is contained (step 10a) and after its unlock (step 14), with the explicit `--amounts` a market on a virtual reserve needs, and stops unless every check passed but `exact_out_refund`, skipped; `--conformance-out <dir>` keeps each report (`HOOK-38`).
- `--quote-mint` may be given once for each token, and `new` quotes a token in a fresh SPL Token mint the script creates once per run and mints the launcher; `--unlock none` leaves a token contained.
  On a home market quoted in wrapped SOL, Pipeline 0.3 takes its fee in SOL, so only a token quoted in another mint pays Pipeline's fee in the token and has it swept through the hook (`HOOK-41`).
- Before it sends anything, it also refuses a `--record` path whose directory does not exist, an `--unlock goal` whose goal the launch's own buy and sell may already collect (80,000,000 with wrapped SOL), and with `--pipeline-check` a quote mint of fewer than 6 decimals, whose real reserve could not pay a sell of the checker's largest trade.

The devnet launch is one run with three tokens (`HOOK-40`):

```sh
NOW=$(date +%s)
WSOL=So11111111111111111111111111111111111111112
pnpm launch --cluster devnet --launcher ~/.config/testing-pipeline/devnet/wallet.json \
  --goal 5000000000 --deadline $((NOW + 240)) --unlock deadline --quote-mint $WSOL \
  --goal 100000000 --deadline $((NOW + 86400)) --unlock goal --quote-mint $WSOL \
  --goal 1000000000 --deadline $((NOW + 2592000)) --unlock none --quote-mint new \
  --pipeline-check ../../../fixtures/pipeline/target/release/pipeline-check \
  --conformance-out ../conformance/devnet \
  --record ../../../deployments/devnet-demo-containment-hook.json
```

The same run with `--cluster http://127.0.0.1:8973` passed on 2026-11-22 in 260 seconds, most of it waiting for the first token's deadline, from a fresh validator running devnet's Pipeline 0.3 router after the tax AMM's demo.

#### On devnet

The hook went to devnet on 2026-11-22.

- **Deploy.** `scripts/deploy-devnet.sh containment-hook`, the first of the three steps of "Deploy to devnet" (the hook is not a strategy, so there is nothing to register and no metadata to pin), deployed `77b6ddc` from `main` over TPU in slot 525,139,692, signature `2Qb6w8uUj6PDSs5v488noLHCc6hnJhd6m81es6Ddya5xuR5Jwe71Eymyv1rrnZkNo1eo6v8S33ws4EfnjvZ8i4iu`.
  - The executable hash is `f6ac2df343a63b7acf351152d2106eb3ee2ea517a8815aed2165ae7aba4cdd98` (211,056 bytes), which `solana-verify get-program-hash -u devnet` matched.
  - Its upgrade authority is `upgrade-authority.json`'s key, `Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe`.
  - All 121 hook tests passed on those exact bytes first, beside the tax AMM's bytes dumped from devnet.
  - When devnet's router moved to Pipeline 0.3 the same day ([#194](https://github.com/imDev2023/testing-pipeline/issues/194)), they passed again on the same bytes against the 0.3 router, so the deploy stands.
- **Launch.** The three-token run above passed on devnet in 394 seconds, with `pipeline-check` 0.3.0 reporting 13 pass, 0 warn, 0 fail on every home market while contained and after each unlock.
  Every signature and address is in `deployments/devnet-demo-containment-hook.json`, and the reports are in `programs/containment-hook/conformance/devnet/`.
  - The first token unlocked by its deadline, with 54,635,805 of its goal of 5,000,000,000 collected (`unlock` 13,819 units).
  - The second unlocked by its goal: refused on chain at 54,635,805 collected, unlocked once one more round had taken it to 133,135,805 (`unlock` 14,171 units).
  - The third, quoted in a fresh SPL Token mint, paid Pipeline's fee of 32,332,288 of the token on its sell into its fee account through the hook, and `sweep_fees` moved it to Pipeline's treasury with the hook accounts; it stays contained, its deadline 30 days away.
- **A refused transaction the RPC had not served yet.** A first run stopped at the second token's refused `unlock`: the refusal had landed with the hook's error, but devnet's RPC answered `getTransaction` with nothing just after confirming it.
  The script now asks again for up to 30 seconds (`LANDED_TRANSACTION_WAIT_MS`).

### CI

`.github/workflows/ci.yml`, on every pull request and every push to `main`:

| Job | Runs | Does |
| --- | --- | --- |
| `changes` | always | Decides whether on-chain code changed: `programs/`, `packages/`, `fixtures/pins.env`, the scripts that install, fetch, build, deploy or run it, the pnpm workspace files or the workflow |
| `no keypairs` | always | `scripts/test-check-no-keypairs.sh`, then `scripts/check-no-keypairs.sh` |
| `rust` | on-chain changes | The toolchain from `scripts/install-toolchain.sh solana`, the router fixture's test and fetch, the devnet deploy script's test, Pipeline's test programs from `scripts/fetch-pipeline.sh programs` (its clone cached by the pinned `rev`), `cargo fmt --check`, each program's SBF build by its manifest, the buy wall AMM release gate's seven stranding test builds (`cargo run -p buy-wall-gate -- test-builds`, `POOL4-44`), clippy with `-D warnings`, the tests, the lending AMM's `mainnet` build with its clippy and unit tests, and the buy wall AMM built with `test-designer-recipient` (a test key as `DESIGNER_RECIPIENT`, `POOL4-39`) into `programs/target/deploy-designer`, with its clippy, unit tests and payout tests |
| `typescript` | on-chain changes | Pipeline's SDK from `scripts/fetch-pipeline.sh sdk`, `pnpm install --frozen-lockfile`, `pnpm typecheck`, and the shared packages' tests (`pnpm --recursive --if-present test`) |
| `kani` | on-chain changes | Every program's Z3 proofs (`programs/*/proofs/*_z3.py`, with `z3-solver` 5.4.1.0), then Kani from `scripts/install-toolchain.sh kani` and `cargo kani --workspace -j --output-format=terse` |
| `canary` | changes to `crates/`, the containment hook (`programs/containment-hook/`, whose rules Canary's checks meet on contained tokens) or any of its build inputs (`programs/mint-rules/`, `programs/tax-amm/`, `programs/Cargo.toml`, `programs/Cargo.lock`, `programs/rust-toolchain.toml`, `scripts/build-programs.sh`, `scripts/workspace-programs.py`), the fixtures' pins or scripts, or the workflow | `scripts/check-canary-paths.py`, which fails when `CANARY_PATHS` misses a build input of the hook, then the toolchain, the router fixture and Pipeline's test programs as `rust` gets them, and Canary's own fixture programs (`crates/canary/tests/fixtures/build.sh`), then `cargo fmt --check`, clippy with `-D warnings` and the tests in `crates/` |
| `gate` | always | Passes only if `changes` and `no keypairs` passed and, when on-chain code changed, every heavy job passed too, and `canary` likewise when Canary changed; when none changed, they must have been skipped |

`gate` is the one check `main` requires, so a pull request that touches no on-chain code still gets a passing result in a minute.
`scripts/github-settings.sh` makes it required, through a repository ruleset that admins may bypass (so a history rewrite can still be force-pushed), and switches on private vulnerability reporting, which every program's `security.txt` names as its contact.
Both settings need the repository public on GitHub Free; `scripts/make-repo-public.sh` ran it when the repository went public on 2026-11-20, and both are on.

`.github/workflows/advisories.yml` checks every tracked `Cargo.lock` with `cargo audit` (0.22.0) against the RustSec advisory database, failing on any vulnerability or unsound advisory, and `pnpm-lock.yaml`'s production dependencies with `pnpm audit --prod`, when a lock file changes, every day at 06:41 UTC and on demand; a failed daily run opens an issue or comments on the open one (`BAR-46`, hardening findings H075 and R2T-14 of [#74](https://github.com/imDev2023/testing-pipeline/issues/74)).
Unmaintained crates are only reported, since they come through Solana's and LiteSVM's own dependencies; a lock file's own `.cargo/audit.toml` may ignore an advisory, each with the reason it cannot reach that tool's users.
Its first run found `url` 2.5.8 (RUSTSEC-2026-0592), reached through `pipeline-client` in the tests and in Canary, and both lock files moved to 2.5.9; no program's bytes contain `url`.
Auditing `scripts/quote-devnet` then found two more: one fixed by a lock bump, and RUSTSEC-2026-0387 ignored there with its reason.

The first run, on [the PR that added CI](https://github.com/imDev2023/testing-pipeline/pull/102) on 2026-11-12, took 9 minutes from cold caches: `rust` 9 minutes (2 minutes 13 seconds of it compiling cargo-build-sbf, then the SBF build in 44 seconds, clippy in 64 seconds and the test build in 49 seconds), `kani` 3 minutes with Kani's install, `typescript` 28 seconds, and `changes`, `no keypairs` and `gate` a few seconds each.

### CI on the owner's iMac

Since the repository went public on 2026-11-20, CI runs on GitHub's runners, which cost nothing for a public repository: `CI_RUNS_ON` is deleted and the iMac's runners are stopped and unregistered, so a pull request from a fork can never reach them.
The rest of this section is how CI ran before, kept for a private repository.

While the repository is private, GitHub's included Actions minutes run out, and from 2026-11-12 GitHub refused to start any job; so on 2026-11-13 the owner moved CI to the iMac (`BAR-39`).
Both workflows run where the repository variable `CI_RUNS_ON` says, as a JSON list of runner labels, and on GitHub's runners when it is unset:

```bash
gh variable set CI_RUNS_ON --repo imDev2023/testing-pipeline --body '["self-hosted","testing-pipeline"]'   # the iMac
gh variable delete CI_RUNS_ON --repo imDev2023/testing-pipeline                                          # GitHub's runners again
```

The iMac's runners are two Docker containers from `scripts/ci-runner/` (Ubuntu 24.04 with what the jobs take from GitHub's image, and GitHub's runner at a pinned, checksummed release), so the `rust` and `kani` jobs of one run go side by side.
Each has 8 CPUs and 7 GB of Docker Desktop's VM and its own home volume, which keeps its registration and the toolchains, Kani, Z3 and cargo registry the jobs install, so the cache steps run only on GitHub's runners.
No host folder is mounted: a job sees nothing of the Mac's files, keys or `~/.config`.

- `scripts/ci-runner/start.sh` builds the image, registers each runner the first time (with a one-use token from `gh`) and starts them; they restart with Docker Desktop.
- `docker compose -f scripts/ci-runner/compose.yml logs -f` follows them, and `docker compose -f scripts/ci-runner/compose.yml down` stops them and keeps their volumes.
- A job waits in the queue while Docker Desktop is not running, so the iMac must be awake for CI to finish.
- They are for a private repository only: their home volumes outlive each job, so a pull request from a fork must never run on them; `scripts/make-repo-public.sh` deletes `CI_RUNS_ON`, stops the runners and unregisters them before it makes the repository public.
- To start a runner afresh, remove it under the repository's Settings, Actions, Runners, then its volume (`docker volume rm testing-pipeline-ci_runner-1`), and run `start.sh` again.

### The repository and its archive

Since the move of 2026-11-19 ([#167](https://github.com/imDev2023/testing-pipeline/issues/167), decision `SUITE-46`), `imDev2023/testing-pipeline` is a new repository, and the old one is `imDev2023/testing-pipeline-archive`, private for good.
The move was needed because GitHub's read-only pull request refs of the old repository still pointed at commits holding MetalLegBob's profile and the archive of his X posts, and only GitHub Support could delete them.

- The new repository's history is the old one's rewritten without `research/metallegbob.md` and `research/x/`, with the few lines that quoted him reworded, so every commit id changed; the ids in issue comments were pointed at the new commits, the ids inside committed files were not.
- Every issue kept its number, its comments and their dates, its labels, its sub-issues and its blocked-by links; each number that was a pull request is a closed placeholder issue naming the archived pull request and its squash commit, and the pull requests open at the move go on under new numbers, noted on their tickets.
- The archive holds the original pull request pages, their reviews and the history before the purge; read it, never write to it.
- On the owner's Mac, the purge's hooks in the main checkout's git folder refuse, in every worktree, a commit that adds the purged files or the private outreach lines, and a push of any branch that still carries the old history.
  A branch made before the move is moved onto the new history by `git rebase --onto origin/main <the old commit it started from>`.
- `scripts/move-repo/README.md` describes the move and its check, `bash scripts/move-repo.sh check` proves every issue number against the archive and scans every object, issue, comment and revision of the new repository, and `scripts/make-repo-public.sh`, which ran that check first, made it public on 2026-11-20 with the owner's go-ahead.

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

### Pipeline 0.2

Devnet's router was upgraded twice on 2026-11-18: in slot 523,711,920 to Pipeline's Release 0.2.0 (`e9fbf1a`), and in slot 523,772,247 to `3fd85ce` ("a swap can never lower the trader's output balance; 10 SOL fee cap").
Each upgrade made the router fixture refuse the dump, so every on-chain CI run stopped at "Fetch devnet's router" until this workspace moved, on 2026-11-19, in one PR from [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66):

- **The router has no pause.**
  `swap`, `create_market` and `register_existing_market` no longer take the config account, and the router's error numbers shifted down.
  Transactions built with Pipeline's 0.1 clients fail on the new router with nothing moved: against it, 470 of 762 of our tests failed before the move, almost all with `AccountDiscriminatorMismatch` on `strategy` in `create_market`, where the accounts had shifted.
- **A swap can never lower the trader's output balance** (`OutputDecreased`, since `3fd85ce`), whatever its minimum; Canary's direct path refuses it too (`CANARY-45`).
- **Custom actions left Pipeline's metadata and SDK.**
  A document with an `actions` section is still valid but draws a warning, and `buildActionInstruction` is gone; our strategies describe their actions under `aviary_actions` instead, which the `strategy-actions` package validates and builds (`BAR-41`).
- `pipeline-strategy-interface` is unchanged (0.1.0), so our programs' source did not change; the crates and the SDK we build with are 0.2.0.

Since 2026-11-22 the workspace is on Pipeline 0.3 (below); until then `programs/Cargo.toml` pinned `rev = "3fd85ce"`, `fixtures/pins.env` pinned its router, and Canary (`crates/`) took `pipeline-check`, `pipeline-client` and `pipeline-quoter` 0.2.0 from crates.io.
Both commits were checked as the bar asks: `solana-verify build` 0.5.2 in Docker with `--arch v3` gave executable hash `7cbf5998a6c93213148cbaa0c12271766d158a2bb839b9d4cc5f5506540004b1` for `e9fbf1a` and `98d3d0377da8e70f9d4e69add25294bb9aab752d1ca1683b0a5bf74bd512c0f5` for `3fd85ce`, each equal to the executable hash of the router devnet ran at the time (its `solana program dump` with trailing zeros removed).
Moving the `rev` changed the workspace's lock for Pipeline's own crates only; the tax AMM still built on the host in 12 seconds.

### Pipeline 0.3

Devnet's router was upgraded on 2026-11-21, in slot 524,761,925, to Pipeline's Release 0.3.0 (`48a6b5f`, "fee mints, route, lookup tables"), without notice; the router fixture refused it, so every on-chain CI run failed at "Fetch devnet's router" until this workspace moved on 2026-11-22 in [Pipeline 0.3](https://github.com/imDev2023/testing-pipeline/issues/194), which also added the daily router pin check (`BAR-43`, "Fixtures" above).

- **Fee mints.**
  Each market has a fee mint: the one its strategy declares after `MarketInfo` in `pipeline_market_info`, or wrapped SOL if the market trades it, or none.
  A trade into the fee mint pays Pipeline's 0.25% out of what arrived, `ceil(received × 25 / 10,000)`, and the trader's minimum applies to what they keep; every other trade pays it on the input as before.
  `swap` takes the fee account of the side that pays and refuses the other (`WrongFeeAccount`), and the swap event and result carry `fee_mint`.
  Our strategies declare none (`BAR-44`), so on every market of ours that trades wrapped SOL a sell now pays Pipeline in SOL: the demo scripts set the minimum to what the trader keeps (the SDK's `keptAfterOutputFee`), the containment hook runs once on such a sell instead of twice and the token's fee account stays empty (`HOOK-35` changed), and Canary values the sale's fee in the mint the router took it in (`CANARY-34` changed) and its direct path takes it from the output as the router does.
- **Markets recorded before fee mints** cannot trade until anyone calls `migrate_market`, which appends the fee mint index to the `Market` account (373 bytes, from 372); our two devnet demo markets were already migrated, each with wrapped SOL (index 1) as its fee mint.
  The containment hook reads the `Market` account only up to the fee authority's bump, so the longer account changes nothing for it.
- **`route`** (up to four exact-in hops in one instruction) and **`record_lookup_table`** (a frozen address lookup table per market) are new; nothing of ours uses them yet.
- `pipeline-strategy-interface` is 0.1.1, additive (`encode_market_info`, `settle_fee_on_output`, `NATIVE_MINT`), so our programs' source did not change; `pipeline-client`, `pipeline-quoter`, `pipeline-check`, `pipeline-events` and the SDK are 0.3.0.
  `pipeline-quoter`'s `amount_out` is now what the trader keeps, and `simulate_swap` takes the fee side.

`programs/Cargo.toml` pins `rev = "48a6b5f"`, `fixtures/pins.env` pins its router, and Canary (`crates/`) takes `pipeline-check`, `pipeline-client` and `pipeline-quoter` 0.3.0 and `pipeline-strategy-interface` 0.1.1 from crates.io.
The commit was checked as the bar asks: `solana-verify build` 0.5.2 in Docker with `--arch v3`, in the image `fixtures/pins.env` pins, gave executable hash `4500c2939465439279caa0555123b44b81c63293a35ff36a1932a7cf51c49803` for `48a6b5f`, equal to `solana-verify get-program-hash -u devnet` of the router and to the executable hash of its `solana program dump`.

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

### Deploy to devnet

Built by [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66) on 2026-11-16 for every program's devnet ticket (`BAR-42`, `TAX-53`, `TAX-54` in `docs/decisions.md`).
The repo is public since 2026-11-20, so the steps below run as written: every metadata URI resolves, the demo checks it with Pipeline's validator before it registers it, and `publish.ts verify` runs at the end of the third step.
A program may also be deployed while a repo is private (owner, 2026-11-19, `BAR-21`), as the tax AMM was: then `--metadata-not-yet-public` lets the demo register a URI that cannot resolve yet, and `verify` waits until the repo is public; on a URI that resolves the flag changes nothing.

`scripts/deploy-devnet.sh <program>` deploys one program from a verified build, from a clean checkout of a commit on `main`:

- it refuses any cluster but devnet (checked by its genesis hash) or a local validator, and on devnet a worktree with changes or a `HEAD` that is not on `origin/main`;
- it builds that commit, exported with `git archive` so nothing uncommitted reaches the bytes, with `solana-verify build --library-name <lib> --arch v3` in the Docker image `fixtures/pins.env` pins (`VERIFY_IMAGE`, the image solana-verify 0.5.2 picks for `[workspace.metadata.cli] solana` 4.3.0; the script refuses when the workspace pins another version);
- it deploys, or upgrades, paid by `wallet.json`, with `upgrade-authority.json` as the upgrade authority, at the address of `<program>.json`;
- it stops unless `solana-verify get-program-hash` on the cluster equals the build's executable hash and the program's upgrade authority is `upgrade-authority.json`'s key;
- it records the program id, the executable hash, the commit, the image, the upgrade authority, the payer and the deploy slot under the program's name in `deployments/devnet.json` (on a local validator, only where `--record` says), moving the program's earlier deploy into its `history`, newest first, so a metadata still naming that deploy passes `tests/published.rs` until it is pinned again;
- an uncommitted `deployments/devnet.json` alone does not count as a change, so several programs can be deployed before their records go through one PR.
- on devnet it signs its write transactions up to `DEVNET_MAX_SIGN_ATTEMPTS` times in all, resending the unconfirmed ones with a fresh blockhash each round, and pays a priority fee of `DEVNET_COMPUTE_UNIT_PRICE` micro-lamports per compute unit, and sends the writes to the validators over TPU, the CLI's default, rather than through the RPC (`DEVNET_SEND_VIA`, which `--send-via rpc` overrides for a network that blocks QUIC to the validators; all three named at the top of the script): the tax AMM's first devnet deploys, on 2026-11-19 and 2026-11-20, sent them through public devnet's RPC with `--use-rpc` and failed three times with "Data writes to account failed: Max retries exceeded", once with the retries and the fee, after only about a quarter of the program had reached the buffer, while over TPU the whole program wrote in 14 seconds; each round waits about a minute for a blockhash to expire, so a deploy during a devnet outage gives up after about 20 minutes.

A deploy that fails part way leaves its buffer account, which holds rent for the program's full size (the three the tax AMM's failed attempts left on 2026-11-19 and 2026-11-20 held 1.74 SOL each).
The script leaves buffers alone, since another program's deploy under the same upgrade authority may be using one; list them with `solana program show --buffers -u devnet --buffer-authority <upgrade authority>` and close each failed one into the wallet with `solana program close <buffer> -u devnet -k ~/.config/testing-pipeline/devnet/wallet.json --authority ~/.config/testing-pipeline/devnet/upgrade-authority.json --recipient <wallet> --bypass-warning`.

`--build-only` builds and prints the hash and sends nothing, `--out <dir>` keeps the built program, and `scripts/test-deploy-devnet.sh` tests the script without the network or Docker.
The Docker image builds with the Solana 4.3.0 release's cargo-build-sbf and CI with 4.6.0, both on platform tools v1.58, so before a deploy the program's tests run on the very bytes to be deployed: `scripts/deploy-devnet.sh tax-amm --build-only --out <dir>`, then `SBF_OUT_DIR=<dir> cargo test -p tax-amm` from `programs/`.
On 2026-11-16 every tax AMM test, the fuzzer, the compute ceilings and `pipeline-check` among them, passed on the Docker build of `f691993`.
It needs solana-verify 0.5.2 or later, which `bash scripts/install-toolchain.sh verify` installs beside the machine's older one and `toolchain-env.sh` puts first, and Docker Desktop running.
A Docker build from a fresh export fetches and compiles every dependency, 10 to 12 minutes in all on the owner's Mac (the compile itself under 2 minutes), and the first one also pulls the image, 17 minutes then.
Built from `main` at `f691993` on 2026-11-16, the tax AMM's executable hash was `6b92098a176ee863e2176a687e4bac60569348f077d9ae04b71f73a5643e8be5` (341,336 bytes), and two builds from later commits that left `programs/tax-amm` unchanged gave the same hash.
Rehearsed the same day on a local validator started with `SKIP_PROGRAMS=tax-amm scripts/local-validator.sh ...`, so the tax AMM was first deployed by the script, as on devnet: the first deploy and then an upgrade each passed the hash and authority checks and wrote their record (`--record`), the program left upgradeable by `Gf8tq5uE...` and no deploy buffer left behind.

A program's metadata cannot name the commit that holds it, and a squash merge leaves a branch's commits off `main`, so a strategy goes public in three merges (`TAX-54`); for the tax AMM:

1. **The deploy commit.** Merge the tooling, then from a clean checkout of `origin/main`, fund the keys (`devnet-airdrop ~/.config/testing-pipeline/devnet/wallet.json --target 8`, and `--target 1` for `upgrade-authority.json`), and run:

   ```sh
   source scripts/toolchain-env.sh
   scripts/deploy-devnet.sh tax-amm --build-only --out <scratchpad>/verified
   (cd programs && SBF_OUT_DIR=<scratchpad>/verified cargo test -p tax-amm)
   scripts/deploy-devnet.sh tax-amm
   cd programs/tax-amm/scripts
   pnpm demo --cluster devnet \
     --payer ~/.config/testing-pipeline/devnet/wallet.json \
     --upgrade-authority ~/.config/testing-pipeline/devnet/upgrade-authority.json \
     --metadata-uri https://raw.githubusercontent.com/imDev2023/testing-pipeline/<deploy commit>/programs/tax-amm/metadata.json \
     --record <scratchpad>/devnet-demo.json
   ```

   On devnet the demo stops unless the metadata URI resolves and passes Pipeline's validator with zero warnings.
   In a private repo, the first registration, before the metadata is pinned, takes `--metadata-uri https://raw.githubusercontent.com/imDev2023/testing-pipeline/main/programs/tax-amm/metadata.json --metadata-not-yet-public` instead; the demo fetches `origin/main` and checks the copy that link serves.
   It registers the strategy, signed and paid by the upgrade authority, and creates only the demo market, `SOL_MARKET` (`TAX-53`): created with both fee accounts and its seed in one transaction, bought, sold, and paid out slot by slot.
2. **The record.** Take the conformance report and check the router lists the market, with `pipeline-check` from Pipeline's clone (`cargo build --release -p pipeline-check` in `fixtures/pipeline`):

   ```sh
   fixtures/pipeline/target/release/pipeline-check --url devnet --market <demo market> --fail-on-warn --json \
     > programs/tax-amm/conformance/devnet.json
   fixtures/pipeline/target/release/pipeline-check --url devnet --list-markets | grep <demo market>
   ```

   Merge `deployments/devnet.json`, the report, and the README and docs saying where the program is.
3. **The metadata.** Run `node publish.ts pin --report-commit <the record's merge commit>` in `programs/tax-amm/scripts` and merge `metadata.json`.
   Each program's `publish.ts` is a few lines naming the program; the steps are one shared tool, `packages/strategy-publish`, and the checks each program's `tests/published.rs` runs are one crate, `programs/published-check`, whose own tests hold the rules (`BAR-45`, since [the lending AMM's devnet ticket](https://github.com/imDev2023/testing-pipeline/issues/87) on 2026-11-22).
   `pin` fetches `origin/main`, refuses a report or deployed commit not on it, a report commit without the report, a report that differs from the one committed here or that checks other code than the deploy's, and hashes the report as that commit holds it.
   `tests/published.rs` fails if the metadata names a commit other than the deployed one or a report other than the committed one, or if the committed report is of other code than the deploy record's or has a warning or a failure.
   Then point the router at it and check everything published, as anyone would see it:

   ```sh
   pnpm demo --cluster devnet --register-only --payer ... --upgrade-authority ... \
     --metadata-uri https://raw.githubusercontent.com/imDev2023/testing-pipeline/<metadata commit>/programs/tax-amm/metadata.json
   node publish.ts verify --uri <that URI> --market <demo market>
   ```

   Once the metadata is pinned, the demo refuses `main`'s link on devnet, whose content moves with every later change.
   In a private repo, `--register-only` takes `--metadata-not-yet-public` as well, with the metadata commit's URI, and checks that the commit is on `origin/main` and that its copy pins the deploy with its report; `verify` then waits until the repo is public.

   `verify` checks that the URI resolves with zero warnings, every link resolves, the report hashes to its SHA-256, every commit named is on `origin/main`, the router points at the URI, and Pipeline's hosted devnet API shows the strategy with valid metadata and the deployed code hash, and each of the market's mints with exactly the trust flags `tax-amm.md` ("Mint rules") predicts.

A later deploy repeats the three steps: `deploy-devnet.sh` upgrades the program and records the new commit, and `--register-only` points the router at the new metadata.

The tax AMM went to devnet this way on 2026-11-20, while the repo was private:

- **Deploy.** `scripts/deploy-devnet.sh tax-amm` deployed `274038e` from main over TPU, in slot 524,204,276, signature `3zTGypAFRyKormHbfMW2sZHTwjDsZ9thy3AdP6bXAYsmDH2e6znpmYMZYSUkqKomXjfjTMo6MdUh4FASqjTaGdbN`.
  The executable hash is `a48b5e5962290aafe35ced955d0a8a8d6cb5cb63bd0be435fc87935d6c05db59`, which `solana-verify get-program-hash -u devnet` matched.
  Every tax AMM test, 193 of them, had passed on those exact bytes first.
- **Registration and the demo market.** The demo then ran with `--metadata-not-yet-public`:
  - `register_strategy`;
  - the demo market `C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w`, created with both fee accounts and its seed in one transaction of 1,179 bytes;
  - a buy of 0.05 SOL and a sell of 1,000 tokens, each delivering exactly its quote;
  - `distribute` for every slot, each paying exactly what the market state owed.

  Every signature and address is in `deployments/devnet-demo-tax-amm.json`, the run's `--record`.
- **Conformance.** `pipeline-check` 0.2.0 `--fail-on-warn` reported 13 pass, 0 warn, 0 fail and `exact_out_refund` skipped (`programs/tax-amm/conformance/devnet.json`), and `--list-markets` listed the market.
- **Pipeline's hosted API.** It showed the strategy with the deployed code hash, upgradeable, its metadata unreachable until the repo is public, and the market with its own checks passed and the mint flags `tax-amm.md` predicts (`mint-authority` on the demo token, none on wrapped SOL).
- **The metadata.** Pinned to the deployed commit and the report in `407179c`, and the router pointed at it; once the repo was public, `node publish.ts verify --uri https://raw.githubusercontent.com/imDev2023/testing-pipeline/407179c8381c58edf2d6b8b89018665c350f6dbf/programs/tax-amm/metadata.json --market C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w` passed every check on 2026-11-20: the URI valid with zero warnings, every link resolving at a commit on `main`, the report's SHA-256, the router's URI, and the hosted API showing the strategy with valid metadata, the deployed code hash and the flags `upgradeable` and `conformance-report`.

The buy wall AMM goes the same way, with `programs/buy-wall-amm/scripts/` for `programs/tax-amm/scripts/`, and the release gate in front of every deploy (`POOL4-54`): `deploy-devnet.sh` runs any program's `programs/<program>/scripts/pre-deploy.sh` on the bytes it built, before sending anything, and the buy wall AMM's refuses unless the gate has passed that build on that cluster.
So between the build and the deploy, the gate runs on the same build, and its record, in `deployments/release-gate/buy-wall-amm/devnet.json`, goes into the record PR with `deployments/devnet.json`:

```sh
scripts/deploy-devnet.sh buy-wall-amm --build-only --out <scratchpad>/verified
(cd programs && SBF_OUT_DIR=<scratchpad>/verified cargo test -p buy-wall-amm)
(cd programs && cargo run -p buy-wall-gate -- run --cluster devnet --candidate <scratchpad>/verified/buy_wall_amm.so)
scripts/deploy-devnet.sh buy-wall-amm
cd programs/buy-wall-amm/scripts
pnpm demo --cluster devnet --payer ... --upgrade-authority ... \
  --metadata-uri https://raw.githubusercontent.com/imDev2023/testing-pipeline/main/programs/buy-wall-amm/metadata.json \
  --metadata-not-yet-public --record <scratchpad>/devnet-demo.json
```

On devnet the demo creates one market, the worked example's (`POOL4-55`), and walks its whole life through the router: the two trades of the worked example, the wall placed and sold into, `settle`, both handovers, `pay_rewards` and `sweep_fees` for slots 0 and 2 with slot 1 refused; after every step it reads the whole market state back against the spec's formulas, and at the end it checks Pipeline's hosted API quotes the market both ways at the program's own quotes.
After the deploy, `pnpm demo --cluster devnet ... --market <the demo market's state> --trade-only` buys and sells once more and leaves every keeper job due, and `cargo run -p buy-wall-gate -- snapshot --cluster devnet --out programs/buy-wall-amm/gate/fixtures/layout-1-devnet.json` saves that market, with its jobs due, as layout version 1's fixture from a real market (`POOL4-20`); the gate's stranding test needs each fixture to hold a market whose fee slot 2 the deployed build sweeps.
After an upgrade, `pnpm demo --cluster devnet ... --market <the demo market's state>` trades the market and runs its keeper jobs again from its state as read (`POOL4-56`), and `pipeline-check` runs against it again.

Done on 2026-11-20 from `main` at `a941f9c`.
- The verified build's executable hash was `89093fa7feed9f6400cb8b405e0bfe094c1d04327a231b7d1fed449d3c14dac9` (8 minutes in Docker), and all 226 buy wall AMM tests passed on those exact bytes.
- The gate passed it on devnet, with no market there yet and one of its own.
- `deploy-devnet.sh` ran the pre-deploy check, which found that pass, and deployed over TPU in slot 524,228,154; `solana-verify get-program-hash -u devnet` gave the same hash.
- The devnet demo then passed in 86 seconds:
  - the market was created and seeded in one 1,058-byte transaction;
  - the worked example's buy of 1 SOL delivered 90,081,892,629 units, and its sell back 980,099,999 lamports, trimming 39,351,849 units;
  - `place_wall` was refused below the threshold, then after a second buy tipped 123,535 lamports and placed 12,229,983 lamports;
  - the sell into the wall delivered 1,174,222,146 lamports;
  - `settle` burned 20,030,661,544 units and owed 9,722,222 to the rewards;
  - both handovers went through, `pay_rewards` paid 9,722,222 units, and slots 0 and 2 swept 16,704,332 and 4,176,083 lamports, with slot 1 refused with `RecipientUnset`;
  - Pipeline's hosted API quoted a buy of 96,235,009 lamports at 9,814,543,806 units and a sell of 9,999,596,162 units at 94,215,275 lamports, exactly the program's quotes on the same state.
- `pipeline-check --fail-on-warn` on the demo market reported 13 pass, 0 warn, 0 fail and `exact_out_refund` skipped.
- A `pipeline-check` copied from another worktree failed with `getSlot: error sending request` until it was run from the path LuLu already allowed ("Known problems").

The first upgrade, to release 0.1.1 from `main` at `d83e048`, went through the gate on the same day.
- `deploy-devnet.sh buy-wall-amm` first built it (executable hash `e4bd061ef3a7662ad92deed019368d8a89f46fe07b86dc1e8e277aa708aeb5da`) and stopped before sending anything: `REFUSED: no passing release gate run for build e4bd061e…`.
- All 227 buy wall AMM tests passed on those bytes.
- `cargo run -p buy-wall-gate -- run --cluster devnet` replayed the live demo market and a market of its own with them, and passed.
- `deploy-devnet.sh` then found that pass against the deployed `89093fa7…`, upgraded the program in slot 524,292,769, and checked the hash on chain.
- `demo.ts --market GJaWKKtnFXs8CiVDz3WqFwK6hdAZ2VLwh4vpBbEAb9EU` then passed on the upgraded program:
  - the buy lowered the cap by 331,018,518 units and the sell back trimmed 331,018,523;
  - `place_wall` tipped 1,860,835 lamports and placed 738,810,291;
  - the sell into the wall crossed it, and `settle` burned 19,900,480,826 units;
  - `pay_rewards` paid 49,652,777 units, slots 0 and 2 swept 8,685,860 and 2,171,464 lamports, and slot 1 was refused;
  - the hosted API's quotes equalled the program's.
- `pipeline-check --fail-on-warn` reported 13 pass, 0 warn, 0 fail and `exact_out_refund` skipped, on build `e4bd061e…`.
- Two of the day's Docker builds failed part way with `can't find crate for ...` (`syn`, then `solana-epoch-schedule`), and the same commit built cleanly when run again ("Known problems").

The lending AMM goes the same way, with `programs/lending-amm/scripts/` and its release gate in front of every deploy, including the first (`lending-pool.md`, "A release gate"):

```sh
scripts/deploy-devnet.sh lending-amm --build-only --out <scratchpad>/verified
(cd programs && SBF_OUT_DIR=<scratchpad>/verified cargo test -p lending-amm)
(cd programs && cargo run -p lending-gate -- run --cluster devnet --candidate <scratchpad>/verified/lending_amm.so)
scripts/deploy-devnet.sh lending-amm
cd programs/lending-amm/scripts
pnpm demo --cluster devnet --payer ... --upgrade-authority ... --record <scratchpad>/devnet-demo.json
```

Before it, `npm run cli -- setup` and `status` in `scripts/kamino-devnet` must report our Kamino lending market unchanged, with the second depositor's 5 SOL in the WSOL reserve, and both reserves' Pyth price accounts must still exist, since klend's `refresh_reserve` reads them.
On devnet the demo walks the whole product on one market, as on a local validator, and steps 28 to 30 (the launchpad) are skipped; step 25's wait is `WITHDRAW_MODE_EXIT_DELAY_SLOTS` of devnet's slots, about an hour, and step 31 asks Pipeline's hosted API to list and quote the market (`LENDING-98`).
Step 27 ends with the buffer back at its target and prints two sales of the token whose output lands just inside and just beyond the buffer, which `pipeline-check --amounts` takes for the checks on both sides of the buffer's edge.
`--hosted-api <router market>` runs step 31 alone on a market an earlier run made, and `--record` writes what a run did even when it stops part way, by a failed check or a thrown error.

The lending AMM went to devnet this way on 2026-11-22 and 2026-11-23:

- **Kamino.** `setup` reported our lending market in place with nothing to create, `layout` matched every offset, and `status` showed the second depositor's 5.0001 SOL in the WSOL reserve, none borrowed and every stop off.
- **The release gate.** The verified build of `25a209c`, executable hash `34f2e33cc46f64f72e065b81318050d94fd99cc9331f77e8a6348b5fa51bfc4c`, built in 172 seconds, and every lending AMM and gate test, 263, passed on those bytes.
  `lending-gate run --cluster devnet` found no market, made and traded one of its own with them, its sale beyond the buffer redeeming 6,000,169,061 lamports from Kamino, exactly its quote, and recorded the pass (`deployments/release-gate/lending-amm/devnet.json`).
- **Deploy.** `deploy-devnet.sh lending-amm` built the commit again, the first try failing with `can't find crate` and the second building the same hash ("Known problems"); the pre-deploy check found the gate's pass, and the program was deployed over TPU in slot 525,242,911, signature `2rK27mtodhzgDZNKM8tSr8EpJJWBift2faAx8ARnk9CFg5io4ZH4P2CmA8gCwHQpV2MyF17RR4kyHzVN12nHQyKb`, with `solana-verify get-program-hash -u devnet` giving the build's hash.
- **The demo.** Its first run registered the strategy and walked steps 4 to 21, then klend refused the test borrower's borrow with `PriceTooOld`: devnet's sponsored Pyth feeds had stopped updating for over 25 minutes, past our reserves' 600-second price max age, which `setup` then raised to a week (`LENDING-40` changed); the second run's borrow landed, and public devnet dropped a connection right after, which the demo now retries.
  The third run passed every step from 4 to 30, 28 to 30 skipped, in about 90 minutes, an hour of it withdraw mode's wait, and stopped at step 31's sale, whose comparison then took the strategy's quote for what the trader keeps; with the comparison fixed, `--hosted-api` ran step 31 alone on the same market and passed (below):
  - the token held no authorities, and the market was created and funded with 0.5 SOL on its lent side in one transaction;
  - `rebalance` lent 447,949,380 lamports for 447,943,772 cTokens and a second one was refused with `WithinBand`;
  - a sale beyond the buffer built from a smaller sale's accounts was refused with `RedeemAccountsMissing`, and with its own accounts redeemed its shortfall inside the swap, the trader receiving exactly the quote;
  - the second wallet's deposit was refused with `ReserveStale` until klend's `refresh_reserve` went first, which works with devnet's Pyth accounts, and it removed in cash, in kind and the lent side alone, redeemed its cTokens at klend and locked shares;
  - with the loan held the lending yield rose from 83 to 140 lamports between slots 525,425,925 and 525,425,935;
  - `rebalance` entered withdraw mode at 1,556,837,980 lamports free, redeeming all 284,303,018 cTokens for 284,306,864, refused to move again until the wait was over, and left it at 5,574,119,164 free, lending 321,367,826;
  - with emergency mode on a sale within the buffer traded, one beyond it was refused by the quote and the swap with `BeyondBuffer`, `rebalance` with `KaminoStopped` and a cash removal with `KaminoCannotPay`, and the second wallet left in kind; with it off a sale beyond the buffer redeemed again and `rebalance` restored the buffer.
- **Pipeline's hosted API** listed the demo market and quoted it: a buy of 5,886,771 lamports at 10,379,899,096 of the token, and a sale of 5,309,366,395 at 2,898,322 lamports kept, each exactly what the program's own quote leaves the trader on the same state (Pipeline 0.3 takes its fee out of a sale into WSOL, so the strategy's 2,905,586 less 0.25%).
  So the API quotes a market whose swaps read another program's account.
- **Conformance.** `pipeline-check --url devnet --market AMJ4eVWMgqc9hZMmKDipbvwU6EQkmAvhUf4F42dNSDuu --fail-on-warn` reported 13 pass, 0 warn, 0 fail and `exact_out_refund` skipped, at its default sizes (`programs/lending-amm/conformance/devnet.json`) and with `--amounts 131473535384,134801897064`, sales paying out 99% and 101% of the buffer, resolving up to 11 strategy accounts and using up to 99,225 compute units; `--list-markets` listed the market.
- A `pipeline-check` built at a new path waited on LuLu until the owner allowed it ("Known problems").

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

## Aviary's local run

Aviary runs locally for now (`PIPESCOPE-98`): both Workers in `wrangler dev` against the Docker Postgres and devnet, from the project's `.env`.
Every terminal ticket verifies on this run until the hosted deploy of [#192](https://github.com/imDev2023/testing-pipeline/issues/192) lands (`docs/spec/pipescope-architecture.md`, Build tickets).

Node 24 (`source scripts/toolchain-env.sh`), Docker, and the project's `.env` in the main checkout, which direnv loads after `~/.config/env/global.env` (`.env.example` names its two values):

- `RPC_URL=https://devnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`: the owner's shared Helius key until Aviary has its own; direnv expands it, and nothing prints it.
- `DATABASE_URL=postgres://terminal:terminal@127.0.0.1:5462/terminal`: the Docker Postgres.

In a worktree without its own `.envrc`, prefix each command with `direnv exec "<main checkout>"`.

```sh
pnpm --filter terminal-db db:up      # the Postgres container, terminal-postgres on 127.0.0.1:5462, shared by every worktree
pnpm terminal:db:migrate             # apply packages/terminal-db/migrations to DATABASE_URL
pnpm terminal:dev:api                # terminal-api on http://localhost:8811, with --test-scheduled
pnpm terminal:dev:web                # terminal-web built through OpenNext and run on http://localhost:3111
```

- `terminal:dev:api` hands `wrangler dev` the database as `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` and `RPC_URL` through the environment, never on a command line; `wrangler.jsonc` declares `RPC_URL` as its one required secret.
  `curl localhost:8811/health` shows the database, the slot and the Worker's version; `curl "localhost:8811/__scheduled?cron=*+*+*+*+*"` fires the cron.
- `terminal:dev:web` builds the production bundle first; `pnpm --filter terminal-web dev` is the faster Next.js dev server on the same port.
- `TEST_DATABASE_URL=postgres://terminal:terminal@127.0.0.1:5462/postgres` lets the unit tests make and drop their own databases: `pnpm --recursive --filter 'terminal-*' test`.
- `pnpm terminal:lint` runs ESLint over the terminal's packages, whose TypeScript is 6.0 (typescript-eslint and Next.js do not support 7 yet); the rest of the workspace stays on 7.

### Aviary's end-to-end tests

`pnpm terminal:e2e` runs Playwright (`tests/terminal-e2e`) on the local run: it starts both Workers unless they are already up, checks every page at 1440, 390 and 360 px in the light and the dark theme, and saves each page's screenshot to `tests/terminal-e2e/screenshots/<width>-<theme>/` for the PR.
`E2E_RPC` says where the API's RPC goes: `devnet` (the default outside CI) uses `RPC_URL`; `fixtures` (CI's) replays `tests/terminal-e2e/fixtures/devnet-rpc.json` with no network; `record` (`pnpm --filter terminal-e2e record`) runs against devnet and records every answer into that file (`PIPESCOPE-102`).
The first run needs `pnpm --filter terminal-e2e exec playwright install chromium`.
Before the tests, `src/global-setup.ts` fires the cron and waits for the indexer's first run, which backfills the router's whole history into the database, so the feed has devnet's markets to show; on the recorded fixtures that history is the one recorded, so a run on an empty database draws the same pages.

### Aviary's devnet tests

`tests/devnet` holds the indexer's restart test and the parity checks against Pipeline's hosted devnet API (`docs/spec/pipescope-architecture.md`, Indexer).
Each starts its own `terminal-api` under `wrangler dev`, on a throwaway database made on `TEST_DATABASE_URL` and on ports 8822 and 8824, so it never meets a local run already up; the restart test spends a little devnet SOL in fees from the project's devnet wallet.

```sh
direnv exec "<main checkout>" pnpm --filter terminal-devnet devnet
```

They read devnet, so they never run in CI.
`wrangler dev`'s `workerd` reaches devnet only once LuLu allows its path, which differs in every worktree (`node_modules/.pnpm/@cloudflare+workerd-darwin-64@<version>/node_modules/@cloudflare/workerd-darwin-64/bin/workerd`, unsigned, so LuLu cannot allow it by signature).

Passed on 2026-11-22 with Node 24.4.1 (#113): 36 tests, in 1.4 minutes against devnet and 1.2 minutes on the recorded fixtures.

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
- **A verified build can fail part way with `can't find crate for ...`.**
  On 2026-11-20 two of about ten `solana-verify` builds failed with `error[E0463]: can't find crate for` a dependency the same build had just compiled, while the iMac's CI runner containers ran in the same Docker VM; the same commit built cleanly, to the same hash, when `deploy-devnet.sh` ran again, so run it again.
  A build that fails or is stopped leaves its container (an idle `bash` from the verifiable-build image) running; `docker ps --filter ancestor=<the image>` lists them, and the owner removes them.
- **LuLu, the Mac's outbound firewall, allows binaries by path.**
  A binary copied or built at a new path, such as `fixtures/pipeline/target/release/pipeline-check` copied into a new worktree, fails its first RPC call (`getSlot: error sending request`) until the owner allows it; run the copy LuLu already allows, or ask the owner to allow the new one.
- **Downloads from GitHub are flaky on this network**: `gh` calls hit TLS timeouts and connection resets; retry.
- **`cargo-build-sbf --install-only` asks GitHub's REST API without a token.**
  On GitHub's shared runners that call is rate limited, and on 2026-11-20 the first cold install there failed with `Failed to install platform-tools: Failed to parse Github response: error decoding response body`.
  So `install-toolchain.sh` downloads the platform tools itself, from the release's file URL with retries, checks the archive against the SHA-256 it pins for each host, and unpacks it where cargo-build-sbf looks (`SOLANA_PLATFORM_TOOLS_DIR`, or `~/.cache/solana`).
- **`Invalid syscall code 131074`.**
  `cargo build-sbf` 4.6.0 on platform tools v1.57 prints `WARN cargo_build_sbf::post_processing] Invalid syscall code 131074` for every Anchor program built here, Pipeline's own `test-strategy-cp` included (its native `test-hook` does not print it).
  CI's Linux build on platform tools v1.58 does not print it, so it belongs to v1.57, which only the owner's Intel Mac uses.
  The programs load and run in LiteSVM and on the local validator, through devnet's router, so it is noise from the toolchain, not a fault of a program.
