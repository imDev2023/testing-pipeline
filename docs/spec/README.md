# Spec

The build-ready spec for the Pipeline suite on devnet, charted by [Map: a build-ready spec for the Pipeline suite on devnet](https://github.com/imDev2023/testing-pipeline/issues/1).
This file holds what every product shares; each product has its own file beside it, and decisions with a lasting trade-off are ADRs in `docs/adr/`.
Terms are as in `GLOSSARY.md`, and the toolchain and its install steps are in `docs/toolchain.md`.

## Product files

- `pipescope.md`: Pipescope's first devnet version.
- `pipescope-explainer.md`: Pipescope's explainer.
- `tax-amm.md`: the tax AMM.
- One more file per product as its decision tickets close: the containment hook, Pool4 for Solana and the lending pool.

## Our products live inside Pipescope

Decided with the owner in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3).

- The tax AMM, the containment hook, Pool4 for Solana and the lending pool get no websites of their own.
- Their user actions run through Pipescope's custom-action forms, from each strategy's own complete metadata (see "Metadata, IDL and conformance report" below).
- Each product adds its own panel and forms to Pipescope when it is built, for example progress toward the unlock goal for the containment hook, the buy wall for Pool4 for Solana, the buffer for the lending pool, and the launch form and payouts that [`tax-amm.md`](tax-amm.md) describes for the tax AMM.
- So each product's build tickets include its metadata, its Pipescope panel and its Pipescope forms.

## Engineering and security bar for on-chain programs

Decided with the owner on 2026-11-10 in [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4), against Pipeline commit `5ad130d`.
It applies to every on-chain program we write: the tax AMM, the containment hook, Pool4 for Solana, the lending pool and any single-use AMM.
A program's build tickets count as done on devnet only when the program meets all of it, and each build ticket's acceptance criteria name the sections below that it covers.
External audits belong to the mainnet launch effort, which is out of scope.

### Framework and toolchain

- Anchor `=1.2.2`, with the rest pinned as Pipeline pins it: Rust 1.97.1, cargo-build-sbf 4.6.0, platform tools v1.58 (v1.57 on the owner's Intel Mac, see `docs/toolchain.md`), sBPF v3, LiteSVM 0.18.2 and Kani 0.67.0.
- When Pipeline moves a pin, we move ours to match, in a PR of its own; Anchor 2.0 waits for a stable release and for Pipeline to move.
- Native code or Pinocchio only when a build ticket measures that a program cannot fit its compute budget in Anchor, and that ticket records the measurement.
- The release profile sets `overflow-checks = true`, `lto = "fat"` and `codegen-units = 1`.
- On-chain code uses checked arithmetic and returns errors: no `unwrap`, `expect`, `panic!` or unchecked indexing.
- Each program is built by its own manifest, never as a whole workspace, because a workspace build unifies dependency features and changes a program's bytes.

### Starting point

- Each strategy starts from Pipeline's Apache-2.0 strategy template (`templates/strategy`, generated with `scripts/new-strategy.sh` from a scratchpad clone), copied into this repo and owned here; the PR that adds it notes the Pipeline commit.
- The containment hook, which is a transfer-hook program and not a strategy, starts from Pipeline's Apache-2.0 `test-hook` allowlist hook (`programs/test-hook`).
- Pipeline's crates (`pipeline-strategy-interface`, `pipeline-client`, `pipeline-check`) are git dependencies pinned by `rev`, never by `branch` as the template ships them.
- The router's source (BSL 1.1 until 2028-11-08) is never copied in.

### Strategy rules

- Our strategies refuse bypass: `pipeline_swap` accepts only the router's market signer for that market, so every swap of ours goes through the router, pays the Pipeline fee and emits a swap event ([ADR 0001](../adr/0001-our-strategies-refuse-bypass.md)).
- `pipeline_quote` and `pipeline_swap` call one shared pricing function (the template's `pricing.rs`), so a quote is exactly what the swap does.

### Test layers

Tests run against the real router.
A fixture script, from the template's `scripts/fetch-router.sh`, copies the router deployed on devnet into a gitignored fixtures folder and checks its hash against the hash pinned in the repo.
When MetalLegBob upgrades the devnet router the check fails, and a PR re-pins it deliberately after the tests pass against the new bytes.

1. **LiteSVM integration tests** of every instruction, through the router wherever the router is involved, with hostile cases modelled on Pipeline's `adversarial.rs` and `test-strategy-evil`: a wrong or missing market signer, bypass attempts, aliased and substituted accounts, and Token-2022 mints with a transfer fee and with a transfer hook.
2. **Maths proofs.** The maths lives in pure functions that take no accounts.
   Proptest runs at least 10,000 cases per property, and Kani proves them, with bounded harnesses by default and full-domain ones behind `--cfg kani_full` as in Pipeline.
   Z3 proves division and rounding where Kani cannot relate a division's output to its inputs.
   Book of Knowledge (see "Internal adversarial review") chooses the properties.
3. **Stateful invariant fuzzing**: Proptest generates sequences of swaps, custom actions and clock jumps against LiteSVM and checks after every step that value is conserved (no token is created or lost beyond the stated fees), that every holder can still exit, and that each quote equals its swap; each product's spec file adds its own invariants.
   Trident is not used: its stable release (0.12) is built on solana-sdk 2.3 and 0.13 has been a release candidate since 2026-05, so it cannot load Anchor 1.2 and Solana 3 and 4 crates.
   Revisit this if that changes, or if [Prior art for behavioural testing of Solana programs](https://github.com/imDev2023/testing-pipeline/issues/8) finds a better fuzzer.
4. **Conformance**: every strategy's LiteSVM tests run `pipeline-check`'s `check_market` on their markets and require zero Fail and zero Warn.
5. **Limits**: a compute ceiling asserted per instruction, with headroom, and a call-depth test with hooked mints wherever a program calls another program inside a swap.
6. **Outside protocols**: wherever a program calls one (the lending pool's lending market), its tests also run in LiteSVM loaded with that protocol's programs and accounts dumped from mainnet by a fixture script pinned to a slot, and against the protocol's devnet deployment if it has one.
7. **Devnet demo**: a script deploys the program, registers it, creates a market and swaps through the router with the TypeScript SDK, and every demo market passes `pipeline-check --url devnet --market <market> --fail-on-warn`.
8. **Canary checks**: once Pipescope's Canary checks exist, our strategies must pass them on devnet, like any other strategy.

A `pipeline-check` Warn, in layer 4 or 7, is accepted only with a written reason in the program's spec file; a Skip for a feature the program refuses by design (such as exact-out) needs no reason.

### CI

- One GitHub Actions workflow, required to pass before any merge that touches on-chain code.
- It runs: a check that no keypair is in the repo (as Pipeline's `scripts/check-no-keypairs.sh`), `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, each program's SBF build, test layers 1 to 5 (and 6 once its fixtures exist), and the Kani proofs and any Z3 proofs.
- The first on-chain build ticket adds it; that is the tax AMM's, the first product to build.
- Standard GitHub-hosted runners cost nothing on a public repository.

### Internal adversarial review

- Tools: Stronghold of Security (an adversarial audit) and Book of Knowledge (maths verification) from MetalLegBob's MIT-licensed Solana Vibes Kit (`https://github.com/MetalLegBob/solana-vibes-kit`), the process Pipeline's router went through twice.
  They are installed in this repo's `.claude/skills` at a pinned commit, by the first on-chain build ticket.
- Each program's last build ticket is its **hardening ticket**, run in a fresh session after its feature tickets have merged:
  - Round 1: a full Stronghold of Security audit and a Book of Knowledge pass; every confirmed finding gets a fix and a LiteSVM regression test named `sos_<finding id>`, as in Pipeline.
  - Round 2: Stronghold's verify phase and a re-audit of the code the fixes changed.
- The hardening ticket is done when no Critical, High or Medium finding is open; a Low finding is accepted only with the owner's written sign-off, recorded in the report.
- Reports go in `docs/security/<program>/`.
- Separately, every build PR gets `/code-review` at high effort before it merges.
- These reviews are internal and are never presented as audits, in metadata or anywhere else.

### Verified builds

- Every devnet deploy is a `solana-verify` (0.5.2 or later) Docker build with the same pins as Pipeline: `[workspace.metadata.cli] solana` chooses the Docker image (4.3.0 at `5ad130d`), `[workspace.metadata.solana] tools-version` chooses the platform tools, and the build passes `--arch v3`.
- Each deploy is recorded in `deployments/devnet.json`: program id, executable hash, commit and Docker image digest.
- After each deploy, `solana-verify get-program-hash -u devnet <program id>` must equal the build's executable hash; OtterSec's verified builds cover mainnet only, so on devnet we compare the hashes ourselves.
- Every program embeds a `security.txt` (the `solana-security-txt` crate) with the contact and the source repository.

### Published source

- The source is published from this repo, which must be public before the first devnet deploy of an on-chain program; making it public is the owner's action.
- `solana-verify verify-from-repo` takes this repo with the on-chain workspace as its mount path.
- The on-chain workspace carries its own Apache-2.0 `LICENSE` ([ADR 0002](../adr/0002-on-chain-source-public-under-apache-2.md)).

### Metadata, IDL and conformance report

- Every strategy publishes complete `pipeline-strategy-metadata/1` metadata that passes `pipeline-client`'s validator with zero warnings.
- `source` names this repo, the deployed commit and the program's directory; `links.idl` points at the program's Anchor IDL; `conformance` points at the devnet demo's `pipeline-check` JSON report with its SHA-256; `security.contact` is set; and every `init` form and custom action is listed.
- The metadata, the IDL and the report are committed beside the program and linked through `raw.githubusercontent.com` at the commit hash, so the content behind a link never changes.
- Each deploy updates the router's metadata URI for the strategy.
- `security.audits` stays empty.

### Upgrade authority

- On devnet every program stays upgradeable, under one project upgrade-authority key, `~/.config/testing-pipeline/devnet/upgrade-authority.json`, separate from the wallet that pays for deploys (`wallet.json`) and never committed.
  The upgrade authority also signs `register_strategy` and pays its listing fee, so it holds a little devnet SOL.
- Nothing is frozen on devnet while Pipeline's interfaces can still change.
- Pipescope gives our programs no exemption and no trusted badge: Canary checks and trust facts show them as upgradeable by a single key, exactly as they would anyone else's.
- Each product's spec file states the product's intended mainnet upgrade policy: a multisig with a timelock, then frozen once stable, unless the product says otherwise.
  The containment hook is the most sensitive, because an upgrade to it could block every contained token's transfers.
  Carrying the policy out belongs to the mainnet launch effort.

### What each product's spec file adds

- Its intended mainnet upgrade policy.
- Its compute ceilings per instruction.
- Its invariants for test layer 3, beyond the shared three.
- Any accepted `pipeline-check` Warn, with the reason.
- What its Pipescope panel shows and which actions its metadata exposes.
