# Pipeline, the router we build on

Read on 2026-11-09 from https://github.com/MetalLegBob/pipeline at commit `a8b1b1d` ("Security audit fixes and regression tests", 2026-11-08), plus a devnet census the same day.
Clone it into a scratchpad when you need the source; never copy it into this repo.
The router is source-available under BSL 1.1 until 2028-11-08 (then GPL-2.0-or-later), so we may read and test it but not run our own copy in production; everything else in that repo is Apache-2.0.

## What it is

- One Anchor program, the router, at `PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34`, keeps a registry of strategies and markets.
- A strategy is any program that implements five instructions: `pipeline_init_market`, `pipeline_market_info`, `pipeline_resolve_accounts`, `pipeline_quote`, `pipeline_swap`; an optional sixth, `pipeline_seed_liquidity`, lets another program create and fund a market in one call.
- Discriminators are `sha256("global:<name>")[..8]`, so an Anchor function of the same name matches, and native programs can implement the bytes directly.
- Strategies hold their own liquidity; the router never custodies it.
- In a swap the router moves the trader's input into the strategy's vault, calls the strategy signed by the market signer, measures balances before and after, enforces the trader's minimum output and that the trader never parts with more than `amount_in`, charges `ceil(net_sent x 0.25%)` plus any integrator fee, and emits one `SwapEvent` through a self-call.
- The trader is never a signer in the call to the strategy, so a strategy can pay into the trader's accounts but cannot take from them.
- Registration costs a one-time listing fee (0.01 SOL on devnet, capped in the program) paid by the strategy's upgrade authority, or by an immutable program through its own `["pipeline-register"]` PDA.
- Anyone can create markets; `create_market` lends the strategy at most the creator's `max_creator_lamports` for rent through a router payer and never passes the creator's own signature.
- Admin can pause swaps, market creation and registration while the router is upgradeable; once the router is frozen, the pause power ends and anyone can lift a leftover pause.

## Accounts a swap passes to a strategy (fixed prefix)

0. Market signer (signer), 1. market state (writable), 2. trader's wallet (not a signer), 3. trader's input token account, 4. trader's output token account, 5. strategy input vault, 6. input mint, 7. output mint, 8. input token program, 9. output token program.
Then the strategy's own accounts in the order `pipeline_resolve_accounts` returned them, then transfer-hook accounts.

## Integrator surface

- Discovery: `getProgramAccounts` on the router filtered by the `Strategy` and `Market` account discriminators, plus `StrategyRegistered` and `MarketCreated` events for new ones.
- Quoting: `pipeline-quoter` runs a strategy's deployed bytecode in an embedded LiteSVM (`litesvm = 0.18.2`) at about 10 to 20 microseconds a quote, applies Pipeline, integrator and Token-2022 fees, and can `simulate_swap` the whole router swap with `set_clock`; or RPC-simulate `pipeline_quote` through the TypeScript SDK (`quoteStrategy`, 50 to 300 ms).
- Account resolution: `pipeline_resolve_accounts` returns up to about 30 accounts per round, up to 4 rounds.
- Building swaps: `pipeline_client::swap` or the TypeScript SDK (`@solana/kit`); multi-hop is several `swap` instructions in one transaction, each hop paying 0.25%.
- The market's fee account for the input mint must exist before the first sell; `init_fee_account` is idempotent.
- Indexing: decode `SwapEvent` (market, strategy, trader, mints, mode, `net_sent`, `received`, `pipeline_fee`, integrator, `integrator_fee`, slot, timestamp) with `pipeline-events` or the SDK; price is `received / net_sent`, volume is `net_sent`.
- Metadata: JSON schema `pipeline-strategy-metadata/1` with name, image, links, `init` args and `actions` (custom-action forms with typed args and account sources such as `wallet`, `market_state`, `vault:i`, `wallet_token_account:i`, `pda:<program>:<seeds>`).
- The integrator guide asks integrators to show neutral facts only: upgradeable or frozen, mint and freeze authorities, liquidity, market age, volume; Pipeline does not vet strategies.

## Limits that shape what we build

- Call depth: trader, router, strategy, token program, transfer hook uses all four nested levels; a strategy that calls another protocol uses the last one, so it fails with hooked tokens (smart wallets add one more level).
- Compute: a swap through the example strategy costs about 40 to 45k units, 30 to 35k of them the router's; about 1.3M remain for strategies per transaction.
- Return data is capped at 1 KB; accounts at 10 MB.
- A token whose hook refuses transfers into the market's fee account can be bought but not sold through Pipeline; fee accounts are associated token accounts of the market's `["fees", market]` PDA, and `sweep_fees` moves them to the treasury owner's token accounts.
- Mints with frozen default account state, CPI Guard on the trader's input account, and loader-v4 strategy programs do not work.
- A mint's permanent delegate can move Pipeline's collected fees in that mint.
- Integrator fees have no cap; quotes and swaps can diverge for strategies that do not share code between them.
- Bypass is allowed: a strategy that does not check the market signer can be called directly, without the Pipeline fee or a swap event.

## Toolchain

Rust per its `rust-toolchain.toml`, `cargo-build-sbf` 4.6.0 (sBPF v3), the Agave 4.4 CLI for a local validator (run with `--deactivate-feature 6TkHkRmP7JZy1fdM6fg5uXn76wChQBWGokHBJzrLB3mj` because devnet and mainnet do not have SIMD-0268's deeper call limit yet), Node 20.19 or later for the SDK.
`scripts/devnet/smoke.ts` goes from nothing to a swap on devnet in about 0.02 SOL.
Tests run in LiteSVM (`crates/pipeline-tests`), including a hostile strategy (`test-strategy-evil`) and two transfer-hook programs (`test-hook`, an allowlist hook in 141 lines, and `test-hook-refill`).

## Security status

Three internal adversarial rounds and a "Stronghold of Security" review on 2026-11-08, every confirmed finding fixed with a regression test (`sos_h009`, `sos_h014`, `sos_h017`, `sos_h022`); no external audit; interfaces "may still change, and package names are placeholders".

Update, commit `a2d5bfb` (2026-11-09 07:14 UTC, "Router verification and security audit, with the hardened router"): formal verification of 47 router properties (Kani proofs, Z3 proofs of the fee maths, Proptest, LiteSVM; `docs/VERIFICATION.md`), a second router-only Stronghold of Security audit with no critical or high findings (one medium in the multi-hop guidance: every hop now carries its own minimum; `docs/SECURITY-AUDIT.md`), and router hardening (swaps that move nothing are refused, fee accounts cannot be the trader's input, balances are re-checked after the strategy call); still no external audit.
The swap's measurement and fees are now one pure function, `pipeline_strategy_interface::settlement::settle`.

## Devnet census, 2026-11-09 (through Helius devnet RPC)

| Strategy program | Upgrade authority | Metadata URI | Markets |
| --- | --- | --- | --- |
| `yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx` (example constant product) | `2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ` | `https://example.com/pipeline/constant-product.json` | 14 |
| `ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb` (bonding curve) | `2yJJsmhv...` | `https://example.com/pipeline/bonding-curve.json` | 12 |
| `4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD` (4-mint pool) | `2yJJsmhv...` | `https://example.com/pipeline/pool4.json` | 8 |
| `9mAV3pMKXx67poy98jHizWM6TEeKJ5g48ZeD83xFa1UF` (outside builder) | `FWbhWcufRWM3CsVb6MixpwtNXWMYQbhQo3uWEfg4vrKq` | `raw.githubusercontent.com/Hiraeth010/iwao-solana/...` (404, repository private or gone) | 4 |

38 markets in all, and 172 router transactions between 2026-11-07 18:30 and 2026-11-09 03:58 UTC.
`2yJJsmhv...` is MetalLegBob's devnet authority; the three example metadata URLs are placeholders.

## Our verdict (2026-11-09)

Pipeline moves the distribution problem up one level rather than solving it: it matters once integrators carry its markets, and on 2026-11-09 none had committed (see `research/x/pipeline-launch-thread.md`).
Its realistic early integrators are the ones that already chase long-tail venues (OKX, DFlow and Axiom carried 85% of DBC transfer-hook pool swaps on 2026-10-26, see `landscape.md`).
The 0.25% Pipeline fee rules it out for pairs that trade cheaply elsewhere (SOL-USDC); it suits markets whose assets or rules exist only there.
MetalLegBob asked publicly for a terminal (see `metallegbob.md`), which is why our first product is Pipescope.
