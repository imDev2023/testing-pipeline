# Buy wall AMM

Decided in [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20) on 2026-11-10 with the owner, against Pipeline commit `5ad130d` (its strategy guide and template, conformance checker, metadata standard and trust facts).
It builds on [Pool4 maths on a single Pipeline strategy, and what MetalLegBob's pool4.json strategy is](https://github.com/imDev2023/testing-pipeline/issues/11) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/pool4-on-pipeline/research/pool4-on-pipeline.md)) and on the verified source of IMD's `CappedBurnHook` at `0xc6c965bd164c483e87d0b550671798e9a3602840` on Ethereum, which is MIT-licensed.
The buy wall AMM re-implements IMD's mechanism in Rust and copies none of its code.
It was specified under the working name Pool4 for Solana; [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17) named it the buy wall AMM, because Pool4 is IMD's product name, and it credits IMD's Pool4 design wherever it is described.
MetalLegBob is not building it himself ([Record MetalLegBob's answers to the follow-up DM](https://github.com/imDev2023/testing-pipeline/issues/27)), so it stays in scope as our own strategy, to be built, deployed on devnet and registered with Pipeline.
The shared engineering and security bar for our programs is in [`README.md`](README.md); this file adds only what is particular to the buy wall AMM.
[Cut Pool4 for Solana's build tickets](https://github.com/imDev2023/testing-pipeline/issues/24) cuts the build tickets from this file and `README.md`.
It follows the conventions of [`tax-amm.md`](tax-amm.md) wherever the two strategies share a need, so our strategies have one shape.
Terms are as in `GLOSSARY.md`: inventory cap, cap floor, cap decay, trim, retired tokens, reward share, buy wall, designer share, suite share, keeper job.

## What it is

- A Pipeline strategy whose markets own all their liquidity: a token against wrapped SOL, seeded once, with no LP shares and no way to take liquidity out.
- Pricing is a constant-product curve plus the buy wall, a second, SOL-only stretch of liquidity below the price.
- After every swap the market compares the curve's token holdings with its inventory cap.
  A buy that leaves it below the cap lowers the cap, within the cap decay and never below the cap floor.
  A sell that leaves it above the cap is trimmed: the excess tokens and the proportional SOL leave the curve without moving the price.
- Trimmed tokens are retired: burned, except for the market's reward share.
  Trimmed SOL becomes the buy wall.
- Every swap pays the market's fee, always in SOL, split between IMD and Adam (the designer share), us (the suite share) and the market, whose part goes to a fee recipient, the buy wall, or both.
- Four keeper jobs place the wall, burn, pay rewards and pay out fees; anyone may call them.
- After the seed nobody, us included, has any power over a market, except that each of its two recipients may hand its own role to another wallet.

## Not in v1

- Exact-out swaps.
- Staking with streamed rewards; a market's rewards recipient can be a staking program later, ours or the creator's.
- Quote mints other than wrapped SOL.
- Being a contained token's home market: the containment hook's first version accepts only tax AMM markets ([ADR 0006](../adr/0006-unlock-goal-counted-by-the-home-market.md)); see "With the containment hook".
- Single-sided launches, LP shares, adding liquidity after the seed, closing a market or withdrawing anything from one.
- Any change to a market's parameters after creation.
- IMD's three-way split of the reward share between its own products; a creator who wants a further split names their own splitter as the rewards recipient.
- Mainnet: nothing deploys there before Pipeline's router does, and the program is frozen first (see "Upgrades and freezing").

## Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `MIN_FEE_BPS`, `MAX_FEE_BPS` | 25, 300 | The range a market's fee is chosen from (0.25% to 3%) |
| `DESIGNER_SHARE_BPS` | 1000 (10% of the fee) | The designer share, owed to IMD and Adam |
| `SUITE_SHARE_BPS` | 1000 (10% of the fee) | The suite share |
| `DESIGNER_RECIPIENT` | unset (the all-zero key) on devnet | The wallet the designer share is paid to |
| `SUITE_TREASURY` | set at build time | The same wallet the tax AMM pays its suite share to; on devnet its key is in `~/.config/testing-pipeline/devnet/` |
| `MAX_REWARD_SHARE_BPS` | 3000 | The highest reward share, IMD's own limit |
| `MIN_CAP_FLOOR_BPS` | 10 | The lowest cap floor, as a share of the seeded tokens (0.1%) |
| `MAX_CAP_DECAY_BPS` | 10,000 | The highest cap decay a day, as a share of the seeded tokens |
| `WALL_THRESHOLD` | 10,000,000 lamports (0.01 SOL) | Idle SOL, or SOL the wall has spent, that lets the wall be placed again |
| `KEEPER_TIP_CAP` | 2,000,000 lamports (0.002 SOL) | The most a wall placement tips its caller |
| `FLOOR_CRAWL_BPS` | 400 a day | How fast the wall's floor may rise, in price terms |
| `REF_STEP_BPS`, `REF_STEP_WINDOW` | 200, 12 seconds | How fast the reference may follow the price: 2% of the price per 12 seconds |
| `DECAY_CREDIT_WINDOW` | 86,400 seconds | The most cap decay allowance that builds up while a market is idle: one day's worth |
| `MIN_SQRT_PRICE`, `MAX_SQRT_PRICE` | 2^32, 2^96 | The square-root prices no trade may reach |
| `MIN_SEED_LAMPORTS` | 100,000,000 (0.1 SOL) | The least SOL a seed may bring |
| `MIN_OPENING_SQRT_PRICE`, `MAX_OPENING_SQRT_PRICE` | 2^40, 2^88 | The square-root prices a market may open between |
| `MIN_LIQUIDITY` | 1,000,000 | The least liquidity the curve may ever hold |
| `MARKET_STATE_SIZE` | 1,024 bytes | The size of every market state, for good |

The constants are compiled into the program; changing one is a program upgrade, which ends when the program is frozen.
`DESIGNER_SHARE_BPS` and `SUITE_SHARE_BPS` are also published in the program's IDL (Anchor's `#[constant]`), where the generated client and the demo script read them ([`POOL4-25`](../decisions.md#pool4-25-the-fee-shares-in-the-idl)), and so are `DECAY_CREDIT_WINDOW` and `MIN_LIQUIDITY`, which the demo's model of the cap reads ([`POOL4-30`](../decisions.md#pool4-30-what-a-swap-that-moves-the-cap-reports)), and `WALL_THRESHOLD`, `KEEPER_TIP_CAP`, `FLOOR_CRAWL_BPS`, `REF_STEP_BPS` and `REF_STEP_WINDOW`, which its models of the wall and its guard read ([`POOL4-35`](../decisions.md#pool4-35-the-walls-constants-in-the-idl)).
There is no admin and no settings account.

Every decision here is a default that MetalLegBob may change (the map's standing rule of 2026-11-10), so each policy value lives in exactly one place:

- the constants above, all in one module of the program (`config.rs`), which nothing else in the code repeats;
- a market's creation parameters, for everything a creator chooses;
- Aviary's create form, for the pre-filled values.

Changing a fee, cap, split, limit or default is then one edit in one of those places before a deployment.

`DESIGNER_RECIPIENT` is unset because IMD and Adam have no known Solana address (2026-11-10).
The designer share builds up in each market from its first swap and waits there; the owner asks Adam for an address, and a program upgrade sets the constant, which must happen before the program is frozen.
`DESIGNER_RECIPIENT` and `SUITE_TREASURY` are published in the IDL as well, where the demo reads the wallets fee slots 1 and 2 are paid to ([`POOL4-40`](../decisions.md#pool4-40-the-fee-slots-wallets-in-the-idl)).
So that slot 1's payout is tested before the constant is set, the program has a `test-designer-recipient` feature that sets it to a test key nobody holds; only CI's extra test build turns it on, and that build has a program id of its own, so deployed at the program's address it would refuse every instruction ([`POOL4-39`](../decisions.md#pool4-39-testing-the-designer-slot-before-its-wallet-is-set)).

## Markets

### Shape

- Exactly two mints: index 0 is the token and index 1 is wrapped SOL (`So11111111111111111111111111111111111111112`), which is the order `pipeline_market_info` reports.
- Prices below are in lamports per token unit, the token's smallest unit.

### Addresses

- A market created through the router has a fresh keypair as its market state (metadata `init.market_state` is `new_keypair`), as in the tax AMM and for the same reason: a key derived from only some parameters could be taken first by a market with bad ones.
- The vault authority is the PDA `["authority", market_state]` of the program; it signs every transfer and burn out of the vaults.
  A program can sign for a PDA only if its account is passed in, so `pipeline_resolve_accounts` lists it, read-only, after the output vault, and `pipeline_swap` checks it against the stored bump ([`POOL4-24`](../decisions.md#pool4-24-the-vault-authority-in-a-swap), owner, 2026-11-12; the tax AMM does the same).
- Each vault is a token account at the PDA `["vault", market_state, mint]`, owned by the vault authority.
- So the vaults and the router's market and fee accounts can all be computed before `create_market` is sent, as for the tax AMM.
- A market created through `pipeline_seed_liquidity` lives at the PDA `["seeded", seeder, token_mint, wsol_mint]`, with its vaults and authority derived from that address in the same way.

### Creation parameters

`init_data` is the Borsh encoding of these fields, in this order (metadata `init.args` lists them the same way):

| Field | Type | Rule |
| --- | --- | --- |
| `fee_bps` | u16 | `MIN_FEE_BPS` to `MAX_FEE_BPS` |
| `wall_split_bps` | u16 | 0 to 10,000: the part of the market's share of each fee that goes to the buy wall |
| `fee_recipient` | pubkey | A wallet; the default (all-zero) key only when `wall_split_bps` is 10,000 |
| `reward_share_bps` | u16 | 0 to `MAX_REWARD_SHARE_BPS` |
| `rewards_recipient` | pubkey | A wallet; the default key exactly when `reward_share_bps` is 0 |
| `cap_floor_bps` | u16 | `MIN_CAP_FLOOR_BPS` to 10,000, of the seeded tokens |
| `cap_decay_bps` | u16 | 0 to `MAX_CAP_DECAY_BPS`, of the seeded tokens a day; 0 switches the ratchet off |
| `seeder` | pubkey | The only signer the seed action accepts; must not be the default key |

- None of these can change after creation, except through a recipient's own handover (see "Recipients").
- Aviary's create form pre-fills IMD's own launch values: a 1% fee, a 15% reward share, a cap floor of 20% and a cap decay of 20% a day; they are defaults of the form only, kept in one place there.
- `pipeline_init_market` refuses anything that breaks a rule, checks the token mint against the mint rules, checks that the market signer is the router's PDA `["market", program, market_state]` and stores it, creates both vaults idempotently, and records the creation slot and Unix time.
- `pipeline_seed_liquidity` takes the same fields in `SeedRequest.data`, with `seeder` ignored because the calling program's PDA is the seeder.

### Mint rules

- The token is an SPL Token or Token-2022 mint.
- Its mint authority and its freeze authority must both be removed by the time the market is seeded.
  A live mint authority could mint and sell into the curve and the buy wall, and would make the burns meaningless; a live freeze authority could freeze the market's vault.
  The tax AMM allows both because USDC has them; a token on the buy wall AMM has no such need.
- A Token-2022 token with a transfer hook must have its hook cleared by the time the market is seeded, like the mint and freeze authorities: both its hook program and its hook authority unset, the state a contained token reaches after its unlock ([`POOL4-48`](../decisions.md#pool4-48-a-transfer-hook-at-the-seed)).
  Whoever could still set the hook, or upgrade or configure the hook program it names, could make it refuse every sell but their own once holders have bought, and sell into the curve and the buy wall themselves, a freeze that spares one wallet.
  Once both are unset Token-2022 can never set them again, so no hook ever runs on a seeded market's token; a token without the extension is unaffected.
  Creation still accepts a live hook, and the seed refuses it with `TransferHookLive`, since the hook can be cleared between the two and could be changed until the seed.
- A Token-2022 token may carry only the suite's allowlist of mint extensions, the tax AMM's ([`tax-amm.md`](tax-amm.md), "Mint rules"), which lives in the shared `programs/mint-rules` crate; the buy wall AMM calls that crate and keeps no copy of the list.
  Every other extension is refused at creation, including any the program does not recognise.
- In Pipeline's trust flags a seeded market's token can therefore only ever show `token-2022`: `transfer-hook` and `transfer-hook-authority` mark a hook program or a hook authority that is still set, which the seed refuses.

### Creating a market

One transaction, as Pipeline's guide recommends:

1. The router's `create_market` with the creation parameters, signed by the creator and the market state keypair.
2. The router's `init_fee_account` for each of the two mints.
3. The `seed` action, signed by the seeder.

A launchpad graduating a token instead calls `pipeline_seed_liquidity`, then the router's `register_existing_market` and `init_fee_account` for each mint, in one transaction.

### The seed

- `seed { token_amount: u64, sol_amount: u64 }` is a custom action signed by the market's `seeder`, from token accounts the seeder owns, allowed once.
- It records what actually arrived in each vault, `x` token units and `y` lamports, and opens the market:
  - `sqrt_price = floor(sqrt(y × 2^128 / x))`;
  - `liquidity = min(floor(x × sqrt_price / 2^64), floor(y × 2^64 / sqrt_price))`, the most both amounts can back at that rounded price, so the ledgers cover the curve from the start (the plain `sqrt(x × y)` can exceed them by a unit);
  - `pool_tokens = x`, `pool_sol = y`, `seeded_tokens = x` and the inventory cap is `x`;
  - `cap_floor = max(1, floor(x × cap_floor_bps / 10,000))` and `cap_decay_per_day = floor(x × cap_decay_bps / 10,000)`;
  - the wall's reference, floor and last close all start at `sqrt_price`, and every clock field at the current time.
- It is refused unless the token's mint and freeze authorities are removed, `y` is at least `MIN_SEED_LAMPORTS`, `sqrt_price` is between `MIN_OPENING_SQRT_PRICE` and `MAX_OPENING_SQRT_PRICE`, and `floor(cap_floor × sqrt_price / 2^64)` is at least `MIN_LIQUIDITY`, so the curve stays usable even with its cap at the floor.
- Until the seed, quotes and swaps are refused.
- `pipeline_seed_liquidity` seeds and opens the market in the same call, taking at most `amounts[i]` from each escrow, and returns `SeedResult { taken, lp_amount: 0 }`; the LP recipient is ignored.
  It is created and opened by the same code as a market created through the router and seeded by `seed`, under every creation rule, mint rule and seed rule, and emits the same two events, `MarketCreated` (with the calling program's PDA as its seeder) and `MarketSeeded` ([`POOL4-29`](../decisions.md#pool4-29-how-a-seed-request-is-checked)).
  It refuses a request without exactly two amounts, the token's then wrapped SOL's (`BadSeedAmounts`), `data` that is not exactly the creation parameters, and escrows the seeder does not own, as `seed` requires of the seeder's accounts; `taken` is what it measured leaving each escrow.
  Any signer may call it directly, a wallet included, and becomes its market's seeder; the address keyed by the seeder is what keeps one launchpad from taking another's market first.
- Tokens or SOL sent to a vault outside a swap or the seed are donations: never credited as input, never paid out.

## Pricing

Exact-in only: `pipeline_market_info` reports `supports_exact_out = false`, and an exact-out quote or swap is refused.

### What is stored

Square-root prices are unsigned Q64.64 numbers held in 128 bits: the square root of the price, times `Q = 2^64`.

| Field | Meaning |
| --- | --- |
| `sqrt_price` | The current square-root price, `s` below |
| `liquidity` | The curve's liquidity `L`; the curve holds `L × Q / s` token units and `L × s / Q` lamports |
| `wall_liquidity` | The buy wall's liquidity `W`; 0 when no wall is placed |
| `wall_top` | The square-root price at and below which the wall trades |

The buy wall is one stretch of liquidity from `wall_top` down to zero, as in IMD's design.
At or above `wall_top` it is all SOL, `W × wall_top / Q` lamports; below it, it has bought tokens and holds `W × s / Q` lamports.
A wall is placed exactly when `W` is above 0; a `wall_top` with no liquidity, which `place_wall` leaves when almost nothing is idle, trades as no wall ([`POOL4-33`](../decisions.md#pool4-33-when-a-wall-counts-as-placed)).
While the price is at or below `wall_top`, a trade moves through `L + W`; above it, through `L` alone.
So a trade crosses at most one boundary and is priced in at most two steps, with no square roots and no extra accounts.

### A sell

For `a` credited token units:

1. Start with `remaining = a`, `gross = 0` and `s = sqrt_price`.
2. Take up to two steps:
   - if a wall is placed and `s > wall_top`, the step uses `liq = L` and `target = wall_top`; otherwise `liq = L + W` and `target = MIN_SQRT_PRICE`;
   - `need = ceil(liq × Q × (s - target) / (s × target))`;
   - if `remaining >= need`, then `next = target` and `used = need`; otherwise `next = ceil(liq × Q × s / (liq × Q + remaining × s))` and `used = remaining`;
   - `gross += floor(liq × (s - next) / Q)`, `remaining -= used`, `s = next`, and stop when `remaining` is 0.
3. `fee = ceil(gross × fee_bps / 10,000)` and `out = gross - fee`.

### A buy

For `a` credited lamports:

1. `fee = ceil(a × fee_bps / 10,000)`; start with `remaining = a - fee`, `out = 0` and `s = sqrt_price`.
2. Take up to two steps:
   - if a wall is placed and `s < wall_top`, the step uses `liq = L + W` and `target = wall_top`; otherwise `liq = L` and `target = MAX_SQRT_PRICE`;
   - `need = ceil(liq × (target - s) / Q)`;
   - if `remaining >= need`, then `next = target` and `used = need`; otherwise `next = s + floor(remaining × Q / liq)` and `used = remaining`;
   - `out += floor(liq × Q × (next - s) / (next × s))`, `remaining -= used`, `s = next`, and stop when `remaining` is 0.

### Rules for both

- A quote or swap is refused when the input is 0, when `out` is 0, when a buy leaves nothing after the fee, or when input is left over because a price bound was reached.
- The trader always gets the worse side of every rounding: prices move no further than the input pays for, outputs round down and the fee rounds up.
- Intermediate maths uses 256-bit integers with checked operations; an overflow refuses the instruction.
  A division by two square-root prices divides once by their product, which always fits in 256 bits and gives the same floor or ceiling as dividing by one price at a time ([`POOL4-26`](../decisions.md#pool4-26-dividing-by-two-square-root-prices)).
- `pipeline_quote` and `pipeline_swap` call this one pricing function, so quotes include the fee and match swaps exactly, which `pipeline-check`'s `quote_matches_swap` verifies to the unit.
- Pricing reads no clock: everything time-based below runs after the output is decided, so a quote never depends on when it is asked.

### Credited input

- Input is credited with Pipeline's `credited_input`: what the input vault holds beyond what the market has recorded there, capped at what the router sent.
- What the market has recorded in a vault is the sum of every ledger kept in it (see "Ledgers"), not the curve's holdings alone.
- The input stays in the input vault for the whole swap, as Pipeline's guide asks.

### Bypass

- Refused, as for every strategy of ours ([ADR 0001](../adr/0001-our-strategies-refuse-bypass.md)): `pipeline_swap` accepts only the router's market signer stored at creation.
- So every trade pays Pipeline's fee, emits a swap event and counts in the market's counters.
- No custom action moves the price.
- The router lets a trader name the account its output goes to; the swap pays exactly that account exactly the quote, and refuses only the output vault itself as that account ([`POOL4-27`](../decisions.md#pool4-27-paying-a-swaps-output-to-another-wallets-account)).

## After pricing

`pipeline_swap` then updates the market in this order.
None of it changes the trade just priced.
`now` is the Clock's Unix time and every time difference saturates at 0.

1. **Reference.**
   If the Clock's slot is later than `last_slot`: `dt = min(now - ref_time, REF_STEP_WINDOW)`, `step = floor(ref × REF_STEP_BPS × dt / (2 × 10,000 × REF_STEP_WINDOW))`, and `ref` moves toward `last_close` by at most `step`; then `ref_time = max(ref_time, now)` and `last_slot` is the slot.
   `last_close` is still the price the previous slot's trading ended at, so no trade in this slot can move the reference.
2. **Books.**
   A sell adds `a` to `pool_tokens` and takes `gross` from `pool_sol`; a buy adds `a - fee` to `pool_sol` and takes `out` from `pool_tokens`.
   The fee is split (see "The fee").
3. **Price.**
   `sqrt_price` and `last_close` become the new price.
4. **Floor.**
   The floor changes only at the slot's first update, when step 1 found the Clock's slot later than `last_slot`, with the `ref` step 1 left and the `last_close` step 1 read, the previous slot's close from before step 3 replaced it ([`POOL4-50`](../decisions.md#pool4-50-when-the-walls-floor-moves)).
   If `floor < ref`, `dt = min(now - floor_time, 86,400)` and `floor` rises by `floor(floor × FLOOR_CRAWL_BPS × dt / (2 × 10,000 × 86,400))`, but not above `ref`.
   Then `floor` drops to that `last_close` if it is lower, and `floor_time = max(floor_time, now)`, at every slot's first update whether or not the floor crawled ([`POOL4-32`](../decisions.md#pool4-32-when-the-floors-clock-moves)).
   In a slot already brought up to date the floor and `floor_time` stay as they are, so no trade can move the floor in its own slot, and the floor is never above the price the slot opened at.
5. **Decay credit.**
   `decay_credit = min(decay_credit + cap_decay_per_day × (now - decay_time), cap_decay_per_day × DECAY_CREDIT_WINDOW)` and `decay_time = now`.
   The credit is in token-seconds, so nothing is lost to rounding, and at most one day's allowance ever builds up.
6. **The cap.**
   With `held = floor(L × Q / s)`:
   - **Ratchet**, when `held < cap`: the cap falls to `max(held, cap - floor(decay_credit / 86,400), cap_floor)`, with the subtraction saturating at 0, and `decay_credit` drops by 86,400 for every token unit the cap fell.
     This runs after a sell as well as a buy, whenever the curve ends below the cap ([`POOL4-31`](../decisions.md#pool4-31-the-ratchet-after-a-sell)).
   - **Trim**, when `held > cap`: `new_L = max(floor(cap × s / Q), MIN_LIQUIDITY)`, and if that is below `L`, the curve gives up `held - ceil(new_L × Q / s)` token units and `floor(L × s / Q) - ceil(new_L × s / Q)` lamports (0 if negative).
     Both leave the pool ledgers: the tokens join `retired_tokens`, the SOL joins `idle_sol`, and `L` becomes `new_L`.
     `sqrt_price` is untouched, so a trim never moves the price.
7. **Counters** (see "Counters").

The halving in steps 1 and 4 turns a rate on the price into a rate on its square root.

### What these do

- The ratchet is IMD's at its deployed setting: a buy lowers the cap by all the room it opens, limited by the cap decay and the cap floor.
- IMD's hook lets decay allowance build up without limit while a market is idle; ours stops at one day's worth, so a long-idle market's cap can never drop many days at once.
- The wall's floor follows IMD's guard, slot by slot: at a slot's first update it drops to the price the slot opened at, the previous slot's close, and it rises about 4% a day toward a reference that lags the price, but never above that close.
  The wall can never be placed above the floor, nor in a slot a swap has already run in, so pumping the price and placing the wall high earns nothing, a dip bought straight back inside one slot never drags the wall down, and no trade can lift the floor in its own slot, so a quiet spell's crawl never lifts it above the price a buy started from when that buy opens its slot ([`POOL4-50`](../decisions.md#pool4-50-when-the-walls-floor-moves)).
- IMD's rates are per Ethereum block; ours are per second, because Solana's slot times vary.

## The fee

For each swap's `fee`, in lamports:

- `designer = floor(fee × DESIGNER_SHARE_BPS / 10,000)`, added to `fees_designer`;
- `suite = floor(fee × SUITE_SHARE_BPS / 10,000)`, added to `fees_suite`;
- the market's part is the rest: `to_wall = floor(rest × wall_split_bps / 10,000)` joins `idle_sol`, and what is left is added to `fees_recipient`.

Traders pay this fee on top of Pipeline's 0.25%.
Taking it in SOL in both directions means no recipient is ever paid in the token, so none has tokens to sell, and no fee payout passes through a transfer hook.
Nothing is paid out during a swap, so a swap needs no recipient accounts and a broken recipient account can never block trading.

## Ledgers

The market state keeps one ledger per claim on a vault:

| Vault | Ledgers |
| --- | --- |
| Token | `pool_tokens` (the curve's and the wall's), `retired_tokens` (waiting to be burned and split), `rewards_owed` |
| Wrapped SOL | `pool_sol` (the curve's and the wall's), `idle_sol` (waiting to be placed as the wall), `fees_recipient`, `fees_designer`, `fees_suite` |

These always hold, and the tests check them after every instruction:

- Each vault's balance is at least the sum of its ledgers.
- `pool_tokens` and `pool_sol` cover everything the curve and the wall could ever pay out at the current price.
- The curve never holds more tokens than the inventory cap after a swap, except where `MIN_LIQUIDITY` stopped a trim.
- The inventory cap never rises and never falls below the cap floor.
- The wall's floor is never above the reference, and never above the previous slot's close (`last_close` at the slot's first update); it changes only at a slot's first update.
- A placed wall's top is never above the price at placement nor the floor it was placed under.

## Keeper jobs

Four permissionless custom actions; anyone may call them at any time, and our keeper runner does.
None moves the price.

### `place_wall`

It runs only in a slot no swap has run in yet, and is refused with `SwapThisSlot` when `last_slot` is the Clock's slot, that is when a swap, or the seed, ran in it ([`POOL4-50`](../decisions.md#pool4-50-when-the-walls-floor-moves)).
In a later slot it first brings the floor up to date as "After pricing" step 4 does at a slot's first update, with `ref` and `last_close` as they are, but leaves `last_slot`, `ref` and `ref_time` alone, so a swap later in the same slot still runs steps 1 and 4, where the floor's update then changes nothing.
Since only a swap moves the price, `last_close` is the price at placement, so the floor it places under is never above it.
Then:

1. `converted` is the SOL the placed wall has spent buying tokens: `wall_sol_placed - floor(W × min(s, wall_top) / Q)`, or 0 with no wall.
   The call is refused unless `idle_sol` or `converted` is at least `WALL_THRESHOLD`.
2. The old wall is closed at the current price: its SOL moves from `pool_sol` to `idle_sol` and the tokens it bought, `floor(W × Q × (wall_top - s) / (wall_top × s))` when `s < wall_top`, move from `pool_tokens` to `retired_tokens`.
3. Rounding dust follows: whatever `pool_sol` and `pool_tokens` hold beyond the curve's own holdings, rounded up, joins `idle_sol` and `retired_tokens`.
4. The caller is tipped `min(KEEPER_TIP_CAP, floor(work × fee_bps / 10,000), idle_sol)` lamports from `idle_sol`, where `work` is the larger of `converted` and the idle SOL from step 1 if that reached the threshold.
   This is IMD's rule: the tip never exceeds the fee the market earned on the work, so faking work never pays.
   It is paid in wrapped SOL to a token account the caller names.
5. The wall is placed with everything left: `wall_top = min(s, floor)`, `W = floor(idle_sol × Q / wall_top)`, `wall_sol_placed = floor(W × wall_top / Q)`, and `idle_sol` moves into `pool_sol`.

The caller signs, and the tip account may be any wrapped SOL account but the market's own SOL vault; the metadata's form names the caller's own.
It emits `WallPlaced` (the caller, the tip account, `converted`, what closing the old wall moved, the dust, the tip and the new wall), and the lifetime total of tokens the wall bought grows by what each closed wall bought ([`POOL4-34`](../decisions.md#pool4-34-what-place_wall-takes-and-reports)).

### `settle`

- Splits `retired_tokens`: `floor(retired × reward_share_bps / 10,000)` joins `rewards_owed`, and the rest is burned from the token vault.
- Refused when there is nothing retired.
- No tip.
- A burn calls no transfer hook, so no hook can refuse it.
- Nobody signs it but whoever pays the transaction fee, since it pays nobody ([`POOL4-38`](../decisions.md#pool4-38-who-signs-the-payouts-and-what-they-report)).
- Like `pay_rewards` and `sweep_fees`, it is refused with `MarketNotOpen` until the market is seeded.
- It emits `Settled` (what was retired, burned and added to the rewards owed, the rewards owed after and the lifetime total burned), and the lifetime total of tokens burned grows by what it burns.

### `pay_rewards`

- Sends all of `rewards_owed` to the rewards recipient's associated token account for the token, created if missing at the caller's expense, forwarding transfer-hook accounts.
- Refused when nothing is owed.
- No tip.
- It is separate from `settle` so that burns never wait on a transfer a broken recipient account might refuse.
- It emits `RewardsPaid` (the recipient, its token account, the amount and the lifetime total paid), and the lifetime total of rewards paid grows by what it pays.

### `sweep_fees { slot }`

- Pays one slot's whole ledger in wrapped SOL to the associated token account of that slot's wallet, created if missing at the caller's expense: slot 0 is `fees_recipient` to the fee recipient, slot 1 is `fees_designer` to `DESIGNER_RECIPIENT`, slot 2 is `fees_suite` to `SUITE_TREASURY`.
- Slot 1 is refused while `DESIGNER_RECIPIENT` is unset; the SOL waits in the vault.
- Each slot is paid separately, so one broken account never holds up the others.
- No tip.
- A recipient unwraps by closing the account (Aviary offers this).
- It emits `FeesSwept` (the slot, the wallet, its token account and the amount).

### The recipient's token account

How `pay_rewards` and `sweep_fees` name and check the account they pay ([`POOL4-37`](../decisions.md#pool4-37-how-a-payout-names-and-checks-its-recipients-account)):

- The caller signs and names the recipient's wallet, which must be the one the market (or, for slots 1 and 2, the program) names; metadata forms cannot read a market state, so the forms take it as an input.
- Only the wallet's associated token account for the mint is paid, the address every wallet and Aviary compute.
- One that does not exist, because it was never created, was closed, or only holds lamports someone sent to its address, is created at the caller's expense.
- One that exists but whose owner is no longer the wallet (SPL Token lets an account's owner hand it to another wallet) is refused with `RecipientAccountNotTheirs`, since paying it would pay someone else; only that payout waits, and the recipient can hand its role to another wallet.

### For the keeper runner

The runner is not specified yet (the map's "Not yet specified"); what it needs from here:

| Job | Run it when |
| --- | --- |
| `place_wall` | `idle_sol` or the wall's `converted` reaches `WALL_THRESHOLD`, checked after each swap event on the market, and sent so it lands in a later slot than that swap, since in the swap's own slot it is refused with `SwapThisSlot` |
| `settle` | `retired_tokens` is above 0, at most hourly for each market |
| `pay_rewards` | `rewards_owed` is above 0, daily |
| `sweep_fees` | A slot's ledger is above 0, daily; slot 1 only once `DESIGNER_RECIPIENT` is set |

`pay_rewards` for a token with a transfer hook needs the hook's extra accounts, which the metadata form cannot carry, so the runner resolves them from the mint's extra account metas, as Aviary does; a hook that refuses the payout makes the job fail like any other, changing nothing.

A payout into a recipient account that does not exist makes the caller pay its rent, and a recipient that closes its account after each payout gets that rent back each time, so the runner should skip a payout whose ledger is worth less than that rent while the account is missing.

## Recipients

- `set_fee_recipient { new }` is signed by the current fee recipient, and `set_rewards_recipient { new }` by the current rewards recipient; `new` must not be the default key.
- `new` must not be the role's current wallet (refused with `SameRecipient`), nor one of the market's own addresses: its market state, its vault authority, either vault or the program (refused with `NotAWallet`), since no key signs for a token account any of them owns and the role's income would be stranded there ([`POOL4-52`](../decisions.md#pool4-52-which-wallets-a-role-may-be-handed-to)).
  Any other key is accepted in one step, so a mistyped wallet remains the holder's own risk.
- What the role is owed follows it to the new wallet.
- A market created with no fee recipient or no rewards recipient never gets one.
- Nobody else can change a recipient, and nothing else about a market can change.
- A handover may happen at any time, before the seed as well, and emits `RecipientChanged` (which role, the old wallet and the new) ([`POOL4-38`](../decisions.md#pool4-38-who-signs-the-payouts-and-what-they-report)); since a handover to the current wallet is refused, the old and the new wallet always differ ([`POOL4-52`](../decisions.md#pool4-52-which-wallets-a-role-may-be-handed-to)).

## Counters

The market state keeps the tax AMM's counters, changed only by `pipeline_swap` calls signed by the market signer:

| Field | Type | Adds, per swap |
| --- | --- | --- |
| `volume[0]`, `volume[1]` | u128 | For the input mint, the credited input; for the output mint, what the trader was paid |
| `fees_collected` | u128 | The swap's fee, in lamports |
| `swap_count` | u64 | 1 |

It also keeps the creation slot and time and lifetime totals for display: tokens trimmed, SOL trimmed, tokens the wall bought, tokens burned, rewards paid and tips paid.

## With the containment hook

- A buy wall market cannot be a contained token's home market in v1: the containment hook's first version binds only tax AMM markets and reads only the tax AMM's counter ([`containment-hook.md`](containment-hook.md), [ADR 0006](../adr/0006-unlock-goal-counted-by-the-home-market.md)).
  So a contained token reaches the buy wall AMM only after its unlock.
- A token may no longer carry a live third-party transfer hook: the seed refuses one whose hook program or hook authority is still set, so a hooked token reaches a market only with its hook cleared, as a contained token's is after its unlock ([`POOL4-48`](../decisions.md#pool4-48-a-transfer-hook-at-the-seed)).
  The market still forwards whatever hook accounts it is given on every transfer of the token, which a cleared hook does not need, so a later rule that admitted some hooks would need no change to the actions.
- The design keeps everything a later hook version would need to accept these markets, so that change would touch only the hook and the seed's refusal of a live hook, which would have to admit a token bound to the market being seeded:
  - bypass is refused, and the counters count router swaps only;
  - `fees_collected` is in SOL and can't be gamed by changing the rate, since a market's fee never changes and is never below 0.25%;
  - the vault and the router's `["fees", market]` account are computable before creation;
  - the token moves only between traders and the market's vault (swaps and the seed), out of the vault to the rewards recipient (`pay_rewards`), or is burned;
  - fees and keeper tips are wrapped SOL, which no hook sees;
  - liquidity can never leave: trims only move it, inside the same vaults, to the burn and the buy wall.
- Pipeline's hosted API refuses to build swaps whose input mint has a transfer hook, because the client must resolve the hook's accounts; a seeded market's token has no hook program and needs none, and should the API refuse it for carrying the cleared extension, its sells are built with the SDK, as Aviary does.

## Market state

An upgrade must never strand a market.
On 2026-11-08 an upgrade of another Pool4 port on devnet left 6 of its 8 markets failing every resolve, quote and swap with `AccountDidNotDeserialize`, because the new program could not read market states written by older versions.
Three rules prevent that here.

### One fixed-size layout

- Every market state is `MARKET_STATE_SIZE` bytes from creation and is never resized.
- It starts with the 8-byte account discriminator, which never changes, and a layout version byte.
- Fields are read at fixed offsets (a zero-copy account, not a Borsh-decoded one), with no padding: 128-bit values are stored as little-endian byte arrays.
- Space after the last field is zeroed and reserved.
  A later version may only append fields into the reserve; it never moves, resizes or removes a field, and a zeroed new field must mean the old behaviour.
- So a newer program reads every older market as it is, with no migration step, and every instruction accepts every layout version ever deployed.

Fields, in order:

| Group | Fields |
| --- | --- |
| Identity | discriminator, layout version, status (created or open), bumps, market signer, token mint, wrapped SOL mint, token vault, SOL vault, seeder, creation slot, creation time, seed time |
| Counters | `volume[0]`, `volume[1]`, `fees_collected`, `swap_count` |
| Parameters | `fee_bps`, `wall_split_bps`, `reward_share_bps`, fee recipient, rewards recipient, `cap_floor_bps`, `cap_decay_bps`, `cap_floor`, `cap_decay_per_day`, `seeded_tokens` |
| Pricing | `sqrt_price`, `liquidity`, `wall_liquidity`, `wall_top`, `wall_sol_placed` |
| Ledgers | `pool_tokens`, `pool_sol`, `retired_tokens`, `rewards_owed`, `idle_sol`, `fees_recipient`, `fees_designer`, `fees_suite` |
| Cap | inventory cap, `decay_credit`, `decay_time` |
| Wall guard | `ref`, `ref_time`, `floor`, `floor_time`, `last_slot`, `last_close` |
| Totals | tokens trimmed, SOL trimmed, tokens the wall bought, tokens burned, rewards paid, tips paid |
| Reserve | zeroed to the end of the account |

The first build ticket ([Buy wall AMM: a market opens](https://github.com/imDev2023/testing-pipeline/issues/47)) fixed the byte offsets below; they are frozen from the first devnet deployment ([Buy wall AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/56)) and published in the IDL.
The creation parameters `cap_floor_bps` and `cap_decay_bps` are kept as well, because `cap_floor` and `cap_decay_per_day` can only be computed at the seed, from what the seed brings.

### Byte offsets

Layout version 1.
Offsets are from the start of the account, every integer is little-endian, and nothing is padded.
The discriminator is the ASCII bytes `BWMARKET` (`42 57 4d 41 52 4b 45 54`), written in the code as fixed bytes ([`POOL4-21`, `POOL4-22`](../decisions.md#pool4-22-the-market-states-discriminator-and-layout-version)).
`status` is 1 once created and 2 once seeded.
The program's `state.rs` holds the same layout, and `tests/layout.rs` reads this table and checks every row against it.

| Field | Offset | Size | Type |
| --- | --- | --- | --- |
| `discriminator` | 0 | 8 | bytes |
| `layout_version` | 8 | 1 | u8 |
| `status` | 9 | 1 | u8 |
| `authority_bump` | 10 | 1 | u8 |
| `token_vault_bump` | 11 | 1 | u8 |
| `sol_vault_bump` | 12 | 1 | u8 |
| `market_signer` | 13 | 32 | pubkey |
| `token_mint` | 45 | 32 | pubkey |
| `wsol_mint` | 77 | 32 | pubkey |
| `token_vault` | 109 | 32 | pubkey |
| `sol_vault` | 141 | 32 | pubkey |
| `seeder` | 173 | 32 | pubkey |
| `creation_slot` | 205 | 8 | u64 |
| `creation_time` | 213 | 8 | i64 |
| `seed_time` | 221 | 8 | i64 |
| `volume[0]` | 229 | 16 | u128 |
| `volume[1]` | 245 | 16 | u128 |
| `fees_collected` | 261 | 16 | u128 |
| `swap_count` | 277 | 8 | u64 |
| `fee_bps` | 285 | 2 | u16 |
| `wall_split_bps` | 287 | 2 | u16 |
| `reward_share_bps` | 289 | 2 | u16 |
| `fee_recipient` | 291 | 32 | pubkey |
| `rewards_recipient` | 323 | 32 | pubkey |
| `cap_floor_bps` | 355 | 2 | u16 |
| `cap_decay_bps` | 357 | 2 | u16 |
| `cap_floor` | 359 | 8 | u64 |
| `cap_decay_per_day` | 367 | 8 | u64 |
| `seeded_tokens` | 375 | 8 | u64 |
| `sqrt_price` | 383 | 16 | u128 |
| `liquidity` | 399 | 16 | u128 |
| `wall_liquidity` | 415 | 16 | u128 |
| `wall_top` | 431 | 16 | u128 |
| `wall_sol_placed` | 447 | 8 | u64 |
| `pool_tokens` | 455 | 8 | u64 |
| `pool_sol` | 463 | 8 | u64 |
| `retired_tokens` | 471 | 8 | u64 |
| `rewards_owed` | 479 | 8 | u64 |
| `idle_sol` | 487 | 8 | u64 |
| `fees_recipient` | 495 | 8 | u64 |
| `fees_designer` | 503 | 8 | u64 |
| `fees_suite` | 511 | 8 | u64 |
| `cap` | 519 | 8 | u64 |
| `decay_credit` | 527 | 16 | u128 |
| `decay_time` | 543 | 8 | i64 |
| `ref` | 551 | 16 | u128 |
| `ref_time` | 567 | 8 | i64 |
| `floor` | 575 | 16 | u128 |
| `floor_time` | 591 | 8 | i64 |
| `last_slot` | 599 | 8 | u64 |
| `last_close` | 607 | 16 | u128 |
| `tokens_trimmed` | 623 | 16 | u128 |
| `sol_trimmed` | 639 | 16 | u128 |
| `wall_tokens_bought` | 655 | 16 | u128 |
| `tokens_burned` | 671 | 16 | u128 |
| `rewards_paid` | 687 | 16 | u128 |
| `tips_paid` | 703 | 16 | u128 |
| `reserve` | 719 | 305 | bytes |

Square-root prices (`sqrt_price`, `wall_top`, `ref`, `floor`, `last_close`) are Q64.64; times are Unix seconds; `cap` is the inventory cap and `ref` is the wall's reference; `decay_credit` is in token-seconds.

### A release gate

- Before any upgrade, a script downloads every live market state of the program from the cluster, with its mints and vaults, and loads them into LiteSVM with the new build and the real router.
- On every market it runs account resolution, a quote, a buy and a sell through the router, and each keeper job whose condition holds or that the deployed build runs.
- The upgrade is refused if a step fails on any market that passes there under the deployed build, if a layout check fails, or if a quote differs from the deployed build's quote on the same state without the release declaring a pricing change.
- The deploy script accepts only a build whose hash the gate has passed.

How it does each of these ([`POOL4-41`](../decisions.md#pool4-41-what-the-release-gate-runs-on-each-market) to [`POOL4-45`](../decisions.md#pool4-45-how-the-gate-reads-a-cluster), [`POOL4-46`](../decisions.md#pool4-46-when-a-failed-step-counts-against-a-candidate) and [`POOL4-47`](../decisions.md#pool4-47-markets-the-router-has-not-recorded)):

- It finds the market states as the accounts the program owns that start with the discriminator, and refuses outright if one of them is not `MARKET_STATE_SIZE` bytes.
- It copies each market as `pipeline-check` does (the router and its config, the Market, the strategy's registration, program and ProgramData, the mints, vaults, fee accounts, transfer hooks and every account `pipeline_resolve_accounts` lists), adds the token accounts the payouts pay into, reads them all again in as few calls as it can so they agree, and saves them in one snapshot file with the cluster's clock read last.
- A market state the router has no Market for, which any wallet can make by calling `pipeline_seed_liquidity` itself, is copied the same way, as if the router had recorded what `pipeline_market_info` gives, and saved marked unregistered.
- When it takes the snapshot it replays it with the deployed build and records what that build did: its quotes, and whether each other step passed, with the program a failure started in, every keeper job tried whether due or not, each slot of `sweep_fees` on its own.
- On every market, with the candidate and the router copied from the cluster, it registers a market the router never recorded, with the router's `register_existing_market` and `init_fee_account` for both mints, and creates any missing router fee account, as anyone may, so such a market is checked like the rest.
- It then resolves the accounts of a buy and a sell, quotes exact-in both ways at a tenth, a hundredth and a thousandth of the input vault and compares each quote with the deployed build's on the same state, and checks that `pipeline_market_info` gives the mints and vaults the router records.
- It runs each keeper job that this tree's rules say is due on the state as downloaded and each job the deployed build ran on the snapshot, so a candidate that narrows a rule cannot drop that job from its own test, then buys with a hundredth of the SOL vault and sells what that bought, each swap with the candidate's quote as its minimum and delivering exactly it.
- A market waiting for its seed is seeded first, as its seeder would seed it (the replay checks no signatures, and removes the mint's authorities and clears its transfer hook as a seed requires), then traded like the rest, so a build that could not seed it is refused.
- A failed step counts against the candidate unless the deployed build failed the same step, matched by kind and not by name, on the same snapshot, the failure starting in the same program: a market whose token's hook refuses the gate's trader, or whose fee recipient handed its wrapped SOL account to another owner, fails those steps under every build and cannot veto a release, while a candidate that newly fails a step, or fails it in its own code where the deployed build failed in the hook, is refused.
- The layout checks (reading the market state, finding the market, account resolution, the quotes and `pipeline_market_info`) never count as failing under the deployed build too, and run on every market whatever else fails there, so a build that would strand a market is refused even on a market whose trades are blocked.
- Both replays sign with the same keys, the payer derived from the program and each market's trader and keeper from the market, so a step whose compute depends on a PDA's bump cannot pass in one replay and fail in the other.
- A release declares a pricing change in `programs/buy-wall-amm/release.json`, committed with it, by naming the executable hash of each build whose quotes it changes, so a declaration left behind after its release stops covering anything once the build it named is no longer deployed.
- A declaration lets amounts differ, never a quote the deployed build served turn into a refusal, and a pass that relied on one is recorded only from the committed `release.json` with no uncommitted change, and counts for a deploy only while the committed file still declares it.
- A passing run against a cluster is recorded in `deployments/release-gate/buy-wall-amm/<cluster>.json` (a local validator's records are kept out of git), with every failed step that did not count and why; the deploy script accepts a build only with a record for that cluster and that executable hash, made against the build deployed there now and covering every market there now, so an upgrade or a new market since the run means running the gate again.
- It reads a cluster only through read-only JSON-RPC calls, sent with `curl`, and can send nothing; it prints and saves an RPC URL without its path, query or user part, where a provider's key sits.

#### How to run it

From the repo root, with the toolchain on `PATH` (`source scripts/toolchain-env.sh`) and the program built (`cargo build-sbf --manifest-path programs/buy-wall-amm/Cargo.toml`):

```sh
cd programs
# Replay every market on the cluster with the candidate; records the pass, or exits 1 naming
# each market and step that failed.
cargo run -p buy-wall-gate -- run --cluster devnet --candidate target/deploy/buy_wall_amm.so
# Deploy or upgrade: refused unless a passing run covers this build on this cluster now.
buy-wall-amm/scripts/deploy.sh --url devnet --so target/deploy/buy_wall_amm.so
```

- `--cluster` takes `devnet`, `localnet` or an RPC URL; `--snapshot-out <file>` keeps what was downloaded, and `cargo run -p buy-wall-gate -- check --snapshot <file> --candidate <build>` replays it again offline.
- For a release that changes pricing, set `pricing_change` in `release.json` to the builds it changes (`{ "from": ["<hash>"], "why": "..." }`, each hash from `cargo run -p buy-wall-gate -- hash <build>` or the gate's own output), and once it has deployed, set it back to `null` and re-record each fixture's baseline (its quotes and step outcomes) with the deployed build (`cargo run -p buy-wall-gate -- rerecord --fixture <file> --build <deployed build>`).
- `cargo run -p buy-wall-gate -- help` lists every command.

### Fixtures in CI

- The repo keeps a saved market state for every layout version ever deployed, taken from a real market.
- CI runs the release gate's checks on each of them against every build.
- Until the devnet deploy saves one from a real market (`cargo run -p buy-wall-gate -- snapshot --cluster devnet --out <file>`), layout version 1 is represented by three markets made by a LiteSVM run through devnet's router (one with every keeper job due, one with none, one waiting for its seed), marked synthetic, and CI keeps both once both exist ([`POOL4-20`](../decisions.md#pool4-20-the-first-layout-fixture)).
- Fixtures are snapshots in `programs/buy-wall-amm/gate/fixtures/`, without the programs: CI replays each with the pinned router and the build under test, and compares its quotes with the ones the fixture records.
- CI also builds five test builds from edited copies of the workspace, never from the program's own source ([`POOL4-44`](../decisions.md#pool4-44-how-the-gate-is-proved-to-catch-stranding)): one moving a field, one renaming the market state type with its discriminator left to Anchor, one growing the account, each of which the gate must refuse on every fixture, failing on every open market, one whose payout rule can no longer sweep fee slot 2, which it must refuse on every market the deployed build swept that slot on, and one appending a field into the reserve as layout version 2, which it must pass.
- A fixture records the deployed build's outcome of every step as a cluster snapshot does; `rerecord` records them again, and reads a fixture saved before they were recorded.

## Upgrades and freezing

- On devnet the program stays upgradeable under the project's upgrade-authority key, `~/.config/testing-pipeline/devnet/upgrade-authority.json`, as `README.md` sets for every program, and every upgrade there passes the release gate.
- Intended mainnet upgrade policy: frozen (upgrade authority removed) before any mainnet deployment, after `DESIGNER_RECIPIENT` is set.
  This departs from the shared default of a multisig with a timelock first: a market's promise is that nobody has power over it, and an upgrade key would be exactly that power, over locked liquidity, the cap and the burns.
- Carrying the policy out belongs to the mainnet launch effort.

## Custom actions and metadata

| Action | Metadata `kind` | Signer |
| --- | --- | --- |
| `seed` | `add_liquidity` | The seeder |
| `place_wall` | `other` | Anyone |
| `settle` | `other` | Anyone |
| `pay_rewards` | `claim` | Anyone (payer for a missing token account) |
| `sweep_fees` | `claim` | Anyone (payer for a missing token account) |
| `set_fee_recipient` | `other` | The fee recipient |
| `set_rewards_recipient` | `other` | The rewards recipient |

- Every action that moves the token forwards transfer-hook accounts after its own, as the template's swap does.
  Since the seed refuses a live hook ([`POOL4-48`](../decisions.md#pool4-48-a-transfer-hook-at-the-seed)), a seeded market's token never needs any, so the generic forms work for every market; the forwarding matters only to a seed attempted while a hook is live, which is refused before any transfer.
- Each instruction emits an event (market created, seeded, wall placed, settled, rewards paid, fees swept, recipient changed), and a swap emits one when it trims or lowers the cap (`Trimmed` or `CapLowered`, [`POOL4-30`](../decisions.md#pool4-30-what-a-swap-that-moves-the-cap-reports)), so Aviary's indexer can show a market's history; Aviary reads current values from the market state, not from events.
- `pipeline_seed_liquidity` is described in a top-level `seed_liquidity` form shaped as `init` is, which Pipeline's validator allows as an unknown key: the seeded market state as a `pda:` source keyed by `input:seeder`, `input:token_mint` and wrapped SOL, `data` as init's arguments under the same IDL type with the seeder marked ignored, and the vault authority and both vaults after Pipeline's fixed seed accounts, so the SDK's `resolveInit` resolves it ([`POOL4-28`](../decisions.md#pool4-28-how-metadata-describes-seeding-from-another-program)).
- The metadata follows `pipeline-strategy-metadata/1` at `5ad130d`: name, a description that credits IMD's Pool4, category `amm`, tags including `pool4`, links including `source` and the IDL, `init` as above with `market_state: new_keypair`, every action above, `security.contact`, and `conformance` pointing at a published `pipeline-check` report and its SHA-256; where they are published is in `README.md`.
- The trust flags describe programs and mints, not markets, so nothing there says a market trims or burns: the metadata declares it, and Aviary reads each market's parameters, ledgers and cap from its market state.
- Pipeline's API reports raw vault balances, so retired tokens, the buy wall, idle SOL and unpaid fees show there as liquidity; Aviary reads the ledgers instead.

## Worked example

Checked against an integer model of this file's rules, which also held every invariant in "Ledgers" over 3,000 random runs (about 957,000 swaps, 65,000 trims and 33,000 wall placements).
The build must reproduce these numbers exactly.

A market is seeded with 1,000,000 tokens of 6 decimals (1,000,000,000,000 units) and 10 SOL, with `fee_bps` 100, `wall_split_bps` 5,000, `reward_share_bps` 1,500, `cap_floor_bps` 2,000 and `cap_decay_bps` 2,000.

| Step | Result |
| --- | --- |
| Seed | `sqrt_price` 1,844,674,407,370,955,161; `liquidity` 99,999,999,999; cap 1,000,000,000,000 |
| One hour later, a buy of 1 SOL | Fee 10,000,000: designer 1,000,000, suite 1,000,000, fee recipient 4,000,000, wall 4,000,000. Out 90,081,892,629 units; `sqrt_price` 2,027,297,173,702,505,949. The cap falls by one hour's allowance to 991,666,666,667 |
| 60 seconds later, a sell of those 90,081,892,629 units | Gross 989,999,999; fee 9,900,000 (3,960,000 of it to the wall); out 980,099,999. `sqrt_price` 1,844,674,407,372,029,099. The trim retires 8,333,333,329 units and moves 83,333,332 lamports to idle SOL, leaving `liquidity` 99,166,666,666, `pool_tokens` 991,666,666,671, `pool_sol` 9,916,666,669 and `idle_sol` 91,293,332 |
| `place_wall`, in a later slot | Tip 912,933. `wall_top` 1,844,674,407,372,029,099; `wall_liquidity` 903,804,009; `wall_sol_placed` 90,380,400; `pool_sol` 10,007,047,068; 11 units of dust join the retired tokens (8,333,333,340), leaving `pool_tokens` 991,666,666,660 |
| `settle` | Burns 7,083,333,339 units; `rewards_owed` 1,250,000,001 |
| 60 seconds later, a sell of 20,000,000,000 units | Gross 196,081,138; fee 1,960,812; out 194,120,326, through the curve and the wall together. `sqrt_price` 1,808,529,293,213,661,729. The wall has spent 1,770,941 lamports on 180,633,508 units |

In the same model, on a market seeded the same way with 5 SOL idle, buying with 30 SOL, placing the wall in the next slot (it is refused in the buy's own slot) and selling everything back loses 0.595 SOL, and the wall's top ends no higher than the price before the buy.

## Aviary's panel

Aviary's buy wall AMM panel shows, per market:

- the price, the buy wall's top, the SOL in the wall and what it has bought since it was placed, and the wall's floor;
- the inventory cap against what the curve holds, the cap floor, the cap decay and the allowance built up;
- retired tokens, rewards owed, and the tokens burned so far as a share of the supply;
- the fee and its split, each fee ledger, and whether the designer share has a wallet yet;
- the market's parameters and both recipients;
- each keeper job that is due, as a button, and the recipients' handover forms;
- the create form, pre-filled with IMD's launch values and showing the whole fee split, the designer and suite shares included.

The explainer's fact table carries the same facts, and its risks for every buy wall market are: the curve thins as the cap falls, so the same trade moves the price more over time; and after a fall in price the buy wall can sit well below the price, because its floor rises only about 4% a day.
A hook that could stop trading is not among them, since the seed refuses a token whose transfer hook is still live ([`POOL4-48`](../decisions.md#pool4-48-a-transfer-hook-at-the-seed)).

## For the shared engineering bar

What `README.md` asks each product's file to add; the mainnet upgrade policy is under "Upgrades and freezing".

### Compute ceilings

Asserted per instruction in test layer 5; the build ticket measures each one and may lower it, and raising one needs a written reason here.
They start from another Pool4 port's swaps on devnet, measured at 13,000 to 29,000 units, with room for 256-bit maths.
No transfer hook runs on a seeded market's token ([`POOL4-48`](../decisions.md#pool4-48-a-transfer-hook-at-the-seed)), so they cover every transfer the strategy makes, including those of a token whose hook was cleared, which the tests measure beside SPL Token and Token-2022.

| Instruction | Ceiling (compute units) | Main cost |
| --- | --- | --- |
| `pipeline_quote` | 40,000 | Two pricing steps at most; well under the quoter's 200,000 cap |
| `pipeline_swap`, one step | 45,000 | Pricing, one output transfer, the books and the guard |
| `pipeline_swap`, crossing into the wall and trimming | 60,000 | Two pricing steps and the trim |
| `pipeline_resolve_accounts` | 10,000 | Two accounts, the output vault and the vault authority |
| `pipeline_market_info` | 10,000 | |
| `pipeline_init_market` | 120,000 | Creating two vaults |
| `seed` | 80,000 | Two transfers in and two square roots |
| `pipeline_seed_liquidity` | 180,000 | Creation plus the seed |
| `place_wall` | 50,000 | Closing and placing the wall, one transfer |
| `settle` | 30,000 | One burn |
| `pay_rewards` | 60,000 | One transfer, possibly creating the recipient's token account |
| `sweep_fees` | 60,000 | One transfer, possibly creating the recipient's token account |
| `set_fee_recipient`, `set_rewards_recipient` | 10,000 | |

Measured on 2026-11-12 by [Buy wall AMM: plain trading through the router](https://github.com/imDev2023/testing-pipeline/issues/48), on markets from 10^-7 to 10^9 lamports a unit and trades from dust to a third of a pool: `pipeline_quote` at most 15,682 units, a one-step `pipeline_swap` 14,837 to 27,630 (a hook's own compute left out), and `pipeline_resolve_accounts` 5,181 to 5,372.
The ceilings stay as they are for the wall's second step and the trim.
Measured on 2026-11-12 by [Buy wall AMM: the inventory cap](https://github.com/imDev2023/testing-pipeline/issues/49), on the same five markets: a buy that lowers the cap 22,240 to 35,480 units and a sell that trims 26,649 to 33,223, within their ceilings of 45,000 and 60,000 (a hook's own compute left out); with the cap's steps on every swap, the costliest one-step swap of the earlier measurement is now 36,396.
Measured on 2026-11-16 by [Buy wall AMM: the buy wall](https://github.com/imDev2023/testing-pipeline/issues/50), on the same five markets: `place_wall` 16,858 to 29,143 units (the most when it closes a wall that has bought tokens, on the market of 10^-7 lamports a unit), a sell that crosses into the wall and trims 41,013 to 48,388, and its quote 25,886 to 28,534; the ceilings stay as they are.
Measured on 2026-11-17 by [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55), with the floor's slot rule ([`POOL4-50`](../decisions.md#pool4-50-when-the-walls-floor-moves)), on the same five markets: `place_wall` 17,611 to 29,889 units, about 750 more for reading the Clock and bringing the floor up to date; the ceilings stay as they are.
Measured on 2026-11-16 by [Buy wall AMM: payouts and recipient handovers](https://github.com/imDev2023/testing-pipeline/issues/51), on SPL Token, Token-2022 and Token-2022 with a transfer hook, with recipients whose associated token accounts have bump 255 (a payout derives that address twice, once itself and once in the associated token program, at 1,500 units for each bump below 255, a cost of the recipient's address and not of the program): `settle` 6,894 to 8,605 units, `pay_rewards` 10,383 to 19,390 into an account that exists and 27,354 to 40,213 when it creates one (the most for the hooked Token-2022 token, the hook's own compute left out), `sweep_fees` 10,381 into an account that exists and 27,347 when it creates one, and a handover 1,590; the ceilings stay as they are.
Measured on 2026-11-17 by [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55), with the payouts sharing one helper and a handover refusing the market's own addresses ([`POOL4-52`](../decisions.md#pool4-52-which-wallets-a-role-may-be-handed-to)), on the same three tokens: `pay_rewards` 10,242 to 19,249 units into an account that exists and 27,204 to 40,063 when it creates one, `sweep_fees` 10,230 and 27,187, and a handover 3,196 (deriving the vault authority from its stored bump costs most of the rise); the ceilings stay as they are.
Measured on 2026-11-12 by [Buy wall AMM: seeding by another program](https://github.com/imDev2023/testing-pipeline/issues/53), inside the stand-in launchpad's call in LiteSVM: `pipeline_seed_liquidity` 48,850 units for an SPL Token token, 59,716 for a Token-2022 one and 65,802 for one with a transfer hook (the hook's own compute left out), and 60,847 for an SPL Token token on a local validator; its ceiling stays at 180,000, room for what later tickets add to creation and the seed.

### Invariants for test layer 3

Beyond the shared three (value conserved, every holder can exit, each quote equals its swap), checked after every step of generated sequences of swaps, keeper jobs and clock jumps, including several trades in one slot:

- Every invariant in "Ledgers".
- "Every holder can exit" means, at a price bound ([`POOL4-36`](../decisions.md#pool4-36-every-holder-can-exit-at-a-price-bound)): a holder's whole holding sells, or it pays nothing (worth less than one lamport), or it is more than the curve can take before `MIN_SQRT_PRICE` and is refused whole, as "Rules for both" says, and then the most the curve can take sells or pays nothing, and one token unit more is refused for the bound.
  A trim can leave a curve of `MIN_LIQUIDITY` close to the bound, which takes fewer tokens than some holdings; what such a holding cannot sell could only sell below the bound, for the `(L + W) × MIN_SQRT_PRICE / Q` lamports the curve and the wall keep there, which no sell reaches for anyone, with or without the cap.
  A trim lowers `L`, so it only shrinks that amount, which is less than one lamport whenever `L + W` is below 2^32.
- A trim never changes `sqrt_price`.
- A buy sold straight back never returns more than it cost, whatever keeper jobs run in between: in its own slot `place_wall` is refused, and a buy that opens its slot and is sold back after `place_wall` in a later slot with no time passed in between never returns more either.
- The reference and the floor never move on a trade in the slot they were last updated in, and `place_wall` is refused in a slot a swap has run in.
- No instruction other than `pipeline_swap` changes `sqrt_price` or the counters.

### Accepted `pipeline-check` warnings

None.
Exact-out checks are skipped by design and need no reason.
The checks that shape this design are `quote_matches_swap` (exact to the unit), `determinism` (the same quote twice, and for any trader), `round_trip` (a buy sold straight back never returns more), `dust_and_zero` (a zero input is refused) and `transaction_size` (a swap resolves two accounts, the output vault and the vault authority).
The checker sizes its trades from vault balances, which include the wall and the other ledgers; that needs no special handling.

## Where it differs from IMD's Pool4

| | IMD's hook | The buy wall AMM |
| --- | --- | --- |
| Fee | 1%, on whichever token comes in | Chosen per market, 0.25% to 3%, always in SOL |
| Who gets the fee | The hook's owner | 10% IMD and Adam, 10% us, the rest the market's fee recipient and buy wall |
| Owner powers | Close the market, withdraw the position, the wall's SOL and the fees, change every parameter | None; a recipient may hand over its own role |
| Reward share | To IMD's stakers, bonding reserve and nodes | To one rewards recipient per market |
| Rates for the wall's guard | Per block | Per second |
| Decay allowance while idle | Unlimited | One day |
| Burns | Bridged to Base | Native |
| Trim and payouts inside a swap | Held as claims, settled later | Booked in ledgers, paid by keeper jobs |

## Building it

- Generate the program from Pipeline's Apache-2.0 strategy template with `scripts/new-strategy.sh`, from a scratchpad clone at `5ad130d`, and pin the Pipeline crates to `rev = "5ad130d"`, as for the tax AMM.
- Replace the template's Borsh-decoded pool account with the fixed-size, zero-copy market state above.
- Keep the pricing, the cap and the wall's guard in pure functions that take no accounts, so the proofs and the worked example run against them directly.
- Keep the program keypair in `~/.config/testing-pipeline/devnet/`, never in the repo.
- Build and test with the toolchain in `docs/toolchain.md` (`source scripts/toolchain-env.sh`).

### Build tickets

Cut by [Cut Pool4 for Solana's build tickets](https://github.com/imDev2023/testing-pipeline/issues/24) on 2026-11-10, labelled `build`, one session each, in run order:

1. [Buy wall AMM: a market opens](https://github.com/imDev2023/testing-pipeline/issues/47): the program from the template, the fixed-size market state and its byte offsets, creation, the mint rules and the seed.
2. [Buy wall AMM: plain trading through the router](https://github.com/imDev2023/testing-pipeline/issues/48): curve pricing both ways, the fee and its split, the ledgers and counters, and `pipeline-check` clean.
3. [Buy wall AMM: the inventory cap](https://github.com/imDev2023/testing-pipeline/issues/49): the ratchet, the decay credit and the trim.
4. [Buy wall AMM: the buy wall](https://github.com/imDev2023/testing-pipeline/issues/50): two-step pricing, the guard and `place_wall`.
5. [Buy wall AMM: payouts and recipient handovers](https://github.com/imDev2023/testing-pipeline/issues/51): `settle`, `pay_rewards`, `sweep_fees` and both handovers.
6. [Buy wall AMM: seeding by another program](https://github.com/imDev2023/testing-pipeline/issues/53): `pipeline_seed_liquidity` with a stand-in launchpad; it can run beside tickets 3 to 5.
7. [Buy wall AMM: the release gate and layout fixtures](https://github.com/imDev2023/testing-pipeline/issues/54): the gate, the fixtures and their CI job, and tests that show it refusing a build that would strand a market.
8. [Buy wall AMM: hardening](https://github.com/imDev2023/testing-pipeline/issues/55): the hardening ticket, before the first deploy, so the registered bytes are hardened and the layout freezes once.
9. [Buy wall AMM: deploy on devnet, register with Pipeline and run a demo market](https://github.com/imDev2023/testing-pipeline/issues/56): the end of the program's chain, with the whole lifecycle on devnet and one upgrade through the release gate on a live market.
10. [Buy wall AMM: Aviary panel and forms](https://github.com/imDev2023/testing-pipeline/issues/57): after the deploy and Aviary's own build tickets.

The first waits for the tax AMM's first build ticket, which sets up the on-chain workspace, CI, the router fixture and the review skills.
Tickets 1 to 8 are verified end to end through the real router copied from devnet, in LiteSVM; ticket 9 runs every check in "Done means" on devnet itself.

### Done means

- LiteSVM tests through the real router cover:
  - pricing both ways above, across and inside the wall, and quotes matching swaps in each;
  - the fee and its split at the lowest, a typical and the highest rate, with every wall split from none to all;
  - the trim leaving the price unchanged, and `MIN_LIQUIDITY` stopping one;
  - the ratchet with its decay credit, its one-day limit and the cap floor, and the ratchet switched off;
  - the wall's reference ignoring trades in the same slot, and its floor's crawl;
  - pumping the price, placing the wall and dumping never profiting;
  - each keeper job, its refusals and its rounding, with a frozen or missing recipient account never blocking trading or the other payouts;
  - both recipient handovers and every refusal by anyone else;
  - refusal of exact-out, of bypass, of every refused mint extension and of live mint or freeze authorities;
  - a token with a live transfer hook (Pipeline's `test-hook`, its program or its authority still set) refused at the seed by both seeding paths, and one whose hook was cleared through the seed, swaps and `pay_rewards`;
  - donations never credited, and the counters;
  - seeding by another program at the seeder-scoped address.
- The worked example's numbers are reproduced exactly.
- `pipeline-check` passes every check on a seeded market with no warning (with `exact_out_refund` skipped), both in the tests and against devnet.
- The release gate script exists, runs in CI against the fixtures, and has passed against devnet before every upgrade there.
- On devnet:
  - the program deployed and registered with the router's `register_strategy`, with its metadata and conformance report published;
  - one market created with a fresh test token, seeded, and traded both ways through the router;
  - a sell that trims, the wall placed and then sold into, a settle that burns, rewards paid and fees swept, with slot 1 refused while `DESIGNER_RECIPIENT` is unset.
- Its Aviary panel and forms, as `README.md` asks of every product.
- Whatever else `README.md` requires of our on-chain programs.
