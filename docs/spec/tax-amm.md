# Tax AMM

Decided in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19) on 2026-11-10 with the owner, against Pipeline commit `5ad130d` (its strategy template, conformance checker, metadata standard and trust facts).
It builds on the findings of [How the containment hook works with the router and unlocks](https://github.com/imDev2023/testing-pipeline/issues/10) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/containment-hook-mechanics/research/containment-hook-mechanics.md)).
The owner made the tax AMM the first product to build (2026-11-10), to be deployed on devnet and registered with Pipeline, which is what MetalLegBob asks builders for.
MetalLegBob is not building it himself ([Record MetalLegBob's answers to the follow-up DM](https://github.com/imDev2023/testing-pipeline/issues/27)), so it stays in scope.
The shared engineering and security bar for our programs lands in `docs/spec/README.md`, from [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4); this file adds only what is particular to the tax AMM.
[Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23) cut the build tickets from this file on 2026-11-10 and added what the bar asks of each product's file: "In Aviary", and under "Building it" the order of the build, where its policy values live, the compute ceilings, the invariants, and the `pipeline-check` and Canary warns.
Terms are as in `GLOSSARY.md`: tax market, tax side, buy tax, sell tax, tax authority, tax recipient, suite share, virtual reserve.

## What it is

- A Pipeline strategy whose markets always take their tax in one chosen mint, the tax side, whichever way a trade goes.
- Pricing is constant product, and the tax is taken outside the curve, so a trader pays the tax while trading at the curve's price, and the curve's price stays the market's fair price.
- Liquidity is seeded once and locked for good: no LP shares, no adding or removing, no LP fee.
- Tax builds up in the market's own vault and anyone can pay it out to the market's tax recipients, the burn and the suite share.
- It is built to pair with the containment hook (its market state counts the volume and tax the unlock may need), but works for any two mints that pass its mint rules.

## Not in v1

- Exact-out swaps.
- LP shares, adding liquidity after the seed, or withdrawing liquidity.
- Automatic taxes that move with volatility or volume; rates change only when the tax authority changes them.
- Moving the tax authority to another address; it can only renounce.
- Markets with more than two mints.
- Quote mints with extensions outside the allowlist below, such as PYUSD (permanent delegate, transfer fee configuration, confidential transfers).
- Mainnet: nothing deploys there before Pipeline's router does, and the program is frozen first (see "Upgrades and freezing").

## Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `MAX_TAX_BPS` | 1000 (10%) | The highest buy or sell tax any tax market may ever charge, so no tax market can be a honeypot through its tax |
| `SUITE_SHARE_BPS` | 1000 (10% of the tax) | The suite share, taken from every tax before the creator's split |
| `SUITE_TREASURY` | set at build time | The wallet the suite share is paid to; on devnet a wallet whose key is in `~/.config/testing-pipeline/devnet/` |
| `MAX_RECIPIENTS` | 4 | Tax recipients per market |

The constants are compiled into the program; changing one is a program upgrade, which ends when the program is frozen.

## Markets

### Shape

- Exactly two mints, in the order the creator gives them (index 0 and 1), which is the order `pipeline_market_info` reports.
- The mints must differ, and each must be owned by SPL Token or Token-2022 and pass the mint rules below.
- The tax side is one of the two indexes, chosen by the creator and fixed for the market's life.
- Aviary's launch form defaults the tax side to the quote mint (SOL or USDC), so recipients are paid in SOL or USDC rather than in the token they would sell.

### Addresses

- The market state is a fresh keypair the creator generates and signs with (metadata `init.market_state` is `new_keypair`).
  Pipeline's template keys a pool by its parameters instead, but a tax market's parameters (rates, bounds, authority, seeder, four recipients and their shares, the burn share, the virtual reserve) are far more than the 15 seeds a metadata `pda:` source allows, and a key derived from only some of them could be taken first by a market with the same seeds and bad parameters.
  A fresh keypair can't be taken by anyone else; if someone pre-funds it, the creation fails and the creator retries with another keypair, as Pipeline's guide describes.
  Checked against devnet's router in LiteSVM on 2026-11-12 (`programs/tax-amm/tests/hostile.rs`): once the address holds lamports the router passes it on unsigned, the program's account creation fails with a signer privilege escalation, and the whole `create_market` fails, leaving only the lamports; the same creation with a fresh keypair succeeds.
- The vault authority is the PDA `["authority", market_state]` of the tax AMM program; it signs every transfer and burn out of the vaults.
  So `pipeline_resolve_accounts` lists it, read-only, after the output vault: a swap's transfer out of the vault needs it among the swap's accounts ([Tax AMM: seed a market and trade it](https://github.com/imDev2023/testing-pipeline/issues/60), 2026-11-12).
- Each vault is a token account at the PDA `["vault", market_state, mint]`, owned by the vault authority.
  `pipeline_init_market` creates both itself, after every rule below has passed, so a refused mint meets the rule that refuses it rather than a vault creation that can't read it (Anchor's own vault constraints read the mint first and fail on an extension they don't know); each is sized by its mint's token program (`GetAccountDataSize`), which leaves room for a hooked mint's account extension.
  Lamports someone sent to a vault's address beforehand stay in it without blocking the creation; on a native SOL vault the token program turns them into wrapped SOL, a donation the market never counts (see "Locked for good").
  Metadata describes both as `pda:` sources keyed by `market_state` and `input:mint_0` or `input:mint_1`, which the SDK resolves before the market exists.
- So the vaults and the router's market and fee accounts can all be computed from the keypair's address before `create_market` is sent, which the containment hook needs to bind a home market before its first deposit.
- Markets created through `pipeline_seed_liquidity` instead live at the PDA `["seeded", seeder, mint_0, mint_1]`, as Pipeline's guide asks, with vaults and authority derived from that address in the same way.

### Creation parameters

`init_data` is the Borsh encoding of these fields, in this order (metadata `init.args` lists them the same way, because metadata arguments have no arrays or options):

| Field | Type | Rule |
| --- | --- | --- |
| `tax_side` | u8 | 0 or 1 |
| `buy_tax_bps` | u16 | Within its range |
| `sell_tax_bps` | u16 | Within its range |
| `buy_tax_min_bps`, `buy_tax_max_bps` | u16 | min ≤ max ≤ `MAX_TAX_BPS` |
| `sell_tax_min_bps`, `sell_tax_max_bps` | u16 | min ≤ max ≤ `MAX_TAX_BPS` |
| `tax_authority` | pubkey | The default (all-zero) key means none, so the market's taxes and recipients never change |
| `seeder` | pubkey | The only signer the seed action accepts; must not be the default key |
| `recipient_0` to `recipient_3` | pubkey | Owner wallets; used slots first, unused slots the default key |
| `share_0` to `share_3` | u16 | Each used slot's share in basis points of the creator's part, above 0; unused slots 0 |
| `burn_share_bps` | u16 | The burn's share of the creator's part; 0 if the tax side is either native SOL mint (SPL Token's or Token-2022's), since SOL can't be burned |
| `virtual_side` | u8 | 0 or 1 |
| `virtual_reserve` | u64 | 0 for none |

- There is at least one recipient, and the used shares plus `burn_share_bps` sum to exactly 10,000.
- Each rule refuses with an error of its own (`programs/tax-amm/src/errors.rs`), so Aviary's launch form can say which rule a market breaks; a mint refused for an extension is also logged with Token-2022's number for that extension.
- `pipeline_init_market` refuses anything that breaks a rule, checks that the market signer is the router's PDA `["market", program, market_state]` and stores it, creates the vaults, and records the creation slot and Unix time.
- `pipeline_seed_liquidity` takes the same fields in `SeedRequest.data`, with `seeder` ignored because the calling program's PDA is the seeder.

### Mint rules

- A Token-2022 mint may carry only these mint extensions: transfer hook (any hook program), metadata pointer, token metadata, group pointer, group member pointer, token group and token group member.
- Every other mint extension is refused at creation, including transfer fee, permanent delegate (it could take tokens out of the vaults), confidential transfers, pausable, default account state, non-transferable, mint close authority, interest-bearing, scaled UI amount and permissioned burn, as well as any extension the program doesn't recognise.
- Mint and freeze authorities are allowed, since USDC has both; Aviary shows them.
- In Pipeline's trust flags this means a tax market's mints can only ever show `token-2022`, `mint-authority`, `freeze-authority`, `transfer-hook` and `transfer-hook-authority`; a contained token shows the last two until its unlock clears both.
- The trust flags describe strategy programs and mints, not markets, so no flag ever says a market is taxed: the strategy metadata declares it (category `amm`, tag `tax`) and Aviary reads each market's rates, bounds, authority and recipients from its market state.

### Creating a market

One transaction, as Pipeline's guide recommends:

1. The router's `create_market` with the creation parameters, signed by the creator and the market state keypair.
2. The router's `init_fee_account` for each of the two mints.
3. The tax AMM's `seed` action, signed by the seeder.

A launchpad graduating a token instead calls `pipeline_seed_liquidity`, then the router's `register_existing_market` and `init_fee_account` for each mint, in one transaction.

How big that transaction is, against a transaction's 1,232 bytes without an address lookup table, with the creator as the seeder, measured on 2026-11-12 by [Tax AMM: seed a market and trade it](https://github.com/imDev2023/testing-pipeline/issues/60) (`programs/tax-amm/tests/seed.rs`, as a legacy transaction):

- 1,210 bytes for two SPL Token mints or two Token-2022 mints; the demo script's version 0 transaction is 2 bytes longer, 1,212.
- 1,242 bytes for one of each, and 1,308 with a hooked mint (Pipeline's `test-hook`, which adds the fewest accounts a hook can); a seeder other than the creator adds 96 bytes.
- So a market pairing a Token-2022 token with SOL or USDC, and every contained token's home market, needs an address lookup table for its creation transaction, or sends the seed as a second transaction (the market refuses every swap until then); that choice belongs to [Tax AMM in Aviary: the launch form and the tax panel](https://github.com/imDev2023/testing-pipeline/issues/75).

## Liquidity

### The seed

- `seed { amount_0: u64, amount_1: u64 }` is a custom action signed by the market's `seeder`, from token accounts the seeder owns, allowed once and only before any swap.
- Each side's real amount must be above 0, except the virtual side when `virtual_reserve` is above 0, where it may be 0; that is how a token launches single-sided, with only the token deposited.
- The market records each side's real reserve from what actually arrived in its vault, and opens for swaps.
- Until the seed, quotes and swaps are refused (`pipeline-check` reports this as a warning, as it does for any market not yet open).
- `pipeline_seed_liquidity` seeds and opens the market in the same call, taking at most `amounts[i]` from each escrow, and returns `SeedResult { taken, lp_amount: 0 }`.

### Locked for good

- There is no instruction that takes liquidity out of a market, and no LP shares, so nobody, the creator and us included, can pull liquidity.
- Tokens sent to a vault outside a swap or the seed are donations: they are never credited as input, never paid out, and stay in the vault.

### Virtual reserve

- Pricing treats the virtual side as holding its real reserve plus `virtual_reserve`.
- A swap can never pay out more of a side than its real reserve; a quote or swap that would is refused.
- The virtual reserve is never paid out and never changes.
- `pipeline-check` sizes its trades from vault balances, so checks on a market with a virtual reserve pass explicit `--amounts`.

## Pricing and the tax

Exact-in only: `pipeline_market_info` reports `supports_exact_out = false` (the template's `SUPPORTS_EXACT_OUT` set to `false`), and an exact-out quote or swap is refused.

For a trade from side `i` to side `o`, with real reserves `R_i`, `R_o`, effective reserves `E` (the real reserve plus `virtual_reserve` on the virtual side) and credited input `a`:

- **Buy tax** (the tax side is `i`): `tax = ceil(a × buy_tax_bps / 10,000)`, `c = a - tax`, `out = floor(E_o × c / (E_i + c))`.
  The trader receives `out`; afterwards `R_i += c` and `R_o -= out`.
- **Sell tax** (the tax side is `o`): `g = floor(E_o × a / (E_i + a))`, `tax = ceil(g × sell_tax_bps / 10,000)`, `out = g - tax`.
  The trader receives `out`; afterwards `R_i += a` and `R_o -= g`, and the tax stays in the tax-side vault.
- Intermediate maths is in u128; the tax rounds up and curve output rounds down, so the product of the effective reserves never falls.
- A quote or swap is refused when `out` is 0, or when the curve would pay out more of `o` than `R_o`.
- `pipeline_quote` and `pipeline_swap` call the same pricing function, so quotes include the tax and match swaps exactly, which `pipeline-check`'s `quote_matches_swap` verifies.
- Rates are read at the time of the swap: a rate change applies from the next swap, and a trader's minimum output protects against a change between quote and swap.

### Credited input

- Input is credited with Pipeline's `credited_input`: what the input vault holds beyond what the market has recorded there, capped at what the router sent.
- What the market has recorded in a vault is its real reserve, plus all tax owed if it is the tax-side vault.
- The input stays in the input vault for the whole swap, as Pipeline's guide asks; tax taken from input is only booked as owed.

### Bypass

- Refused: `pipeline_swap` accepts only the router's market signer stored at creation (the template's default).
- So every trade pays Pipeline's fee, emits a swap event and counts in the market's counters.
- No custom action moves the price.

## Taxes

### Rates

- A buy tax and a sell tax, each in basis points, each between 0 and `MAX_TAX_BPS`.
- Each side also has a range, `[min, max]`, fixed at creation inside `[0, MAX_TAX_BPS]`; the rate can only ever move inside it.

### Tax authority

- The tax authority, if the market has one, may sign:
  - `set_taxes { buy_tax_bps, sell_tax_bps }`, each inside its fixed range;
  - `set_recipients { recipient_0..3, share_0..3, burn_share_bps }`, under the same rules as at creation;
  - `renounce_tax_authority`, after which the market's taxes and recipients never change again.
- Changes take effect immediately.
- Nobody else can change anything about a market, us included; the program has no admin.

### Where the tax goes

- From every tax, the suite share comes first: `floor(tax × SUITE_SHARE_BPS / 10,000)`, owed to `SUITE_TREASURY`.
- The rest is the creator's part, split by the market's shares: each recipient `floor(rest × share / 10,000)`, the burn `floor(rest × burn_share_bps / 10,000)`, and any rounding remainder to the first recipient.
- Aviary's launch form shows creators the whole split, the suite share included.

### Payout

- Tax is never paid out during a swap: it is booked as owed per slot (recipients 0 to 3, the burn, the suite share) and stays in the tax-side vault.
  - A recipient account that was closed or frozen would otherwise make every swap fail, turning the market into a honeypot.
  - Swaps then need no recipient accounts.
  - Under the containment hook the home market's vault is the only account allowed to pay out a contained token, so tax held anywhere else would be stuck.
- `distribute { slot }` is permissionless: anyone may call it, at any time, for one slot.
  - The slots are numbered as the market state books them: 0 to 3 the tax recipients, 4 the burn and 5 the suite share.
    A slot number above 5 is refused (`NoSuchSlot`), and so is a recipient slot the market does not use, which has no wallet to pay (`UnusedSlot`).
  - A recipient or the suite share is paid its whole owed amount to the associated token account of its wallet for the tax-side mint, which the instruction creates if missing, at the caller's expense.
    For native SOL that account holds wrapped SOL, which the recipient unwraps by closing it (Aviary offers this).
  - The burn slot burns its owed amount from the vault.
  - A slot owed nothing moves nothing, creates no account and emits no event; any other payout emits a distributed event with the slot, its wallet and the amount.
  - Each slot is paid separately, so one broken recipient account never holds up the others: a frozen recipient account fails only its own slot's `distribute`, swaps go on booking tax to the slot, and it pays out once the account is thawed ([Tax AMM: pay the tax out with distribute](https://github.com/imDev2023/testing-pipeline/issues/61), 2026-11-12).
- Its accounts are the caller, who signs and pays for a missing token account, the market state, the vault authority, the tax-side vault and mint, the slot's wallet, that wallet's associated token account for the tax-side mint, the tax-side token program, the associated token program and the system program, then the tax-side mint's transfer-hook accounts.
  - The slot's wallet is its tax recipient, `SUITE_TREASURY` for the suite share, and the default key for the burn, which pays no wallet.
  - Refused: any other wallet (`NotSlotWallet`); any token account but that wallet's associated token account, including one of the other mint and one whose owner the wallet has handed to someone else, which SPL Token allows (`NotSlotTokenAccount`); the other vault, another vault authority and the other mint passed as the tax-side mint (`WrongAccount`).
  - Metadata sources can't name a mint by the market's tax side or a wallet held in the market state, so the metadata's `distribute` action takes both as inputs, `tax_mint` and `recipient`, from which it derives the vault and the token account; Aviary's tax panel, the keeper runner and the demo script read them from the market state, and the program refuses any that are not the slot's.
  - `SUITE_TREASURY` is published in the IDL beside `MAX_TAX_BPS` and `SUITE_SHARE_BPS`, so the generated client carries the suite share's wallet.
- Owed amounts belong to slots: if the tax authority changes a slot's recipient, what the slot is owed goes to the new recipient, so a recipient leaving should be paid out first (anyone can call `distribute`).
- Owed amounts fit in u64, because together with the real reserve they never exceed the vault's balance.
- Pipeline's API reports raw vault balances, so tax not yet paid out shows there as liquidity; Aviary reads the real reserves from the market state instead.

## Counters for the containment hook

The market state keeps these totals, changed only by `pipeline_swap` calls signed by the market signer, never by custom actions:

| Field | Type | Adds, per swap |
| --- | --- | --- |
| `volume[0]`, `volume[1]` | u128 | For the input mint, the credited input (what arrived in the vault, the swap event's `net_sent`); for the output mint, what the trader was paid (the swap event's `received`) |
| `tax_collected` | u128 | The swap's tax, in the tax-side mint |
| `swap_count` | u64 | 1 |

With the creation slot and time, the fixed tax ranges and the tax side, that is everything [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18) might measure an unlock goal by (volume, tax paid, age, or a minimum tax), so the hook can choose without changing the tax AMM.
The market state starts with an 8-byte account discriminator and a version byte, and these fields sit at fixed offsets that later versions never move, because the hook reads them directly.
The build fixes the offsets in the ticket that creates markets, publishes them as constants in the tax AMM's crate and pins them with a test, so the two programs cannot drift apart unnoticed.
[Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59) fixed them on 2026-11-12: the market state is 596 bytes, the tax side is the byte at offset 10 and `tax_collected` the little-endian u128 at offset 460, published as `state::layout::TAX_SIDE`, `TAX_COLLECTED` and `LEN` and pinned with every other field's offset by `programs/tax-amm/tests/layout.rs`.
Besides the fields this file names, the market state holds its status (created; the seed adds open), the vault authority's bump, a flag set when the tax authority renounces, so Aviary can tell a renounced market from one created without an authority, and 64 zero bytes at the end, so a later version can add a field without moving any or reallocating existing markets.
Containment hook policy chose `tax_collected`: the unlock reads it, a home market's tax side must be the quote mint, and no minimum tax is needed, because the goal counts tax and not volume (`docs/spec/containment-hook.md`, "Unlock goal").

## Custom actions and metadata

| Action | Metadata `kind` | Signer |
| --- | --- | --- |
| `seed` | `add_liquidity` | The seeder |
| `distribute` | `claim` | Anyone (payer for a missing token account) |
| `set_taxes` | `other` | The tax authority |
| `set_recipients` | `other` | The tax authority |
| `renounce_tax_authority` | `other` | The tax authority |

- Every action that moves tokens forwards transfer-hook accounts after its own, as the template's swap does.
- Each instruction emits an event (market created, seeded, taxes changed, recipients changed, authority renounced, distributed) so Aviary's indexer can show a market's history; Aviary reads current values from the market state, not from events.
- The metadata follows `pipeline-strategy-metadata/1` at `5ad130d`: name, description, category `amm`, tags including `tax`, links including `source` and the IDL, `init` as above with `market_state: new_keypair`, every action above, `security.contact`, and `conformance` pointing at a published `pipeline-check` report and its SHA-256.
- `security.contact`, and the contact in the program's `security.txt`, is this repo's private vulnerability reporting page on GitHub, never a personal address.
- The Anchor IDL is committed at `programs/tax-amm/idl/tax_amm.json`, which `links.idl` names, and the TypeScript client in `programs/tax-amm/scripts/client/` is generated from it with Codama; tests fail when the IDL disagrees with the program or the metadata, and `pnpm typecheck` fails when the client disagrees with the IDL.
  Pipeline's interface crate types don't derive Anchor's traits, which the IDL needs, so the program declares the same Borsh types for its instruction arguments (`interface.rs`), tested to encode exactly as Pipeline's.

## In Aviary

`docs/spec/README.md` has each product add its own panel and forms to Aviary; these are the tax AMM's, built with its build tickets once Aviary's own pages exist.
Everything here is read from the market state and the strategy metadata, and nothing gives a tax market a badge or a better place in the feed.

- **Actions from metadata**: `seed`, `distribute`, `set_taxes`, `set_recipients` and `renounce_tax_authority` are rendered by Aviary's generic custom-action forms from the strategy metadata, like any strategy's.
- **Launch form**, the tax AMM's own form on the create-market page:
  - the tax side defaults to the quote mint (SOL or USDC);
  - it shows the whole split before signing: the suite share first, then each tax recipient and the burn;
  - it builds the creation transaction of "Creating a market" (`create_market`, `init_fee_account` for each mint, then `seed`), simulated before the wallet signs like every transaction Aviary builds;
  - it refuses, with the reason, a mint the mint rules would refuse and a mint whose transfer hook is the containment hook (`docs/spec/containment-hook.md`, "Launch in v1").
- **Tax panel**, on a tax market's page:
  - the tax side, the buy tax and the sell tax, each with its fixed range;
  - the tax authority, or that the market has none or that it renounced, in which case the rates and the tax recipients can never change;
  - the tax recipients with their shares, the burn share and the suite share;
  - the tax collected so far, and what each slot is owed and not yet paid out, with a button per slot that sends `distribute`;
  - the real reserves and the virtual reserve from the market state, since raw vault balances include tax not yet paid out.
- The trade box needs nothing of its own: the tax is inside the quote, as `docs/spec/pipescope.md` says of every strategy's own fees, and the panel shows the rates beside it.
- The wallet page's offer to unwrap wrapped SOL covers tax recipients paid in SOL.

## Upgrades and freezing

- On devnet the program stays upgradeable, with its upgrade authority in `~/.config/testing-pipeline/devnet/`.
- It is frozen (upgrade authority removed) before any mainnet deployment, because the containment hook's unlock will trust its counters and the vaults hold locked liquidity.
- The general upgrade policy is in `docs/spec/README.md`.

## Building it

- Generate the program from Pipeline's Apache-2.0 strategy template with `scripts/new-strategy.sh`, from a scratchpad clone at `5ad130d`, and pin the Pipeline crates to `rev = "5ad130d"` in `Cargo.toml`; the template is code Pipeline means builders to copy, unlike the router (owner, 2026-11-10).
- Keep the program keypair the template creates in `~/.config/testing-pipeline/devnet/`, not `~/.config/pipeline/keys/`, and never in the repo.
- Build and test with the toolchain in `docs/toolchain.md` (`source scripts/toolchain-env.sh`).

### Order of the build

Decided with the owner on 2026-11-10 in [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23).

- **Local first, devnet last.**
  Until its last feature ticket, the tax AMM is verified by the LiteSVM tests through devnet's real router bytes and by the demo script run against a local validator that runs devnet's router.
  Only the devnet ticket deploys and registers it, so a half-built strategy never appears in Pipeline's registry and no demo market is stranded by a change to the market state.
- **Deploy, then harden.**
  The hardening ticket comes after the devnet ticket, as the bar's last ticket for the program.
  If it changes the program, it redeploys from a verified build, repeats the devnet demo and republishes the metadata and the conformance report.
- **The name.**
  The strategy registers as Aviary Tax AMM (`docs/spec/README.md`, "Names").
  A later change of name is one `update_metadata` call and a rebuild for the `security.txt`; the crate, the program id and the markets keep theirs.
- The demo script grows with each ticket and builds every market creation and custom action from the strategy metadata with the SDK's generic builders, as Aviary will, so the metadata is tested from the first ticket on.

### Where its policy values live

The owner's standing rule of 2026-11-10 keeps every decision cheap to change, since each is a default MetalLegBob may change.

- The four values of "Constants" are build-time constants in one config module of the program, and no other file repeats them.
  `MAX_TAX_BPS`, `SUITE_SHARE_BPS` and `SUITE_TREASURY` are also published in the program's IDL (Anchor's `#[constant]`), so the TypeScript client generated from it carries them for Aviary's launch form and tax panel and the demo script, rather than any of them restating one.
- The mint extension allowlist of "Mint rules", and the check that applies it, live in one small library crate of the on-chain workspace.
  The tax AMM, the containment hook, the buy wall AMM and the lending AMM all depend on that crate, so there is one list and never a second copy; a product with a stricter rule adds it on top.
  The crate is `programs/mint-rules`; it depends on nothing and reads a mint's extension entries itself, the way Token-2022 lays them out, so an extension Token-2022 adds after the crate was written is refused by its number rather than misread.
- Both are fixed on-chain because traders rely on them, so they can change until a program is frozen and not after.
- Every other policy value is a creation parameter, chosen per market and held in its market state: the rates, their ranges, the tax authority, the tax recipients and their shares, the burn share and the virtual reserve.
- The public name, Aviary Tax AMM, lives only in the strategy metadata's `name` and in the `name` of the embedded `security.txt` (`docs/spec/README.md`, "Names").
- The compute ceilings live in the table below and in one test module that mirrors it.
- The demo markets' parameters live in one named block of the demo script.

### Compute ceilings

Tests assert the measured cost of each instruction with headroom, never above these ceilings.
A cost is what the tax AMM's own invocation consumes, its token program calls included, measured on mints without a transfer hook; a hook's cost is the hook's own to bound.

| Instruction | Ceiling (CU) | Why |
| --- | --- | --- |
| `pipeline_quote` | 25,000 | Integrators and Canary quote constantly, and the quoter's own cap is 200,000 |
| `pipeline_swap` | 60,000 | With the router's share and a hooked mint's transfers on top, a swap must stay well under the 200,000 at which `pipeline-check`'s `compute` check warns |
| `pipeline_market_info`, `pipeline_resolve_accounts` | 15,000 each | Read-only, and called for every account resolution |
| `pipeline_init_market` | 120,000 | Creates two vaults and reads both mints' extensions |
| `pipeline_seed_liquidity` | 150,000 | Creates the market state and two vaults and takes from two escrows, inside a launchpad's own instruction, which needs compute too |
| `seed` | 80,000 | Two transfers in |
| `distribute` | 90,000 | One transfer or burn, and creating the recipient's token account when it is missing |
| `set_taxes`, `set_recipients`, `renounce_tax_authority` | 20,000 each | They only write the market state |

### Invariants

For the bar's stateful fuzzing layer, beyond its shared three:

1. Each vault holds at least the market's real reserve of its mint, plus everything owed when it is the tax-side vault; donations only ever add to the surplus.
2. A swap never lowers the product of the effective reserves, never pays out more of a side than its real reserve, and never changes the virtual reserve.
3. Every tax is split exactly: the suite share, the tax recipients' parts and the burn add up to the tax, and `tax_collected` always equals what has been paid out or burned plus what is still owed.
4. No rate ever leaves its range or passes `MAX_TAX_BPS`, and nothing fixed at creation ever changes: the mints, the tax side, the ranges, the seeder and the virtual reserve.
5. After the seed, only router swaps change the real reserves, and only router swaps ever change the counters; `distribute` moves at most what its slot is owed.
6. The counters never fall.
7. Once the tax authority has renounced, or on a market created without one, the rates and the tax recipients never change.

### `pipeline-check` warns

- None is accepted on a seeded market: the tests and the devnet demo require zero Fail and zero Warn, with `exact_out_refund` skipped because exact-out is refused by design.
- A market that is created but not yet seeded refuses every quote, which `pipeline-check` reports as a `quotes` warn; that is the state between two instructions of one creation transaction, never a demo market's.
- A market with a virtual reserve is checked with explicit amounts, as "Virtual reserve" says.

### Canary checks

The bar asks our strategies to pass Canary checks on devnet: no fail on any market, with every warn named here (`docs/spec/pipescope-canary.md`, "Outcomes").

- `cost`, and `exit_queue`, which shares its bands: a warn whenever the buy tax, the sell tax and the Pipeline fee on both legs take the ordinary trade's round-trip return under 95%, which is whenever the two taxes together pass about 4.5%.
  That is the market's stated tax, shown in its panel, and not a hidden cost.
  The tax alone can never make it a fail: with both taxes at `MAX_TAX_BPS` the round trip still returns about 80%.
- `token_authorities`: a warn while a mint of the market keeps an authority that could act on holders, such as a launcher's mint authority or USDC's freeze authority; that is a fact about the mint, which the tax AMM allows and Aviary shows.
- `custom_instructions` notes `seed`, `distribute`, `set_taxes`, `set_recipients` and `renounce_tax_authority`; Canary lists them and does not call them, so a tax authority changing rates inside its range is not exercised.
- On the home market of a contained token, the containment hook's own warns apply as well (`docs/spec/containment-hook.md`, "Canary checks").
- No other check may warn or fail on a tax market we create.

### Build tickets

Cut by [Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23) on 2026-11-10, labelled `build`, one session each, in run order:

1. [Tax AMM: Pipeline's strategy template in our repo, with CI and a local demo run](https://github.com/imDev2023/testing-pipeline/issues/58): the on-chain workspace, the pins, the fixtures, CI, the review skills and the demo script, with the template's own pricing.
2. [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59): the market state and its pinned offsets, the creation parameters and their rules, the mint rules and the metadata's `init`.
3. [Tax AMM: seed a market and trade it with buy and sell tax](https://github.com/imDev2023/testing-pipeline/issues/60): `seed`, the pricing with both taxes, the virtual reserve, credited input, the tax booked per slot, and the counters.
4. [Tax AMM: pay the tax out with distribute](https://github.com/imDev2023/testing-pipeline/issues/61): `distribute` for tax recipients, the suite share and the burn.
5. [Tax AMM: the tax authority](https://github.com/imDev2023/testing-pipeline/issues/62): `set_taxes`, `set_recipients` and `renounce_tax_authority`.
6. [Tax AMM: seeding from another program](https://github.com/imDev2023/testing-pipeline/issues/63): `pipeline_seed_liquidity`, with a stand-in launchpad.
7. [Tax AMM: proofs of the pricing, tax and split maths](https://github.com/imDev2023/testing-pipeline/issues/64): the property list chosen with Book of Knowledge, proven with Kani, Z3 and Proptest.
8. [Tax AMM: invariant fuzzing across every instruction](https://github.com/imDev2023/testing-pipeline/issues/65): the stateful fuzzer and its ten invariants, and every compute ceiling asserted.
9. [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66): the first devnet deploy, with everything in "Done means" shown on devnet.
10. [Tax AMM: hardening ticket](https://github.com/imDev2023/testing-pipeline/issues/67): the hardening ticket, after the deploy.
11. [Tax AMM in Aviary: the launch form and the tax panel](https://github.com/imDev2023/testing-pipeline/issues/75): after the deploy and Aviary's own build tickets.

Tickets 4 to 7 can run side by side once ticket 3 has merged.
Tickets 1 to 8 are verified by LiteSVM tests through the real router copied from devnet and by the demo script on a local validator; ticket 9 is the first to touch devnet.
The buy wall AMM and the containment hook start from what ticket 1 sets up.

### Done means

- LiteSVM tests through the real router cover: the tax maths both ways at 0, typical and maximum rates; the cap and the ranges; the tax authority's three actions and every refusal by anyone else; renounced markets; the split and its rounding; `distribute` for each slot, including a frozen recipient account not blocking others and burning; the virtual reserve and its real-reserve limit; refusal of exact-out, of bypass and of every refused mint extension; donations not credited; and the counters.
- `pipeline-check` passes every check on a seeded market (with `exact_out_refund` skipped), both in the tests and against devnet.
- The invariants above under the bar's fuzzing layer, the compute ceilings under its limits layer, and proofs of the pricing, tax and split maths under its maths layer.
- On devnet: the program deployed and registered with the router's `register_strategy`, its metadata and conformance report published, and one market created, seeded, traded both ways through the router, and paid out with `distribute`.
- Whatever else `docs/spec/README.md` requires of our on-chain programs.

## Not measured yet

- The compute cost of each instruction not built yet.
  The ceilings above are set from what Pipeline's constant-product example costs at `5ad130d` (a quote of about 4,900 units and a whole router swap of about 35,500, `docs/toolchain.md`), with room for a larger market state and for Token-2022.
  The build measures each instruction against them, and a ceiling changes only by a PR to this file.
  Measured on 2026-11-12 by [Tax AMM: create a tax market](https://github.com/imDev2023/testing-pipeline/issues/59), on mints without a transfer hook: `pipeline_init_market` 37,909 units on SPL Token mints and 37,345 on Token-2022 mints, `pipeline_market_info` 4,249 inside `create_market` and 2,531 called directly, `pipeline_resolve_accounts` 4,484.
- Measured on 2026-11-12 by [Tax AMM: seed a market and trade it](https://github.com/imDev2023/testing-pipeline/issues/60), on mints without a transfer hook: `pipeline_quote` 5,429 to 5,439 units, `pipeline_swap` 14,110 to 14,163 on SPL Token mints and 15,804 to 15,857 on Token-2022 mints (a whole router swap 39,805 to 46,442), and `seed` 13,040 on SPL Token mints and 16,420 on Token-2022 mints.
  A swap of a mint with Pipeline's allow-all `test-hook` took 51,347 to 63,250 units in all, the hook called at depth 4 inside the tax AMM's transfer when the hooked mint is the output.
- Measured on 2026-11-12 by [Tax AMM: pay the tax out with distribute](https://github.com/imDev2023/testing-pipeline/issues/61), on mints without a transfer hook: `distribute` 34,907 units paying a tax recipient into a token account it creates and 30,399 for the suite share on SPL Token mints, 44,045 and 35,037 on Token-2022 mints; 15,062 (SPL Token) and 18,372 (Token-2022) into a token account that exists; and 20,206 (SPL Token) and 13,960 (Token-2022) burning.
