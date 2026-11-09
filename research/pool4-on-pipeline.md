# Pool4 on one Pipeline strategy, and what the `pool4.json` strategy is

Researched on 2026-11-09 for ticket #11; every fact below is as of that date.
Sources: IMD's docs at https://pool4.imd.fun/docs, the verified source of IMD's `CappedBurnHook` on Ethereum mainnet, Pipeline's source at commit `a2d5bfb` (read-only clone in a scratchpad, never copied here), and devnet accounts and transactions read through the free public RPC and Helius devnet.
Anything marked "inferred" was worked out from on-chain numbers, not read from source.

## Answer in brief

- Pool4 fits one Pipeline strategy whose quote and swap share one pricing function.
- The buy wall is a second liquidity segment on the SOL side only, so pricing is a two-segment curve with one boundary and no extra accounts.
- The trim and the cap ratchet can run inside `pipeline_swap` after the output is priced, as bookkeeping in the market state with no token movement, so they never change the quote and never touch the router's measurements.
- Burning, paying shares, placing the wall and sweeping fees become keeper jobs (custom actions).
- The `pool4.json` strategy (`4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD`) is not a four-mint pool.
  It is MetalLegBob's own Pool4 port for Solana: two mints (a Token-2022 token and wSOL), a trim to an inventory cap, a cap ratchet with a daily decay, a SOL buy wall that bought tokens on devnet, burns, keeper tips and a swept fee ledger (partly inferred from on-chain numbers, section 1).
  Its source is not public, its metadata URL is a placeholder, and it was registered on 2026-11-08.
- Measured compute in his port: 15.4k to 16.7k units for a buy, 12.9k to 14.2k for a sell that trims, 28.6k for a sell that fills the wall, against 8.8k to 12.0k for Pipeline's example constant-product strategy.
- Recommendation: before we build Pool4 for Solana, ask MetalLegBob whether he will ship or publish his port, and apply the map's existing rule (a product he builds himself leaves our scope).

## 1. What the `pool4.json` strategy is

### Identity

- Program `4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD`: upgradeable loader, upgrade authority `2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ` (MetalLegBob's devnet authority, see `research/pipeline-router.md`), last deployed in slot 520151758 (2026-11-08 21:10 UTC), 450,216 bytes (`solana program show`, devnet).
- The router's `Strategy` record `DHrDdeG2MSFsWqqGJckiQ926AYguRHxVpBjgdaxgLBjn` (PDA `["strategy", program]` of the router) holds the metadata URI `https://example.com/pipeline/pool4.json`, a registration time of 1794134338 (2026-11-08 10:38:58 UTC) and a market count of 8 (raw account data, devnet).
- The registration transaction is `58MmzfapKPBenZ9v8Kwxt9CLsa9JrCeY4i9K3Fnw8EvJtbzHZ3zzmtgA7H3V6vJAamqsxzjo4ixJnRKgbsV49Xe5` (https://explorer.solana.com/tx/58MmzfapKPBenZ9v8Kwxt9CLsa9JrCeY4i9K3Fnw8EvJtbzHZ3zzmtgA7H3V6vJAamqsxzjo4ixJnRKgbsV49Xe5?cluster=devnet).
- Strings in the deployed binary (dumped with `solana program dump`) name it: the crate path `pool4/src/lib.rs`, the PDA seed `pool4-seeded`, the errors "Pool4 trades exact-in only", "The price is too far above the reference to rebalance", "The vaults no longer cover the pool's accounts" and "Caller is not this pool's Pipeline market", and the instructions `PipelineInitMarket`, `PipelineMarketInfo`, `PipelineResolveAccounts`, `PipelineQuote`, `PipelineSwap`, `PipelineSeedLiquidity`, `SeedPool`, `RebalanceWall`, `SettleRetired` and `SweepFees`.
- No public source: MetalLegBob's five public repositories (`gh repo list MetalLegBob`) are `pipeline`, `fantastical-finance-factory`, `drfraudsworth-jupiter-adapter`, `integration-template` and `solana-vibes-kit`, and none holds it; GitHub code search for `pool4-seeded` and for `settle_retired rebalance_wall` finds nothing; the binary carries no `security.txt` or source link; there is no Anchor IDL account on chain (`anchor idl fetch` reports the IDL account missing).
- The census label "4-mint pool" in `research/pipeline-router.md` is wrong: `pipeline_market_info` returned two mints and `supports_exact_out: false` when market `F6f6xBPCT6ZxXPNuFwCrDwPH7pnNdZARFChuNUfVUeBF` was created (return data of transaction `3QxDnmP96s4diUdqyKjLGXpD65fd79bkakce1JqdkMVcG3q6B1YX4WPTUkyErhpBdKJsmSYKV2n4dS7AyreRZPA9`).
  "pool4" is the design's name, not a mint count.

### How its markets are made

- All 8 markets were created by MetalLegBob's bonding-curve strategy (`ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb`, crate `bonding-curve`) in its `Graduate` instruction, which calls the Pool4 strategy's `pipeline_seed_liquidity` and then the router's `register_existing_market` (logs of the 8 seeding transactions, devnet).
- So the path is a bonding-curve launch that graduates straight into a Pool4 market (Seeding in our glossary); the seed returned `SeedResult { taken: [211111111111112, 5045600000], lp_amount: 0 }` for market `F6f6x...`, so there are no LP shares and the liquidity is owned by the market.
- The token mints are Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), the other side is wSOL.
- 23 of the strategy's 31 transactions were paid by `2yJJsmhv...`, 5 by `39zx59wehvSfocr5VY6KfesDJD2Bpto5BQ5mH4L6218o` (which also received the keeper tips and a 0.01 SOL payment in a seeding transaction), 2 by `vbKLAhRD...` and 1 by `BJZJJkqJ...`; the trades look like scripted tests in four sessions on 2026-11-08 (10:38, 11:31, 13:20 and 21:10 UTC).
- The market state grew from 567 to 591 to 623 bytes across those sessions, so the layout was still changing (`getProgramAccounts` on the program, devnet).

### What it does, replayed from one market

Market `F6f6xBPCT6ZxXPNuFwCrDwPH7pnNdZARFChuNUfVUeBF` ran a full lifecycle on 2026-11-08 between 11:31:10 and 11:32:36 UTC; the numbers below are token balance changes from its transactions, replayed against a model in a scratchpad script.

| Step | Transaction | What moved |
| --- | --- | --- |
| Seed | `3QxDnmP96s...` | 211,111,111,111,112 token units and 5,045,600,000 lamports into the vaults |
| Sell | `34rPsixBFz...` | 6,217,190,650,882 tokens in (after the Pipeline fee), 143,424,712 lamports out |
| Buy | `4hJuwN81aB...` | 50,000,000 lamports in, 2,179,198,988,285 tokens out |
| RebalanceWall | `5NDTC4ijPb...` | no vault change except a 307,025-lamport tip to the caller |
| Sell into the wall | `4mL2xTo17E...` | 2,751,850,564,892 tokens in, 62,198,306 lamports out |
| RebalanceWall | `5PhVCpuRqa...` | a 30,635-lamport tip to the caller |
| SettleRetired | `cVEHucgUyg...` | 6,803,005,463,489 tokens left the token vault: 14,966,612,019 to the caller, the rest burned |
| SweepFees | `2JLPsh1v49...` | 44,845,206,080 tokens and 250,000 lamports to the fee recipient stored in the market state |

Full signatures: `3QxDnmP96s4diUdqyKjLGXpD65fd79bkakce1JqdkMVcG3q6B1YX4WPTUkyErhpBdKJsmSYKV2n4dS7AyreRZPA9`, `34rPsixBFznxvqbsSVuWVFXksSfGsoJNUEGhUFdkYybDyUaVtCd9eXR6ekHzAFR3wYea8FbRZNfYYdFR3UDj7MLU`, `4hJuwN81aBX5iM5hhxmvCpj69kG9HBPkD4jrZPJRTZ8kTDkru57N6c4bhHYMPze2i1iU7mr8Az4uzzd6rNiWXQ9Q`, `5NDTC4ijPb1aFo5MwoMJvQbG8bvFj53uNRKghdvR6L26XP7f8AmDqUs4DL6Q6eT5fFwPqMvmvKFLJZUQ4Jwogs7f`, `4mL2xTo17EU7E1m5KnH6XWv9sAmwLW4Z9fhDWoP2dYH4Dpe6Gv2NiKbpS7GbB2PNnfdxSpq8KCy3o5F4JBK4mHGL`, `5PhVCpuRqaTKbp7xzzgt6rucnityYzRE91K2fDHMDX7bTWtE6FjcndS3hFKftuanCcRR7Xtm5yArvxCfhM9XigQH`, `cVEHucgUygEb5dDvdcXmnCAJLzjgi7vEiTxMCJydVTvHuRqBLjUxDz77VAJzde62qbh74mpFBLiTkg4BiDeodWf`, `2JLPsh1v49BX3bKyfnC48ptGHba3yujdDsdqPpBNhHTGmjf2CGCCxYToE4gtAKWCMaQ6wRVdVeTD12QUGUS2MRjU` (devnet).

What the replay shows:

- Pricing is constant product, exact-in only, with two fees.
  A fee of 50 basis points of the input, rounded up, goes to a fee ledger that `SweepFees` pays out (the swept 44,845,206,080 tokens equal the two sells' rounded-up 50 basis points exactly, and the swept 250,000 lamports equal 50 basis points of the buy).
  A second fee of 15 basis points is always taken in SOL and stays in the pool: from the SOL output on a sell and from the SOL input on a buy.
  With these rules the model reproduces the sell's 143,424,712 lamports and the buy's 2,179,198,988,285 tokens to the unit (inferred from the replay; the rule is not in any published source).
- The trim is real and does not move the price.
  The buy only reproduces exactly if, after the first sell, token inventory was cut back to the inventory cap (the seeded 211,111,111,111,112) together with the proportional SOL (139,557,101 lamports) at an unchanged price (inferred).
- The trim moves no tokens inside the swap.
  `PipelineSwap` makes only the output transfer; the trimmed SOL stays in the wSOL vault as buy-wall SOL and the trimmed tokens stay in the token vault until `SettleRetired` burns them (logs of the swap and settle transactions).
  At the end the wSOL vault held exactly the curve's SOL plus the wall's SOL (4,764,094,889 + 125,294,433 = 4,889,389,322 lamports, from the market state and the vault balance).
- The cap ratchet with a daily decay is implemented.
  After the buy the stored cap is 211,110,908,307,615, which is the seeded cap minus `floor(211,111,111,111 x 83 / 86,400)` = 202,803,497, so the cap fell by a decay of 211,111,111,111 tokens a day (0.1% of the seeded inventory) over the 83 seconds from seeding to the next sell; 211,111,111,111 appears twice in the state, consistent with a cap floor equal to one day's decay, as in IMD's launch values (cap floor 1,000 IMD, cap decay 1,000 IMD a day) (inferred from the market state).
  The decay ran to the second sell's time, not the buy's, so the port applies the ratchet at a different point than IMD's hook, which ratchets only right after a swap that left inventory below the cap (inferred).
- The buy wall filled.
  The first `RebalanceWall` placed 139,250,076 lamports (the trim's SOL less the tip); the second sell paid out about 13,925,008 lamports of it as the price fell into the wall; the second `RebalanceWall` retired what the wall bought; 125,294,433 lamports remained (inferred from the tips and the final state).
  The sell that filled the wall cost 28,562 compute units against 12,890 to 14,188 for other sells.
- Keeper tips: both `RebalanceWall` tips and the `SettleRetired` tip are 0.22% of the work done (307,025 of 139,557,101 lamports; 30,635 of 13,925,008 lamports; 14,966,612,019 of 6,803,005,463,489 tokens), paid to the caller; two stored parameters equal 10,000,000 and 2,000,000 lamports, consistent with a rebalance threshold of 0.01 SOL and a tip ceiling of 0.002 SOL (inferred; IMD's are 0.1 ETH and 0.002 ETH).
- `RebalanceWall` refuses when the price is too far above a reference ("The price is too far above the reference to rebalance"), a guard against pumping the price before placing the wall; IMD's hook uses a placement floor instead (section 2).
- No 85/15 split: `SettleRetired` burned everything except the caller's tip, and no staking, bonding or node recipients exist; the fee recipient in later markets is `2yJJsmhv...`, so no share is routed to IMD or Adam that we can see.

## 2. IMD's Pool4 mechanics, from the verified hook

Read from the verified source of `CappedBurnHook` at `0xc6c965bd164c483e87d0b550671798e9a3602840` on Ethereum mainnet (Solidity 0.8.30, verified 2026-09-19; https://sourcify.dev/server/v2/contract/1/0xc6c965bd164c483e87d0b550671798e9a3602840?fields=sources, also https://etherscan.io/address/0xc6c965bd164c483e87d0b550671798e9a3602840#code).
Constructor arguments: `rewardShareBps` 1500, `minTrimTokens` 0, `lpFee` 10000 (1% in v4's millionths), `tickSpacing` 60.

- Every swap runs `afterSwap`, which collects this swap's LP fee into a separate fee ledger, then `_applyCap`, then `_updateDeploymentFloor`, then `_observeTick`; it declares no deltas, so the quote is plain Uniswap v4 maths.
- `_applyCap` reads the tokens held by the full-range position.
  If they are below the cap, the cap ratchets: `next = cap - (cap - held) x ratchetBps / 10,000`, no lower than `cap - capDecayTokensPerDay x elapsed / 1 day` and no lower than `capFloor`; the decay clock then advances by the time-equivalent of what was used, with a carried remainder so many tiny ratchets cannot beat the rate.
  If they are above the cap by at least `minTrimTokens`, it removes `liquidity x excess / held` from the position, which is price-neutral, and reverts if the price moved (`_requirePriceUnchanged`).
- Trimmed tokens are split `rewardShareBps` (at most 30%) to the rewards recipient and the rest to the burn sink; trimmed ETH goes to `retainedEth`, the buy wall's budget.
  Because v4 settles only at the end of the unlock, all of these are first held as ERC-6909 claims and turned into transfers later by `settleClaims` (a keeper job, or automatically in a later block).
- The buy wall (the hook calls it the backstop) is one single-sided ETH position from just past the price to the end of the price range, so it bids at every price from its top down to almost zero; while the price is inside it, the pool's liquidity is the full-range position plus the wall's.
- Only the permissionless `rebalance()` moves the wall: it closes the old wall, retires the tokens it bought through the same split, and places all retained ETH again, when idle ETH reaches `rebalanceEthThreshold` or the wall has converted that much.
  The keeper's tip is at most `keeperReward` and at most the pool fee on the work, so faking work never pays.
- The wall's top can be no higher in token price than `deploymentFloorTick`, which moves at once to any price the pool trades at and recovers only `floorDecayTicksPerDay` (400 ticks, about 4% a day, with elapsed time clipped to one day) toward `refTick`.
  `refTick` follows the previous block's closing tick by at most `maxRefStep` (200 ticks) per block, so one transaction cannot move it.
- The cap decay's elapsed time is not clipped, so idle days are banked for the next buy; the floor decay's is clipped to one day (both from the source).
- IMD's docs contradict themselves on launches: section 09 says a permissionless launch factory "is the plan, not a product yet", while section 13 says one transaction deploys a `CappedBurnHook` for any token at `/launch` (https://pool4.imd.fun/docs, read 2026-11-09); `research/pool4.md` repeats only the first.

## 3. Fitting Pool4 into one Pipeline strategy

### One pure function for quote and swap

Pipeline requires quote and swap to agree and suggests computing both from one function (`docs/STRATEGY-GUIDE.md`, rule 1, commit `a2d5bfb`, https://github.com/MetalLegBob/pipeline/blob/a2d5bfb/docs/STRATEGY-GUIDE.md).
The clean shape is `step(state, trade, clock) -> (QuoteResult, next_state)`: `pipeline_quote` returns the `QuoteResult`, and `pipeline_swap` checks the market signer, credits the input, calls the same `step`, pays out and writes `next_state`.
The trader's output is decided before the trim and the ratchet run, as in IMD's `afterSwap`, so they change the next trade's depth but never this trade's quote.
If any time-based change ran before pricing (a lazy decay that trims first, for example), the quote would depend on the clock, and the quoter would have to be given the expected time (`Quoter::set_clock`, `crates/pipeline-quoter/src/lib.rs`, commit `a2d5bfb`); keeping every time-based change after pricing avoids that.

### Constant product plus the buy wall

- Store the full-range position as liquidity `L` and the square-root price, as Uniswap does; the wall is a second liquidity `L_w` that is active below its top price.
- A sell moves the price down with `1/sqrtP' = 1/sqrtP + dx / L`, a buy moves it up with `sqrtP' = sqrtP + dy / L`; if a sell crosses the wall's top, the rest uses `L + L_w`.
  Because the wall reaches down to almost zero, there are at most two segments and one boundary, so the loop is bounded at two steps.
- Swaps need no square root and no tick arrays: only multiply-divides on 128 or 256 bits, as in the reference strategy's `mul_div` (`programs/test-strategy-cp/src/lib.rs`, commit `a2d5bfb`).
- Placing the wall needs `L_w = wall SOL / sqrtP_top` when its bottom is zero; that runs in the keeper job, not in the swap.
- The wall's SOL can sit in the same wSOL vault as the curve's, so the swap needs no account beyond the output vault; MetalLegBob's port does this (its swaps resolve exactly one strategy account, the output vault).
- Exact-out across the boundary is possible but adds an inverse for each segment; MetalLegBob's port is exact-in only, and integrators must honour `supports_exact_out: false`.

### The trim, without moving the price

- After pricing a sell, if the curve's tokens exceed the inventory cap, scale the full-range position by `cap / held` (both reserves, or `L`, by the same ratio); the price is unchanged.
- Book the removed tokens to a ledger of tokens awaiting burn and split (MetalLegBob's "retired") and the removed SOL to the wall's idle SOL; nothing moves in the swap.
- This keeps the input in the input vault, which the router asks of strategies (`docs/STRATEGY-GUIDE.md`, rule 10).
  Burning inside the swap would not cut the Pipeline fee, because the router charges on the larger of what the trader spent and what the vault kept (`settlement::settle` in `crates/pipeline-strategy-interface/src/lib.rs`, commit `a2d5bfb`), but it would add a burn and transfers to every sell and run any transfer hook at the deepest call level.
- Because the vaults then hold more than the curve's reserves, pass the sum of everything booked against a vault (reserves, fee ledger, retired tokens, wall SOL) as the "recorded reserve" to `credited_input`; passing only the curve's reserve makes `credited_input` return `amount_sent` even when a Token-2022 transfer fee took part of it, and the books drift above the vault (`credited_input` in `crates/pipeline-strategy-interface/src/lib.rs`).
  MetalLegBob's port checks the same invariant ("The vaults no longer cover the pool's accounts").

### The cap ratchet, floor and decay

- After pricing a buy, if the curve's tokens are below the cap, lower the cap by IMD's rule: the room the buy opened, times the ratchet share, limited by the decay allowance since the last ratchet and by the cap floor, with the decay clock and remainder carried as in the hook.
- It needs only the market state and the Clock sysvar, which Pipeline allows (`docs/STRATEGY-GUIDE.md`, rule 3).
- Run it in every swap, as IMD does in every `afterSwap`; leaving it to a keeper would let a sell and a buy in one transaction round-trip without ratcheting or trimming.

### The wall's guards

- IMD's guard needs a per-swap observation: the previous block's closing price, followed at a capped step, and a placement floor that drops at once and recovers about 4% a day.
- On Solana use the slot for the block, and keep these values as square-root prices with a fixed per-day ratio rather than ticks, so no logarithm is needed in the swap; 400 ticks a day is a ratio of `1.0001^200` a day on the square-root price.
- MetalLegBob's port instead refuses `RebalanceWall` when the price is too far above a reference; which guard we use is a design choice.

### Keeper jobs (custom actions)

| Job | Does | Called by |
| --- | --- | --- |
| Place the wall | Retires what the wall bought, places idle SOL under the price, pays a tip | Anyone, when idle SOL or the wall's fill passes a threshold |
| Settle | Burns the retired tokens and pays the shares | Anyone |
| Sweep fees | Pays the fee ledger to its recipients | Anyone |

They are ordinary instructions on the strategy, called directly, with no Pipeline fee (`docs/STRATEGY-GUIDE.md`, section 5); each should be described in the strategy metadata's `actions` so Pipescope can render a form.

## 4. Compute

Measured on devnet on 2026-11-08 and 2026-11-09 from the transactions' logs; "strategy" is the units the strategy itself consumed inside the router's call.

| Instruction | Strategy | Units | Count |
| --- | --- | --- | --- |
| `pipeline_swap`, buy (with the ratchet) | Pool4 port | 15,374 to 16,682 | 7 |
| `pipeline_swap`, sell (with a trim) | Pool4 port | 12,890 to 14,188 | 4 |
| `pipeline_swap`, sell that filled the wall | Pool4 port | 28,562 | 1 |
| `pipeline_swap` | example constant product `yRptCdde...` | 8,799 to 12,024 | 12 |
| Router `swap`, whole instruction | Pool4 port | 40,710 to 47,077 (62,629 with the wall) | 12 |
| `RebalanceWall` | Pool4 port | 10,805 to 10,820 | 2 |
| `SettleRetired` (includes a Token-2022 `TransferChecked` of 2,977 and a `Burn` of 2,397) | Pool4 port | 15,625 to 15,809 | 4 |
| `SweepFees` | Pool4 port | 20,307 | 1 |
| `pipeline_seed_liquidity` (creates the vaults) | Pool4 port | 71,047 to 86,047 | 8 |

What this means for each mechanism (inferred from the comparison, not measured separately):

- The trim and the ratchet as bookkeeping cost a few thousand units at most: a Pool4 sell with a trim costs about the same as an example-strategy swap plus the larger state.
- Filling the wall roughly doubles the strategy's cost (about 14k to 16k more in his port), still far under the quoter's default cap of 200,000 units (`docs/STRATEGY-GUIDE.md`, rule 7) and the about 1.3M units left for strategies per transaction.
- A quote should cost about the swap minus its token transfer; no quote is recorded on chain, so this is unverified.
- Doing the burn and two share transfers inside every trimming sell would add about 8k to 11k units (one `Burn` plus two `TransferChecked` at the measured costs) and a transfer-hook call for each transfer.

## 5. Recommendation

- Pool4 for Solana is feasible as one strategy, with the design in section 3: one pure `step` function, a two-segment square-root-price curve, the trim and ratchet as in-swap bookkeeping after pricing, the wall's SOL in the quote vault, and placement, settlement and fee sweeps as keeper jobs; start exact-in only.
- MetalLegBob has already built and tested his own closed-source port on devnet, fed by graduations from his own bonding curve, one day before this research.
  The map already says that a product he builds himself leaves our scope (map issue #1, "Decided while charting"); ask him before designing ours.
- Suggested question for `research/outreach.md` (the owner sends it): "Your devnet strategy 4ajWF6Y3... with pool4.json looks like a Pool4 port with a buy wall, burns and keeper tips. Do you plan to ship or open-source it, and should we build Pool4 for Solana, build on yours, or leave it to you and support it in Pipescope instead?"
- If we still build it, his port gives us measured costs and a working shape to match, and our version should differ where it matters to the owner: a published source, IMD's 85/15 split and the share for IMD and Adam that MetalLegBob asked for, and IMD's placement floor if we prefer it to his reference check.

## Sources

- IMD's docs: https://pool4.imd.fun/docs (read 2026-11-09).
- `CappedBurnHook` verified source: https://sourcify.dev/server/v2/contract/1/0xc6c965bd164c483e87d0b550671798e9a3602840?fields=sources and https://etherscan.io/address/0xc6c965bd164c483e87d0b550671798e9a3602840#code.
- Pipeline at commit `a2d5bfb` (2026-11-09 07:14 UTC): `docs/STRATEGY-GUIDE.md`, `crates/pipeline-strategy-interface/src/lib.rs` (`credited_input`, `settlement::settle`, `MAX_MARKET_MINTS`), `programs/test-strategy-cp/src/lib.rs`, `crates/pipeline-quoter/src/lib.rs` (`set_clock`); https://github.com/MetalLegBob/pipeline/tree/a2d5bfb.
- Devnet: program `4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD` (account, binary, 8 market states, all 31 transactions), program `ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb` (binary strings), router `Strategy` record `DHrDdeG2MSFsWqqGJckiQ926AYguRHxVpBjgdaxgLBjn`, and 25 recent transactions of `yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx`; through `https://api.devnet.solana.com` and Helius devnet.
- MetalLegBob's request for a Solana Pool4 that routes some fees to Adam and IMD: `research/x/metallegbob-2026-09-01-to-2026-11-09.md`, line 3010.
