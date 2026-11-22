# Aviary: Canary checks

Decided in [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14) on 2026-11-10, from a rough harness run on every devnet market and the owner's reaction to its results.
The harness, its output for all 61 markets and a summary table are on the throwaway branch [`prototype/canary-checks`](https://github.com/imDev2023/testing-pipeline/tree/prototype/canary-checks/prototype/canary-checks); that branch is never merged.
It builds on [Prior art for behavioural testing of Solana programs](https://github.com/imDev2023/testing-pipeline/issues/8) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/behavioural-testing-prior-art/research/behavioural-testing-prior-art.md)) and [Where the quoter runs for Canary checks](https://github.com/imDev2023/testing-pipeline/issues/7) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/quoter-hosting/research/quoter-hosting.md)).
[Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22) reconciled this file with the other Aviary spec files on 2026-11-12 and cut its build tickets, listed in [`pipescope-architecture.md`](pipescope-architecture.md#build-tickets).

## What Canary is

- Canary checks trade a private copy of one market the way a trader would, and record what happened.
- They detect; they cannot prove a market safe, and no result is a promise about a later trade or a later strategy version.
- Canary covers every strategy and every market registered with the router, not a chosen list: on 2026-11-10 devnet had 8 strategies and 61 markets, four more strategies than when the ticket was written.
- A Canary result belongs to one market, one strategy version and one slot, and says so.

### Three layers, and what each one sees

Pipeline published its own trust flags and its own checker, `pipeline-check`, on 2026-11-09.
Canary builds on both and does not repeat them.

| Layer | Whose | What it reads | What it cannot see |
| --- | --- | --- | --- |
| Trust flags (`pipeline-client`, the hosted API) | Pipeline's | The shape of accounts: upgradeable or frozen, mint and freeze authorities, Token-2022 extensions, metadata status | Anything a trade does |
| `pipeline-check` | Pipeline's | Whether quoting and trading one market through the router conforms to the strategy interface, at one moment, for the strategy's author | What a trade costs, what happens later or earlier, at other sizes, to other wallets, or when an authority acts |
| Canary | Ours | What a trader meets: whether they can get out, what the round trip returns, and how that changes with size, time, wallet and the use of an authority's powers | Rules reached only by inputs it did not try, and code that can tell a simulation from a real trade |

- Canary runs `pipeline-check` unchanged on every market copy and keeps its report as the **conformance report**, one Canary result among the others.
  This answers the question the explainer spec left open.
- Canary reuses Pipeline's trust flags for token facts and adds nothing to them except what its own runs measure.

### What the prototype found that the other two layers did not

All figures are from the run of 2026-11-10 on devnet, slots 520,628,944 to 520,629,552, with Pipeline at `5ad130d` and the router whose executable hash is `fb0003280ef9d0bbeca3919c4491e4728620eddd1d7ebd96340727b15ca621b8`.

| Finding | Trust flags | `pipeline-check` | Canary |
| --- | --- | --- | --- |
| The strategy `EZwLuZ...` (metadata file `sniper-tax.devnet.json`) keeps almost all of a buy made at a market's launch | Nothing | Pass, 14 of 14, on both markets | With the clock set back to the market's creation, a 0.01 SOL round trip returns 0.995%, then 11.9% after 10 seconds, 66.7% after 1 minute and 99.5% from 10 minutes on |
| The outside builder's AMM `9mAV3p...` returns about half | Nothing | Its `round_trip` check passes, because it warns only about a profit | 48.8% to 49.4% back from 0.01 SOL on all 4 markets, and 48.7% to 52.6% across every size |
| A bonding-curve buy that completes the curve cannot be sold back there | Nothing | Warn on the 3 open curves | The same, with the boundary: buys of 0.1 SOL and below return 97.5% to 98.6%, buys of 1 SOL and above are refused on the way out (`WrongStatus`) |
| Markets their own strategy's current version cannot read | Nothing | Fail, market by market, as a failed account resolution | Named for what it is and counted per strategy version: 16 of 61 markets (6 of 8 on the Pool4 port, 6 of 7 on `2Tmcmq...`, 2 of 3 on `4scUVy...`, 2 of 23 on the constant product) |
| What a token authority can do to a holder | `mint-authority` and `transfer-fee-authority` say one exists | Nothing | Acting as the authority: minting and selling takes 99.0% of the SOL in a constant-product market's vault; with the transfer fee set to 100%, a 0.01 SOL buy takes the SOL and delivers nothing |
| Instructions beyond Pipeline's own | Nothing | Nothing | 34 across the 8 strategies, each confirmed by its discriminator in the code |

What came back clean is evidence too:

- All 2,658 swaps that had a quote matched it to the unit, at every size and every clock position.
- No strategy treated the market creator, the upgrade authority or a mint authority differently from a fresh wallet.
- Transferred tokens sold everywhere; five buyers leaving in turn all got out everywhere.
- No result changed with a wait of up to 30 days.
- Every direct `pipeline_swap` call was refused.

## How a run works

- A Canary run covers one strategy version, on all of its markets or on one of them, and treats each market on its own.
- For each market it builds a copy of the market and everything its trades touch in a local Solana VM, with the cluster's slot, epoch and time, using `pipeline-check`'s own cloner.
- The cloner reads accounts from a source the caller supplies.
  On a developer's machine that is read-only RPC, as in the prototype.
  In the container [`pipescope-architecture.md`](pipescope-architecture.md) specifies, which has no network, it is the snapshot the `CanaryRun` Durable Object posts in.
- A strategy can name more accounts when a later trade resolves its accounts than it did for the first snapshot.
  When a trade names an account the snapshot lacks, the binary answers with the missing addresses instead of results, and the Durable Object fetches them and posts the snapshot again, at most four times; after that the affected checks are "not run", naming the accounts.
  On devnet the prototype needed about 7 RPC requests a market, no more than the first copy takes, so no strategy there asked for more.
- The router and the strategy are the cluster's own program bytes, so the run tests what is deployed.
- Signature checks are off in the VM, so the run can act as any key: a fresh wallet, the market creator, an upgrade authority or a token authority.
- Every trade goes through the router's real `swap`, is committed in the VM, and can be followed by another trade in the state it left.
- Before every swap the run resolves the strategy's accounts in the current state and takes a quote with `pipeline-quoter` holding only what an integrator would hold; the swap is then compared with that quote.
- Each scenario starts from a fresh copy of the snapshot unless it says otherwise, so one scenario never changes another's starting state.
- Wallets are new random keys on every run.
- Transfer-hook accounts are resolved as `pipeline-check` resolves them; the prototype skipped this because no devnet mint has a hook.

### The money side and sizes

- Sizes are always set on the **money side** of a market, and a sale only ever sells what a buy in the same run produced.
  The prototype first sized sales by a share of the token vault and sold more tokens than could exist, which produced false alarms of 2% to 20% returns on two curves; this rule removes them.
- The money side is wrapped SOL when the market has it; otherwise it is the mint whose vault holds the smallest share of that mint's supply.
- With wrapped SOL the sizes are 0.00001, 0.001, 0.01, 0.1, 1 and 10 SOL, and the **reference size** is 0.01 SOL.
- Without wrapped SOL the sizes are 1, 100, 1,000, 10,000 and 50,000 parts per million of the money vault, and the reference size is 1,000 parts per million; when that vault holds under 2,000,000 units they are 0.01, 0.1, 1, 10 and 100 whole tokens and the reference size is 1 token.
- When the reference size cannot be bought and sold back, the largest size that can stands in for it and the result says so.
- Every size is reported beside its share of the money vault, because 10 SOL into a devnet pool holding 0.2 SOL buys the whole pool.
- Mainnet sizes, including a size equal to Jupiter's 500 dollar routing benchmark, are for the mainnet plan.

### Clock positions

- **Waits**: the same slot, the next slot, 10 seconds, 1 minute, 10 minutes, 1 hour, 1 day, 3 days and 30 days, moving slot, epoch and Unix time together (2.5 slots a second, 432,000 slots an epoch).
- **Launch clock**: the market's creation time and 10 seconds, 1 minute, 10 minutes, 1 hour and 1 day after it, for every offset that is already in the past.
  The state is today's; only the clock is set back, so the figures show the strategy's time rules, not what early buyers actually got.

## Outcomes

- A Canary result has one of five outcomes: **pass**, **warn**, **fail**, **not run** or **noted**.
- The number behind an outcome is always shown beside it, and a code-written sentence gives the reason.
- **Fail** is kept for what the **ordinary trade** meets right now: a buy of the reference size or the smallest size at the cluster's current clock, sold back in the same slot or the next (owner, 2026-11-10).
- Anything that depends on another time, a larger size or an authority choosing to act is at most a **warn**, with its numbers.
  A market still inside a launch-time tax fails on its own, because its ordinary trade returns too little right now.
- **Not run** always carries its reason, such as "the market refuses every trade (`WrongStatus`: Not allowed in the curve's current status)".
- **Noted** is for facts Canary reads and does not judge.
- The round-trip return bands are the owner's (2026-11-10): **95% or more back is a pass, 50% up to 95% is a warn, under 50% is a fail**.
  The rows below call these the **pass band** and the **fail band**; their values live only in Canary's config module ([One place for every value](#one-place-for-every-value)), with the 1-point tolerance and the other policy values.
  On devnet today the ordinary trade returns 97.0% to 99.5% on seven strategies and 48.8% to 49.4% on the outside builder's AMM, so the bands sit in a wide gap.
- These words follow `pipeline-check`'s (pass, warn, fail, skip) so one page can show both.
- An outcome belongs to one check on one market.
  Canary never adds outcomes up into a score, a badge or a colour, which [`pipescope.md`](pipescope.md) rules out; how a result is shown is for [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16).
- The engineering bar in [`README.md`](README.md) asks our own strategies to pass Canary checks on devnet.
  That means no fail on any market of the version, with every warn named and explained in that product's spec; it is a gate for us, never something shown to traders.
- One consequence of the rule: a strategy that lets a buyer sell at once and refuses them a day later gets a warn, not a fail.
  The result's sentence says plainly that the tokens could not be sold after that wait.

### How a failure is named

Every failed step is classed from the transaction's error and logs, with the program that raised it and, for Anchor programs, the error's name, number, message and source line:

- **cannot read state**: the strategy cannot deserialise the market's state (`AccountDidNotDeserialize`, `AccountDiscriminatorMismatch`).
- **strategy refused**, **router refused**, **token program refused**: a clean error from that program.
- **crash**: the program panicked instead of returning an error.
- **out of compute**: the step ran out of its compute limit (200,000 units for a quote, 1,400,000 for a swap).

A crash or an out-of-compute anywhere in a run is at least a warn on the check it happened in.

## The checks

Check ids are stable.
Each row gives the outcome rule; "ordinary trade" is as defined above.

### Readability and conformance

| Id | What it does | Fail | Warn | Pass |
| --- | --- | --- | --- | --- |
| `readable` | Calls `pipeline_market_info`, resolves accounts and quotes the smallest size in every direction | The strategy's current version cannot read the market's state: a **stranded market** | A direction resolves and then crashes or runs out of compute | The version reads the market; a market that reads but refuses every trade passes here and its trading checks are "not run" with the strategy's own error |
| `conformance` | Runs `pipeline-check` on the copy and keeps its whole report | `pipeline-check` reports fail | It reports warn | It reports pass |

### Exit test

| Id | What it does | Fail | Warn | Pass |
| --- | --- | --- | --- | --- |
| `exit_sizes` | Buys each size and sells everything bought in the same slot | At the reference size or the smallest size, the tokens cannot be sold back | At a larger size, the tokens cannot be sold back | Every size that could be bought was sold back; sizes that could not be bought are listed and are not a finding |
| `exit_hold` | Buys the reference size, then sells after each wait, each wait from the same bought state | The sale fails in the same slot or the next | After a longer wait the sale fails, or returns more than the tolerance less than in the same slot | Every wait sells within the tolerance of the same slot |
| `exit_late` | Moves the clock forward by each wait, then buys and sells the reference size | Never: it is not the present | A later round trip fails, or returns more than the tolerance less than now | Every later round trip is within the tolerance of now |
| `exit_launch_clock` | Sets the clock to each launch-clock position, then buys and sells the reference size | Never: it is not the present | A launch-clock round trip fails, or returns more than the tolerance less than now | Every one is within the tolerance of now |
| `exit_wallets` | Round-trips the reference size from five fresh wallets, the market creator, the strategy's upgrade authority and each mint authority, each from the same starting state | Fresh wallets get different results from the same state, or an insider gets more back than a fresh wallet | An insider gets less back than a fresh wallet | All get the same |
| `exit_transferred` | One wallet buys the reference size and sends the tokens to a second wallet, which sells them | The transfer went through and the second wallet cannot sell | The transfer is refused (for any token, ours or anyone's: the result says the token could not be sent to another wallet, and what the buyer got back by selling it), or the second wallet's return is below the pass band while the buyer's own is not, or, when the buyer's own is below it too, more than the tolerance below the buyer's own (`CANARY-37`) | The second wallet's return is in the pass band, or no more than the tolerance below a buyer's own return that is also below it |
| `exit_queue` | Five wallets buy the reference size one after another, then sell in the same order | Any of the five cannot sell, or together they get back within the fail band | Together they get back less than the pass band | All five sell and together get back within the pass band |

- Wallets that are a program's address, not a wallet, are skipped and named: a key off the Ed25519 curve, a program, or an account a program holds (`CANARY-39`).
- In `exit_queue` only the total is judged: in a thin pool the first buyer out gains what the last one loses, which is ordinary price movement.
- Every row but `exit_sizes` trades the reference size, or the size that stands in for it in `exit_sizes`, and judges a later or earlier time against a round trip measured in the same row at the cluster's clock, from the same kind of starting state (`CANARY-40`).

### Quote against swap

| Id | What it does | Fail | Warn | Pass |
| --- | --- | --- | --- | --- |
| `quote_matches_swap` | Compares every swap the run commits with the quote taken in the same state just before it: output received, input sent, Pipeline fee, and the trader's own balance changes | In the ordinary trade, any difference, a quoted swap that fails, or a swap that works when its quote failed | The same at another size or clock position | Every compared swap equals its quote; the count is reported |

- Exact-out quoting stays with `pipeline-check`'s `quotes`, `quote_matches_swap` and `exact_out_refund` checks, carried in the conformance report; Canary trades exact-in only.
- Of the exit checks' own swaps, the ordinary trade is a buy or sale of the reference size by a fresh wallet in the copy's own state, at the cluster's clock or the next slot: `exit_hold`'s buy and its sales in the same and the next slot, `exit_late`'s round trips now and a slot later, `exit_launch_clock`'s round trip now, the fresh wallets' round trips in `exit_wallets`, the buy in `exit_transferred` and the first buy in `exit_queue` (`CANARY-41`).

### Fee honesty

| Id | What it does | Fail | Warn | Pass |
| --- | --- | --- | --- | --- |
| `cost` | Reports the **round-trip return** at every size of `exit_sizes`, and splits the loss at the smallest size and at the reference size into Pipeline's fee on both legs, Token-2022 transfer fees, and the rest, which is the strategy's own fee and spread | The ordinary trade's return is in the fail band | The ordinary trade's return is between the two bands, or any other size returns less than the pass band | Every size's return is in the pass band |

- Pipeline's fee on each leg is what the router charged, in the mint it took it in: since Pipeline 0.3 a sale into the market's fee mint (wrapped SOL, on a market that trades it, `BAR-44`) pays it out of what it brought back, and a fee charged in the token is valued at the sale's own price, before any fee taken from what arrived (`CANARY-34`); at the reference size on devnet the two legs together come to 0.49% to 0.50% of what was put in, and to 0.37% on the outside builder's AMM, where the sale brings back half as much.
- The same bands apply to the returns measured by the other exit checks.

### Control

| Id | What it does | Fail | Warn | Pass |
| --- | --- | --- | --- | --- |
| `direct_call` | Calls the strategy's `pipeline_swap` without the router, once with another key signing as the market signer and once with the real market signer not signing, after sending the input to the vault as the router would | Never | The call is accepted: trades can skip the Pipeline fee and leave no swap event | Both calls are refused |
| `token_authorities` | For each of the market's mints, acts as each authority that exists and then trades again (see below) | Never: it depends on an authority acting | An authority exists and its action took from the market or stopped or emptied a trade; the figure is reported | No mint has such an authority |
| `transaction_accounts` | Lists accounts the strategy asks for that describe the transaction, not the market: the Instructions, SlotHashes and RecentBlockhashes sysvars | Never | The strategy asks for one, so it could tell a simulated trade from a real one and Canary's results may not hold | It asks for none |
| `contained_mint` | For a mint with a transfer hook, reads the hook program, whether it can still be upgraded, and the hook's authority, as [`containment-hook.md`](containment-hook.md) recognises a contained token | Never | The hook is not our containment hook with the mint's unlock PDA as its authority, or the hook program can still be upgraded | The hook is our containment hook, its authority is the mint's unlock PDA and the hook program is frozen; "not run" when no mint has a hook, and when a mint's transfer hook extension has both its program and its authority unset, as a contained token's has after its unlock |
| `custom_instructions` | Lists every instruction in the strategy's code beyond Pipeline's six, each with how often it has been called and by which signers | Noted only | Noted only | Noted only |

What `token_authorities` does with each authority, when the authority is a wallet:

- **Mint authority**: mints 100 times what the market's vault holds of that mint and sells it all; the result is the share of the other vault taken.
- **Freeze authority**: after a buy of the reference size, freezes the buyer's token account, then tries the sale.
- **Transfer-fee authority**: sets the fee to 100% with no maximum, moves the clock two epochs on so the fee applies, then round-trips the reference size.
- **Permanent delegate**: after a buy, moves the buyer's tokens away.
- **Pause authority**: pauses the mint, then tries the sale.
- An authority that is a program's address is "not run" and named with the program that owns it, because only that program's own instructions can use it.
- An authority is a program's address by the same rule as an insider in `exit_wallets` (`CANARY-39`): a key off the Ed25519 curve, a program, or an account a program holds, such as a market's own state or an SPL multisig (`CANARY-43`).
- An authority of the money side's mint acts in the same round trip: freezing the buyer's account of it or pausing it between the buy and the sale, setting its transfer fee before the buy, and, as permanent delegate, taking what the sale returned once the buyer holds it; a mint authority sells what it minted into each other mint, each sale from the same state (`CANARY-44`).

The prototype ran the first and third on devnet and built the second; no devnet mint has a freeze authority, a permanent delegate or a pause authority.

### Custom instructions are listed, not called

- Instruction names come from the strategy's code: each "Instruction: Name" string Anchor compiles in is kept only when the discriminator of that name is also in the code, which also cuts names that run on into the next string.
- That list is worked out once per strategy version, by `terminal-api` when the indexer records the version, and stored with it; the facts panel, the forms' instruction check and the explainer read it from there, and the `CanaryRun` Durable Object posts it in the snapshot, so one implementation serves all four.
- The snapshot carries it in an optional `instructions` field, whether the program is built with Anchor and each instruction's name, call count and signers; Canary drops Pipeline's six by name and notes the rest, and a run given no list records `custom_instructions` as "not run" (`CANARY-46`).
- A program that is not built with Anchor gets "none found", worded as such and not as "none".
- Who has called each instruction, and how often, comes from the indexer's history of the strategy program.
- Canary v1 does not call custom instructions: the prototype can name them and cannot build their arguments without each strategy's own layout (owner, 2026-11-10).
- Canary does use the standard token powers above, which need no strategy-specific knowledge.
- The 34 on devnet: `Deposit` (constant product); `ClaimAllocation`, `ClaimCreatorFees`, `ClaimLeftover`, `FundCurve`, `Graduate`, `SetFeeRecipient` (bonding curve); `RebalanceWall`, `SeedPool`, `SettleRetired`, `SweepFees` (Pool4 port); `Buy`, `Buyback`, `CreateMarket`, `DeepenQuote`, `DeepenToken`, `InitializeFactory`, `PublishManifest`, `Sell`, `SetMetadata`, `SplitFees` (outside builder); `ClaimFees`, `ClosePack`, `OpenDraw`, `OpenPack` (`2Tmcmq...`); `BurnToClose`, `ClaimFees`, `Deploy` (`4LHmX6...`); `ClaimFees` (`4scUVy...`); `ClaimTax`, `InitializeConfig`, `Launch`, `SweepProtocolFees`, `UpdateConfig` (`EZwLuZ...`).

## What v1 would say about devnet today

Applying the rules above to the run of 2026-11-10:

| Strategy | Markets | `readable` fails (stranded) | Trading checks not run (the market is closed) | Trade | Ordinary round trip | Outcomes beyond pass |
| --- | --- | --- | --- | --- | --- | --- |
| Constant product `yRptCd...` | 23 | 2 | 0 | 21 | 97.0% to 99.2% | `token_authorities` warn on the 15 markets where a mint's authority is a wallet (minting and selling takes 99.0% of the other vault), one of which also has the transfer-fee authority |
| Bonding curve `ETrmUe...` | 12 | 0 | 9 (`WrongStatus`, graduated) | 3 | 97.5% to 98.5% | `exit_sizes` warn on all 3: buys of 1 SOL and above cannot be sold back |
| MetalLegBob's Pool4 port `4ajWF6...` | 8 | 6 | 0 | 2 | 98.3% to 98.4% | None |
| Outside builder `9mAV3p...` | 4 | 0 | 0 | 4 | 48.8% to 49.4% | `cost` fail and `exit_queue` fail on all 4; `token_authorities` not run (the mint authority is the market's own state) |
| `2Tmcmq...` (`gacha-curve.json`) | 7 | 6 | 0 | 1 | 98.5% | `token_authorities` warn (minting the money mint takes 90.6% of the token vault) |
| `4LHmX6...` (`perp-curve.json`) | 2 | 0 | 0 | 2 | 97.9% | `token_authorities` warn (49.4%) |
| `4scUVy...` (`launch-curve.json`) | 3 | 2 | 0 | 1 | 98.5% | `token_authorities` warn (9.0%) |
| `EZwLuZ...` (`sniper-tax.devnet.json`) | 2 | 0 | 0 | 2 | 99.5% | `exit_launch_clock` warn on both: 0.995% at creation, 11.9% after 10 seconds, 66.7% after 1 minute |

- `quote_matches_swap`, `exit_hold`, `exit_late`, `exit_wallets`, `exit_transferred`, `direct_call` and `transaction_accounts` pass on every market that trades.
- The names in brackets are the file names of each strategy's metadata address; they are the author's words, not facts.
- MetalLegBob's Pool4 port did not change with the clock alone over 30 days on its two readable markets, so any daily decay of its inventory cap needs one of its own instructions to be called.

## Records

Each check on each market produces one **Canary result**, a record the facts panel renders and the explainer cites by evidence id:

| Field | Meaning |
| --- | --- |
| `id` | Stable: the check, the market, the strategy version's deploy slot and the run's slot |
| `check` | A check id from this file |
| `harness` | The Canary version that produced it, so a change of rules is visible |
| `cluster`, `slot`, `run_at` | Where and when the copy was taken |
| `strategy`, `strategy_version` | The program, with the ProgramData deploy slot and the executable hash (`pipeline-check`'s `executable_sha256`) |
| `router_version` | The router's deploy slot and executable hash |
| `market` | The market's address |
| `inputs` | Sizes, waits, clock positions, wallets and their roles |
| `outcome` | pass, warn, fail, not run or noted |
| `reason` | One sentence written by code |
| `numbers` | What was measured: amounts in and out, returns, the fee split, compute units, the failure's class, program, error name and message |

- A check that has not run for a market and version still has a record, with the outcome "not run" and why.
- Per strategy version, Canary also keeps a roll-up: for each check, how many markets got each outcome, and which markets warn or fail.
  This is where "6 of 8 markets stranded since the version deployed in slot 520,151,758" comes from.
- Aviary keeps the latest record of each check for each market and version, and every earlier record whose outcome differed from the one after it.
- `custom_instructions` and the stranded-market count feed the explainer's F items, where its spec already lists them; every other result, the conformance report included, is one of its C items.
- Results for an older strategy version stay attached to that version and are never shown as the current version's.

## What counts as "a buyer could not sell back"

[`pipescope.md`](pipescope.md) repeats one Canary observation in the trade box and asks this file to define it.

- It is any latest result of `exit_sizes`, `exit_hold`, `exit_wallets`, `exit_transferred` or `exit_queue`, for the market's current strategy version, in which a wallet's buy worked and the sale of what it bought then failed.
- A refused wallet-to-wallet transfer in `exit_transferred` is never "could not sell back": the buyer could still sell, so it raises no notice (`CANARY-27`).
- Every exit record carries `could_not_sell_back` in its numbers, true exactly when this definition holds for it, so the trade box reads one field (`CANARY-38`); `exit_late` and `exit_launch_clock` carry it as false.
- It counts whether the result is a fail or a warn, and the notice states the condition from the record: the size, the wait or the wallet's role, and the refusing program's own error message.
  On devnet today that is the three open bonding curves: "a wallet that bought 1 SOL or more could not sell back; buys of 0.1 SOL and less sold back".
- `exit_late` and `exit_launch_clock` do not count: they describe another time, and the scheduled runs see that time when it comes.
- A low round-trip return is not "could not sell back": the outside builder's 49% stays in the facts panel as a `cost` fail.
- A stranded market cannot be bought either, so it has no trade box to put a notice in; its page says the current version cannot read it.

## When Canary runs

- **A strategy's ProgramData changes** (a new strategy version): every market of that strategy, at once.
- **The router's ProgramData changes**: every market, at once.
- **A market is created or registered**: that market at once, and again 10 minutes, 1 hour and 1 day later, because launch-time rules are live then and fade.
- **Every 6 hours**: every market (owner, 2026-11-10).
  A change in a market's own state, or in a mint's authorities or extensions, shows within 6 hours; v1 has no separate watch on mints.
- This section is the only place in the spec that states the schedule (`CANARY-22`, `CANARY-23`); in code its delays and the sweep's interval live in `terminal-api`'s config module ([`pipescope-architecture.md`](pipescope-architecture.md#one-place-for-every-value)), the code that starts runs, not in `crates/canary`.
- The triggers come from the indexer's ProgramData watch and its market events, as [Where Pipescope's indexer gets its data](https://github.com/imDev2023/testing-pipeline/issues/6) decided; no router event marks a new strategy version.
- Each trigger starts or wakes the `CanaryRun` Durable Object of the strategy version concerned, which [`pipescope-architecture.md`](pipescope-architecture.md) keys by program id and ProgramData slot; that file left the triggers beyond a new version to this one.
- A sweep of all 61 devnet markets took 2 minutes 27 seconds on the owner's Mac, about 45 seconds of it CPU, and 442 RPC requests (about 7 a market), before the token-authority runs were added; with them the request count was the same.
- Against the architecture's budget, four sweeps a day are about 32 Canary runs a day (one per strategy version, about 960 a month where it assumed 500) and about 53,000 RPC requests a month (where it assumed about 5,000 credits for Canary snapshots).
  The requests are about a twentieth of Helius's free million credits.
  If each sweep keeps the one container awake for about ten minutes, four sweeps a day are about 20 GiB-hours a month, close to the 18.5 the architecture budgeted and, like them, at worst a few cents over the allowance shared with the owner's other project.
  The build should measure a sweep on the `basic` instance, a quarter of a vCPU, before trusting that figure.

## One place for every value

Every policy value of a Canary run lives in one module, `crates/canary/src/config.rs`, as a named constant (`CANARY-28`); nothing else in code writes them, and the check rows above refer to the bands and the tolerance by name rather than by number.
A change to any of them changes the `harness` version that every Canary result carries, so results made under different rules can be told apart.

| Value | Default | Decision |
| --- | --- | --- |
| Sizes with wrapped SOL, and the reference size | 0.00001, 0.001, 0.01, 0.1, 1 and 10 SOL; 0.01 SOL | `CANARY-06` |
| Sizes without wrapped SOL, the small-vault threshold and the reference sizes | 1, 100, 1,000, 10,000 and 50,000 parts per million of the money vault, or 0.01 to 100 whole tokens under 2,000,000 units; 1,000 parts per million, or 1 token | `CANARY-07` |
| Waits | the same slot, the next slot, 10 seconds, 1 minute, 10 minutes, 1 hour, 1 day, 3 days and 30 days | `CANARY-08` |
| Launch-clock offsets | creation, then 10 seconds, 1 minute, 10 minutes, 1 hour and 1 day after it | `CANARY-09` |
| Clock rates | 2.5 slots a second, 432,000 slots an epoch | `CANARY-08` |
| Pass band and fail band | 95% or more back; under 50% back | `CANARY-12` |
| Tolerance over time | 1 point | `CANARY-13` |
| Wallets | five fresh wallets in `exit_wallets`, five buyers in `exit_queue` | `CANARY-16` |
| Token authorities acting | mint 100 times the vault's holding; a transfer fee of 100% with no maximum, two epochs on | `CANARY-17` |
| Compute limits used to class a failure | 200,000 units for a quote, 1,400,000 for a swap | `CANARY-14` |
| Snapshot rounds before checks are "not run" | 4 | `CANARY-25` |

- The sections above explain each value where it is used; when one changes, the constant, this table, that section and the decision's block change in one PR.
- The schedule is not here: see [When Canary runs](#when-canary-runs).

## Built on

- Pipeline's Apache-2.0 crates, from crates.io at exact versions (0.3.0, with `pipeline-strategy-interface` 0.1.1, since 2026-11-22, published 2026-11-21 at Pipeline's `48a6b5f`, for the router with fee mints; 0.2.0 from 2026-11-19, published 2026-11-18 at `e9fbf1a`, for the router without a pause; first 0.1.0, published 2026-11-10 at `5ac3121`; see [`pipescope-architecture.md`](pipescope-architecture.md#pipelines-packages)): `pipeline-check` (the cloner, the read-only RPC source, the conformance checks, token-account writing), `pipeline-quoter` (quotes), `pipeline-client` (swap and fee-account instructions, decoders, trust facts) and `pipeline-strategy-interface` (fee maths, request types).
- The router's program is loaded from the cluster's own bytes, never built or copied into this repo; `pipeline-check` does the same.
- Every trade in the checks goes through one swap function, so the architecture's licence seam holds: on devnet it calls the router, and it can be replaced by a direct call to the strategy plus Pipeline's Apache-2.0 settlement code if running the router's bytes in production is not allowed.
  The direct implementation refuses what the router's own rules refuse a trader (an account that is not a token account of its mint, a swap that lowers the trader's output balance, and every refusal of the settlement code, named in that code's words), takes Pipeline's fee on the side the market's record names (since Pipeline 0.3, out of what arrived on a trade into the market's fee mint, with the settlement code's `settle_fee_on_output`), undoes the swap on any refusal, and is chosen in one place, Canary's config module; the strategy then runs one call level higher than under the router, the one difference (`CANARY-45`).
  `conformance` is the exception, because `pipeline-check` itself runs the router; without the router it is "not run".

## A correction to earlier research

- The quoter-hosting research saw a simulated sale fail with error 6002 and read it as the router's `ListingFeeTooHigh`, concluding the deployed router probably differed from source.
- It is the constant-product strategy's own `WrongAccount` (6002), raised at `test-strategy-cp/src/lib.rs:199`: the sale had been given the buy direction's strategy account, the wrong vault.
- `Quoter::simulate_swap` reports only the last log line, where the router repeats the strategy's error code, which is how it was misread.
- With the sale's own account the same sale succeeds (362,551,406,577 units for 100,000 lamports, fee 250), in the quoter and in a full VM.
- So that failure is no evidence that devnet's router differs from its source; verifying the router's build is still not done.

## What Canary does not do

- It does not call custom instructions, so a rule that only a custom instruction can switch on (a fee change through `UpdateConfig`, say) is not exercised; the instruction is listed.
- It does not use the upgrade authority's power, because an upgradeable program can become anything: every result holds for one strategy version, and the facts panel says the program can be upgraded.
- The launch-clock run shows time rules against today's state, not history.
- A strategy that can tell a simulation from a real trade can show Canary one behaviour and traders another; `transaction_accounts` reports the known ways and cannot rule out others.
- Results on devnet say nothing about a mainnet deployment of the same program.
