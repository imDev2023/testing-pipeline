# Lending AMM

Decided in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21) on 2026-11-10 with the owner, against Pipeline commit `5ad130d` (its strategy guide, template and seeding interface) and Kamino Lend (klend) release 1.28.0 (`686913e`).
It builds on [Which lending market the lending pool lends to](https://github.com/imDev2023/testing-pipeline/issues/12) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/lending-market/research/lending-market.md)) and on a check of Kamino's flags, caps, exchange rate and devnet setup made for this ticket ([Kamino facts](https://github.com/imDev2023/testing-pipeline/blob/research/lending-market/research/lending-market-kamino-facts.md)).
MetalLegBob asked for a pool that lends out the idle part of its liquidity, through Kamino or a similar market, and he is not building it himself ([Record MetalLegBob's answers to the follow-up DM](https://github.com/imDev2023/testing-pipeline/issues/27)), so it stays in scope.
The shared engineering and security bar for our programs lands in `docs/spec/README.md`, from [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4); this file adds only what is particular to the lending AMM.
It was specified under the working name lending pool; [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17) named it the lending AMM, because a lending pool reads as a pool to lend to or borrow from.
Amended on 2026-11-10 in [Cut the lending pool's build tickets](https://github.com/imDev2023/testing-pipeline/issues/25), with the owner: what withdraw mode's thresholds are measured against (see "Withdraw mode"), and with it the second depositor our devnet reserve needs and the shape of the `init` form.
The build tickets cut there are listed under "Build tickets" below.
Terms are as in `GLOSSARY.md`: lending AMM, buffer, lent side, lending market, cToken, withdraw mode, keeper job.

## What it is

- A Pipeline strategy whose markets are two-mint constant-product pools with open LP shares.
- One mint of each market is the lent side, WSOL or USDC; most of the lent side is lent to Kamino Lend through its cToken instructions, and a buffer stays in the market's own vault for swaps.
- Prices come from the market's total reserves: the other side's vault, and on the lent side the buffer plus the market's cTokens valued at Kamino's exchange rate.
- A swap that must pay out more of the lent side than the buffer holds redeems just the shortfall from Kamino in the same swap; a swap never deposits into Kamino.
- A permissionless keeper job, `rebalance`, moves the buffer back to its target when it drifts out of its band.
- The LP fee and all the lending yield go to LPs, through the value of their shares.
- The program has no admin: nobody, us included, can pause it, change a market or move a market to another reserve; it reacts to Kamino's own state.

## Not in v1

- Exact-out swaps.
- Lending both sides of a market, or any lent mint other than WSOL and USDC.
- Any lending market other than Kamino Lend: Jupiter Lend is out of scope for this map (see the map's Out of scope), and so are Kamino's obligations, which refuse calls from our program (`CpiDisabled`).
- Kamino withdrawal tickets: issuance is switched off on Kamino's main market (2026-11-09), so the program never enqueues one.
- A buffer target or band chosen per market.
- A share of the yield or the LP fee for us or for the market's creator.
- Markets with more than two mints.
- On-chain token metadata for LP mints.
- Mainnet: nothing deploys there before Pipeline's router does, and the program is frozen first (see "Upgrades and freezing").

## Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `BUFFER_TARGET_BPS` | 2000 (20%) | The buffer's target share of the lent side's total |
| `BUFFER_MIN_BPS`, `BUFFER_MAX_BPS` | 1000, 3000 | The band; `rebalance` acts only when the buffer's share is outside it |
| `MIN_REBALANCE` | 0.05 SOL (50,000,000 lamports) for WSOL, 5 USDC (5,000,000 base units) for USDC | Smaller moves are skipped |
| `KAMINO_RATE_HEADROOM_BPS` | 10 (0.1%) | Headroom `rebalance` leaves below Kamino's freely available liquidity and withdrawal cap when it plans a redeem, for the interest klend accrues when it refreshes the reserve inside the redeem (see "The rule") |
| `WITHDRAW_MODE_ENTER` | 5 | Enter withdraw mode when Kamino's freely available liquidity is below 5 times the larger of the market's lent value and its target lent value (see "Withdraw mode") |
| `WITHDRAW_MODE_EXIT` | 10 | Leave withdraw mode when it is back above 10 times that amount |
| `MAX_LP_FEE_BPS` | 200 (2%) | The highest LP fee a market may charge |
| `MINIMUM_LIQUIDITY` | 1,000 LP base units | Locked for good by the first deposit |
| `LP_DECIMALS` | 9 | Decimals of every market's LP mint |
| `KLEND_PROGRAM` | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` | Kamino Lend, the same id on devnet and mainnet |
| `LENT_MINTS` | per cluster, below | The lent mints and the one Kamino reserve each lends to |

`LENT_MINTS`, selected at build time by a cluster feature (`devnet` or `mainnet`):

| Cluster | Lent mint | Lending market | Reserve |
| --- | --- | --- | --- |
| mainnet | WSOL `So11111111111111111111111111111111111111112` | Kamino main market `7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF` | SOL `d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q` |
| mainnet | USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | Kamino main market | USDC `D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59` |
| devnet | WSOL `So11111111111111111111111111111111111111112` | Our own Kamino lending market `DCKrWS5G3YEcrRP1Ayu8S8nBR4QfgFsSaRzRdPrjqzj3` (see "Devnet") | WSOL `5vJJ1sQi972Qcf6oUy3gHEx6prijjSj31CWo5He85Hjw` |
| devnet | Our test USDC `CqHMaMB72rTsJGRDzeQmcAsVHuwoBw7V7gdaCexcjcC7`, 6 decimals | Our own Kamino lending market | Test USDC `72wAn7eQBbBSXQcb2eAMHz2SDxUgAM51LHhH3aGbY7T3` |

- Market creators never choose a reserve: a reserve in a lending market the creator owned could be reconfigured to let its owner borrow the LPs' deposits away.
- The devnet rows come from [`deployments/kamino-devnet.json`](../../deployments/kamino-devnet.json), which also holds the lending market's authority and each reserve's liquidity supply, fee vault, collateral mint and collateral supply; the program's devnet constants must equal that file.
- The constants are compiled into the program; changing one is a program upgrade, which ends when the program is frozen.
- They live in one module, `programs/lending-amm/src/config.rs`, where each `LENT_MINTS` entry also names its reserve's lending market and collateral mint and its `MIN_REBALANCE`.
  The cluster is chosen by the crate's `devnet` or `mainnet` feature, exactly one of them; `devnet` is the default, since devnet is the only cluster this project deploys to, and CI builds both ([Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78), 2026-11-12).

## Markets

### Shape

- Exactly two mints: the lent mint, which must be on the cluster's `LENT_MINTS` list, and the other mint.
- The mints must differ.
- If both mints are on the list (a SOL and USDC market), the creator's `lent_index` decides which one is lent, and the other is never lent.
  Such a market is allowed but pointless next to cheaper SOL and USDC venues, since every hop pays Pipeline's 0.25%.
- `pipeline_market_info` reports the mints in the order the creator gave them, with `supports_exact_out = false`.

### Mint rules

- The lent side is exactly the listed mint, owned by SPL Token.
- The other side follows the tax AMM's mint rules ([`tax-amm.md`](tax-amm.md), "Mint rules"): SPL Token, or Token-2022 with only transfer hook, metadata pointer, token metadata, group pointer, group member pointer, token group and token group member extensions; transfer fees, permanent delegates and every other extension are refused at creation.
- So hooked tokens may trade in a lending AMM market.
  The hooked transfer and the Kamino redeem are sibling calls under the strategy and never stack: the deepest chain is the redeem, router (1), strategy (2), klend (3), SPL Token (4), or 5 when the trader uses a smart wallet, inside the limit of 5.
  A transfer hook that makes calls of its own fails for smart-wallet traders, as it does in any Pipeline market.
- A contained token can only trade in its home market until its unlock, and Kamino refuses hooked mints, so a contained token is never lent.

### Addresses

- The market state is the PDA `["market", other_mint, lent_mint, lp_fee_bps as u16 little-endian]` of the lending AMM program, so there is one market per pair, lent side and fee.
  Every creation parameter is in the seeds, so nobody can occupy a market's address with other parameters.
  Someone may create a market first at a bad price with dust liquidity; correcting that price by a swap costs little, and the locked minimum stops share inflation.
- Markets created through `pipeline_seed_liquidity` live at `["seeded", seeder, other_mint, lent_mint, lp_fee_bps]` instead, as Pipeline's guide asks, so nobody can create or price them first.
- The vault authority is the PDA `["authority", market_state]`, a data-less address that signs every transfer out of the vaults, owns the cToken account, signs Kamino calls as the depositor and is the LP mint's mint authority.
- Each vault is a token account at `["vault", market_state, mint]`, owned by the vault authority; the lent mint's vault holds the buffer.
- The cToken account is a token account at `["ctoken", market_state]` for the reserve's collateral mint, owned by the vault authority; each market holds its own cTokens.
- The LP mint is an SPL Token mint at `["lp_mint", market_state]`, with `LP_DECIMALS` decimals, the vault authority as mint authority and no freeze authority.
- The lock account is the vault authority's associated token account for the LP mint; no instruction ever moves LP shares out of it.
- An LP's shares account is a token account of the LP mint at `["lp_shares", market_state, lp]`, owned by the LP; `add_liquidity` mints the LP's shares into it and creates it, at the LP's expense, if it is missing.
  It is a PDA rather than the LP's associated token account because metadata cannot describe the associated token account of a mint that is itself a PDA (a `pda:` source cannot sit inside an `ata:` one at `5ad130d`), and a generic desk could then not build `add_liquidity` ([Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78), 2026-11-12).
  The shares are the LP's own tokens, free to move to any account.
- Metadata describes all of them as `pda:` sources, so the SDK can resolve them before the market exists.

### Market state

The market state has its final layout from the first build ([Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78), 2026-11-12), because on 2026-11-08 an upgrade of another strategy on devnet stranded most of its markets when the new program could no longer read what older versions had written.

- Anchor's discriminator, then a version byte (1), then fixed-size fields only, so each sits at a fixed offset: the bumps of the market state and the vault authority, `lent_index`, `lp_fee_bps`, withdraw mode, the two mints and vaults in the creator's order, the market signer, the LP mint, the cToken account, the reserve and its collateral mint, the seeder (the default key for a market created through the router), the recorded reserves by mint index (`R`, and the buffer `B` on the lent side), the recorded cTokens `c`, the running totals deposited into and redeemed from Kamino (u128), the creation slot and time, and 256 reserved bytes; 663 bytes in all.
- No field ever moves, resizes or disappears; a new field takes reserved space, with a zeroed value meaning the old behaviour.
- `programs/lending-amm/src/state.rs` publishes the offsets and `tests/layout.rs` pins every one.

### Creation parameters

`init_data` is the Borsh encoding of:

| Field | Type | Rule |
| --- | --- | --- |
| `lent_index` | u8 | 0 or 1: which of the two mints is lent; it must be on the cluster's `LENT_MINTS` list |
| `lp_fee_bps` | u16 | At most `MAX_LP_FEE_BPS`; Aviary's form defaults it to 30 (0.30%) |

- `pipeline_init_market` refuses anything that breaks a rule, checks that the market state's address is the PDA above, checks that the market signer is the router's PDA `["market", program, market_state]` and stores it, creates the vaults, the cToken account and the LP mint idempotently, and records the reserve, the creation slot and the Unix time.
- Rent comes from the router's payer, funded by the creator's `max_creator_lamports`.

### Creating a market

One transaction, as Pipeline's guide recommends:

1. The router's `create_market` with the creation parameters.
2. The router's `init_fee_account` for each of the two mints.
3. The lending AMM's `add_liquidity`, which makes the first deposit.

Until the first deposit, quotes and swaps are refused, because an empty side cannot be priced.

## Valuing the lent side

### Total reserves

- The other side's reserve `R` is what the market has recorded in its vault.
- The lent side's reserve is `L = B + V`, where `B` is the buffer the market has recorded in its lent-mint vault and `V` is the value of the cTokens it has recorded, `V = floor(c x S_total / S_ctoken)`.
- `S_total` is the reserve's total supply, `total_available_amount + borrowed_amount_sf - accumulated_protocol_fees_sf - accumulated_referrer_fees_sf - pending_referrer_fees_sf` (fixed point with 60 fractional bits where the field ends in `_sf`), and `S_ctoken` is the reserve's own `collateral.mint_total_supply`, never the SPL mint's supply, which differs by the 100,000-unit seed on new reserves and by 13.8M on mainnet USDC.
- Field offsets are in the [Kamino facts](https://github.com/imDev2023/testing-pipeline/blob/research/lending-market/research/lending-market-kamino-facts.md), section 4, at klend 1.28.0.
- Tokens or cTokens sent to the market outside its own instructions are donations: never credited, never priced and never paid out.
- `V` is exactly what klend's `redeem_reserve_collateral` pays for `c` at the same rate: klend multiplies `c` by the total supply in 256-bit fixed point, divides by `S_ctoken` and rounds down, and `floor(floor(x / n) / 2^60) = floor(x / (n x 2^60))`.
  The program computes it with every intermediate inside its type (the product as 64-bit digits, a 64-step long division), refuses a value above a u64, and counts cTokens as worth nothing when `S_total` or `S_ctoken` is 0, which can only understate ([Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79), 2026-11-12).
  On 2026-11-12 the valuation equalled klend's real payout to the unit on the cloned mainnet SOL and USDC reserves when refreshed in the same slot, and stayed below it on a reserve refreshed 60 seconds earlier.

### The stored rate, everywhere

- Quotes, swaps, adding liquidity and `rebalance` all value cTokens at the rate stored in the reserve account, with no projection to the current slot.
- The stored rate lagged 2 to 68 seconds behind on 2026-11-09, which understates the value by about 0.05 bps an hour of lag, far below any fee; it is always an understatement, because interest only raises the rate.
- Projecting it would mean copying Kamino's interest maths into our program, where any drift from Kamino's own would misprice.

### Kamino's losses fall on LPs

- The rate can fall: Kamino's lending market owner can write off bad debt with `socialize_loss`, which lowers the reserve's total supply.
- A market's lent value, and so its price and every LP share, falls with it pro rata; there is no insurance fund.
- Bad debt Kamino has not yet written off still counts as borrowed, so until then the stored rate overstates what the cTokens can fetch.
- If a write-off reaches the reserve's whole supply, Kamino deprecates the reserve and redeems stop for good; the market then behaves as under emergency mode (see "When Kamino can't pay").
- On 2026-11-16 klend's real `socialize_loss`, run on an obligation edited to owe debt with no collateral, halved our devnet reserves' total supply, and the market's `V`, its price and every LP share's claim on the lent side fell with it pro rata, to the unit, while quotes still equalled swaps within the buffer and beyond it; on the mainnet reserves it lowered them by 4.6% and 7.6% ([Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83)).
  A write-off of exactly the whole supply deprecated the reserve on both builds and left its cTokens worth nothing, so the market traded from its buffer alone; klend itself panics on a write-off beyond the whole supply where protocol fees make the supply smaller than what is borrowed.

### Checking the reserve before reading it

- Every instruction that reads the reserve first checks its address (the constant for the lent mint), owner (`KLEND_PROGRAM`), size (8624 bytes), Anchor account discriminator, lending market, liquidity mint and collateral mint.
- On any mismatch, such as a Kamino upgrade that changes the layout, it refuses rather than misprices: quotes, swaps, adding liquidity and `rebalance` fail.
- Each part has its own error, in the order above (`ReserveWrongAddress`, `ReserveNotKamino`, `ReserveWrongSize`, `ReserveWrongDiscriminator`, `ReserveWrongLendingMarket`, `ReserveWrongLiquidityMint`, `ReserveWrongCollateralMint`), so a trade built without the reserve fails with `ReserveWrongAddress` whatever account sits in its place.
- The check runs whether or not the market holds cTokens, so a Kamino change stops trading in every market at once rather than only in those that have lent.
- Removing liquidity in kind never reads the reserve, so a Kamino change can stop trading but can never trap LPs.

## Swaps

### Pricing

Exact-in only, so `pipeline_market_info` reports `supports_exact_out = false` and an exact-out quote or swap is refused.

For a trade from side `i` to side `o`, with effective reserves `E` (`R` for the other side, `L` for the lent side) and credited input `a`:

- `a_net = a - ceil(a x lp_fee_bps / 10,000)` and `out = floor(E_o x a_net / (E_i + a_net))`.
- The whole of `a` joins side `i`, so the LP fee stays in the market and accrues to LPs.
- Intermediate maths is in u128; the fee rounds up and the output rounds down, so the product of the effective reserves never falls.
- Input is credited with Pipeline's `credited_input`: what the input vault holds beyond what the market has recorded there, capped at what the router sent.
- The input stays in the input vault for the whole swap, as Pipeline's guide asks; lent-side input simply joins the buffer.
- A quote or swap is refused when `out` is 0, when the other side would pay out its whole reserve, or when the lent side would pay out more than the buffer plus what Kamino can pay right now.

### Redeeming the shortfall

- When the output is the lent side and `out` exceeds the buffer `B`, the swap redeems the shortfall `s = out - B` from Kamino before paying the trader.
- It burns `ceil(s x S_ctoken / S_total)` cTokens with `redeem_reserve_collateral`; Kamino refreshes the reserve inside that call, so the rate it pays at is at least the stored rate, and the market receives at least `s`.
- The market measures what actually arrived in its vault; anything above `s` stays in the buffer.
- What Kamino can pay right now is the smallest of: the reserve's freely available liquidity (`total_available_amount` minus the value of queued withdrawal tickets), what remains of its withdrawal cap in the current interval, and the value of the market's own cTokens; it is zero while either emergency mode is on or the reserve is deprecated.
  As klend counts them: the cap has no limit when its interval length is 0, is back to its whole capacity once the interval is over, counts net outflow (deposits make the running total smaller, even negative), and leaves nothing for a negative capacity or an interval starting in the future; a reserve is deprecated when its `version` is not klend's program version, 1, which klend sets to `u64::MAX` after a total write-off; and the lending market's emergency mode is its byte at offset 122.
  `block_ctoken_usage` does not change it, since it stops deposits, not redeems ([Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79), 2026-11-12, each term shown binding against klend's real redeem).
- `pipeline_quote` and `pipeline_swap` call the same pricing function on the same reserve fields, so a quote shows whether a trade redeems and refuses a trade Kamino could not pay, and `pipeline-check`'s `quote_matches_swap` verifies quotes on both sides of the buffer's edge.

How it is built ([Lending AMM: redeem a swap's shortfall from Kamino inside the swap](https://github.com/imDev2023/testing-pipeline/issues/81), 2026-11-16):

- The burn is `ceil(s x S_ctoken / S_total)` at the stored rate, computed exactly as the floor of `ctokens_for_value` plus one when its division leaves a remainder: the fewest cTokens worth at least `s` at that rate, so one fewer would be worth less than `s` and they are at most one cToken more than the shortfall needs.
  Proptest, Kani (bounded, and full-domain behind `kani_full`) and Z3 (`proofs/kamino_z3.py`, claim 4) prove it.
- What Kamino can pay right now is counted for a swap's redeem as for a redeem `rebalance` plans, with `KAMINO_RATE_HEADROOM_BPS` taken off its freely available liquidity and what remains of its withdrawal cap (see "The rule"), since the burn's payout grows with the rate klend refreshes to and klend refuses a redeem past either limit; so a quote refuses a trade slightly before klend itself would, never after.
  It reads the lending market, for its emergency mode, and the clock, for the withdrawal cap, and only for a lent-side output beyond the buffer; a trade the buffer covers reads neither.
- The swap measures the lent mint that arrived in its buffer vault and the cTokens that left its cToken account, fails with `RedeemPaidShort` should klend ever pay less than `s` (it cannot while interest only raises the rate), records both and adds what arrived to its running total redeemed, then pays the trader exactly the quote.
- It emits `ShortfallRedeemed` with the shortfall, the cTokens burned, the lent mint received, and the buffer, cTokens and running total redeemed it records afterwards.
- As in a `rebalance`, Kamino's rounding may lower the lent side's total by one unit in a redeeming swap: klend pays `floor(k x rate)` for the `k` cTokens burned while the market values the rest rounded down too; the tests and the fuzzer allow that unit and no more.
- With a redeem `pipeline_swap` measured at most 59.6k compute units on both builds, klend's redeem 31.0k of them, `pipeline_quote` 15.8k and `pipeline_resolve_accounts` 18.7k; an in-swap redeem from a smart wallet calling the router, with a hooked token on the other side, runs klend's token transfers at the fifth and last call level with SIMD-0268 off.

### Accounts

- Every swap needs the output vault, the vault authority, which signs the payout, and the reserve, read-only, for valuation; `pipeline_resolve_accounts` lists them in that order.
- `pipeline_resolve_accounts` receives the trade, so it lists the Kamino redeem accounts after the reserve and marks the reserve writable only when the trade's quote needs a redeem: klend, the lending market, the lending market authority, the reserve's liquidity supply (writable), its collateral mint (writable), the market's own cToken account (writable), whose cTokens the redeem burns, SPL Token, which is both of the token programs klend's redeem takes, and the instructions sysvar ([Lending AMM: redeem a swap's shortfall from Kamino inside the swap](https://github.com/imDev2023/testing-pipeline/issues/81), 2026-11-16).
- A trade paying out the other side never redeems, and resolves in one round; one paying out the lent side needs the reserve's data to run its quote, so it resolves in two, Pipeline's way for a strategy that must read accounts before it knows the rest: the first round lists the three accounts with `complete: false`, and the second receives them, runs the quote with the same pricing function as quotes and swaps, and adds the redeem accounts only if the quote redeems.
  A reserve that fails its check, and a trade the quote refuses, get no redeem accounts, and their quote and swap report why.
  Resolution counts what Kamino can pay from the reserve alone (its emergency mode, deprecation, free liquidity and withdrawal cap), since it has no lending market account; so a trade only the lending market's emergency mode refuses still gets the redeem accounts, and its quote and swap, which read the lending market, refuse it with `BeyondBuffer`.
  A quote or swap built without the redeem accounts counts what Kamino can pay the same way, so a trade the reserve alone refuses fails with `BeyondBuffer`, its reason, and one that would redeem fails with `RedeemAccountsMissing` ([Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83), 2026-11-16).
- Ordinary swaps then pass the reserve read-only, for valuation, and never write-lock Kamino's reserve, which every Kamino user of that mint shares.
- The program recognises the redeem accounts by klend's id where they start, and only after a lent-side output's reserve, where nothing else can follow since a lent mint has no transfer hook; it checks them, as `rebalance` checks its own, only when the trade redeems, each failure with `KaminoAccountWrong` unless the reserve check or the lending market check names it, the cToken account against the market's own, and the redeem pays only into the output vault, which must be the market's own lent-mint vault.
- A swap that needs a redeem but was built without those accounts, because the buffer shrank between quote and swap, fails cleanly with its own error, `RedeemAccountsMissing`, and changes nothing, and the integrator resolves again.
- The instructions sysvar among the redeem accounts is klend's, which its redeem introspects; the lending AMM never reads it, but Canary's `transaction_accounts` check lists it for any sale it resolves beyond the buffer, as it would for any strategy whose swap calls klend.
- A swap that redeems costs about 30k compute units more (Kamino's redeem, mainnet median 29,670).

### Bypass

- Refused: `pipeline_swap` accepts only the router's market signer stored at creation, as in the tax AMM.
- So every trade pays Pipeline's fee and emits a swap event.
- No custom action moves the price.

## The buffer and `rebalance`

### The rule

- The buffer's share is `B / L`.
- Inside the band (`BUFFER_MIN_BPS` to `BUFFER_MAX_BPS`), `rebalance` does nothing and fails with `WithinBand`, so a keeper's simulation shows there is nothing to do and nobody pays for a no-op.
- Above the band it deposits `B - L x BUFFER_TARGET_BPS / 10,000` into Kamino with `deposit_reserve_liquidity`; below the band it redeems `L x BUFFER_TARGET_BPS / 10,000 - B`, capped at what Kamino can pay right now.
- A move smaller than `MIN_REBALANCE` is skipped.
- The market measures the cTokens or liquidity that actually moved and records them.
- The market state also keeps running totals of the liquidity it has deposited into Kamino and redeemed from it, in swaps and removals as well, so its lending yield so far is `V + redeemed - deposited`.
- With 20% held back, a sell that drops the price by about a third is paid from the buffer alone.

How it is built ([Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80), 2026-11-16):

- The target is `t = floor(L x BUFFER_TARGET_BPS / 10,000)`, and the band is compared exactly in 128-bit integers, `B x 10,000` against `L x BUFFER_MIN_BPS` and `L x BUFFER_MAX_BPS`, with both edges inside it; so above the band it deposits `B - t` and below it redeems `min(t - B, what Kamino can pay right now)`.
- What Kamino can pay right now is counted, for a redeem `rebalance` plans, with each of Kamino's own limits, its freely available liquidity and what remains of its withdrawal cap, lowered by `KAMINO_RATE_HEADROOM_BPS` of itself, since klend pays at the rate it refreshes the reserve to inside the redeem, above the stored rate the redeem is planned at, and refuses a redeem that would pass either limit; the value of the market's own cTokens needs no headroom.
  On 2026-11-16 a redeem capped by the withdrawal cap landed with 10 bps of headroom a day after the last refresh on both mainnet reserves, and an hour after it on our devnet reserves, whose curve is steep on purpose; beyond what the headroom covers klend refuses the redeem and the call fails whole, changing nothing.
  A keeper that sees the reserve's stored rate is stale then puts klend's own `refresh_reserve` first in the same transaction, with the reserve's oracle accounts, so the redeem is planned at a rate refreshed in that slot and the headroom has no interest to cover; that way `rebalance` redeems what Kamino can pay however stale the reserve was, without projecting interest in the program or widening the headroom ([Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83), 2026-11-16, a month stale on both builds' reserves).
- A move below the lent mint's `MIN_REBALANCE`, and a redeem Kamino can pay nothing of, fail with `BelowMinRebalance` and change nothing, as inside the band they fail with `WithinBand`, so a keeper's simulation shows either and nobody pays for a no-op.
- A redeem burns as many cTokens as are worth at most the shortfall at the stored rate, `floor(s x S_ctoken / S_total)`, or every cToken the market holds once the shortfall reaches their whole value, so at the stored rate the buffer never passes its target and lands less than one cToken's worth short of it.
- klend rounds both calls its own way: a deposit mints `floor(d x S_ctoken / S_total)` cTokens and takes back what they are worth rounded up, and a redeem pays at the rate it refreshes to; so a `rebalance` may lower the lent side's total by one unit, and no more, which is the only way it can move the price or an LP share's value.
- `rebalance` checks every account it passes to klend before calling it (see "Custom actions and metadata"), and a call klend refuses fails whole.

### Withdraw mode

- `rebalance` checks Kamino's freely available liquidity against `X = max(V, T)`: the larger of the market's lent value `V` and its target lent value `T = L x (10,000 - BUFFER_TARGET_BPS) / 10,000`, what it would lend with the buffer at its target.
- Below `WITHDRAW_MODE_ENTER` times `X`, the market enters withdraw mode: `rebalance` redeems everything Kamino can pay and deposits nothing.
- Above `WITHDRAW_MODE_EXIT` times `X`, it leaves withdraw mode and the band applies again.
- Measured against `V` alone the rule would flap: once the market has redeemed everything `V` is 0, so the next `rebalance` would leave withdraw mode at once, lend back into the same crunch and re-enter (owner, 2026-11-10).
  With the target term a market that has redeemed everything stays in withdraw mode until Kamino has 10 times its target lent value free, and a market never makes its first deposit into a reserve too thin to pay it back.
- On 2026-11-09 Kamino's SOL reserve had about 218,000 SOL free at 90.9% utilisation, and it blocks new borrowing above 90%, so withdraw mode only bites in a real crunch, and then our LPs leave early rather than last.

How it is built ([Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83), 2026-11-16):

- The rule is `withdraw_mode::decide`, a pure function of the market's buffer, its lent value at the stored rate, the mode it is in, and what `rebalance` reads of Kamino: the reserve's freely available liquidity, what a redeem may plan to take (see "The rule"), whether Kamino redeems nothing, and whether it blocks cToken deposits.
- The free liquidity is `total_available_amount` less the value of queued withdrawal tickets, the same figure klend checks a redeem against, read at the stored rate.
- `T` is `L - floor(L x BUFFER_TARGET_BPS / 10,000)`, what the market would lend with the buffer exactly at its target, which rounds `L x (10,000 - BUFFER_TARGET_BPS) / 10,000` up.
- The market enters withdraw mode when the free liquidity is below `WITHDRAW_MODE_ENTER x X`, leaves it when it is above `WITHDRAW_MODE_EXIT x X`, and keeps the mode it has from one to the other, both edges included; each product is a u64 times a u64 in 128 bits, so neither can overflow, the thresholds cannot overlap since the build refuses an entry multiple above the exit multiple, and Kani proves both for every input.
- In withdraw mode `rebalance` redeems `min(V, what Kamino can pay)` and deposits nothing; a redeem below the lent mint's `MIN_REBALANCE` is skipped unless it takes every cToken the market holds, so a market can always empty out its last cTokens.
- A call that enters or leaves withdraw mode succeeds and records the mode even when it moves nothing, for example entering with nothing Kamino can pay, or leaving with the buffer inside its band or deposits blocked; a call that neither moves nor changes the mode fails as before, with `BelowMinRebalance` in withdraw mode when there is nothing left to redeem, so a keeper's simulation still shows a no-op.
- Leaving and lending happen in the same call: once above the exit threshold the band applies at once.
- `rebalance` emits `WithdrawModeEntered` or `WithdrawModeLeft` with the free liquidity and the exposure `X` it measured, before its `Rebalanced`, if it moved anything.
- Since withdraw mode measures Kamino's free liquidity at the moment `rebalance` runs, `rebalance` refuses with `RebalanceNotAlone` unless it is called directly, at the transaction's level, beside nothing but compute budget instructions, klend's `refresh_reserve` and other `rebalance` calls, as the instructions sysvar shows; otherwise a deposit before it and a redeem after it, by klend's instructions or by another program calling klend, could force a market out of withdraw mode and lend its liquidity into a crunch, and a klend flash loan around it could force one in.
  Moving Kamino's liquidity across separate transactions stays possible for whoever bears it: a real borrow held around a `rebalance` can put a market into withdraw mode, where it stays until Kamino's free liquidity is back above the exit threshold, which costs the borrower interest and the market only its lending yield meanwhile, and a real deposit held around one can take a market out, which leaves that depositor's own liquidity in the same reserve; the program cannot see past its own transaction.
- On 2026-11-16 the local demo run brought the demo market into withdraw mode with devnet's klend: the test borrower took the WSOL reserve's free liquidity to 1.42 SOL, below 5 times the market's exposure of 0.29 SOL, and `rebalance` redeemed every one of its cTokens; a second call was refused with `BelowMinRebalance`, and after the repay `rebalance` left withdraw mode and lent 0.29 SOL again.

### When it runs

- `rebalance {}` is a permissionless custom action: anyone may call it at any time, and inside the band it does nothing, so it cannot be used to grief a market.
- It creates no accounts, so the caller pays only the transaction fee, and gets no tip.
- Our keeper runner calls it when Aviary's indexer sees a swap or an LP action leave a market outside its band, and sweeps every lending AMM market every 10 minutes for withdraw mode and anything missed.
- That is the lending AMM's whole answer for the map's keeper runner: one keeper job per market, triggered by events, a few calls an hour at most.
  Kamino's `withdraw_queued_liquidity` is not needed, since the program never holds a withdrawal ticket.

## When Kamino can't pay

The program has no switches of its own; it reads Kamino's state at each call.

| Kamino's state | Swaps | `rebalance` | Adding liquidity | Removing liquidity |
| --- | --- | --- | --- | --- |
| Normal | Buffer, then redeem the shortfall | Band and withdraw mode as above | Allowed | Cash or in kind |
| Little free liquidity, or withdrawal cap used up | Up to the buffer plus what Kamino can pay | Redeems what it can; withdraw mode if below the threshold | Allowed | Cash if Kamino can pay the LP's share, else in kind |
| `block_ctoken_usage` set (only Kamino's global admin can) | As normal | Skips deposits, still redeems | Allowed | Cash or in kind |
| Reserve or market emergency mode | Buffer only | Refuses | Allowed | In kind |
| Reserve deprecated after a total write-off | Buffer only, for good | Refuses | Refused | In kind |
| Reserve fails the layout check | Refused | Refuses | Refused | In kind |

- Kamino has used reserve emergency mode on its main market once in the period checked: the ETH reserve's redeems were blocked for about 16 hours from 2026-04-23 19:58 UTC, during the Kelp exploit; SOL and USDC were never touched.
- Our own devnet lending market lets the demo turn emergency mode on and off for real.

How it is built ([Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83), 2026-11-16):

- Kamino redeems nothing while either emergency mode is on or the reserve is deprecated (`Reserve::redeems_stopped`); what Kamino can pay is then 0, so swaps pay from the buffer alone, and a sale beyond it is refused with `BeyondBuffer` by the quote and the swap.
- `rebalance` refuses with `KaminoStopped` while Kamino redeems nothing, before anything else, and changes nothing.
- Under `block_ctoken_usage` a deposit `rebalance` would make is skipped, refused with `KaminoDepositsBlocked`, and redeems go ahead; leaving withdraw mode is still recorded.
- `add_liquidity` refuses with `ReserveDeprecated` once the reserve is deprecated, since no redeem will ever come from it; under either emergency mode it is allowed.
- A cash removal refuses with `KaminoCannotPay` before calling Kamino whenever Kamino redeems nothing and the LP's part holds any cTokens, even cTokens the stored rate values at nothing, as after a total write-off, so the LP takes them in kind; in kind works in every state, a failed layout check included.
- Little free liquidity and a withdrawal cap used up need nothing of their own: what Kamino can pay counts both, so swaps pay up to the buffer plus what Kamino can pay, `rebalance` redeems what it can (entering withdraw mode below the threshold), and a cash removal goes ahead only when Kamino can pay the LP's cTokens' part.
- The tests make every state by editing the accounts dumped from each build's cluster and run klend's deployed bytes on them, every column of the table on both builds (`tests/kamino_states.rs`), and the local demo run turns the WSOL reserve's emergency mode on and off with devnet's klend.

## Liquidity and LP shares

### Shares

- A market's share count is `N = LP mint supply + MINIMUM_LIQUIDITY`; the locked minimum is never minted, so it can never be withdrawn.
- LP shares burned with SPL Token's burn leave the count, which hands their value to the remaining LPs; to keep liquidity in the market for good, send shares to the lock account instead (see `lock_lp`).

### Adding

`add_liquidity { max_0: u64, max_1: u64, min_lp: u64 }`, signed by the LP, with the most it will add of each mint by mint index, as its accounts are ordered, so a form can show each amount with its own mint's decimals whichever side is lent ([Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78), 2026-11-12; below, `other` and `lent` are the two maximums by side):

- The first deposit takes both amounts in full, both above 0, sets the price, and mints `isqrt(other x lent) - MINIMUM_LIQUIDITY` shares; it fails if that is not above 0.
- Later deposits take both mints at the current ratio `R : L`, with the lent side valued at its total, mint `min(other x N / R, lent x N / L)` shares rounded down, and take only the amounts those shares are worth, rounded up.
- The lent-side deposit joins the buffer; `rebalance` lends it later, so adding never calls Kamino.
- It refuses if fewer than `min_lp` shares would be minted, and while the reserve is deprecated or fails the layout check.

### Removing

`remove_liquidity { lp: u64, min_other: u64, min_lent: u64, in_kind: bool }`, signed by the LP, who burns `lp` shares and receives pro rata, each part rounded down:

- the other side: `R x lp / N`, from its vault;
- the buffer's part: `B x lp / N`, in the lent mint;
- the cTokens' part: `c x lp / N` cTokens.

With `in_kind = false` the cTokens' part is redeemed from Kamino and paid in the lent mint, so the LP receives only the two mints; if Kamino cannot pay that part right now, the instruction fails before calling Kamino, and `min_lent` protects against a rate move.
With `in_kind = true` the cTokens' part is paid as cTokens into the LP's associated token account for the collateral mint, created at the LP's expense; this path reads no Kamino account and calls no Kamino instruction, so it works whatever state Kamino is in.
Aviary offers in kind whenever a cash removal would fail.
Either way the buffer's share of the market is unchanged, so one LP leaving never drains the buffer traders rely on.

How it is built ([Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82), 2026-11-16):

- The maths is `shares::removal`: each part is `X x lp / N` rounded down, with `N` the LP mint's supply plus `MINIMUM_LIQUIDITY`, so a removal never pays more than the burned shares' part of any of the three and the locked minimum's part of each always stays behind; burning no shares, more shares than exist, or shares worth less than one unit of every part is refused with `ZeroRemoval` or `NotEnoughShares`.
  Proptest, Kani (bounded, and full-domain behind `kani_full`) and Z3 (`proofs/removal_z3.py`) prove that, and that adding then removing at once never returns more than was put in of either side, the cTokens' part counted at its value at any rate.
- The LP signs the burn of their own shares, from any token account of the LP mint they own; an account they are only a delegate of is refused with `WrongAccount`, as is any account of the market other than its own.
- In cash, the program checks every Kamino account as `rebalance` does, then refuses with `KaminoCannotPay` before burning anything or calling Kamino unless the cTokens' part, valued at the stored rate, is within what Kamino can pay right now as a swap's redeem counts it, `KAMINO_RATE_HEADROOM_BPS` included; it redeems exactly that part into the market's buffer vault, measures what klend paid, and pays the LP the buffer's part plus all of it, at the rate klend refreshed to.
  cTokens worth less than one unit at the stored rate are not redeemed, since klend would pay nothing for them; they stay in the market, as every part's rounding does, and a cash removal that would then pay nothing at all is refused with `ZeroRemoval` rather than burn the shares for nothing.
- In kind, the cTokens' part goes to the LP's associated token account for the collateral mint, which the associated token program creates at the LP's expense only when it is missing; only an in-kind removal checks that account, so a cash removal pays for no address search it does not need.
- cTokens paid in kind take their part of the net amount lent, `deposited - redeemed` times the share of the market's cTokens they are, rounded towards zero, off `deposited` (off `redeemed` while redeemed is the larger), so the market's lending yield `V + redeemed - deposited` keeps measuring the cTokens it still holds plus what it has redeemed, without the in-kind path valuing them.
- `remove_liquidity` takes the lent mint's Kamino accounts last, as Anchor optional accounts: an in-kind removal passes the program's own id in their seven places, so it holds no Kamino account at all, and never reads one even when given; a cash removal that must redeem but lacks them fails with `KaminoAccountsMissing`.
  The collateral mint is read-only among the shared accounts, where in kind only its decimals are read, so an in-kind removal never write-locks the mint every Kamino user of the reserve shares; a cash removal passes it again, writable, as the last Kamino account, since klend burns from its supply.
- `min_other` bounds the other side's part, and `min_lent` the lent mint paid: the buffer's part, plus klend's payout in cash.
- The market records exactly what left: the other side and the buffer lose their parts, the cTokens what was paid in kind or what klend burned, and the running total redeemed gains what klend paid; it emits `LiquidityRemoved` with the shares burned, the share count afterwards, what each mint paid, the cTokens that left, whether in kind, and klend's payout.
- Per share none of `R`, `B` and `c` falls, but the market values the cTokens that remain rounded down, so a removal may lower `L x lp / N` by one unit of the lent mint, as Kamino's rounding may in a `rebalance`; the tests and the fuzzer allow that unit and no more.
- With the hook and creating the LP's cToken account, a removal measured at most 76.1k compute units in cash, klend's redeem 31.3k of them, and 62.7k in kind; on 2026-11-16 an LP removed in kind on a reserve whose free liquidity, emergency modes, version or layout each stopped a removal in cash, and redeemed the cTokens at klend itself for at least what the market had valued them at.

### Locking

`lock_lp { amount: u64 }`, signed by an LP, moves LP shares into the market's lock account and emits an event, so indexers can show how much of a market's liquidity is locked.
Locked shares still count in `N` and still earn the LP fee and the yield, which stay in the market as depth for traders; this is MetalLegBob's protocol-owned liquidity.

How it is built ([Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82), 2026-11-16):

- The LP signs a transfer of `amount` shares, at least one (`ZeroLock`), from any token account of the LP mint they own into the lock account, which the first lock creates at that LP's expense through the associated token program.
- The program checks the lock account against the vault authority's associated token address for the LP mint; nothing can close it, since only the vault authority could, and the vault authority signs only transfers out of the market's vaults and cToken account, its LP mint's mints and its Kamino calls, each from an account the program checks.
- It emits `SharesLocked` with the shares locked, the lock account's balance afterwards and the share count, which locking leaves unchanged.
- Metadata cannot describe the associated token account of a mint that is itself a PDA (a `pda:` source inside an `ata:` one, as under "Addresses"), so the `lock_lp` action takes the lock account as the named input `lock_account`, which Aviary's form fills in.

### Seeding

- `pipeline_seed_liquidity` takes `SeedRequest.data` as the Borsh encoding of `{ lent_index: u8, lp_fee_bps: u16 }`, under the same rules as creation.
- It creates the market at the seeder-scoped address, takes at most `amounts[i]` from each escrow, opens the market at the price those amounts imply, mints the first deposit's shares to the associated token account of the LP recipient (seed account 4) for the LP mint, and returns `SeedResult { taken, lp_amount }`.
- A launchpad that wants the liquidity locked names the market's vault authority as the LP recipient, which puts the shares straight into the lock account.
- The caller then records the market with the router's `register_existing_market` and `init_fee_account` for each mint, in the same transaction.

How it is built ([Lending AMM: seeding by a launchpad](https://github.com/imDev2023/testing-pipeline/issues/84), 2026-11-16):

- The accounts are Pipeline's fixed seed accounts (the seeder, the market state, the payer, the system program, the LP recipient), then mint, escrow and token program for each mint, then the vault authority, both vaults, the collateral mint, the cToken account, the LP mint and SPL Token, as `init` takes them, then the LP recipient's associated token account for the LP mint, the associated token program and the lent mint's reserve; the other mint's transfer-hook accounts follow.
- The market is created by the same code as `pipeline_init_market`, so it refuses every market creation refuses, and stores the router's market signer and the seeder; the mints may come in either order, and the address is the same either way.
- `SeedRequest.amounts` must hold exactly two amounts (`BadSeedAmounts`), and the first deposit is `add_liquidity`'s: both above 0 (`ZeroDeposit`), enough for a share above the locked minimum, and refused while the reserve fails its check or is deprecated (LENDING-84 in `docs/decisions.md`).
- Each escrow's balance is measured before and after its transfer, the seeder signing, and `SeedResult.taken` reports what left it; `lp_amount` is the shares minted.
- The strategy creates the LP recipient's associated token account for the LP mint idempotently, from the payer's SOL, and refuses any other account there (`WrongAccount`); the metadata's `seed_liquidity` form takes it as the named input `lp_recipient_shares`, since metadata cannot describe the associated token account of a mint that is itself a PDA (LENDING-85).
- It emits `MarketCreated`, then `MarketSeeded` with the seeder, the LP recipient, the shares account, the amounts, the shares and the share count (LENDING-87).
- Signed by the creator alone, the graduation with `register_existing_market` and both `init_fee_account` calls fits a legacy transaction on SPL Token and plain Token-2022 tokens (1,124 to 1,188 bytes in the tests, with the stand-in launchpad, since Pipeline 0.2 dropped the config account from `register_existing_market`), but with a transfer hook's two accounts it fits only when the shares are locked (1,222 bytes) and not when they go to a wallet (1,254), so a launchpad graduating a hooked token sends a version 0 transaction with an address lookup table of the accounts every graduation shares (1,010 and 1,042 bytes) (LENDING-86).
- A seeded market then lends, redeems a swap's shortfall and pays removals in cash and in kind exactly as a market created through the router with the same amounts, on both lent mints; the invariant fuzzer seeds about half its markets, their shares locked, and `pipeline-check` passes them before and after they lend.

## Who earns what

- LPs: the LP fee and all the lending yield, pro rata through their shares, and Kamino's losses likewise.
- Pipeline: its 0.25% router fee on every swap.
- Us: nothing from the strategy; Aviary earns its integrator fee on the trades it routes.
- A market's creator: nothing beyond their own LP shares.

## Custom actions and metadata

| Action | Metadata `kind` | Signer |
| --- | --- | --- |
| `add_liquidity` | `add_liquidity` | The LP |
| `remove_liquidity` | `remove_liquidity` | The LP |
| `remove_liquidity`, in kind (the form `remove_liquidity_in_kind`) | `remove_liquidity` | The LP |
| `lock_lp` | `other` | The LP |
| `rebalance` | `other` | Anyone |

- Every action that moves the other mint forwards transfer-hook accounts after its own, as the template's swap does.
- Each instruction emits an event (market created, liquidity added, liquidity removed with the in-kind amount, shares locked, rebalanced with the amount and direction, withdraw mode entered or left, a swap's redeem with its amount) so Aviary's indexer can show a market's history; Aviary reads current values from the market state and the reserve, not from events.
- The metadata follows `pipeline-strategy-metadata/1` at `5ad130d`: name, description, category `amm`, tags including `lending` and `kamino`, links including `source` and the IDL, `init` as above with `market_state` as a `pda:` source, every action above, `security.contact`, and `conformance` pointing at a published `pipeline-check` report and its SHA-256.
- A `pda:` source lists its seeds in a fixed order and metadata arguments have no default values (the schema at `5ad130d`), so the `init` form takes the two mints as named inputs in the order of the market state's seeds, the other mint and then the lent mint, and that order makes `lent_index` 1; the form's label for `lent_index` says so, and Aviary's own form fills it in.
  A caller that builds `create_market` itself, and a launchpad seeding a market, may give the mints in either order.
- The `add_liquidity` action takes the lent mint's reserve the same way, as the named input `reserve` after its other accounts, since adding values the lent side from it; the program refuses any reserve but the one `LENT_MINTS` names, and Aviary's form fills it in ([Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79), 2026-11-12).
- The `rebalance` action takes the lent mint's Kamino accounts as named inputs, `lent_mint`, `reserve`, `lending_market`, `reserve_liquidity_supply` and `collateral_mint`, and the lending market authority as klend's PDA `["lma", lending_market]`; its caller is a read-only signer, and Aviary's form and the keeper fill the inputs in ([Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80), 2026-11-16).
  The program checks each before calling klend, each failure with `KaminoAccountWrong` unless the reserve check or the lending market check names it: klend's id, SPL Token, the instructions sysvar, the lent mint and the collateral mint against the lent mint's `LENT_MINTS` entry, the reserve as for every read, the liquidity supply against the reserve's own (offset 160), the lending market, and its authority against the PDA from the bump the lending market stores (offset 16); the buffer vault and the cToken account must be the market's own.
- `remove_liquidity` has two metadata forms, because metadata gives each action one fixed list of accounts and arguments with no defaults (the schema at `5ad130d`): `remove_liquidity` in cash, with the lent mint's Kamino accounts as `rebalance` takes them, and `remove_liquidity_in_kind`, which names the instruction by its `discriminator` and puts `strategy_program` in place of each Kamino account, the second, writable copy of the collateral mint among them; each form's `in_kind` label says which value it takes, as `lent_index`'s does in `init`.
  Both take the collateral mint as the named input `collateral_mint`, and the LP's cToken account as `ata:wallet,input:collateral_mint` ([Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82), 2026-11-16).
- The `init` form also takes the lent mint's collateral mint as a named input, because a market creates its cToken account at creation and metadata has no source for a value that depends on which mint is lent; the program refuses any collateral mint but the one `LENT_MINTS` names, and Aviary's form fills it in ([Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78), 2026-11-12).

## Aviary's panel

Aviary's lending AMM panel shows, per market:

- the lent side, its Kamino reserve and lending market, with links;
- the buffer, the lent value and the buffer's share against its band, and whether the market is in withdraw mode;
- the largest sell the buffer pays alone, and the largest Kamino can pay right now on top;
- Kamino's utilisation, freely available liquidity, supply rate, emergency modes and `block_ctoken_usage` for the reserve;
- the LP fee, LP share value, locked shares, and the market's lending yield so far;
- the actions above as forms, with in kind offered whenever a cash removal would fail.

The explainer's fact table carries the same facts, and its risks for every lending AMM market are: Kamino's owner and emergency council can stop redeems, as they did on the ETH reserve for 16 hours; LPs bear Kamino's written-off losses, and bad debt not yet written off is not shown in the rate; swaps larger than the buffer plus Kamino's free liquidity fail.

## Upgrades and freezing

- On devnet the program stays upgradeable under the project's upgrade-authority key, `~/.config/testing-pipeline/devnet/upgrade-authority.json`, as `docs/spec/README.md` sets for every program.
- Intended mainnet upgrade policy: frozen (upgrade authority removed) before any mainnet deployment.
  This departs from the shared default of a multisig with a timelock first: keeping an upgrade key to follow changes in Kamino would be an admin key every LP has to trust, and the in-kind exit already covers a Kamino change.
- A Kamino change that breaks the layout check stops trading in our markets but never traps LPs, who leave in kind; a new strategy version then serves new markets, and LPs move by removing and adding.
- Carrying the policy out belongs to the mainnet launch effort.

## For the shared engineering bar

What `docs/spec/README.md` asks each product's file to add.

### Compute ceilings

Asserted per instruction in test layer 5; the build ticket measures each one and may lower it, and raising one needs a written reason here.
The tests measure each on plain SPL Token and Token-2022 mints and on a mint with Pipeline's `test-hook`; on 2026-11-12 the highest were `pipeline_init_market` 65k, `add_liquidity` 45k (a first deposit that creates the LP's shares account, with the hook), `pipeline_swap` 24k (paying out the hooked token), and `pipeline_quote` and `pipeline_resolve_accounts` 6k ([Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78)).
With the reserve checked and read, on markets holding cTokens, they were `pipeline_quote` 8.5k, `pipeline_swap` 28.2k (paying out the hooked token), `pipeline_resolve_accounts` 6.2k and `add_liquidity` 43.1k, and the one-transaction creation 1,198 of the 1,232 bytes a transaction may hold ([Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79)).
`rebalance` measured at most 69.2k depositing and 56.5k redeeming on both builds, of which klend's own deposit took up to 54.3k and its redeem up to 31.4k; and since the PDA searches in `add_liquidity` cost 1,500 units for every bump they try, so that its cost depends on the LP's key and a hooked mint's (from 39k to 56k over 300 random runs for the hooked first deposit), the tests measure it on fixed keys ([Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80), 2026-11-16).
A swap that redeems its shortfall measured at most 59.6k on both builds, klend's redeem 31.0k of it, its quote 15.8k and its two rounds of `pipeline_resolve_accounts` at most 18.7k, the second running the quote; the ceilings stand ([Lending AMM: redeem a swap's shortfall from Kamino inside the swap](https://github.com/imDev2023/testing-pipeline/issues/81), 2026-11-16).
In every state of "When Kamino can't pay" but a failed layout check, every call the state allows stayed under its ceiling on both builds, and every call it refuses was refused: at most 59.8k for a swap that redeems, 26.3k for its account resolution, which now counts what the reserve can pay, 15.7k for its quote, 71.8k for `rebalance` depositing and 59.2k redeeming, entering or leaving withdraw mode included, with its check of the transaction's other instructions, 65.3k for a cash removal and 47.4k for one in kind; the ceilings stand ([Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83), 2026-11-16).
`remove_liquidity` measured at most 76.1k in cash (klend's redeem 31.3k of it) and 62.7k in kind, both with the hook, the second creating the LP's cToken account; `lock_lp` measured 12.5k into an existing lock account and 32.5k for the market's first lock, which creates the lock account through the associated token program, so its ceiling rises from 20,000, set for one transfer, to 40,000 ([Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82), 2026-11-16).
`pipeline_seed_liquidity` measured at most 110.6k on both builds through the stand-in launchpad, on a hooked token with the shares to a wallet, which creates five accounts, the recipient's shares account among them; the ceiling stands ([Lending AMM: seeding by a launchpad](https://github.com/imDev2023/testing-pipeline/issues/84), 2026-11-16).

Every instruction measured in every state of "When Kamino can't pay", a failed layout check included, on both builds, gave the Measured column, the highest cost of each row over every mint and state; every ceiling is that cost plus a quarter, rounded up to a multiple of 5,000, and the tests assert every cost against both its ceiling and the Measured column, so a change that costs more must update the column, and the rule against the table ([Lending AMM: the fuzzer against a moving Kamino, and the proofs completed](https://github.com/imDev2023/testing-pipeline/issues/85), 2026-11-16).
With Pipeline 0.2's crates (2026-11-19), CI's build measured `rebalance` and `lock_lp` 6 units higher, 71,764 and 36,987.
With Pipeline 0.3 (2026-11-22), whose fee on a sale into wrapped SOL leaves the test's traders other balances than before, `lock_lp` creating the lock account on USDC measured 36,990, the column's.
On 2026-11-20 CI's build measured `rebalance` depositing on SOL at 71,773, where a run of the same code on the same runner minutes before had stayed within 71,764, while the owner's Mac measures it the same on every run; the column records the higher.
Two rows depart from that rule.
`add_liquidity` keeps 60,000 rather than 55,000, because its PDA searches make its cost depend on the LP's key and a hooked mint's, and on random keys the hooked first deposit measured up to 55,635.
`lock_lp` rises from 40,000 to 50,000, because the market's first lock creates the lock account through the associated token program, whose address search costs 4,500 units for every bump it tries after the first: on a market whose lock account needs one bump more than the market measured before, it took 36,981 against the 32,500 recorded then.
These figures are measured on fixed keys; a caller sizing a compute limit for an instruction that searches for an address adds 1,500 units for every further bump the address needs, and 4,500 where the associated token program creates the account.
Account resolution still answers while the reserve fails its layout check, since it reads the reserve only to choose the redeem accounts; the quote and the swap are what refuse.

| Instruction | Measured (compute units) | Ceiling (compute units) | Main cost |
| --- | --- | --- | --- |
| `pipeline_quote` | 15,669 | 20,000 | Reserve checks and fixed-point maths; well under the quoter's 200,000 cap |
| `pipeline_swap`, no redeem | 25,281 | 35,000 | One output transfer, the reserve read; the router's own 30k to 35k is outside it |
| `pipeline_swap`, with a redeem | 59,801 | 75,000 | Kamino's redeem (mainnet median 29,670) |
| `pipeline_resolve_accounts` | 26,268 | 35,000 | Runs the quote to decide on the redeem accounts |
| `pipeline_init_market` | 61,325 | 80,000 | Creating two vaults, the cToken account and the LP mint |
| `pipeline_seed_liquidity` | 110,575 | 140,000 | Creation plus the first deposit |
| `add_liquidity` | 40,662 | 60,000 | Two transfers in, an LP mint |
| `remove_liquidity`, cash | 76,080 | 100,000 | Kamino's redeem, transfers out, an LP burn |
| `remove_liquidity`, in kind | 62,710 | 80,000 | Transfers out, possibly creating the LP's cToken account |
| `rebalance` | 71,773 | 90,000 | Kamino's deposit (mainnet median 43,704) or redeem |
| `lock_lp` | 36,990 | 50,000 | One transfer, and the market's first lock creates the lock account |

### Invariants for test layer 3

Beyond the shared three (value conserved, every holder can exit, each quote equals its swap), checked after every step of the generated sequences, with Kamino's rate moved up between steps and occasionally down by a write-off:

- What the market has recorded never exceeds what it actually holds: the buffer and the other side against their vaults, the cTokens against the cToken account.
- At a fixed Kamino rate, no swap lowers the product `R x L`, and no instruction lowers the value of an LP share; only a fall in Kamino's rate does, and a `rebalance` or a swap that redeems by Kamino's rounding, at most one unit of the lent side (see "The rule" and "Redeeming the shortfall"), and a removal by the rounding down of the remaining cTokens' value, at most one unit too, while per share none of `R`, `B` and `c` falls (see "Removing").
- A removal in kind succeeds for every LP in every Kamino state, emergency modes, a deprecated reserve and a failed layout check included.
- A swap never deposits into Kamino, never redeems when the buffer covers its output, and never redeems more than its shortfall plus one rounding unit's worth of cTokens.
- Outside withdraw mode `rebalance` only ever moves the buffer's share towards `BUFFER_TARGET_BPS`; in withdraw mode it only redeems; and it never deposits while cToken deposits are blocked.
- A market in withdraw mode stays in it across `rebalance` calls for as long as Kamino's freely available liquidity is at or below `WITHDRAW_MODE_EXIT` times `max(V, T)`, however much it has already redeemed.
- The share count `N` changes only by `add_liquidity`, `remove_liquidity`, seeding and SPL burns, and the lock account's balance never falls.

How it is built ([Lending AMM: the fuzzer against a moving Kamino, and the proofs completed](https://github.com/imDev2023/testing-pipeline/issues/85), 2026-11-16):

- The fuzzer, `tests/common/fuzz.rs`, mixes every instruction, created and seeded markets, donations and clock jumps with Kamino's moves, all on klend's deployed bytes: interest raises the rate, by edits of what borrowers owe and by klend's own `refresh_reserve` after time passes; write-offs with klend's real `socialize_loss` lower it, one in ten of them of the whole supply, which deprecates the reserve for good; borrowers move the free liquidity from 0 to 15 times the market's exposure; and `block_ctoken_usage`, both emergency modes and a failed layout check switch on and off.
- It also checks that each call does what "When Kamino can't pay" gives for the state Kamino is in, and that no step but a write-off lowers the rate, so the value of an LP share may fall only on a write-off.
- Every failure names the invariant it breaks, and `tests/broken_builds.rs` shows each one able to fail: the deliberately broken builds in `tests/broken-builds.json`, each one careless edit (a rounding flipped the wrong way, a missing check) to a copy of the program's source built by `scripts/broken-builds.py` in its own target directory, so the program's source never carries them, must each be caught by the invariant the table names, at least one build for every invariant; they are copies of the `devnet` build, the one this project deploys.
- `PROPTEST_CASES` sets how many sequences run (24 in a plain `cargo test`, which CI runs on every push with the broken builds), and `FUZZ_SEED` the seed, which every run prints so it can be repeated.
- On 2026-11-16 a long run of 10,000 sequences of up to 32 steps found no violation on either build: the `devnet` build with `FUZZ_SEED=20261116` in 39 minutes, the `mainnet` build with `FUZZ_SEED=20261117` in 33, on the owner's Mac; the devnet run made 4,757 deposits and 2,709 redeems by `rebalance`, 1,478 withdraw mode changes, 7,522 swaps that redeemed, 3,248 removals in cash and 3,900 in kind, 12,972 rises of the rate, 3,927 write-offs of part of the supply and 416 of all of it, and ran 12,656 steps with the layout check failing.

### Proofs (test layer 2)

Every pure function of the program's maths (`pricing.rs`, `shares.rs`, `buffer.rs`, `withdraw_mode.rs` and the maths of `kamino.rs`) has a Kani harness, and every Proptest property a Kani or Z3 counterpart ([Lending AMM: the fuzzer against a moving Kamino, and the proofs completed](https://github.com/imDev2023/testing-pipeline/issues/85), 2026-11-16).

- The default tier, 42 harnesses, which CI runs, proves over every input every property that needs no reasoning about a quotient (nothing panics or overflows, the shortfall, what Kamino can pay, the withdrawal cap, the total supply, the share count, and that cTokens of no value are worth nothing), and the quotient properties for bounded inputs.
- Behind `--cfg kani_full` the same properties are stated for every input; run once on 2026-11-16 for 3 hours on a loaded machine, 44 harnesses verified, none failed, and 17 did not finish, the divisions and the 64-step loops.
- Each of those 17 is proven for every input by Z3, in six files and 33 claims under `proofs/` sharing `proofs/z3_common.py`, which CI runs: among them that the band's products and its edges in units of the lent mint give the same band, isqrt's loop invariant, the running totals cTokens paid in kind take with them, withdraw mode's exposure and thresholds, the rate headroom, and that a higher rate never values the cTokens lower, which is why only a fall in Kamino's rate can lower an LP share's value.
- Every Z3 claim added then was shown able to fail by a deliberate mutation.
- `quote` itself has a harness only in the full tier, because CBMC also encodes the Anchor errors it can build; the default tier proves its parts (`exact_in`, `lent_total`, `shortfall`), and the fuzzer checks that each quote equals its swap.
- The byte decoding of Kamino's accounts and the account checks are left to the LiteSVM, layout and hostile tests.

### Accepted `pipeline-check` warnings

None.
Exact-out checks are skipped by design and need no reason.

## Devnet

- Our own Kamino lending market, owned by a key in `~/.config/testing-pipeline/devnet/`, with a WSOL reserve and a reserve for our own test USDC mint (6 decimals, mint authority in the same folder), since Circle's devnet USDC cannot be minted freely.
- Setting it up, from the [Kamino facts](https://github.com/imDev2023/testing-pipeline/blob/research/lending-market/research/lending-market-kamino-facts.md), section 1, as the first devnet script:
  1. `init_lending_market` with our key as owner.
  2. `init_reserve` for each mint, which takes a 100,000 base-unit seed deposit.
  3. While each reserve holds only the seed, `update_reserve_config` with validation skipped for the Pyth price account, the borrow rate curve and a borrow factor of 100.
  4. `update_reserve_config` for the deposit limit, with full validation, which opens deposits.
- Both reserves name the live devnet Pyth feeds (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` for SOL, `Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX` for USDC), even though the cToken path never reads them, so a test borrower can open an obligation and create utilisation.
- A second depositor, this project's devnet wallet, keeps each reserve's freely available liquidity above `WITHDRAW_MODE_EXIT` times the target lent value of the markets that lend to it.
  A reserve that held only our markets' own deposits would put every market into withdraw mode at its first `rebalance`.
  The test borrower then borrows that liquidity to bring withdraw mode on, and repays it to end it.
- The demo market is sized for that: with about 5 SOL free in the WSOL reserve, its lent side stays near 0.4 SOL, so its exposure stays below 0.5 SOL and the reserve above 10 times it until the test borrower borrows it down ([Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83), 2026-11-16).
  The `devnet` build's LiteSVM tests, whose markets lend 40 SOL and more, give the dumped WSOL reserve a second depositor of their own instead, written into the cloned accounts as klend's deposit would leave them, which keeps 2,500 SOL free.
- Run by us on 2026-11-10 with [`scripts/kamino-devnet`](../../scripts/kamino-devnet/README.md), from [Lending AMM: our Kamino lending market on devnet](https://github.com/imDev2023/testing-pipeline/issues/77); the sequence had been seen working on devnet before, on reserve `24EfeXj3XyLLE6GThh8ik4vcxEPMooAU5XXDL5nJHEr8` on 2026-09-14.
  The script creates the market, the mint and both reserves, plays the second depositor, a plain cToken holder and the test borrower, and turns the WSOL reserve's emergency mode, and the whole market's, on and off; each is a command the devnet demo can call.
  Every account it creates has an address derived from the market owner's or the mint authority's key, so a re-run finds the same accounts, and its `setup` changes only what differs from its policy values.
- The reserves' policy values live in one place, `scripts/kamino-devnet/src/policy.ts`: the borrow rate curve, steep enough that a few SOL borrowed show interest within seconds, the price max age, the loan-to-value and liquidation threshold, the deposit, borrow and withdrawal caps, and what each party deposits and borrows.
- Devnet's Pyth feeds were seen updating about every 5 minutes on 2026-11-10, against the 2 to 3 minute price max age of Kamino's mainnet reserves, so our reserves accept an older price; with it the test borrower borrowed and repaid on devnet.
- Devnet's klend, last deployed at slot 491,561,420, has the layout this file relies on: on 2026-11-10 both reserves read back with the Reserve's size and discriminator, every field of the Kamino facts, section 4, where it puts them, and the fields "Checking the reserve before reading it" compares at version 8, lending market 32, liquidity mint 128, liquidity supply 160, fee vault 192, collateral mint 2560 and collateral supply 2600; the lending market's emergency mode is at 122.
  Each field moved by exactly what the script did, and `npm run cli -- layout` checks them again at any time.

## Building it

- Generate the program from Pipeline's Apache-2.0 strategy template with `scripts/new-strategy.sh`, from a scratchpad clone at `5ad130d`, and pin the Pipeline crates to `rev = "5ad130d"`, as for the tax AMM.
- Keep the program keypair in `~/.config/testing-pipeline/devnet/`, never in the repo.
- Put every Kamino call and read in one module (deposit, redeem, reserve checks, total supply, what Kamino can pay now, flags), so a later strategy version can add another lending market without touching the pool's maths.
- Write the Kamino instruction data, account lists and reserve offsets by hand from klend 1.28.0, and never depend on the klend crate: klend is BSL 1.1 with no use grant until 2027-11-17, so we call its deployed program but never compile its code into ours.
- Tests load klend's deployed program bytes with cloned mainnet reserve, lending market and mint accounts, as `docs/spec/README.md` (test layer 6) sets.
  A fixture script dumps the accounts once and commits them with the slot they were read at, since an RPC cannot serve an account's past state; it fetches klend's program bytes into a gitignored folder at each setup and checks them against a hash pinned in the repo, as the router's fixture does, so a Kamino upgrade fails the check and is re-pinned deliberately; klend's bytes are never committed.
- The fixtures, from [Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79) (2026-11-12): `programs/lending-amm/scripts/kamino_accounts.py dump` reads each reserve a cluster build lends to, its lending market (and its authority, when it holds an account), mints and token accounts in one `getMultipleAccounts` call, so all are as they were at one slot, into `programs/lending-amm/tests/fixtures/kamino/<cluster>/` with the slot and its time; its `check` dumps afresh and compares the layout (owners, sizes, discriminators, the addresses the reserve check compares, token accounts' mints and owners).
  `programs/lending-amm/scripts/fetch-klend.sh` fetches klend from mainnet and devnet into `fixtures/klend/`, refused unless each matches its hash in `fixtures/pins.env`, and its header says how to re-pin after a Kamino upgrade.
  The tests of each cluster build load that cluster's dump with the clock one slot past it, and klend's bytes wherever klend runs.
- Build and test with the toolchain in `docs/toolchain.md` (`source scripts/toolchain-env.sh`).

### Build tickets

Cut by [Cut the lending pool's build tickets](https://github.com/imDev2023/testing-pipeline/issues/25) on 2026-11-10, labelled `build`, one session each, in run order:

1. [Lending AMM: our Kamino lending market on devnet](https://github.com/imDev2023/testing-pipeline/issues/77): the devnet script that creates our Kamino lending market, its two reserves and the test USDC mint, and proves the cToken path, a test borrower and emergency mode there; it needs no program of ours and can run first.
2. [Lending AMM: markets that trade from their own vaults](https://github.com/imDev2023/testing-pipeline/issues/78): the program from the template, the market state's final layout, creation, the mint rules, adding liquidity and exact-in swaps, with nothing lent yet.
3. [Lending AMM: klend fixtures, and valuing the lent side from Kamino's reserve](https://github.com/imDev2023/testing-pipeline/issues/79): the fixture script for both clusters, the reserve checks, and quotes, swaps and deposits priced from the buffer plus cTokens at the stored rate.
4. [Lending AMM: lend the surplus with `rebalance`](https://github.com/imDev2023/testing-pipeline/issues/80): the band, the target, the dust floor, and Kamino's deposit and redeem by CPI.
5. [Lending AMM: redeem a swap's shortfall from Kamino inside the swap](https://github.com/imDev2023/testing-pipeline/issues/81): the in-swap redeem, the redeem accounts resolved only when needed, and the call-depth test with a smart-wallet stand-in and a hooked token.
6. [Lending AMM: remove liquidity in cash or in kind, and lock LP shares](https://github.com/imDev2023/testing-pipeline/issues/82): `remove_liquidity` both ways, `lock_lp` and SPL burns of LP shares.
7. [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83): withdraw mode as amended, every row of "When Kamino can't pay", and a falling rate from Kamino's real `socialize_loss`.
8. [Lending AMM: seeding by a launchpad](https://github.com/imDev2023/testing-pipeline/issues/84): `pipeline_seed_liquidity` with a stand-in launchpad.
9. [Lending AMM: the fuzzer against a moving Kamino, and the proofs completed](https://github.com/imDev2023/testing-pipeline/issues/85): the invariants checked while Kamino's rate and state move, the Kani and Z3 proofs completed, and the compute table measured.
10. [Lending AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/86): the hardening ticket, before the first deploy, so the registered bytes are hardened and the layout freezes once.
11. [Lending AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/87): the end of the program's chain, with every check under "On devnet" below run on devnet itself.
12. [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88): after the deploy and Aviary's own build tickets.

The second waits for [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58), which sets up the on-chain workspace, CI, the fixtures, the keys, the local demo run and the review skills, and for [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59), whose mint rules it shares.
Tickets 2 to 10 are verified end to end in LiteSVM through the real router copied from devnet and klend's deployed bytes, with the `mainnet` build on cloned mainnet reserves and the `devnet` build on accounts dumped from our devnet lending market; tickets 1 and 11 run on devnet itself, against the real Kamino Lend there.
Tickets 2 to 8 and the hardening ticket also pass a local demo run: the demo script, on Pipeline's TypeScript SDK, against a local validator running devnet's router and devnet's klend, with the accounts of our Kamino lending market cloned from devnet.
Ticket 11 points that same script at devnet.
The hardening ticket comes before the deploy, not last as `README.md` words it, so that what is registered with Pipeline is the hardened program.
The keeper runner is specified separately ([Keeper runner](https://github.com/imDev2023/testing-pipeline/issues/45)); until it runs, the demo script and Aviary's form call `rebalance`.

### Done means

- LiteSVM tests through the real router and the real klend program cover:
  - pricing both ways at LP fees of 0, 30 and 200 bps, and quotes matching swaps on both sides of the buffer's edge;
  - an in-swap redeem: the shortfall, its rounding (the market receives at least the shortfall), and the excess staying in the buffer;
  - an in-swap redeem at one extra outer level (a smart-wallet stand-in program calling the router), with a hooked token (Pipeline's `test-hook`) on the other side;
  - a swap needing a redeem but built without the redeem accounts, failing cleanly;
  - Kamino states made by editing cloned account data: too little free liquidity, the withdrawal cap used up, reserve and market emergency mode, `block_ctoken_usage`, a deprecated reserve, and a reserve failing each part of the layout check, with quotes, swaps, `rebalance`, adding and removing behaving as in the table above;
  - a falling rate from Kamino's real `socialize_loss`, run on an edited obligation that has debt and no collateral, lowering LP share value pro rata;
  - `rebalance`: inside the band, above it, below it, the dust floor, entering and leaving withdraw mode, a market that has redeemed everything staying in withdraw mode until Kamino's free liquidity is back above the exit threshold, no first deposit into a reserve below the entry threshold, and deposits skipped under `block_ctoken_usage`;
  - LP shares: the first deposit and its locked minimum, an inflation attempt by donating to the vaults or the cToken account, adding at the ratio, removing in cash and in kind, locking, and an SPL burn;
  - seeding at the seeder-scoped address, shares to the LP recipient, and the vault authority as recipient locking them;
  - refusal of exact-out, of bypass, of every refused mint extension, and of a lent mint not on the list;
  - donations never credited.
- `pipeline-check` passes every check on a funded market (with `exact_out_refund` skipped), both in the tests and against devnet.
- On devnet:
  - our Kamino lending market created by script;
  - the program deployed and registered with the router's `register_strategy`, with its metadata and conformance report published;
  - one market created, funded, rebalanced into Kamino, and traded both ways through the router, including a sell beyond the buffer that redeems in the swap;
  - a test borrower raising utilisation until the market enters withdraw mode;
  - emergency mode turned on for our reserve, with swaps from the buffer only and an in-kind removal, then turned off again.
- Whatever else `docs/spec/README.md` requires of our on-chain programs.
