# Kamino Lend facts for the lending pool design

Checked 2026-11-09 for [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21), building on `research/lending-market.md` on this branch, which this file does not repeat; its decisions are in `docs/spec/lending-pool.md` on `main`.
Every on-chain number below was read on 2026-11-09 between about 08:45 and 09:15 UTC.

## Sources and method

- klend source: shallow clone of https://github.com/Kamino-Finance/klend at `686913ee421e0c5f3dc44c4c8344461ee0e4fb89` (release 1.28.0, 2026-11-06); every file path below is under `programs/klend/src/` at that commit.
- kfarms source: shallow clone of https://github.com/Kamino-Finance/kfarms at `bfa186034ba8ecd36e7faf27cae6b38ee24d0bc4` (release 1.7.0, 2026-08-27), path `programs/kfarms/src/state.rs`.
- On chain: public RPCs only (`https://api.mainnet-beta.solana.com`, `https://api.devnet.solana.com`), with `getAccountInfo`, `getMultipleAccounts`, `getProgramAccounts`, `getSignaturesForAddress` and `getTransaction`; Helius was not used.
- Accounts were decoded with byte offsets computed from the `#[repr(C)]` layouts at the commit above; the computed sizes match the real accounts (Reserve 8624 bytes, LendingMarket 4664, FarmState 8336), and the decoded main market name, owner and quote currency match Kamino's API.
- Kamino's keyless API: `https://api.kamino.finance/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves/metrics` and `https://api.kamino.finance/v2/kamino-market`.
- The deployed devnet and mainnet program binaries were dumped with `solana program dump` and searched for log strings, to check which features the devnet build has.
- The decoder scripts and raw outputs were kept only in that session's scratchpad, not in this repo.

## 1. Devnet price source, and the minimum for our own devnet market

### What existing devnet reserves configure

- Verified: on devnet, `getProgramAccounts` on klend filtered by size 8624 returns 328 reserves in 129 lending markets.
- Verified: 199 reserves enable only Pyth, 27 only Scope, 10 only Switchboard, 7 Scope and Pyth, and 85 enable none.
- Verified: all 85 reserves with no price source have `deposit_limit` 0 and only the 100,000-unit seed deposit, so they are fresh reserves that were never opened, not working ones.
- Verified: 38 reserves lend WSOL and 30 lend Circle's devnet USDC (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`).
- Verified: most WSOL reserves name the Pyth account `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` and most USDC reserves name `Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX`; both are live on devnet, owned by the Pyth receiver `rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`, fully verified `PriceUpdateV2` accounts that were updated about 80 seconds before the read (SOL 86.45, USDC 0.9998).
- Examples, verified: WSOL reserve `5qTRnm1VKGmNsjfcVB2ShScM2Rez3NjjfrXyh7hSYYiY` (Pyth `7UVimffx...`, about 2.51 WSOL deposited) and USDC reserve `HRwMj8uuoGVWCanKzKvpTWN5ZvXjtjKGxcFbn2qTPKMW` (Pyth `Dpw1EAVr...`, about 277 USDC deposited) were the two most recently refreshed reserves on devnet.
- Verified: 19 devnet reserves have cTokens beyond the seed deposit but have never stored a price (`market_price_last_updated_ts` is 0), so their deposits ran without any oracle being read.
- Verified: in 14 of those 19 the configured "Pyth price" is not an oracle at all but a system-owned account, for example reserve `24EfeXj3XyLLE6GThh8ik4vcxEPMooAU5XXDL5nJHEr8` (TSLAx) names `J28vmQF8RPKnvcy1tZLxBAxmqxwYwvak56nMmfMGYLc3`, and 13 USDC-like reserves name `A1iQJhg25EPc8VwXXngJ58GwVJAsCzsMnt2ybSu93yvD`.
- Verified: that TSLAx reserve has a run of successful `DepositReserveLiquidity` and `RedeemReserveCollateral` transactions on 2026-09-14 to 2026-09-17, several of them made by CPI from devnet program `DiUKSs93G6wBb5FZCjJ8NhknkaVDQht1yeeCTM8K8yPB` at stack height 2 (for example `2aqWSkRecJFD...`, 2026-09-16), which is the same call pattern as our strategy.

### What the program checks

- Verified: a new reserve starts `Hidden`, with a default config (deposit limit 0, borrow factor 0, an all-zero borrow curve, no price source), and `init_reserve` itself moves the market's `min_initial_deposit_amount` from the signer into the supply vault as a seed (`handlers/handler_init_reserve.rs` lines 94 to 117).
- Verified: a new market's `min_initial_deposit_amount` defaults to 100,000 base units (`utils/consts.rs` line 82), and the market owner is whoever signs `init_lending_market` (`handlers/handler_init_lending_market.rs`).
- Verified: the seed is counted in the Reserve's `collateral.mint_total_supply` but no cTokens are minted for it, so on new reserves that field is 100,000 above the SPL mint's supply (checked on devnet reserves `5qTRnm...` and `HRwMj8...` with `getMultipleAccounts` at one slot).
- Verified: the deposit and redeem checks refuse only an `Obsolete` reserve, not a `Hidden` one (`lending_market/lending_checks.rs` lines 34 to 47), so status is not what opens a reserve; the deposit limit is (`lending_market/lending_operations.rs` lines 165 to 179).
- Verified: `update_reserve_config` accepts `skip_config_integrity_validation = true` only while the reserve is "predeposit", meaning nothing beyond the seed is deposited or borrowed and both deposit and borrow limits are 0 (`handlers/handler_update_reserve_config.rs` lines 77 to 91, `state/reserve.rs` lines 1035 to 1052).
- Verified: so the update that raises the deposit limit above 0 always runs `validate_reserve_config_integrity`, which needs a valid token info (at least one enabled price source), a borrow factor of at least 100, a borrow curve starting at 0% and ending at 100% utilisation with non-decreasing rates, and liquidation threshold at least LTV (`lending_market/lending_operations.rs` lines 4862 to 5019, `utils/borrow_rate_curve.rs` lines 144 to 182).
- Verified: "enabled" only means the configured pubkey is not the default or null pubkey (`state/token_info.rs` lines 104 to 109, 234 to 236, 271 to 273 and 309 to 311), and `UpdatePythPrice` just stores the 32 bytes it is given with no account passed or checked (`lending_market/lending_operations.rs` lines 3129 to 3132).
- Verified: the oracle accounts are only read by `refresh_reserve` and `refresh_reserves_batch` (`handlers/handler_refresh_reserve.rs` line 30, `handlers/handler_refresh_reserves_batch.rs` line 74), and price reading uses the Pyth receiver's `PriceUpdateV2` format (`utils/prices/pyth.rs` lines 4 to 37).
- Verified: `init_reserve`, `update_reserve_config`, `deposit_reserve_liquidity`, `redeem_reserve_collateral`, `enqueue_to_withdraw` and `withdraw_queued_liquidity` take no oracle account and refresh with no price (`refresh_reserve(..., None, ...)`).
- Verified: `update_reserve_config` needs Kamino's global config PDA `BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W` (seed `global_config`), which exists on devnet with global admin `ELgAxEgaGCBxNcfLMqNSbBaYDWmHeirf6k439zrM2wmx`, the same key as the devnet program's upgrade authority.
- Verified: the deployed devnet binary contains the log strings of every feature used here (skip-validation warning, reserve rewards, permissioning, withdraw tickets, emergency mode, `TrueApr`), so it is recent enough; its exact release stays unverified.

### The minimum devnet setup

1. Create a 4664-byte account owned by klend and call `init_lending_market` with our devnet key as owner.
2. For each of WSOL and a USDC-like mint, create an 8624-byte account owned by klend and call `init_reserve`, which needs 100,000 base units of the mint in the owner's token account for the seed.
3. While the reserve is still predeposit, call `update_reserve_config` with `skip_config_integrity_validation = true` for `UpdatePythPrice`, `UpdateBorrowRateCurve` and `UpdateBorrowFactor` (100), and optionally `UpdateTokenInfoName`, `UpdateTokenInfoPriceMaxAge` and `UpdateReserveStatus` (Active).
4. Call `update_reserve_config` for `UpdateDepositLimit` without the skip flag, signed by the market owner; this runs the full validation and opens deposits.
5. From then on, `deposit_reserve_liquidity` and `redeem_reserve_collateral` work by CPI with no oracle account and no refresh instruction.

- Verified: someone else used this pattern on devnet reserve `24EfeXj3...` on 2026-09-14, in this order (`UpdateTokenInfoScopeTwap`, `UpdateTokenInfoScopeChain`, `UpdateTokenInfoName`, `UpdateTokenInfoPriceMaxAge`, `UpdateTokenInfoTwapMaxAge`, `UpdatePythPrice`, `UpdateReserveStatus`, `UpdateScopePriceFeed`, `UpdateBorrowRateCurve`, `UpdateBorrowFactor`, all logged with "WARNING! Skipping validation of the config", then `UpdateDepositLimit` with validation), followed by working deposits and redeems.
- Verified: so no Pyth or Scope account is needed at all for a cToken-only demo; any non-default pubkey in `pyth_configuration.price` satisfies the config check, and nothing in the cToken path reads it.
- Recommendation, not a fact: name the live devnet Pyth feeds (`7UVimffx...` for SOL, `Dpw1EAVr...` for USDC) anyway, because a demo that wants non-zero utilisation needs a test borrower, and borrowing through an obligation does call `refresh_reserve` with the real price account.
- Verified: with no price stored, `market_price_sf` stays 0, so anything value-based reads a value of 0; the withdraw-ticket minimum (`min_withdraw_queued_liquidity_value`) defaults to 0 on a new market and the check is `value < minimum`, so tickets still work (`lending_market/lending_operations.rs` lines 980 to 1001).
- Unverified: the whole sequence has not been run by us; it should be the first devnet script of the build ticket.

## 2. Farm rewards

- Verified: the Reserve has two farm fields, `farm_collateral` (offset 64) and `farm_debt` (offset 96) (`state/reserve.rs` lines 76 to 77).
- Verified: a reserve's farm is created by `init_farms_for_reserve` as a delegated farm whose delegate is the lending market authority PDA (`handlers/handler_init_farms_for_reserve.rs`, `lending_market/farms_ixs.rs` lines 17 to 40).
- Verified: farm users are obligations: `init_obligation_farms_for_reserve` creates a farm user whose delegatee is the obligation, and klend sets its stake to the obligation's deposited cTokens (collateral farm) or its borrowed amount (debt farm) (`lending_market/farms_ixs.rs` lines 57 to 127, `handlers/handler_refresh_obligation_farms_for_reserve.rs` lines 138 to 160).
- Verified: `deposit_reserve_liquidity` and `redeem_reserve_collateral` never touch a farm (no farm accounts or calls in either handler), so a plain cToken holder earns no reserve-farm rewards.
- Verified: SOL reserve farm `955xWFhSDcDiUgUr4sBRtCpTLiMd4H5uZLAmgtP3R3sX` and USDC reserve farm `JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh` are delegated to `9DrvZvyWh1HuAoZxvYWMvkf2XCzryCpGgHqrMjyDWpmo`, which is the main market's authority PDA (seed `lma`).
- Verified: neither farm pays anything now: the SOL farm's two rewards (BONK, last issued 2024-02-01, and `kPs18H4xTYxHKssMbJeXzC6mGWHvCtU4w4Dq3grGNh4`, last issued 2024-09-15) and the USDC farm's one reward (BONK, last issued 2024-02-01) all have a reward rate of 0 and 0 rewards available; both reserves have no debt farm.
- Verified: 98.3% of the SOL reserve's cTokens (2.036e15 of 2.071e15) and 88% of USDC's (1.061e14 of 1.206e14) sit in obligations staked in those farms, held by 271,557 and 153,932 farm users.
- Verified: the supply APY from Kamino's API is the interest-only rate, SOL 4.43% and USDC 3.91%, which matches the exchange-rate growth measured in section 4; so a cToken holder gives up nothing on-chain against an obligation depositor today.
- Verified: klend now also has "reserve rewards", which top up `total_available_amount` and so raise the exchange rate for every cToken holder, obligation or not (`state/reserve.rs` lines 679 to 744, `handlers/handler_topup_reserve_rewards.rs`); they are off on the main market (`reserve_rewards_max_apr_bps` 0, and both reserves have `rewards_amount_per_accrual_unit` 0 and `rewards_amount_available` 0).
- Unverified: whether Kamino runs off-chain incentives (points or airdrops) that count only obligation deposits; nothing on-chain or in the API pays them now.

## 3. Main market flags, caps and liquidity

Main market `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF` (named "SOL/BTC Market", `isPrimary: true` in Kamino's API).

- Verified: `withdraw_ticket_issuance_enabled` (offset 3352) is 0, so `enqueue_to_withdraw` fails with `WithdrawTicketIssuanceDisabled` on the main market today (`handlers/handler_enqueue_to_withdraw.rs` lines 32 to 35); ticket redemption (3353) and cancellation (3356) are also 0, and the SOL and USDC reserves have never issued a ticket (`next_issued_ticket_sequence_number` 0).
- Verified: deposits are not permissioned: `permissioning_authority` (offset 3400) is the default pubkey and `permissioned_ops` is 0 on the market (3432) and on both reserves (5800), and `requires_permission` needs a non-default authority first (`utils/permissioning.rs` lines 65 to 94, `state/lending_market.rs` lines 534 to 536).
- Verified: market emergency mode (122) and `borrow_disabled` (124) are 0, the market is not immutable (3305), its owner is `24LjDBukaUSHgPowcF2wY1XscnhChcBUDETN2UhBZMMT` (a Squads v4 vault) and its emergency council is `4VtJ1yCCyU2YGgPTZGHZRwzwaZ3hmzgqMtRQo8RqMa57` (a Squads v4 vault created 2026-04-02).
- Verified: both reserves have status Active, `emergency_mode` 0 (offset 4864) and `block_ctoken_usage` 0 (4862), and use the `TrueApr` interest basis (4865), which accrues by seconds.

| | SOL `d4A2prbA...` | USDC `D6q6wuQS...` |
| --- | --- | --- |
| Deposit withdrawal cap | 1,000,000 SOL per 86,400 s | 90,000,000 USDC per 86,400 s |
| Used in the current interval | 9,704.95 SOL (interval from 2026-11-08 16:26 UTC) | 733,439.92 USDC (from 2026-11-08 21:39 UTC) |
| Borrow (debt) cap | 1,000,000 SOL per 86,400 s | 90,000,000 USDC per 86,400 s |
| Deposit limit | 10,000,000 SOL | 1,000,000,000 USDC |
| Total supply (decoded at slot 467255341) | 2,403,079 SOL | 145,903,746 USDC |
| Borrowed | 2,185,034 SOL | 125,060,931 USDC |
| Freely available (no queue) | 218,221.80 SOL | 20,861,821.97 USDC |
| Utilisation | 90.93% | 85.71% |
| Borrowing blocked above | 90% utilisation | not set (0) |
| Supply APY (API) | 4.43% | 3.91% |

- Verified: the cap counts net outflow, since deposits subtract from it and redeems add to it, and an interval length of 0 means no cap (`lending_market/withdrawal_cap_operations.rs` lines 119 to 200, `lending_market/lending_operations.rs` lines 183 and 634 to 640).
- Verified: so the binding limit for us is the freely available liquidity (about 9% of SOL supply), not the cap, which sat at about 1% used.
- Verified: the decoded totals agree with Kamino's API (SOL 2,403,079.25 supplied, USDC 145,903,751 supplied) to within the minutes between the two reads.

## 4. Exchange rate

### Can it fall

- Verified: yes, through `socialize_loss` and `socialize_loss_v2`, which the lending market owner signs (`handlers/handler_socialize_loss.rs` lines 90 to 100) for an obligation with no collateral left but debt still owed; it calls `forgive_debt`, which cuts `borrowed_amount_sf` and so the reserve's total supply, and every cToken is worth less (`lending_market/lending_operations.rs` lines 2744 to 2826, `state/reserve.rs` lines 1404 to 1408).
- Verified: if the forgiven amount reaches the reserve's whole total supply, the reserve's version is set to `u64::MAX`, after which every redeem fails the version check (`lending_market/lending_operations.rs` lines 2800 to 2803, `lending_market/lending_checks.rs` line 330).
- Verified: `forgive_debt` has no other caller, and the other writers of the rate's inputs move it up or leave it unchanged: interest accrual, fee redemption (`redeem_fees` lowers available liquidity and accumulated fees by the same amount), early-repay penalties and referrer fees, and deposits and redeems round in the reserve's favour (`state/reserve.rs` lines 498 to 558, 575 to 595, 1296 to 1301).
- Verified, by implication: bad debt that has not been socialised is still counted as borrowed, so the stored rate overstates what the cTokens can really fetch until Kamino socialises it.
- Partly verified: the current owner `24LjDBuk...` made no `SocializeLoss` call that the section 5 scan could see (2026-02-24 to 2026-11-04); losses socialised before that, by an earlier owner, are unverified.

### Fields and byte offsets (Reserve account, offsets include the 8-byte discriminator)

| Field | Offset | Type |
| --- | --- | --- |
| `last_update.slot` | 16 | u64 |
| `last_update.stale` | 24 | u8 |
| `last_update.timestamp` | 28 | u32 (unix seconds) |
| `liquidity.total_available_amount` | 224 | u64 |
| `liquidity.borrowed_amount_sf` | 232 | u128, 60 fractional bits |
| `liquidity.cumulative_borrow_rate_bsf` | 296 | U256, 60 fractional bits |
| `liquidity.accumulated_protocol_fees_sf` | 344 | u128, 60 fractional bits |
| `liquidity.accumulated_referrer_fees_sf` | 360 | u128, 60 fractional bits |
| `liquidity.pending_referrer_fees_sf` | 376 | u128, 60 fractional bits |
| `liquidity.rewards_amount_available` | 440 | u64 |
| `collateral.mint_total_supply` | 2592 | u64 |
| `config.status` | 4856 | u8 |
| `config.block_ctoken_usage` | 4862 | u8 |
| `config.emergency_mode` | 4864 | u8 |
| `config.interest_rate_basis` | 4865 | u8 (0 slots, 1 seconds) |
| `config.protocol_take_rate_pct` | 4870 | u8 |
| `config.borrow_rate_curve` | 4920 | 11 x (u32 utilisation bps, u32 rate bps) |
| `config.deposit_limit` | 5016 | u64 |
| `config.deposit_withdrawal_cap` | 5416 | i64 capacity, i64 current, u64 interval start, u64 interval length |
| `config.rewards_amount_per_accrual_unit` | 5792 | u64 |
| `withdraw_queue.queued_collateral_amount` | 6968 | u64 |

- Verified: total supply = `total_available_amount` + `borrowed_amount_sf` - `accumulated_protocol_fees_sf` - `accumulated_referrer_fees_sf` - `pending_referrer_fees_sf` (`state/reserve.rs` lines 1249 to 1255), and liquidity per cToken = total supply / `collateral.mint_total_supply`, or 1 when either is 0 (`state/reserve.rs` lines 642 to 645 and 1491 to 1500).
- Verified: a redeem pays floor(cTokens x total supply / cToken supply) (`state/reserve.rs` lines 537 to 558).
- Verified: use the Reserve's `collateral.mint_total_supply`, not the SPL mint's supply: they differ by the 100,000 seed on new reserves, and on the mainnet USDC reserve by 13,796,967 (read at one slot), while on the SOL reserve they are equal.
- Verified: freely available liquidity for a plain redeem = `total_available_amount` minus the liquidity value of `queued_collateral_amount` (`state/reserve.rs` lines 312 to 330).

### How stale the stored rate is

- Verified: 12 samples of each reserve 15 seconds apart (08:46 to 08:50 UTC) found the SOL reserve last updated 27 to 312 slots (6 to 68 seconds) before the read, median about 120 slots (26 seconds), and USDC 9 to 236 slots (2 to 51 seconds), median about 60 slots (13 seconds).
- Verified: the stored rate rose over the window by 1.374e-9 per second for SOL (4.33% a year) and 1.216e-9 per second for USDC (3.83% a year), which matches the curve: SOL borrows at about 5.61% at 90.93% utilisation, times utilisation, times 85% after the 15% protocol take, and USDC at 4.97% plus a 0.5% host rate that goes to the protocol, times 85.71%, times 90%.
- Verified, by arithmetic: that is about 5.5e-10 (SOL) and 4.9e-10 (USDC) per 0.4-second slot, so the worst sampled lag of 68 seconds understates the value by 9.3e-8 (0.0009 bps), one hour of lag by 4.9e-6 (0.05 bps), and one day by 1.2e-4 (1.2 bps).
- Verified: the error is always an understatement, since accrual only raises the rate, unless a loss is socialised.
- Verified: the strategy can also project the rate itself without a CPI, from the same account: the elapsed seconds since `last_update.timestamp`, the borrow rate from the curve at the current utilisation, the host rate and the protocol take rate, as `refresh_reserve` does (`lending_market/lending_operations.rs` lines 55 to 109, `state/reserve.rs` lines 648 to 677 and 1343 to 1401); the compounding is an approximation (`approximate_compounded_interest`, `state/reserve.rs` line 2370).
- Verified: the `stale` flag is set by every deposit and redeem (`mark_stale`) and does not mean the rate is wrong; it only forces the next caller to refresh in its own slot.

## 5. Emergency mode and `block_ctoken_usage`

### Who can set them

- Verified: market-wide emergency mode (`LendingMarket.emergency_mode`) is set through `update_lending_market`: the market owner can turn it on or off, the emergency council can only turn it on, and nobody can change it on an immutable market (`handlers/handler_update_lending_market.rs` lines 39 to 52 and 407 to 438).
- Verified: market emergency mode blocks `deposit_reserve_liquidity`, `redeem_reserve_collateral`, `enqueue_to_withdraw`, `withdraw_queued_liquidity`, `cancel_withdraw_ticket`, `recover_invalid_ticket_collateral` and `refresh_reserve` (`lib.rs` lines 129, 147, 155 and 588 to 611, `utils/constraints.rs` lines 9 to 14).
- Verified: reserve emergency mode (`ReserveConfig.emergency_mode`) is set through `update_reserve_config` mode `UpdateReserveEmergencyMode`: the market owner can set or clear it, the emergency council can only set it, and it is allowed even on an immutable market (`handlers/handler_update_reserve_config.rs` lines 42 to 49, `lending_market/lending_operations.rs` lines 4739 to 4756 and 4781 to 4824).
- Verified: reserve emergency mode blocks deposits, redeems, ticket issuance, ticket payout, ticket cancellation and recovery on that reserve (`lending_market/lending_checks.rs` lines 26 to 32, 148 to 199, 232, 328 and 684 to 692).
- Verified: `block_ctoken_usage` can be changed only by Kamino's global admin (`UpdateBlockCTokenUsage` is in the global-admin-only list, `lending_market/lending_operations.rs` lines 4670 to 4682), not by the market owner, and the global admin can do so even on an immutable market (`handlers/handler_update_reserve_config.rs` lines 42 to 49); this corrects `research/lending-market.md`, which said a reserve's admin can set it.
- Verified: the mainnet global admin (in global config `BEe6HXZf...`) is `A9rQoX1sictAQkyXxaZA8nz674xutHwoqpK2mwLyexCZ`, which acts through Squads v3 (`SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu`); there is no separate per-reserve admin, only the market's proposer authority during a reserve's initialization phase (`lending_market/lending_operations.rs` lines 4790 to 4806).
- Verified: on our own devnet market we are the owner and can set or clear both emergency modes, but not `block_ctoken_usage` (devnet global admin `ELgAxEga...` is Kamino's).
- Verified: Kamino's docs describe the same split (market-wide and per-reserve emergency mode, council can only turn it on) at https://kamino.com/docs/curators/markets/emergency-controls, and also list "socialize-loss" under the emergency council, which disagrees with the source, where `socialize_loss` needs the market owner's signature.

### History

- Verified: the main market's emergency council `4VtJ1yCC...` has signed 9 transactions since its creation on 2026-04-02, read from `getSignaturesForAddress` and the transactions' logs.
- Verified: none of them set emergency mode on the main market.
- Verified: on 2026-04-03 11:24 UTC it set market-wide emergency mode on the "Apollo Market" `3koBPZPPV4Ag4DPWCyTdAVGxzxABWw9vEZ9vX8sjbbM2` (transaction `3Meyd69cdgJgoPaXA95R...`), which is off again now.
- Verified: on 2026-10-29 22:01 UTC it set `borrow_disabled` on the main market (transaction `5Tn8ft64BQ1KEVPHrcCm...`), during the Binance security incident; Kamino's X post at 22:03 UTC said "out of an abundance of caution, we have temporarily paused borrowing in the SOL/BTC Market" (reported by https://solanacompass.com/news/jupiter-lend-withdrawals-queue-in-liquidity-crunch-as-kamino-pauses-solbtc-borrowing-after-binance-hack).
- Verified: the market owner turned borrowing back on at 2026-10-30 12:28 UTC (transaction `3TZKo16NPQvq...`), about 14.5 hours later; deposits and redeems stayed open throughout, since `borrow_disabled` is checked only in `check_borrow_possible` (`lending_market/lending_operations.rs` lines 4053 to 4062).
- Verified: in April 2026, around the Kelp DAO rsETH exploit, the council's Squads vault also ran `FreezePrice` on Kamino's Scope oracle program `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ` (2026-04-17 and 2026-04-18).
- Verified: until 2026-06-10 the main market's emergency council was `A9rQoX1s...` (the global admin's Squads v3 vault); the owner replaced it with `4VtJ1yCC...` on 2026-06-10 10:39 UTC (transaction `33q43mdH9JG3j6...`, log "Prv value: ... A9rQoX1s...").
- Verified: Kamino has used reserve-level emergency mode on the main market once in the windows scanned: `A9rQoX1s...` set it on the main market's ETH reserve `febGYTnFX4GbSGoFHFeJXUHgNaK53fB23uDins9Jp1E` at 2026-04-23 19:58 UTC (transaction `4yvvwhZHUPJysBZe...`), and the owner `24LjDBuk...` cleared it at 2026-04-24 11:58 UTC (transaction `2uLMjtF21NKFdaWN...`), so ETH cToken redeems on the main market were blocked for about 16 hours.
- Verified: in the same days `A9rQoX1s...` cut other reserves to reduce-only instead, which leaves redeems open: LBTC `DSyZ8en9...` (LTV and deposit limit to 0, 2026-04-21), and ZBTC `HDYDmHLY...` and USDC `GYaaVSmd...` (deposit limit, and for USDC borrow limit, to 0, 2026-04-24); which markets those three reserves belong to was not checked.
- Verified: the main market owner `24LjDBuk...` was created on 2026-02-24 and all 335 of its transactions (2026-02-24 to 2026-11-04) were read: it never set market-wide or reserve emergency mode on any market, and no `SocializeLoss` call was found (transactions without config updates were re-read with every instruction name; transactions with config updates were kept only for their update logs); its only emergency-type actions are clearing the ETH reserve's emergency mode and re-enabling borrowing on 2026-10-30.
- Verified: the main market's SOL and USDC reserves were never put in emergency mode in any window scanned.
- Unverified: actions by `A9rQoX1s...` outside 2026-04-17 to 2026-04-24 (2,324 transactions since 2023-03-15, too many for the public RPC in this session), actions by whoever owned the main market before `24LjDBuk...`, and therefore any emergency mode or loss socialisation on the main market before 2026-02-24.
- Unverified: web searches found no report of market-wide emergency mode on the main market; Kamino's docs page on emergency controls lists no past use.

## 6. Withdrawal queue with a program PDA as ticket owner

- Verified: the ticket is paid by `withdraw_queued_liquidity`, which anyone can call: its only signer is a `payer`, and the ticket owner is a writable non-signer account that only receives the ticket's rent when the ticket closes (`handlers/handler_withdraw_queued_liquidity.rs` lines 283 to 404).
- Verified: the liquidity goes to the token account recorded in the ticket at enqueue time (`user_destination_liquidity_ta`), which must then be a token account of the lent mint owned by the ticket owner, with no delegate and not frozen (`handlers/handler_enqueue_to_withdraw.rs` lines 206 to 213 and 61 to 73).
- Verified: at payout the program re-checks that account; if it has gained a delegate, been frozen, changed owner or been closed (unless it is the owner's ATA), the ticket is marked invalid and skipped, and the cTokens can then be returned to the owner's cToken account by `recover_invalid_ticket_collateral`, which anyone can call into the owner's cToken ATA (`handlers/handler_withdraw_queued_liquidity.rs` lines 85 to 93 and 212 to 281, `handlers/handler_recover_invalid_ticket_collateral.rs`, `lending_market/lending_operations.rs` lines 4848 to 4860).
- Verified: if the destination is the owner's ATA and it does not exist at payout, the payout creates it, using rent the owner prepaid into the ticket at enqueue (`handlers/handler_enqueue_to_withdraw.rs` lines 90 to 102, `handlers/handler_withdraw_queued_liquidity.rs` lines 61 to 84).
- Verified: tickets are paid strictly in order (the ticket must be `next_withdrawable_ticket_sequence_number`), the head ticket can be paid in part as liquidity returns, queued payouts may use liquidity that plain redeems cannot, and they also count against the withdrawal cap (`handlers/handler_withdraw_queued_liquidity.rs` lines 365 to 371, `lending_market/lending_operations.rs` lines 658 to 703, `state/types.rs` lines 293 to 296).
- Verified: our program is not called back at payout (the only progress callback is for Kamino Vaults, `handlers/handler_enqueue_to_withdraw.rs` lines 117 to 170), so the strategy must find a payout by reading its own token balance and the ticket account.
- Verified: cancelling a ticket needs the owner's signature and the market's cancellation flag (`handlers/handler_cancel_withdraw_ticket.rs` lines 38 to 40, 110 and 162).
- Verified: a program PDA can enqueue by CPI: `enqueue_to_withdraw`, `withdraw_queued_liquidity`, `cancel_withdraw_ticket` and `recover_invalid_ticket_collateral` run no `check_refresh`, no `check_cpi_call` and no stack-height check; `check_cpi_call` is used only for obligation ownership transfers and `check_refresh` only in obligation flows (`utils/refresh_ix_utils.rs` lines 35 to 66, `lending_market/lending_checks.rs` line 978, grep over `programs/klend/src`).
- Verified: the owner is also the rent payer for the ticket account (520 bytes, about 0.0045 SOL), the owner's queued-collateral vault (a token account, about 0.002 SOL, created on first use) and the optional ATA rent prepayment, all through the System program (`handlers/handler_enqueue_to_withdraw.rs` lines 232 to 250, `utils/token_transfer.rs` lines 434 to 449).
- Unverified here, but it follows from the System program's transfer rule (the source must be a signer owned by the System program and carry no data): the PDA that owns our cTokens must be a data-less, system-owned PDA holding some SOL, not a program-owned state account; the LiteSVM test should confirm it.
- Verified: none of this works on the main market today, because ticket issuance and redemption are off there (section 3); it would work on our own devnet market once we enable them with `update_lending_market`.
- Unverified: no ticket has been enqueued by CPI on mainnet or devnet by us; the LiteSVM test should cover it.
