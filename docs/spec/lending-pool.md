# Lending pool

Decided in [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21) on 2026-11-10 with the owner, against Pipeline commit `5ad130d` (its strategy guide, template and seeding interface) and Kamino Lend (klend) release 1.28.0 (`686913e`).
It builds on [Which lending market the lending pool lends to](https://github.com/imDev2023/testing-pipeline/issues/12) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/lending-market/research/lending-market.md)) and on a check of Kamino's flags, caps, exchange rate and devnet setup made for this ticket ([Kamino facts](https://github.com/imDev2023/testing-pipeline/blob/research/lending-market/research/lending-market-kamino-facts.md)).
MetalLegBob asked for a pool that lends out the idle part of its liquidity, through Kamino or a similar market, and he is not building it himself ([Record MetalLegBob's answers to the follow-up DM](https://github.com/imDev2023/testing-pipeline/issues/27)), so it stays in scope.
The shared engineering and security bar for our programs lands in `docs/spec/README.md`, from [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4); this file adds only what is particular to the lending pool.
Terms are as in `GLOSSARY.md`: lending pool, buffer, lent side, lending market, cToken, withdraw mode, keeper job.

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
| `WITHDRAW_MODE_ENTER` | 5 | Enter withdraw mode when Kamino's freely available liquidity is below 5 times the market's lent value |
| `WITHDRAW_MODE_EXIT` | 10 | Leave withdraw mode when it is back above 10 times |
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
| devnet | WSOL | Our own Kamino lending market (see "Devnet") | Our WSOL reserve |
| devnet | Our test USDC mint, 6 decimals | Our own Kamino lending market | Our test USDC reserve |

- Market creators never choose a reserve: a reserve in a lending market the creator owned could be reconfigured to let its owner borrow the LPs' deposits away.
- The devnet addresses are filled in by the build ticket that creates our devnet lending market.
- The constants are compiled into the program; changing one is a program upgrade, which ends when the program is frozen.

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
- So hooked tokens may trade in a lending pool market.
  The hooked transfer and the Kamino redeem are sibling calls under the strategy and never stack: the deepest chain is the redeem, router (1), strategy (2), klend (3), SPL Token (4), or 5 when the trader uses a smart wallet, inside the limit of 5.
  A transfer hook that makes calls of its own fails for smart-wallet traders, as it does in any Pipeline market.
- A contained token can only trade in its home market until its unlock, and Kamino refuses hooked mints, so a contained token is never lent.

### Addresses

- The market state is the PDA `["market", other_mint, lent_mint, lp_fee_bps as u16 little-endian]` of the lending pool program, so there is one market per pair, lent side and fee.
  Every creation parameter is in the seeds, so nobody can occupy a market's address with other parameters.
  Someone may create a market first at a bad price with dust liquidity; correcting that price by a swap costs little, and the locked minimum stops share inflation.
- Markets created through `pipeline_seed_liquidity` live at `["seeded", seeder, other_mint, lent_mint, lp_fee_bps]` instead, as Pipeline's guide asks, so nobody can create or price them first.
- The vault authority is the PDA `["authority", market_state]`, a data-less address that signs every transfer out of the vaults, owns the cToken account, signs Kamino calls as the depositor and is the LP mint's mint authority.
- Each vault is a token account at `["vault", market_state, mint]`, owned by the vault authority; the lent mint's vault holds the buffer.
- The cToken account is a token account at `["ctoken", market_state]` for the reserve's collateral mint, owned by the vault authority; each market holds its own cTokens.
- The LP mint is an SPL Token mint at `["lp_mint", market_state]`, with `LP_DECIMALS` decimals, the vault authority as mint authority and no freeze authority.
- The lock account is the vault authority's associated token account for the LP mint; no instruction ever moves LP shares out of it.
- Metadata describes all of them as `pda:` sources, so the SDK can resolve them before the market exists.

### Creation parameters

`init_data` is the Borsh encoding of:

| Field | Type | Rule |
| --- | --- | --- |
| `lent_index` | u8 | 0 or 1: which of the two mints is lent; it must be on the cluster's `LENT_MINTS` list |
| `lp_fee_bps` | u16 | At most `MAX_LP_FEE_BPS`; Pipescope's form defaults it to 30 (0.30%) |

- `pipeline_init_market` refuses anything that breaks a rule, checks that the market state's address is the PDA above, checks that the market signer is the router's PDA `["market", program, market_state]` and stores it, creates the vaults, the cToken account and the LP mint idempotently, and records the reserve, the creation slot and the Unix time.
- Rent comes from the router's payer, funded by the creator's `max_creator_lamports`.

### Creating a market

One transaction, as Pipeline's guide recommends:

1. The router's `create_market` with the creation parameters.
2. The router's `init_fee_account` for each of the two mints.
3. The lending pool's `add_liquidity`, which makes the first deposit.

Until the first deposit, quotes and swaps are refused, because an empty side cannot be priced.

## Valuing the lent side

### Total reserves

- The other side's reserve `R` is what the market has recorded in its vault.
- The lent side's reserve is `L = B + V`, where `B` is the buffer the market has recorded in its lent-mint vault and `V` is the value of the cTokens it has recorded, `V = floor(c x S_total / S_ctoken)`.
- `S_total` is the reserve's total supply, `total_available_amount + borrowed_amount_sf - accumulated_protocol_fees_sf - accumulated_referrer_fees_sf - pending_referrer_fees_sf` (fixed point with 60 fractional bits where the field ends in `_sf`), and `S_ctoken` is the reserve's own `collateral.mint_total_supply`, never the SPL mint's supply, which differs by the 100,000-unit seed on new reserves and by 13.8M on mainnet USDC.
- Field offsets are in the [Kamino facts](https://github.com/imDev2023/testing-pipeline/blob/research/lending-market/research/lending-market-kamino-facts.md), section 4, at klend 1.28.0.
- Tokens or cTokens sent to the market outside its own instructions are donations: never credited, never priced and never paid out.

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
- `pipeline_quote` and `pipeline_swap` call the same pricing function on the same reserve fields, so a quote shows whether a trade redeems and refuses a trade Kamino could not pay, and `pipeline-check`'s `quote_matches_swap` verifies quotes on both sides of the buffer's edge.

### Accounts

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

### Withdraw mode

- `rebalance` checks Kamino's freely available liquidity against the market's lent value `V`.
- Below `WITHDRAW_MODE_ENTER` times `V`, the market enters withdraw mode: `rebalance` redeems everything Kamino can pay and deposits nothing.
- Above `WITHDRAW_MODE_EXIT` times `V`, it leaves withdraw mode and the band applies again.
- On 2026-11-09 Kamino's SOL reserve had about 218,000 SOL free at 90.9% utilisation, and it blocks new borrowing above 90%, so withdraw mode only bites in a real crunch, and then our LPs leave early rather than last.

### When it runs

- `rebalance {}` is a permissionless custom action: anyone may call it at any time, and inside the band it does nothing, so it cannot be used to grief a market.
- It creates no accounts, so the caller pays only the transaction fee, and gets no tip.
- Our keeper runner calls it when Pipescope's indexer sees a swap or an LP action leave a market outside its band, and sweeps every lending pool market every 10 minutes for withdraw mode and anything missed.
- That is the lending pool's whole answer for the map's keeper runner: one keeper job per market, triggered by events, a few calls an hour at most.
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

`add_liquidity { max_other: u64, max_lent: u64, min_lp: u64 }`, signed by the LP:

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
Pipescope offers in kind whenever a cash removal would fail.
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
- Us: nothing from the strategy; Pipescope earns its integrator fee on the trades it routes.
- A market's creator: nothing beyond their own LP shares.

## Custom actions and metadata

| Action | Metadata `kind` | Signer |
| --- | --- | --- |
| `add_liquidity` | `add_liquidity` | The LP |
| `remove_liquidity` | `remove_liquidity` | The LP |
| `lock_lp` | `other` | The LP |
| `rebalance` | `other` | Anyone |

- Every action that moves the other mint forwards transfer-hook accounts after its own, as the template's swap does.
- Each instruction emits an event (market created, liquidity added, liquidity removed with the in-kind amount, shares locked, rebalanced with the amount and direction, withdraw mode entered or left, a swap's redeem with its amount) so Pipescope's indexer can show a market's history; Pipescope reads current values from the market state and the reserve, not from events.
- The metadata follows `pipeline-strategy-metadata/1` at `5ad130d`: name, description, category `amm`, tags including `lending` and `kamino`, links including `source` and the IDL, `init` as above with `market_state` as a `pda:` source, every action above, `security.contact`, and `conformance` pointing at a published `pipeline-check` report and its SHA-256.

## Pipescope's panel

Pipescope's lending pool panel shows, per market:

- the lent side, its Kamino reserve and lending market, with links;
- the buffer, the lent value and the buffer's share against its band, and whether the market is in withdraw mode;
- the largest sell the buffer pays alone, and the largest Kamino can pay right now on top;
- Kamino's utilisation, freely available liquidity, supply rate, emergency modes and `block_ctoken_usage` for the reserve;
- the LP fee, LP share value, locked shares, and the market's lending yield so far;
- the actions above as forms, with in kind offered whenever a cash removal would fail.

The explainer's fact table carries the same facts, and its risks for every lending pool market are: Kamino's owner and emergency council can stop redeems, as they did on the ETH reserve for 16 hours; LPs bear Kamino's written-off losses, and bad debt not yet written off is not shown in the rate; swaps larger than the buffer plus Kamino's free liquidity fail.

## Upgrades and freezing

- On devnet the program stays upgradeable, with its upgrade authority in `~/.config/testing-pipeline/devnet/`.
- It is frozen (upgrade authority removed) before any mainnet deployment, like the tax AMM, rather than kept upgradeable to follow changes in Kamino, which would be an admin key every LP has to trust.
- A Kamino change that breaks the layout check stops trading in our markets but never traps LPs, who leave in kind; a new strategy version then serves new markets, and LPs move by removing and adding.
- The general upgrade policy is in `docs/spec/README.md`.

## Devnet

- Our own Kamino lending market, owned by a key in `~/.config/testing-pipeline/devnet/`, with a WSOL reserve and a reserve for our own test USDC mint (6 decimals, mint authority in the same folder), since Circle's devnet USDC cannot be minted freely.
- Setting it up, from the [Kamino facts](https://github.com/imDev2023/testing-pipeline/blob/research/lending-market/research/lending-market-kamino-facts.md), section 1, as the first devnet script:
  1. `init_lending_market` with our key as owner.
  2. `init_reserve` for each mint, which takes a 100,000 base-unit seed deposit.
  3. While each reserve holds only the seed, `update_reserve_config` with validation skipped for the Pyth price account, the borrow rate curve and a borrow factor of 100.
  4. `update_reserve_config` for the deposit limit, with full validation, which opens deposits.
- Both reserves name the live devnet Pyth feeds (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` for SOL, `Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX` for USDC), even though the cToken path never reads them, so a test borrower can open an obligation and create utilisation.
- The sequence has been seen working on devnet (reserve `24EfeXj3XyLLE6GThh8ik4vcxEPMooAU5XXDL5nJHEr8`, 2026-09-14) but not yet run by us.

## Building it

- Generate the program from Pipeline's Apache-2.0 strategy template with `scripts/new-strategy.sh`, from a scratchpad clone at `5ad130d`, and pin the Pipeline crates to `rev = "5ad130d"`, as for the tax AMM.
- Keep the program keypair in `~/.config/testing-pipeline/devnet/`, never in the repo.
- Put every Kamino call and read in one module (deposit, redeem, reserve checks, total supply, what Kamino can pay now, flags), so a later strategy version can add another lending market without touching the pool's maths.
- Write the Kamino instruction data, account lists and reserve offsets by hand from klend 1.28.0, and never depend on the klend crate: klend is BSL 1.1 with no use grant until 2027-11-17, so we call its deployed program but never compile its code into ours.
- Tests load klend's deployed program bytes, dumped from mainnet at test setup into an ignored folder, never committed, together with cloned mainnet reserve, lending market and mint accounts.
- Build and test with the toolchain in `docs/toolchain.md` (`source scripts/toolchain-env.sh`).

### Done means

- LiteSVM tests through the real router and the real klend program cover:
  - pricing both ways at LP fees of 0, 30 and 200 bps, and quotes matching swaps on both sides of the buffer's edge;
  - an in-swap redeem: the shortfall, its rounding (the market receives at least the shortfall), and the excess staying in the buffer;
  - an in-swap redeem at one extra outer level (a smart-wallet stand-in program calling the router), with a hooked token (Pipeline's `test-hook`) on the other side;
  - a swap needing a redeem but built without the redeem accounts, failing cleanly;
  - Kamino states made by editing cloned account data: too little free liquidity, the withdrawal cap used up, reserve and market emergency mode, `block_ctoken_usage`, a deprecated reserve, and a reserve failing each part of the layout check, with quotes, swaps, `rebalance`, adding and removing behaving as in the table above;
  - a falling rate from Kamino's real `socialize_loss`, run on an edited obligation that has debt and no collateral, lowering LP share value pro rata;
  - `rebalance`: inside the band, above it, below it, the dust floor, entering and leaving withdraw mode, and deposits skipped under `block_ctoken_usage`;
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
