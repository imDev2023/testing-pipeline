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

### Accounts

- Every swap needs the output vault, the vault authority, which signs the payout, and the reserve, read-only, for valuation; `pipeline_resolve_accounts` lists them in that order, and resolves in one round.
- `pipeline_resolve_accounts` receives the trade, so it lists the Kamino redeem accounts (klend, lending market, lending market authority, reserve liquidity supply, reserve collateral mint, both token programs, the instructions sysvar) and marks the reserve writable only when the trade's quote needs a redeem.
- Ordinary swaps then pass the reserve read-only, for valuation, and never write-lock Kamino's reserve, which every Kamino user of that mint shares.
- A swap that needs a redeem but was built without those accounts, because the buffer shrank between quote and swap, fails cleanly with its own error, and the integrator resolves again.
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
- A move below the lent mint's `MIN_REBALANCE`, and a redeem Kamino can pay nothing of, fail with `BelowMinRebalance` and change nothing, as inside the band they fail with `WithinBand`, so a keeper's simulation shows either and nobody pays for a no-op.
- A redeem burns as many cTokens as are worth at most the shortfall at the stored rate, `floor(s x S_ctoken / S_total)`, or every cToken the market holds once the shortfall reaches their whole value, so at the stored rate the buffer never passes its target and lands less than one cToken's worth short of it.
- klend rounds both calls its own way: a deposit mints `floor(d x S_ctoken / S_total)` cTokens and takes back what they are worth rounded up, and a redeem pays at the rate it refreshes to; so a `rebalance` may lower the lent side's total by one unit, and no more, which is the only way it can move the price or an LP share's value.
- `rebalance` checks every account it passes to klend before calling it (see "Custom actions and metadata"), and a call klend refuses fails whole until [Lending AMM: withdraw mode and Kamino's other states](https://github.com/imDev2023/testing-pipeline/issues/83).

### Withdraw mode

- `rebalance` checks Kamino's freely available liquidity against `X = max(V, T)`: the larger of the market's lent value `V` and its target lent value `T = L x (10,000 - BUFFER_TARGET_BPS) / 10,000`, what it would lend with the buffer at its target.
- Below `WITHDRAW_MODE_ENTER` times `X`, the market enters withdraw mode: `rebalance` redeems everything Kamino can pay and deposits nothing.
- Above `WITHDRAW_MODE_EXIT` times `X`, it leaves withdraw mode and the band applies again.
- Measured against `V` alone the rule would flap: once the market has redeemed everything `V` is 0, so the next `rebalance` would leave withdraw mode at once, lend back into the same crunch and re-enter (owner, 2026-11-10).
  With the target term a market that has redeemed everything stays in withdraw mode until Kamino has 10 times its target lent value free, and a market never makes its first deposit into a reserve too thin to pay it back.
- On 2026-11-09 Kamino's SOL reserve had about 218,000 SOL free at 90.9% utilisation, and it blocks new borrowing above 90%, so withdraw mode only bites in a real crunch, and then our LPs leave early rather than last.

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

### Locking

`lock_lp { amount: u64 }`, signed by an LP, moves LP shares into the market's lock account and emits an event, so indexers can show how much of a market's liquidity is locked.
Locked shares still count in `N` and still earn the LP fee and the yield, which stay in the market as depth for traders; this is MetalLegBob's protocol-owned liquidity.

### Seeding

- `pipeline_seed_liquidity` takes `SeedRequest.data` as the Borsh encoding of `{ lent_index: u8, lp_fee_bps: u16 }`, under the same rules as creation.
- It creates the market at the seeder-scoped address, takes at most `amounts[i]` from each escrow, opens the market at the price those amounts imply, mints the first deposit's shares to the associated token account of the LP recipient (seed account 4) for the LP mint, and returns `SeedResult { taken, lp_amount }`.
- A launchpad that wants the liquidity locked names the market's vault authority as the LP recipient, which puts the shares straight into the lock account.
- The caller then records the market with the router's `register_existing_market` and `init_fee_account` for each mint, in the same transaction.

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

| Instruction | Ceiling (compute units) | Main cost |
| --- | --- | --- |
| `pipeline_quote` | 40,000 | Reserve checks and fixed-point maths; well under the quoter's 200,000 cap |
| `pipeline_swap`, no redeem | 40,000 | One output transfer, the reserve read; the router's own 30k to 35k is outside it |
| `pipeline_swap`, with a redeem | 80,000 | Kamino's redeem (mainnet median 29,670) |
| `pipeline_resolve_accounts` | 40,000 | Runs the quote to decide on the redeem accounts |
| `pipeline_init_market` | 150,000 | Creating two vaults, the cToken account and the LP mint |
| `pipeline_seed_liquidity` | 200,000 | Creation plus the first deposit |
| `add_liquidity` | 60,000 | Two transfers in, an LP mint |
| `remove_liquidity`, cash | 120,000 | Kamino's redeem, transfers out, an LP burn |
| `remove_liquidity`, in kind | 90,000 | Transfers out, possibly creating the LP's cToken account |
| `rebalance` | 100,000 | Kamino's deposit (mainnet median 43,704) or redeem |
| `lock_lp` | 20,000 | One transfer |

### Invariants for test layer 3

Beyond the shared three (value conserved, every holder can exit, each quote equals its swap), checked after every step of the generated sequences, with Kamino's rate moved up between steps and occasionally down by a write-off:

- What the market has recorded never exceeds what it actually holds: the buffer and the other side against their vaults, the cTokens against the cToken account.
- At a fixed Kamino rate, no swap lowers the product `R x L`, and no instruction lowers the value of an LP share; only a fall in Kamino's rate does, and a `rebalance` by Kamino's rounding, at most one unit of the lent side (see "The rule").
- A removal in kind succeeds for every LP in every Kamino state, emergency modes, a deprecated reserve and a failed layout check included.
- A swap never deposits into Kamino, never redeems when the buffer covers its output, and never redeems more than its shortfall plus one rounding unit's worth of cTokens.
- Outside withdraw mode `rebalance` only ever moves the buffer's share towards `BUFFER_TARGET_BPS`; in withdraw mode it only redeems; and it never deposits while cToken deposits are blocked.
- A market in withdraw mode stays in it across `rebalance` calls for as long as Kamino's freely available liquidity is at or below `WITHDRAW_MODE_EXIT` times `max(V, T)`, however much it has already redeemed.
- The share count `N` changes only by `add_liquidity`, `remove_liquidity`, seeding and SPL burns, and the lock account's balance never falls.

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
