# Devnet facts: four Pipeline strategies

Gathered 2026-11-09 between 08:38 and 09:01 UTC, read-only.
Pipeline source: clone at `scratchpad/pipeline`, commit `a2d5bfb` ("Router verification and security audit, with the hardened router", 2026-11-09 07:14:42 UTC); file:line references below are to that commit.
RPC: Helius devnet free tier for every account read, transaction fetch and simulation; `solana-verify get-program-hash` (0.4.9) used `https://api.devnet.solana.com`.
No paid service was used and nothing was signed or sent.

## How to read the sources

- `acct X @S`: `getAccountInfo` / `getMultipleAccounts` / `getProgramAccounts` of X at slot S.
Slot times: 520324283 = 08:38:33 UTC, 520324323 = 08:38:43, 520327026 = 08:49:31, 520328047 = 08:53:33, 520329429 = 08:59:04, 520329723 = 09:00:15 (all 2026-11-09, from `getBlockTime`).
- `tx <sig>`: a transaction fetched with `getTransaction`; the full signatures are in `scratchpad/data/tx/`.
- `history`: every signature returned by `getSignaturesForAddress` for the router and each strategy program, from the first ever (2026-11-07 18:30:20 UTC) to the newest (2026-11-09 08:15:42 UTC): 291 unique transactions, all fetched and parsed (router instructions by discriminator, router events from the `emit_cpi!` self-calls, strategy instructions from "Program log: Instruction: X" with call depth).
- `bytecode`: printable strings in the ProgramData program bytes (Anchor writes every instruction name, account name and error message into the binary).
- `sim @S`: `simulateTransaction` with `sigVerify: false` (read-only; fee payer `2yJJsmhv...` named only so the simulation can run).
- `clone file:line`: the Pipeline repo at `a2d5bfb`.
- "Strategy version hash": sha256 of the ProgramData account data from byte 45 (after the 45-byte `UpgradeableLoaderState::ProgramData` header: u32 tag 3, u64 slot, Option<Pubkey>) to the end, with trailing zero bytes stripped.
This is exactly what `solana-verify get-program-hash` prints; I ran it for all four and the outputs matched mine byte for byte.
The hash of the unstripped bytes (which depends on the allocated program size) is given too.

## Router and shared facts

| # | Fact | Source |
| --- | --- | --- |
| R1 | Router `PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34`, ProgramData `3dpKiLEDnLxCDBybnc5N9iVSLDWpvVBhE4971w59JETL`, upgrade authority `2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ`, last deploy slot 520302321 = 2026-11-09 07:11:06 UTC. | acct 3dpKiLED @520324303; getBlockTime |
| R2 | Router deploy history: deployed 2026-11-07 18:30:20 UTC, upgraded 2026-11-08 13:19:53, 2026-11-08 21:09:54 and 2026-11-09 07:11:06 UTC, all by `2yJJsmhv`. | history (BPF upgradeable loader instructions) |
| R3 | Config `BmdeX3kWjQavcjggCd1YDws67szz7iqcJRa1KebtRQZ8`: admin `2yJJsmhv`, paused false, listing fee 10,000,000 lamports (0.01 SOL), listing-fee recipient `2yJJsmhv`, treasury owner `2yJJsmhv`, bump 252. | acct BmdeX3kW @520324283; layout clone programs/pipeline/src/lib.rs:907-917 |
| R4 | Exactly 4 `Strategy` accounts and 44 `Market` accounts exist: constant product 20, bonding curve 12, Pool4 port 8, outside builder 4 (the census, taken around 03:58 UTC, counted 14 constant-product markets; 6 more were created between 07:10 and 08:15 UTC on 2026-11-09). | gPA on router filtered by `sha256("account:Strategy")[..8]` and `account:Market` @520324323; every Market PDA re-derived and matched |
| R5 | Router history: 191 transactions, all succeeded: `init_fee_account` 139, `swap` 113, `create_market` 31, `register_existing_market` 13, `register_strategy` 4, `initialize_config` 1; events: 113 `SwapEvent`, 44 `MarketCreated`, 4 `StrategyRegistered`; no `update_metadata`, `sweep_fees` or `update_config` ever. | history |
| R6 | No swap so far carried an integrator or an integrator fee; 18 distinct traders in all. | history (SwapEvent.integrator) |
| R7 | The market signer of a market is the `Market` account itself: PDA `["market", strategy_program, market_state]` of the router, which signs every `pipeline_swap` call. | clone programs/pipeline/src/lib.rs:695-708, 1158; crates/pipeline-strategy-interface/src/lib.rs:38-39 |
| R8 | Pipeline fees sit in associated token accounts of the PDA `["fees", market]`; `sweep_fees` can be called by anyone and moves them to the treasury owner's (`2yJJsmhv`) associated token account. | clone programs/pipeline/src/lib.rs:601-650, 1195-1215 |
| R9 | `Strategy` layout: discriminator, program_id, metadata_uri (String, max 200), interface_version u8, registered_at i64, market_count u64, bump u8; each strategy's account is 262 bytes holding 0.0019812 SOL. | clone programs/pipeline/src/lib.rs:920-929; gPA @520324323 |
| R10 | The Program Metadata program (`ProgM6JC...`, 9,867 accounts on devnet) and the OtterSec verify program (`verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC`, 440 accounts) both exist on devnet; no account in either names any of the four strategies (filters: program id at offset 1, and at offset 40 respectively; layouts checked on sample accounts). | gPA ~@520325233 |
| R11 | OtterSec's free API returns `is_verified: false`, `message: "On chain program not verified"` and an empty `on_chain_hash` for all four strategies and the router; the empty hash suggests the API does not look at devnet at all. | `https://verify.osec.io/status/<id>`, 2026-11-09 08:39:48 UTC |
| R12 | No mint in any of the 44 markets (49 distinct mints: 31 SPL Token, 18 Token-2022) has a freeze authority, a transfer hook, a permanent delegate, a default account state, a close authority or a pausable extension; one mint (`4oJJye...`, section 1) has a transfer fee; 17 have only MetadataPointer and TokenMetadata. | acct (all mints) @520327026 |

## 1. Example constant product `yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx`

| # | Fact | Source |
| --- | --- | --- |
| F1 | Program `yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx`, owner BPF upgradeable loader, executable. | acct @520324308 |
| F2 | ProgramData `GukXAxpnnR1QEUgCbpWrEVFSF1yn5bNGcJiU62K5pZBL`, 329,205 bytes (329,160 bytes after the header), 1.67301164 SOL. | acct @520324309 |
| F3 | Upgrade authority `2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ` (not frozen). | ProgramData bytes 12..45 @520324309 |
| F4 | Last deploy slot 520151682 = 2026-11-08 21:10:04 UTC. | ProgramData bytes 4..12; getBlockTime; tx `Y1yAiDPjTcWfaqo4...` |
| F5 | Four versions in two days: deployed 2026-11-07 18:30:37 UTC, upgraded 2026-11-08 10:37:59, 13:20:09 and 21:10:04 UTC, all signed by `2yJJsmhv`. | history (loader txs `4bsJjPFj...`, `4AT5EEke...`, `4Px92oc7...`, `Y1yAiDPj...`) |
| F6 | Strategy version hash `f43d1f5df210c1d7bd7cfa9c13d08731f900b8a2acfd3fb36838c0e17ad3954c` (250,297 bytes after stripping trailing zeros); unstripped 329,160 bytes hash to `41b7b6a6d5b810ffb7adebc0c16bb83ec019df88105b7ce735b67fbba4c706ab`. | ProgramData @520324309; solana-verify 0.4.9 |
| F7 | Open source: `programs/test-strategy-cp/src/lib.rs` (731 lines), unchanged since the repo's first commit `91aa240`. The deployed bytes are not verified against it, but they are consistent: the same 7 instruction names in the bytecode, a pool account of 219 bytes (8 + 211), and a direct `pipeline_swap` simulation fails at `test-strategy-cp/src/lib.rs:183`, the line of the source's `require_keys_eq!`. | git diff 91aa240..a2d5bfb; bytecode; sim @520328099 |
| F8 | Router `Strategy` account `HVfuHwJS3d2RQxqGnjsyZvrzoZKxJiE15ZSw26oi4gxV`: registered_at 1794076259 = 2026-11-07 18:30:59 UTC, market_count 20, interface_version 1, metadata_uri `https://example.com/pipeline/constant-product.json`, bump 254. | acct @520324323 |
| F9 | Metadata URI: HTTP 404, 577 bytes of `text/html` (example.com's "Example Domain" page); a placeholder. | curl, 2026-11-09 08:39:28 UTC |
| F10 | No IDL: no Anchor IDL account at `2QxZTAWZ38yX3xNaeL4aFRHyH7A53QFRKkrFz2mRXdp2`, no Program Metadata IDL at `4M1PBPa5qDm7ivg9SHju9mU1KH8xdnc7LmsRkctF1aKr`, and the bytecode has none of Anchor's IDL instructions; no verified build (R10, R11). | acct @520325233; bytecode |
| F11 | Of the 20 markets, 18 quote; the 2 created on 2026-11-07 (`9XkNKSd8a8HKJmWWzru87pcQ9ZfT7mJL53H12ZxfK7r5` and `AiZuQxcMzLmb4eahX34BeFvnWWhx6F98P1Pq7m5pLd8Y`) have 187-byte pools from an earlier layout without `seeder` and fail `AccountDidNotDeserialize` (3003) under the current version. All 20 pools have fee_bps 30. | sim census @520328352-520328451; state bytes @520327026 |
| F12 | Activity: 26 router swaps by 7 traders (2026-11-07 18:31:55 to 2026-11-09 08:15:42 UTC); 19 direct `deposit` calls; 1 `pipeline_seed_liquidity` (from the bonding curve's `Graduate`). | history |
| F13 | Representative market chosen: `5A7chnyqWn3vDzaN8L7aaoMGxmE7YfjKBcKag5SSfv4T`. Every constant-product market has 1 or 2 swaps, so swap count does not discriminate; I took the largest SOL vault (0.31 SOL, the largest of the 20). It is also the one market seeded by a bonding-curve graduation. | vaults @520327026; history |
| F14 | Market `5A7chnyq...` (its own market signer), market state `2WyT1i9tufTJ8e36nW62u5d5AwCVYy4AMzQih26XYPKs` (219 bytes, Anchor account `Pool`, owner `yRpt...`), created_by `39zx59wehvSfocr5VY6KfesDJD2Bpto5BQ5mH4L6218o`, created_at 1794137612 = 2026-11-08 11:33:32 UTC through `register_existing_market` inside the curve's `Graduate` transaction, supports_exact_out true. | Market acct @520324323; tx `ykke3HnJhX9HRr7S...` |
| F15 | Pool state: mint_a `4oJJye...`, mint_b wSOL, reserve_a 271,021,619,603 (271,021.619603 tokens), reserve_b 310,000,000 (0.31 SOL), fee_bps 30, market_signer `5A7chnyq...`, seeder `CcHbFanZ3CiWQtPuSAb2rmcoskPFvPegfYjQzgontZv` (an off-curve PDA used by the bonding-curve program), bump 255. | state @520327026; layout clone programs/test-strategy-cp/src/lib.rs:324-340 |
| F16 | Vaults: `CEWCRBc75oHQkDTGtgeadYBvhHpPwAXwD1xsh3E74ZWq` (Token-2022, owner = pool) 271,021.619603 `4oJJye`; `75jj5nmhtVGKBswbh9nHVRdJ3kNcuGszS6RhjPpRQXxU` (SPL Token, owner = pool) 0.31 wSOL; neither has a delegate or close authority. | acct @520327026 |
| F17 | Mint `4oJJyeB4gyLU6bguKV4ucWhYiiJK4LCCea2oB8Rh8tpq`: Token-2022, decimals 6, supply 1,200,000.000000, mint authority `B1dQr5PSH9BB6vnZc8LGaGjyx4oPYBibWZ2x8pREjiZE` (still set, can mint more), freeze authority none, TransferFeeConfig 100 bps (older and newer both, epoch 1203) with maximum fee u64::MAX (no cap), transfer-fee config authority and withheld-withdraw authority both `B1dQr5...`; no other extension; no token or Metaplex metadata. | acct @520327026 |
| F18 | Mint wSOL `So11111111111111111111111111111111111111112`: SPL Token, decimals 9, no mint or freeze authority. | acct @520327026 |
| F19 | Seeding at graduation: the curve's escrow sent 0.3 SOL and 285,714.285714 `4oJJye`; 280,028.571427 arrived (1.99% less, the transfer fee). | tx `ykke3HnJ...` token balance deltas |
| F20 | One router swap, the only trade so far: 2026-11-08 11:33:33 UTC, trader `vbKLAhRDDEZBduZfnC3fVzUsA3dRsLNDUdppCXQDvtW`, 0.01 SOL in, 8,916.882305 tokens received (the vault sent 9,006.951824; 1% withheld by the transfer fee), Pipeline fee 0.000025 SOL. Looked back over the whole history. | tx `ms4GJqZK2xhXdUyx...`; history |
| F21 | Pipeline fee accounts: wSOL `BZHyyjjsnL7gVPAYRjonvKRZbAgAkcvGKRi935QMY7f3` 0.000025 SOL; `4oJJye` `6Jk7BYm78mBvL8sxVhBFbWENAUqn7bokB8gNSBnHyfsQ` 0 (fee authority `AUks8yFjxEbf9ukvGEGRnh1iq1ASfY7Z6qxfU6E8oQmB`). | acct @520329429 |
| F22 | Live quote at vault level (before the Pipeline fee and the token's transfer fee): 0.01 SOL in gives 8,444.809036 tokens. A tiny trade: 0.00001 SOL gives 8.716124 tokens, and selling 8.716124 back against the same state gives 9,939 lamports (ratio 0.9939, two 0.30% fees). | sim @520328047; @520329027-520329029 |
| F23 | Bypass refused: a direct `pipeline_swap` with another key in the market-signer slot fails `NotPipeline` (6001) "Caller is not this pool's Pipeline market" at `test-strategy-cp/src/lib.rs:183`. | sim @520328099 |

### From source (constant product)

| # | Fact | Source |
| --- | --- | --- |
| S1 | Non-Pipeline instruction `deposit(amount_a, amount_b)`: anyone may call it with their own tokens; it issues no LP shares and the program has no withdraw instruction, so deposited liquidity can never be taken out (short of an upgrade). While either reserve is empty a deposit must add both tokens. | clone programs/test-strategy-cp/src/lib.rs:259-316, 694-715 |
| S2 | Optional `pipeline_seed_liquidity`: any signer can be the seeder; it creates a pool at `["seeded", seeder, mint_a, mint_b, fee_bps]`, funds it from the seeder's escrows at the price their amounts imply, and issues no LP. | clone lib.rs:66-140, 588-640 |
| S3 | Authority checks: `pipeline_init_market` requires the market signer to be the router PDA for this pool and to sign (lib.rs:44-50, 552); `pipeline_swap` requires the market signer to sign and equal `pool.market_signer` (lib.rs:183-187, 674); `deposit` checks the pool's mints and vaults with `has_one` (lib.rs:697). There is no admin, owner or pause in the program; the only privileged party is the upgrade authority. | clone |
| S4 | Fee: `fee_bps` is chosen by whoever creates the market (`InitParams { fee_bps: u16 }`), must be below 10,000 (so up to 99.99%), is part of the pool's seeds and never changes; the fee stays in the pool's reserves (the full input is added to `reserve_in`), there is no fee recipient. | clone lib.rs:40-42, 59, 250-255, 319-322, 415-424, 557 |
| S5 | `pipeline_swap` checks the market signer, so bypass is not possible. | S3 |
| S6 | Quote and swap share code: both go through `Pool::quote`. | clone lib.rs:171-175, 206-212, 392-412 |
| S7 | Pricing: exact-in `out = floor(r_out × in × (1 − fee_bps/10,000) / (r_in + in × (1 − fee_bps/10,000)))`; exact-out input is the least that yields the output, rounded up; refuses while either reserve is 0. | clone lib.rs:396-444 |
| S8 | Swaps credit only what arrived in the input vault beyond the recorded reserve, capped at what the router sent, so donations do not move the price and transfer-fee tokens work; reserves move by the trade itself, not by vault balances. | clone lib.rs:202-204, 248-255; crates/pipeline-strategy-interface/src/lib.rs:256-260 |
| S9 | `supports_exact_out` true; `pipeline_resolve_accounts` returns only the output vault. | clone lib.rs:147, 153-169 |

### Instructions (constant product)

From source and bytecode; counts are calls seen in the whole history.

- `pipeline_init_market` (router only, S3): 19 calls via `create_market`.
- `pipeline_market_info`: 20 calls (19 at creation, 1 at `register_existing_market`).
- `pipeline_resolve_accounts`, `pipeline_quote`: read-only, never sent (simulated by clients).
- `pipeline_swap` (router only): 26 calls.
- `pipeline_seed_liquidity` (any seeder): 1 call, from the bonding curve's `Graduate`.
- `deposit` (anyone): 19 direct calls.

### Open questions (constant product)

- The deployed bytes are not byte-verified against `a2d5bfb`; the last deploy (2026-11-08 21:10 UTC) predates that commit and also `a8b1b1d` (21:14 UTC), though the strategy's own file has not changed since `91aa240`.
- The two 187-byte pools from 2026-11-07 cannot be read by the current code and there is no migration instruction; their tokens stay where they are unless the program is upgraded again.

## 2. Bonding curve `ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb`

Not open source: the brief listed it as one of the two open-source examples, but the Pipeline repo at `a2d5bfb` contains only `test-strategy-cp`, `test-strategy-evil` and two test hooks, and none of MetalLegBob's other public repos (`fantastical-finance-factory`, `drfraudsworth-jupiter-adapter`, `integration-template`, `solana-vibes-kit`) has it; `gh search code` for the program id found nothing.
Everything below therefore comes from bytecode, transactions, account bytes and simulations, and anything marked "inferred" is my reading, not a decoded fact.

| # | Fact | Source |
| --- | --- | --- |
| F1 | Program `ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb`, ProgramData `AhH83hnARcNvXedD2W3tau9aHTPj4g89gNiWSpJuEiPX` (535,329 bytes, 2.72012156 SOL), upgrade authority `2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ`. | acct @520324311-520324312 |
| F2 | Last deploy slot 520151724 = 2026-11-08 21:10:14 UTC; three versions: deployed 10:38:15, upgraded 13:20:26 and 21:10:14 UTC that day, all by `2yJJsmhv`. | ProgramData; history (`5FahLFcs...`, `5MqT6Ety...`, `6CKqmfqF...`) |
| F3 | Strategy version hash `74fca48eb995bb0ab472f642c0c88ac9125168797effe3c880bc6ce4309c3923` (357,713 bytes stripped); unstripped 535,284 bytes hash to `693c5527717d79a25c4d436707ef663caba07a8183aa522cf5383d5f2dccba7a`. | ProgramData @520324312; solana-verify |
| F4 | An Anchor program whose source path is `bonding-curve/src/lib.rs`; its state account is the Anchor account `Curve` (discriminator `bfb4f942b44733b6` = `sha256("account:Curve")[..8]`). | bytecode; state bytes |
| F5 | Router `Strategy` account `iHv1eQKmzW4nSbGTfanK4bwsjoHiwSWUtq7mf4eNSVR`: registered_at 1794134337 = 2026-11-08 10:38:57 UTC, market_count 12, interface_version 1, metadata_uri `https://example.com/pipeline/bonding-curve.json`, bump 255. | acct @520324323 |
| F6 | Metadata URI: HTTP 404, 577-byte example.com HTML page. | curl 08:39:28 UTC |
| F7 | No IDL (none at `7ntxMp6nm9TTngCswcWszk7e62dUM2XmRdust8Qw9vGX` or `6nwduZZAybckJR47pHSoUdU1zS4UwVnk32vsSLwbYoTo`; no IDL instructions compiled in); no verified build. | acct @520325239; bytecode; R10-R11 |
| F8 | 12 curves, all paired with wSOL. 9 have graduated and refuse quotes with `WrongStatus` (6004) "Not allowed in the curve's current status" (byte 8 of their state is 3); 3 created 2026-11-08 13:45-13:47 UTC (`6tbu9cVF...`, `EFpSeL9z...`, `6efYzb4y...`) are open and have never traded (byte 8 is 1). | sim census @520328352-520328451; state bytes @520327026 |
| F9 | The 9 graduations created all 8 Pool4-port markets and 1 constant-product market, each through `pipeline_seed_liquidity` on the target and `register_existing_market` in the same transaction. | history |
| F10 | Activity: 25 router swaps (20 buys with 7.56263579 SOL in, 5 sells with 0.733461717 SOL out) by 3 traders, 2026-11-08 10:39:17 to 21:11:13 UTC; none since. | history |
| F11 | Representative market chosen: `24UgWpWcjGxAT5L6fNMvWsUjvs1UWtWvycGozWMEwKiq`, the most swaps (5) of the 12. It has graduated. | history |
| F12 | Market `24UgWp...`, market state `6TgqdQGYRtBpQn9KKRMtgvEYYdN9hZBc7uYDUimWDZXy` (1,231 bytes), created_by `B1dQr5PSH9BB6vnZc8LGaGjyx4oPYBibWZ2x8pREjiZE`, created_at 1794137410 = 2026-11-08 11:30:10 UTC, supports_exact_out true, mints [`FW8z4f...`, wSOL], vaults [`8D2N27WTn3ehfAqXC7ewLP16WtGYnBbKJLmHNPtNvxbD`, `7LoMb7HrKvWWu3GTrcJmMoVdwhbXmofMtZ1Gw4mvD7g6`]. | Market acct @520324323; tx `58wcGcqx6w4fwp84...` |
| F13 | The token mint was created by the curve in the same transaction (the mint `FW8z4f...` co-signed as a fresh keypair; the bytecode error "A new mint must be a fresh keypair that signs"), and 1,000,000,000 tokens were minted into the curve's vault. | tx `58wcGcqx...`; bytecode |
| F14 | Mint `FW8z4fjAh8TUJzkQM8qrWPn8KuctjiYuca5urj3aKsw7` ("Pipeline E2E", PE2E): Token-2022, decimals 6, supply 993,211,961.148530, mint authority none, freeze authority none, MetadataPointer to itself (authority none), TokenMetadata with update authority none and uri `https://example.com/pipeline/e2e.json`; no hook, fee or delegate. The 6,788,038.851470 missing from 1e9 were burned by the Pool4 port's `SettleRetired` (section 3, F18). | acct @520327026 |
| F15 | Vaults now: `8D2N27WT...` (Token-2022, owner = curve state) 23,750,000 PE2E; `7LoMb7Hr...` (SPL Token) 0 wSOL. | acct @520327026 |
| F16 | Init data passed to `create_market` (338 bytes; `max_creator_lamports` 0.1 SOL), decoded where unambiguous: u8 0, decimals 6, name "Pipeline E2E", symbol "PE2E", uri, then u8 0, u64 1,000,000,000,000,000 (1e9 tokens), u64 2,000,000,000, u64 5,000,000,000, u16 100, pubkey `B1dQr5...`, u16 500, pubkey `B1dQr5...`, u64 120, further bytes including the Pool4 port's program id `4ajWF6...`. Inferred: 100 = creator fee in bps (F18), 500 = creator allocation in bps (F19), `4ajWF6...` = graduation target; the 2 and 5 SOL values and 120 are unknown (virtual reserve, graduation threshold and a delay are candidates). | tx `58wcGcqx...` instruction data |
| F17 | Graduated 2026-11-08 11:31:10 UTC by `Graduate` signed by `39zx59we...` (not the creator) into Pool4-port market `2g5T3r4L...`: 5.0456 SOL and 211,111,111.111112 PE2E moved from the curve to the new market, and the caller received 0.01 SOL. | tx `3QxDnmP96s4diUdq...` |
| F18 | Creator fees: `ClaimCreatorFees` signed by `B1dQr5...` paid it 0.064118 SOL at 11:31:11 UTC, after 5.762 SOL in and 0.643 SOL out had crossed the curve: 1.0% of the SOL volume in both directions. | tx `5bfmTzLiyFScpMyk...`; history |
| F19 | Creator allocation: `ClaimAllocation` by `B1dQr5...` moved nothing at 11:30:51 and 26,250,000 PE2E at 11:32:12 UTC; 23,750,000 PE2E remain in the curve's vault; 26.25M + 23.75M = 50M = 5% of the supply. | txs `GtrormKTuvc24DXb...`, `3bwXkZdyYPwpVBR7...`; acct @520327026 |
| F20 | Router swaps on this market (whole history): 4 buys with 5.762495914 SOL in, 1 sell of 124,343,813.017670 PE2E for 0.642778244 SOL, traders `vbKLAhRD...` and `BJZJJkqJp234fMySbnFERD7vx3rbjdd65DDpfDssgEg9`, 11:30:12 to 11:31:08 UTC. | history |
| F21 | Pipeline fee accounts: wSOL `6c2L4c7SJSCyAvrNHkTzHKfSBBPbvisj3jWRAwjapRh9` 0.01440624 SOL; PE2E `B71ASx31F9uToHterCgWqzJdbA8thsgBJm18htv4FPQV` 310,859.532545 (fee authority `C5J2b4KwqGMip12boei42a8otTEAi3GVEK9cqoEr2aFM`). | acct @520329429 |
| F22 | State byte scan (layout unknown): status byte 3 at offset 8; token mint, wSOL, both vaults, Token-2022 and SPL Token program ids, the market signer, `B1dQr5...` at offsets 364, 396 and 526, the Pool4 port id at 486 and 756, the constant-product id at 622, PDA `ChBuiHV2H8TLxX5Pqo9o9UdyvkJGjNz2do5QBqY35pXi` at 660, and the new Pool4 market state `F6f6xB...` at 788, then 12 empty 32-byte slots. Inferred: the constant-product program is the fallback graduation target (bytecode: "The fallback target is only allowed 3 days after completion"). | state @520327026 |
| F23 | Bypass refused: a direct `pipeline_swap` with another key in the market-signer slot fails `NotPipeline` (6001) "Caller is not this curve's Pipeline market" at `bonding-curve/src/lib.rs:352`. | sim @520328103 |
| F24 | A live curve quotes: on `6efYzb4yWss5gpEmEjZxF7WkDL5Kzj4Pt6nHj1dednYp`, 0.01 SOL buys 101,807,639.836289 tokens; a sell quote fails `CannotFill` (6006) "The curve cannot fill that trade" because that curve holds no SOL yet. | sim @520328903, @520329041 |
| F25 | Every wallet that touched this market (creator `B1dQr5...`, keeper `39zx59we...`, traders `vbKLAhRD...` and `BJZJJkqJ...`) was first funded by `2yJJsmhv` in one transaction at 2026-11-08 11:30:09 UTC (9.2 SOL in all); all four hold 0 SOL now. This is MetalLegBob's own end-to-end run. | getSignaturesForAddress (oldest) per wallet; getBalance ~09:00 UTC |

### Instructions (bonding curve)

From bytecode; counts and signers from the whole history.
Who may call each one is unknown beyond what was observed.

- `pipeline_init_market`: 12 calls via `create_market`.
- `pipeline_market_info`: 12 calls.
- `pipeline_resolve_accounts`, `pipeline_quote`: simulated only.
- `pipeline_swap`: 25 calls; checks the market signer (F23).
- No `pipeline_seed_liquidity`.
- `fund_curve` (accounts include `funder_token`): 2 calls by `B1dQr5...` on `7NWjaeqo...`, a curve for the existing mint `4oJJye...` rather than a new one.
- `graduate`: 9 calls, by `39zx59we...` (2) and `2yJJsmhv` (7), never by a curve's creator; pays the caller (0.01 SOL in F17).
- `claim_allocation`: 2 calls by `B1dQr5...`.
- `claim_creator_fees`: 1 call by `B1dQr5...`.
- `claim_leftover`: 1 call by `B1dQr5...` on `7NWjaeqo...`.
- `set_fee_recipient`: never called.

Error messages in the bytecode: "Init data is not valid InitParams", "Caller is not this curve's Pipeline market" (6001), "Unexpected account", "A new mint must be a fresh keypair that signs", "Not allowed in the curve's current status" (6004), "Trading has not opened yet", "The curve cannot fill that trade" (6006), "Not enough input for the requested output", "The fallback target is only allowed 3 days after completion", "The target strategy is not registered with Pipeline", "Nothing to graduate", "The target did not create and fund the new market".
Account names in the bytecode: caller, token_mint, quote_mint, token_vault, quote_vault, token_program, quote_token_program, seed_authority, token_escrow, quote_escrow, rent_payer, reward_account, new_market_state, lp, destination, funder_token.

### Open questions (bonding curve)

- The pricing formula, the graduation condition and the meaning of the 2 SOL, 5 SOL and 120 init values are unknown without source.
- Whether `graduate` is permissionless (observed callers were never the creator), who may call `set_fee_recipient`, and whether any share of the 1% goes anywhere but the creator.
- Whether quotes and swaps share code (cannot be read from bytecode).
- What `claim_leftover` returns and to whom (one observed call moved `4oJJye` tokens; not inspected further).

## 3. MetalLegBob's Pool4 port `4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD`

| # | Fact | Source |
| --- | --- | --- |
| F1 | Program `4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD`, ProgramData `DQvdNeTFTQrCDeMEgkTzA72UNUpV7TgtBtNsZLTuD3o6` (450,261 bytes, 2.28797612 SOL), upgrade authority `2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ`. | acct @520324315-520324316 |
| F2 | Last deploy slot 520151758 = 2026-11-08 21:10:22 UTC; three versions: deployed 10:38:32, upgraded 13:20:42 and 21:10:22 UTC that day, all by `2yJJsmhv`. | ProgramData; history (`2s6ht9UQ...`, `5RbTTFXm...`, `2eTiKf2z...`) |
| F3 | Strategy version hash `534a2494c0e3e421096afd8bc0b45dfeca7fc94446899f9c19acaf767c9c5d63` (304,825 bytes stripped); unstripped 450,216 bytes hash to `f89411f2424613d0ce8484adfada02f3a04249fc0cd561197a1865964a198e30`. | ProgramData @520324316; solana-verify |
| F4 | Closed source; an Anchor program whose source path is `pool4/src/lib.rs`; state account is the Anchor account `Pool4` (discriminator `f317d3bbab783309`); seeded markets use the seed string `pool4-seeded`. | bytecode; state bytes |
| F5 | Router `Strategy` account `DHrDdeG2MSFsWqqGJckiQ926AYguRHxVpBjgdaxgLBjn`: registered_at 1794134338 = 2026-11-08 10:38:58 UTC, market_count 8, interface_version 1, metadata_uri `https://example.com/pipeline/pool4.json`, bump 255. | acct @520324323 |
| F6 | Metadata URI: HTTP 404, 577-byte example.com HTML page. | curl 08:39:28 UTC |
| F7 | No IDL (none at `S8akKcAmFnoS2GcEnWAJbSRS6ujexYiP52b1bSgQKs2` or `AWHQASizAATYteq5wA7a7y8fcj6ZHD7GFSQo45u7B7DF`; no IDL instructions compiled in); no verified build. | acct @520325243; bytecode; R10-R11 |
| F8 | All 8 markets came from bonding-curve graduations (8 `pipeline_seed_liquidity` calls made by the curve's `Graduate`, then `register_existing_market`); `pipeline_init_market` and `seed_pool` were never called; every market records supports_exact_out false. | history; Market accts @520324323 |
| F9 | The state layout changed with each upgrade: 567 bytes for the 4 markets created 10:39-11:34 UTC, 591 bytes for the 2 created 13:21-13:22, 623 bytes for the 2 created 21:10-21:11 (2026-11-08). Only the two 623-byte markets can be read by the current version; the other 6 fail every resolve, quote and swap with `AccountDidNotDeserialize` (3003) "caused by account: pool". | state lengths @520327026; sim census @520328352-520328451 |
| F10 | Activity: 12 router swaps (7 buys with 0.11 SOL in, 5 sells with 0.591788829 SOL out) by 3 traders, 2026-11-08 10:39:37 to 21:11:17 UTC; none since. | history |
| F11 | Representative market chosen: `2g5T3r4LmRtgzPvdybenUMTehJ9HxM7fT7SVMszq8KCV`, the most swaps (3) and the largest SOL vault (4.889 SOL) of the 8. It is one of the six the current version cannot read (F9). | history; vaults @520327026 |
| F12 | Market `2g5T3r4L...`, market state `F6f6xBPCT6ZxXPNuFwCrDwPH7pnNdZARFChuNUfVUeBF` (567 bytes), created_by `39zx59wehvSfocr5VY6KfesDJD2Bpto5BQ5mH4L6218o`, created_at 1794137469 = 2026-11-08 11:31:09 UTC by the graduation of curve `24UgWp...` (section 2, F17), supports_exact_out false, mints [`FW8z4f...` PE2E, wSOL], vaults [`GuCnZ5aSfjieGgijmJhZ6xjgcrSzeYzc83ZE3dH4iF6e`, `43s1TNokXJgf6xtgzQDYE3t1FhC7XynEF3Ryz3H63jjW`]. | Market acct @520324323; tx `3QxDnmP96s4diUdq...` |
| F13 | Vaults: `GuCnZ5aS...` (Token-2022, owner = market state) 211,053,102.669032 PE2E; `43s1TNok...` (SPL Token, owner = market state) 4.889389322 wSOL; no delegate or close authority. Seeded with 211,111,111.111112 PE2E and 5.0456 SOL. | acct @520327026; tx `3QxDnmP9...` |
| F14 | Mints: PE2E as in section 2 F14 (Token-2022, no mint or freeze authority, metadata only); wSOL. | acct @520327026 |
| F15 | State byte scan (layout unknown): a flag 1 at offset 8, token mint, wSOL, both vaults, both token programs, the market signer, PDA `2udepSdbeGp5drvDiTTzBKythWQQVhtfAR7NtmnFGpqb` at 233, and the curve's creator `B1dQr5...` at 265 (fees are paid to this key, F18). | state @520327026 |
| F16 | Router swaps (whole history): sells of 6,217,190.650882 PE2E for 0.143424712 SOL and 2,751,850.564892 PE2E for 0.062198306 SOL, one buy of 0.05 SOL for 2,179,198.988285 PE2E; traders `vbKLAhRD...` and `BJZJJkqJ...`, 11:32:13 to 11:32:32 UTC. | history |
| F17 | Pipeline fee accounts: PE2E `7ZAFbL8CaA1SuWPvhxFW2Y26STZCNaJmM5M3zqqrxmq9` 22,422.603041; wSOL `2ZZa3P6SsmddYoNKabxQoaYDcVnzeT5Zn3ooCaxSU7Wn` 0.000125 SOL (fee authority `BJzVppdmyPBH3BPoRzBzNUeFaZdwfk2gkwPDvi37PFeG`). | acct @520329429 |
| F18 | Custom actions observed on it, all signed by `39zx59we...` (not the fee recipient): `rebalance_wall` twice, each paying the caller a SOL tip from the SOL vault (0.000307025 and 0.000030635 SOL); `settle_retired` took 6,803,005.463489 PE2E from the token vault, paid the caller 14,966.612019 (0.22%) and burned the other 6,788,038.851470 (the mint's supply fell by exactly that); `sweep_fees` paid 44,845.206080 PE2E and 0.00025 SOL from the vaults to `B1dQr5...`'s token accounts, with no signer among its accounts. | txs `5NDTC4ij...`, `5PhVCpuR...`, `cVEHucgU...`, `2JLPsh1v...` |
| F19 | The current version cannot read this market: resolve, quote and a direct swap all fail `AccountDidNotDeserialize` (3003), so its 4.889 SOL and 211.05M PE2E cannot be traded through Pipeline now. | sim @520328105 |
| F20 | Alternate live market (most swaps among the two readable ones): `eeuwZDiVP9QKmQFSWGowrHEhiec3jR5q4VMqDKwJx6u`, state `5SZEQEWQG2ZXHv5wfbUzfraiAqY1acxzGCKYzQwstr2X` (623 bytes, `2yJJsmhv` at offset 265), created 2026-11-08 21:10:54 UTC, vaults 251,903,988.326261 `3sQdZm...` and 0.081278063 SOL, 2 swaps by `2yJJsmhv`. | Market acct; acct @520327026; history |
| F21 | Quotes on `eeuwZDiV...`: 0.01 SOL buys 57,971,804.019465 tokens; a tiny trade of 0.00001 SOL and its sale back give a ratio of 0.9864 (about 1.4% lost across the two quotes). | sim @520328892, @520329035-520329037 |
| F22 | On `eeuwZDiV...`: exact-out is refused with `ExactOutUnsupported` (6005) "Pool4 trades exact-in only" at `pool4/src/lib.rs:815`; a direct `pipeline_swap` with another key in the market-signer slot fails `NotPipeline` (6001) "Caller is not this pool's Pipeline market" at `pool4/src/lib.rs:255`. | sim @520328905-520328907 |

### Instructions (Pool4 port)

From bytecode; counts and signers from the whole history.

- `pipeline_init_market`: never called.
- `pipeline_seed_liquidity`: 8 calls, all from the bonding curve's `Graduate`.
- `pipeline_market_info`: 8 calls.
- `pipeline_resolve_accounts`, `pipeline_quote`: simulated only.
- `pipeline_swap`: 12 calls; checks the market signer (F22).
- `seed_pool` (accounts include `seeder_token`, `seeder_quote`): never called.
- `rebalance_wall`: 2 calls by `39zx59we...`; pays the caller (`tip_account`).
- `settle_retired`: 4 calls (`39zx59we...` once, `2yJJsmhv` three times); burns most of the retired tokens and tips the caller.
- `sweep_fees`: 1 call; pays `recipient_token` and `recipient_quote`, which were the curve creator's accounts.

Error messages in the bytecode: "Parameters are not valid", "Caller is not this pool's Pipeline market" (6001), "Unexpected account", "The pool has not been seeded", "The pool has already been seeded", "Pool4 trades exact-in only" (6005), "The pool cannot fill that trade", "The price is too far above the reference to rebalance", "Nothing to do yet", "The vaults no longer cover the pool's accounts".

### Open questions (Pool4 port)

- Fee rates, the inventory cap, the burn share and the buy-wall rule cannot be read without source; the 0.9864 ratio is the only measured cost.
- Whether `rebalance_wall`, `settle_retired` and `sweep_fees` are callable by anyone (every observed caller was a keeper wallet or `2yJJsmhv`, never the fee recipient, which suggests so).
- Whether the six old-layout markets will ever be migrated; nothing in the bytecode suggests a migration instruction (the "Account is already migrated" strings are Anchor's own).
- Whether IMD or Adam get any share: the only fee recipient seen is the token's creator (`B1dQr5...`, or `2yJJsmhv` on newer markets).

## 4. Outside builder's "Iwao" AMM `9mAV3pMKXx67poy98jHizWM6TEeKJ5g48ZeD83xFa1UF`

| # | Fact | Source |
| --- | --- | --- |
| F1 | Program `9mAV3pMKXx67poy98jHizWM6TEeKJ5g48ZeD83xFa1UF`, ProgramData `BjCwNzgBT9CQJFCJGDshQuhi2H6yTBHbnR7Bv6CpFtzv` (726,245 bytes, 3.68997484 SOL), upgrade authority `FWbhWcufRWM3CsVb6MixpwtNXWMYQbhQo3uWEfg4vrKq`. | acct @520324319 |
| F2 | Deploy slot 520136342 = 2026-11-08 20:08:52 UTC; deployed once by `FWbhWcuf...` and never upgraded. | ProgramData; history (`4Tiq81J5V9Hm4Mj5...`) |
| F3 | Strategy version hash `062e4c0bf1c8fa0151f2d49599ae577b3fc923affb466f39a05a5fb23e8b1cfa` (726,185 bytes stripped; only 15 trailing zero bytes, so it was deployed without spare room for upgrades); unstripped hash `98eded87a784e515c8a08a0ce00fbed84a8cd23c96415c714ada41295f6baa52`. | ProgramData @520324319; solana-verify |
| F4 | Closed source. The bytecode names its own source files with Windows-style paths: `programs\iwao-amm\src\lib.rs`, `programs\iwao-amm\src\pipeline.rs`, `crates\iwao-core\src\{state,engine,num}.rs`, `crates\iwao-math\src\{u256,i256,wad}.rs`; it is an Anchor program with Anchor's on-chain IDL instructions compiled in, and it links Metaplex's `create_metadata_account_v3`. | bytecode |
| F5 | Router `Strategy` account `5A1ihzM8BVsMi7bEpEfomcEBuL7GXmxLJnmbHgaGoqeK`: registered_at 1794168546 = 2026-11-08 20:09:06 UTC, market_count 4, interface_version 1, metadata_uri `https://raw.githubusercontent.com/Hiraeth010/iwao-solana/main/docs/pipeline-metadata.json`, bump 255. | acct @520324323 |
| F6 | Metadata URI: HTTP 404, 14 bytes ("404: Not Found"). | curl 08:39:28 UTC |
| F7 | `github.com/Hiraeth010/iwao-solana` is still not public: 404 from the GitHub API and from the web page. The account `Hiraeth010` (name "Hiraeth", bio "Crypto Trader / Dev", X `@WoahWurdz`, created 2026-01-04) has 10 public repos, none Iwao; related ones are `hookedpad` (a Token-2022 transfer-hook launchpad) and `token2022-hook-census`. | gh api, 2026-11-09 08:39:34 UTC |
| F8 | No IDL despite the IDL instructions: no Anchor IDL account at `G3tRdk1iRkyR6gcWsidwsiBpryAjiux5gLAgiyxfVsbd`, no Program Metadata account (`Ajon9uLAEVABRTXR2whedWMpaGaWZCZvHF97LKbfG2Jy` and gPA); no verified build. | acct @520325247; R10-R11 |
| F9 | Factory `DYX4TRthdAxCZyuyxrkA15idch2R3eZFP1Qd7s7s31uq` (PDA `["factory"]`, Anchor account `Factory`, 241 bytes): authority `FWbhWcuf...`, treasury `GA8W1gmva6KzLUrhX64S5hzQYU5JafdfKhErQxi3iNKY` (wSOL account, 0 now), quote mint wSOL, `FWbhWcuf...` again, `9cHCWqcMhg8sZetwAF4MJJPQqVjqR72U7EhEQTa6H3VK` (the token mint of market `2u5ep2aL...`, inferred to be the "flagship"), a count of 6, then u128 values 120,000, 120,000, 60,000 and 431,443,963,228 (meaning unknown). | acct @520329719 |
| F10 | Markets are made with the program's own `create_market` (6 calls) and 4 of them were recorded with the router's `register_existing_market`; its `pipeline_init_market` is never used (bytecode message "Create Iwao markets with create_market, then register_existing_market on the router"). | history; bytecode |
| F11 | Activity: 50 router swaps (40 buys with 2.869694111 SOL in, 10 sells with 0.992706509 SOL out) by 11 traders, 2026-11-08 20:09:13 to 22:22:22 UTC; plus 28 direct `buy` and 24 direct `sell` calls on the program that never touch the router; nothing since. Every trader wallet checked was first funded by `FWbhWcuf...`. | history; getSignaturesForAddress (oldest) per wallet |
| F12 | Representative market chosen: `4FXwjRnDPA8YrBYRtpJfoJJbT7ahZJePBuSPDQMTKezd`, tied for most router swaps (16, with `FUJgo86z...`) and the most trades counting direct ones (16 + 13 buys + 10 sells = 39, against 32). | history |
| F13 | Market `4FXwjRnD...`, market state `2aHCxTQb7eG7eQctWZEDvuHtVhgY9n9etDc4bba3oSC1` (441 bytes, Anchor account `Market`), created_by `FWbhWcuf...`, created_at 1794171501 = 2026-11-08 20:58:21 UTC (program `create_market` co-signed by `GvyRi7LaU48nngUbzEPixaBiFCqUzAR34ReDpdCr99PJ`, a key with no account), supports_exact_out false, mints [wSOL, `DFH22w...`], vaults [`EhnPCaKowcJcjeVtf417vJVC8gT9M4FktzrXPHEGyr6V`, `9yeRznRvL4h4UfaGSdGRGbTSrDEjb3UGEVSxUuooe1Rv`]. | Market acct @520324323; tx `4Q8iVMvXenbg9ScQ...` |
| F14 | Vaults: `EhnPCaKo...` (SPL Token, owner = market state) 0.358870908 wSOL; `9yeRznRv...` (SPL Token) 0 `DFH22w`. The state also names a dust vault `5P6zDW4cAoskHTf353GGGMYGq6bJewVtz5TScfSqiYRh` (holds 1.0 `DFH22w`) and a fee vault `9TBu1DDxGoK2ifJrC9Q1A6awXJ9mC49VKR9DBkZd4DjC` (holds 0.003272548 wSOL), and the creator `FWbhWcuf...`. | acct @520327026, @520329723; state byte scan |
| F15 | Mint `DFH22wDYRAb8zijHanSihXfZyRJHF7R9UiSCRC8D8szr`: SPL Token, decimals 9, supply 218.906219418, mint authority = the market state `2aHCxTQb...` (the program mints on buys and the supply shrinks on sells), freeze authority none, no Metaplex metadata. | acct @520327026 |
| F16 | 217.906219418 `DFH22w`, 99.54% of the supply, sits in Pipeline's fee account `bh3BbBW4YVqj2GY57WTWerGGdwJ2W1Z4u3yKy4HiRTi` for this market (the Pipeline fee on its one routed sell); the remaining 1.0 is in the dust vault. The wSOL fee account `As86eAMYBbkNkUXwmZp3ucBkiPMGrEot7iJn6m11deha` holds 0.000990315 SOL (fee authority `AVKiLhdUNhKGj3oqFjAZuJ8zgpwW3S6but8H98ojMcBi`). | acct @520329429 |
| F17 | Strategy fee: 0.30% of the SOL side goes to the market's fee vault on routed and direct trades alike (for example 0.000131120 on 0.043575514 SOL, and 0.000019206 on 0.006357259 SOL). `split_fees` moved a fee vault's SOL 50/50 to the factory treasury and `FWbhWcuf...`'s wSOL account; `buyback` moved treasury SOL 50/50 to `FWbhWcuf...`'s wSOL account and an account of the flagship market. | txs `4syjaL7S...`, `43xiCGEX...`, `3ouRjiEi...`, `43ZdFat5...` |
| F18 | Spread: 0.00001 SOL buys 4.064593969 `DFH22w`, and selling those back against the same state gives 4,899 lamports, a ratio of 0.4899 (selling right after buying returns about half). 0.01 SOL buys 4,064.493134988; selling 100 gives 0.000120565 SOL. Historical trades agree (direct buy at 139 lamports per token, sell at 67). | sim @520328107, @520328717, @520329043-520329049; txs `3CegiE2M...`, `2xoQqWwV...` |
| F19 | Quoting a sale larger than the current supply (4,064.49 tokens) panics with "attempt to subtract with overflow" at `crates\iwao-core\src\engine.rs:389` instead of returning an error. | sim @520328109 |
| F20 | Routed swaps on this market (whole history): 15 buys with 0.396123785 SOL in, 1 sell of 87,162.487767168 `DFH22w` for 0.006338053 SOL; traders `BfqyPb8Q3sKGaHwbYNjEbch7ZrRQyny7yiJcTJ6SesyM`, `8x6p7Yk92mFwkqKpsZhRtjzLFbGzMsm51HwsKGvF5mdt`, `6hArGNsn6qpzTLowHXLvn5RZGMLiamLfXg2XxzisArrG`; 20:58:26 to 21:00:12 UTC. Direct: 13 `buy`, 10 `sell`, all with `FWbhWcuf...` paying the fee and the user co-signing. | history |
| F21 | Bypass of the router's `pipeline_swap` is refused: `NotPipeline` (6014) "Only the Pipeline router's market signer may call this" at `programs\iwao-amm\src\lib.rs:267`. Exact-out is refused: `UnsupportedTrade` (6016) at `programs\iwao-amm\src\pipeline.rs:84`. | sim @520328111, @520328909 |

### Instructions (Iwao)

From bytecode; counts and signers from the whole history (the factory authority `FWbhWcuf...` paid every direct call).

- `initialize_factory(authority)`: 1 call; its argument was `FWbhWcuf...`.
- `create_market`: 6 calls.
- `buy`, `sell`: 28 and 24 direct calls; a 0.30% fee to the market's fee vault and no Pipeline fee or swap event (a built-in route around the router).
- `pipeline_init_market`: never called (refused by design, F10).
- `pipeline_market_info`: 4 calls (via `register_existing_market`).
- `pipeline_resolve_accounts`, `pipeline_quote`: simulated only; resolve returns the token mint, both vaults and the fee vault, all writable.
- `pipeline_swap`: 50 calls; checks the market signer (F21).
- `split_fees`, `buyback`: 2 calls each.
- `deepen_quote`, `deepen_token`, `publish_manifest`, `set_metadata`: never called.
- Anchor IDL instructions (`IdlCreateAccount`, `IdlResizeAccount`, `IdlCloseAccount`, `IdlCreateBuffer`, `IdlWrite`, `IdlSetAuthority`, `IdlSetBuffer`): never called.

Error messages in the bytecode: "Output below minimum (slippage)", "Swap produced zero output", "Lifetime cap exceeded", "Insufficient inventory for this trade", "Insufficient band reserve", "Post-cap trading not implemented in this build", "Invalid market state", "Amount exceeds u64", "Treasury empty; nothing to buy back", "Market is not the flagship", "Only the factory authority may do this", "Flagship already designated", "Operation is post-cap only", "Only the Pipeline router's market signer may call this" (6014), "Account does not match the market", "Unsupported trade: exact-in between the market's two mints only" (6016), "Nothing to split".
Account names in the bytecode: factory, authority, quote_mint, token_program, system_program, treasury_quote, creator, seeder_quote, token_mint, token_vault, dust_vault, quote_vault, fee_vault, user_token, user_quote, creator_quote, founder_quote, flagship_market, token_metadata_program.

### Open questions (Iwao)

- The pricing curve (the bytecode has `wad_exp` and `wad_ln`, so probably exponential), the "lifetime cap" and "band" rules, and why the bid is about half the ask.
- Which instructions "Only the factory authority may do this" guards (`split_fees` and `buyback` were only ever called by the authority).
- Two markets were created but never registered with the router (`create_market` 6, registered 4).
- What the builder plans for the 404 metadata and the private repo.

## Surprises

- Upgrades stranded markets: after the 2026-11-08 21:10 UTC upgrade the Pool4 port cannot read 6 of its 8 markets (including the most traded, holding 4.889 SOL and 211.05M PE2E), and the constant product cannot read its 2 oldest; all fail `AccountDidNotDeserialize`, so they cannot be quoted or swapped through Pipeline.
- One key, `2yJJsmhv`, is the upgrade authority of the router and of three of the four strategies, the router's admin, its listing-fee recipient and its treasury owner; those three strategies had 3 or 4 versions in two days.
- Iwao's bid is about half its ask (ratio 0.49 on a tiny trade), it trades around the router by design (52 direct trades against 50 routed), and Pipeline's fee account holds 99.54% of its representative token's supply.
- The constant-product market seeded by a graduation trades a Token-2022 token with a 1% transfer fee and no maximum, whose creator `B1dQr5...` can still change that fee and still holds the mint authority.
- The bonding curve is not open source (only the constant product is), and neither it nor the Pool4 port publishes an IDL, metadata or a verified build; all three example metadata URLs are example.com placeholders, and the outside builder's is a 404 into a repo that is still private or absent.
- Every strategy checks the market signer in `pipeline_swap` (direct calls were refused on all four), so none can be bypassed through `pipeline_swap`; but Iwao's own `buy` and `sell`, and the constant product's `deposit`, are direct paths by design.
- No mint in any market has a freeze authority, transfer hook or permanent delegate.
- Trading so far is the authors' own testing: every wallet in the bonding-curve and Pool4 markets was funded by `2yJJsmhv` in one transaction, and every Iwao trader by `FWbhWcuf`; 9 of the 12 curves have graduated and the other 3 have never traded.
- In the constant product, liquidity can never be withdrawn (no LP shares, no withdraw instruction), and the market creator picks a fee of anything below 100% at creation (all 20 use 0.30%).

## Files

- Scripts: `scratchpad/scripts/` (`sol.py`, `step1_registry.py` to `step8_census.py`, `simlib.py`, `txsum.py`).
- Raw data: `scratchpad/data/` (`step1.json` registry and programs, `step5.json` market states, vaults and mints, `parsed.json` all 291 transactions parsed, `direct_calls.json`, `step7_sim.json` to `step10_tiny.json` simulations, `step11_fees.json`, program binaries `*.so`, transactions in `tx/`).
- Metadata responses: `scratchpad/downloads-metadata/`.
