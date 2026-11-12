# canary

The Canary checks' binary: it copies one Pipeline market into LiteSVM and trades it the way a trader would, then writes one Canary result per check.
What the checks are and why is [`docs/spec/pipescope-canary.md`](../../docs/spec/pipescope-canary.md); where the binary runs is [`docs/spec/pipescope-architecture.md`](../../docs/spec/pipescope-architecture.md), "Canary runner".

This crate runs `readable`, `conformance`, `exit_sizes`, `quote_matches_swap` and `cost`, and the control checks `direct_call`, `token_authorities`, `transaction_accounts`, `contained_mint` and `custom_instructions`.
The checks over time and across wallets come with their own ticket.
Every trade of every check passes the transfer-hook accounts its mints need, resolved as `pipeline-check` resolves them.

## Run it

From `crates/`, with Rust 1.97.1 (`rust-toolchain.toml` selects it):

```sh
cargo build --release
target/release/canary run --url devnet --market <MARKET>      # one market
target/release/canary run --url devnet --strategy <PROGRAM>   # every market of a strategy
target/release/canary run --url devnet --all                  # every market on the router
```

`--url` is `devnet`, `mainnet`, `testnet`, `localnet` or any http(s) RPC URL, read only.
`run` prints JSON on stdout: the records, the roll-up per strategy version, the notes per market, the market count, the RPC requests made and the wall time; a one-line summary goes to stderr.

The endpoint the container will serve runs locally too:

```sh
target/release/canary snapshot --url devnet --market <MARKET> > snapshot.json
target/release/canary serve --listen 127.0.0.1:8080 &
curl -s -X POST --data-binary @snapshot.json -H 'content-type: application/json' http://127.0.0.1:8080/run
```

`POST /run` takes one market's snapshot (`src/source.rs`, `Snapshot`): the market, the round from 1, the cluster's clock, and every account read by address, `null` where the cluster has none, so an address absent from the snapshot is one it lacks (`CANARY-30`).
It answers with `{"status": "results", "records": [...]}`, or with `{"status": "missing", "addresses": [...], "seed"}` when a trade named accounts the snapshot lacks.
The `CanaryRun` Durable Object adds those accounts (`null` for any the cluster does not have) and posts again with the same `seed`, at most `SNAPSHOT_ROUNDS` times; at the last round the checks that needed them are "not run", naming them (`CANARY-31`).
The snapshot may also carry `instructions`, the strategy version's instruction list as `terminal-api` stores it (`PIPESCOPE-92`, `CANARY-40`): `{"anchor": true, "instructions": [{"name": "Deposit", "calls": 12, "signers": ["<address>"]}]}`, with `"anchor": false` for a program not built with Anchor; without it `custom_instructions` is "not run", and `canary run` never has it.
The seed is chosen at random once per run and every wallet of the run comes from it, so all rounds trade from the same wallets and accounts derived from them can be supplied, while no strategy can know the wallets in advance (`CANARY-36`).
`canary snapshot` writes a complete snapshot with the seed it was recorded with, and refuses when any RPC read failed.

## How it is built

- `src/config.rs`: every policy value, as named constants, and the `harness` version every record carries (`CANARY-28`).
  `tests/policy_values.rs` greps the other sources for those values and pins a fingerprint of them to the version, so neither changes without the other.
- `src/source.rs`: the account sources, read-only RPC (`RpcAccounts`) and the snapshot (`SnapshotSource`), both `pipeline-check` `AccountSource`s, and `record_snapshot`.
- `src/market.rs`: the copy, built by `pipeline-check`'s own cloner from the cluster's own program bytes, and the session that trades in fresh clones of it with signature checks off.
- `src/swap.rs`: the one swap function behind the licence seam (`CANARY-26`) and its two implementations: `ThroughRouter`, the router's own bytes, and `DirectToStrategy`, the input's transfer, the strategy's `pipeline_swap` signed by the market PDA, Pipeline's Apache-2.0 settlement code and the fee, in the router's order (`CANARY-39`); `config::SWAP_PATH` is the one place a run's path is chosen, and `tests/swap_paths.rs` shows every check gives the same result on both.
- `src/hooks.rs`: the transfer-hook accounts of every trade, with `pipeline-check`'s resolver: the input mint's as the router's `input_hook_accounts`, the output mint's after the strategy's own accounts.
- `src/trader.rs`: a funded wallet of the run and a trade prepared without being sent, for the checks that act around a trade.
- `src/trade.rs`: a trader's legs: resolve the strategy's accounts in the current state, quote with `pipeline-quoter` holding only what an integrator holds, swap, compare.
- `src/sizes.rs`: the money side and the sizes; `src/bands.rs`: the pass and fail bands.
- `src/checks/`: each check as a measurement in the copy and a judgement that is a pure function of it.
- `src/failure.rs`: how a failure is named; `src/record.rs`: the records and the roll-up.
- `src/http.rs`: the endpoint; `src/main.rs`: the command.

Pipeline's crates come from crates.io at exact versions in `../Cargo.toml` (`PIPESCOPE-87`); none of Pipeline's source is in this repo, and the router is always loaded from the cluster's deployed bytes.

## Test it

The tests build a small cluster in LiteSVM from devnet's router, checked against the hash in `fixtures/pins.env`, and Pipeline's Apache-2.0 `test-strategy-cp` and `test-strategy-evil`, with its `test-hook` and `test-hook-refill` on Token-2022 mints (the hook also stands in for our containment hook, deployed at its program id), then copy markets out of it exactly as Canary copies them from devnet.
From the repo root:

```sh
source scripts/toolchain-env.sh
scripts/fetch-router.sh              # fixtures/router/pipeline.so
scripts/fetch-pipeline.sh programs   # fixtures/pipeline/programs/target/deploy/*.so
cd crates
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
```
