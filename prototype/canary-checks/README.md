# PROTOTYPE: Canary checks on devnet (throwaway)

A rough harness built to answer one question for the wayfinder ticket [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14): which checks should Canary v1 run, and what do they find that Pipeline's own `pipeline-check` and trust flags do not?
It is not production code: no tests, no error handling beyond what lets it run, one file.
The decisions it led to are in `docs/spec/pipescope-canary.md` on `main`; this branch is the primary source behind them and is never merged.

## What it does

For each market it clones the market from devnet into LiteSVM with `pipeline-check`'s own cloner (read-only RPC), runs `pipeline-check` on that snapshot as a baseline, then trades the same snapshot through the real router with signature checks off:

- **Sizes**: buy and sell straight back at 0.00001, 0.001, 0.01, 0.1, 1 and 10 SOL (or parts of the money vault when the market has no wrapped SOL).
- **Hold**: buy 0.01 SOL, then sell in the same slot, the next slot, and after 10 seconds, 1 minute, 10 minutes, 1 hour, 1 day, 3 days and 30 days.
- **Arrive later**: the whole round trip after each of those waits.
- **Clock at launch**: the round trip with the clock set back to the market's creation time, and 10 seconds, 1 minute, 10 minutes, 1 hour and 1 day after it.
- **Wallets**: five fresh wallets, the market creator, the strategy's upgrade authority and each mint authority.
- **Transferred tokens**: one wallet buys, sends the tokens to another, and that one sells.
- **Queue**: five wallets buy one after another, then sell in the same order.
- **Quote against swap**: every swap above is compared with a `pipeline-quoter` quote taken in the same state just before it.
- **Direct call**: `pipeline_swap` called on the strategy without the router.
- **Token authorities acting**: the mint authority mints and sells, the freeze authority freezes the buyer, the transfer-fee authority sets the fee to 100%, and the trade is run again.
- **Control facts**: the upgrade authority, and every instruction name in the program whose Anchor discriminator is also in the code.

Sizes are always set on the money side (wrapped SOL, or the mint whose vault holds the smallest share of its supply), and a sale only sells what a buy in the same run produced.

## Run it

```sh
source <a checkout of main>/scripts/toolchain-env.sh   # this branch holds only the prototype
cargo build --release
target/release/canary-proto devnet list
target/release/canary-proto devnet run out <MARKET>...
target/release/canary-proto devnet all out
target/release/canary-proto summary out
target/release/canary-proto devnet probe6002 LCHsnkMfToU5C9G28JikT3eP3AvnCZSsPUeYvVLBS52
```

`devnet` is the public RPC, which throttles; any devnet RPC URL works in its place.
Pipeline's crates come from its repository at commit `5ad130d` through Cargo; none of its source is in this repo.
`Cargo.lock` pins the same versions of third-party crates that Pipeline's own lockfile pins, so the build matches what Pipeline tests with.
The router is loaded from devnet's own bytes, as `pipeline-check` does.

## Results of 2026-11-10

`results/2026-11-10/` holds one JSON file per market (61 markets, 8 strategies, devnet slots 520,628,944 to 520,629,552), `summary.md` (the tables), `headlines.txt` and `probe6002.txt`.
The run took 2 minutes 27 seconds and 442 RPC requests, about 45 seconds of it CPU.

- 2,718 swaps were sent and 2,658 had a quote to compare with; all 2,658 matched their quote to the unit.
- 16 of the 61 markets cannot be read by their own strategy's current version (`AccountDidNotDeserialize`): 6 of 8 on the Pool4 port, 6 of 7 on `2Tmcmq...`, 2 of 3 on `4scUVy...` and 2 of 23 on the constant product.
- `EZwLuZ...` (a sniper tax) passes `pipeline-check` 14 of 14, and with the clock at the market's creation a round trip returns 0.995%, then 11.9% after 10 seconds, 66.7% after 1 minute and 99.5% from 10 minutes on.
- `9mAV3p...` (the outside builder's AMM) returns 48.7% to 49.4% on an immediate round trip at every size; `pipeline-check` passes its `round_trip` check, which only warns about a profit.
- On the three open bonding curves a buy of 1 SOL or more completes the curve and cannot be sold back (`WrongStatus`); smaller buys return 97.5% to 98.6%.
- On the constant-product market whose token has a Token-2022 transfer fee, the mint authority can mint and sell enough to take 99.0% of the SOL in the vault, and once the fee authority sets the fee to 100% a 0.01 SOL buy takes the SOL and delivers nothing.
- No strategy treated an insider's wallet differently, refused transferred tokens, changed with the waits tested, or accepted a direct `pipeline_swap`.
- The error 6002 seen in the quoter-hosting research is the constant-product strategy's own `WrongAccount`, raised at `test-strategy-cp/src/lib.rs:199` when a sale is given the buy direction's vault; `Quoter::simulate_swap` prints only the router's last log line, which repeats the code.
  With the sale's own vault the same sale succeeds.

## Known limits

- Transfer hooks are not handled (no devnet mint has one).
- The clock-at-launch run uses today's market state with only the clock set back.
- Custom instructions are listed, not called: calling them needs each strategy's argument layout.
- The freeze-authority run has never executed, because no devnet mint has a freeze authority.
