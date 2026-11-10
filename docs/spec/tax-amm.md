# Tax AMM

Decided in [Tax AMM rules](https://github.com/imDev2023/testing-pipeline/issues/19) on 2026-11-10 with the owner, against Pipeline commit `5ad130d` (its strategy template, conformance checker, metadata standard and trust facts).
It builds on the findings of [How the containment hook works with the router and unlocks](https://github.com/imDev2023/testing-pipeline/issues/10) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/containment-hook-mechanics/research/containment-hook-mechanics.md)).
The owner made the tax AMM the first product to build (2026-11-10), to be deployed on devnet and registered with Pipeline, which is what MetalLegBob asks builders for.
MetalLegBob is not building it himself ([Record MetalLegBob's answers to the follow-up DM](https://github.com/imDev2023/testing-pipeline/issues/27)), so it stays in scope.
The shared engineering and security bar for our programs lands in `docs/spec/README.md`, from [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4); this file adds only what is particular to the tax AMM.
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
- Pipescope's launch form defaults the tax side to the quote mint (SOL or USDC), so recipients are paid in SOL or USDC rather than in the token they would sell.

### Addresses

- The market state is a fresh keypair the creator generates and signs with (metadata `init.market_state` is `new_keypair`).
  Pipeline's template keys a pool by its parameters instead, but a tax market's parameters (rates, bounds, authority, seeder, four recipients and their shares, the burn share, the virtual reserve) are far more than the 15 seeds a metadata `pda:` source allows, and a key derived from only some of them could be taken first by a market with the same seeds and bad parameters.
  A fresh keypair can't be taken by anyone else; if someone pre-funds it, the creation fails and the creator retries with another keypair, as Pipeline's guide describes.
- The vault authority is the PDA `["authority", market_state]` of the tax AMM program; it signs every transfer and burn out of the vaults.
- Each vault is a token account at the PDA `["vault", market_state, mint]`, owned by the vault authority.
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
- `pipeline_init_market` refuses anything that breaks a rule, checks that the market signer is the router's PDA `["market", program, market_state]` and stores it, creates the vaults, and records the creation slot and Unix time.
- `pipeline_seed_liquidity` takes the same fields in `SeedRequest.data`, with `seeder` ignored because the calling program's PDA is the seeder.

### Mint rules

- A Token-2022 mint may carry only these mint extensions: transfer hook (any hook program), metadata pointer, token metadata, group pointer, group member pointer, token group and token group member.
- Every other mint extension is refused at creation, including transfer fee, permanent delegate (it could take tokens out of the vaults), confidential transfers, pausable, default account state, non-transferable, mint close authority, interest-bearing, scaled UI amount and permissioned burn, as well as any extension the program doesn't recognise.
- Mint and freeze authorities are allowed, since USDC has both; Pipescope shows them.
- In Pipeline's trust flags this means a tax market's mints can only ever show `token-2022`, `mint-authority`, `freeze-authority`, `transfer-hook` and `transfer-hook-authority`; a contained token shows the last two until its unlock clears both.
- The trust flags describe strategy programs and mints, not markets, so no flag ever says a market is taxed: the strategy metadata declares it (category `amm`, tag `tax`) and Pipescope reads each market's rates, bounds, authority and recipients from its market state.

### Creating a market

One transaction, as Pipeline's guide recommends:

1. The router's `create_market` with the creation parameters, signed by the creator and the market state keypair.
2. The router's `init_fee_account` for each of the two mints.
3. The tax AMM's `seed` action, signed by the seeder.

A launchpad graduating a token instead calls `pipeline_seed_liquidity`, then the router's `register_existing_market` and `init_fee_account` for each mint, in one transaction.

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
- Pipescope's launch form shows creators the whole split, the suite share included.

### Payout

- Tax is never paid out during a swap: it is booked as owed per slot (recipients 0 to 3, the burn, the suite share) and stays in the tax-side vault.
  - A recipient account that was closed or frozen would otherwise make every swap fail, turning the market into a honeypot.
  - Swaps then need no recipient accounts.
  - Under the containment hook the home market's vault is the only account allowed to pay out a contained token, so tax held anywhere else would be stuck.
- `distribute { slot }` is permissionless: anyone may call it, at any time, for one slot.
  - A recipient or the suite share is paid its whole owed amount to the associated token account of its wallet for the tax-side mint, which the instruction creates if missing, at the caller's expense.
    For native SOL that account holds wrapped SOL, which the recipient unwraps by closing it (Pipescope offers this).
  - The burn slot burns its owed amount from the vault.
  - Each slot is paid separately, so one broken recipient account never holds up the others.
- Owed amounts belong to slots: if the tax authority changes a slot's recipient, what the slot is owed goes to the new recipient, so a recipient leaving should be paid out first (anyone can call `distribute`).
- Owed amounts fit in u64, because together with the real reserve they never exceed the vault's balance.
- Pipeline's API reports raw vault balances, so tax not yet paid out shows there as liquidity; Pipescope reads the real reserves from the market state instead.

## Counters for the containment hook

The market state keeps these totals, changed only by `pipeline_swap` calls signed by the market signer, never by custom actions:

| Field | Type | Adds, per swap |
| --- | --- | --- |
| `volume[0]`, `volume[1]` | u128 | For the input mint, the credited input (what arrived in the vault, the swap event's `net_sent`); for the output mint, what the trader was paid (the swap event's `received`) |
| `tax_collected` | u128 | The swap's tax, in the tax-side mint |
| `swap_count` | u64 | 1 |

With the creation slot and time, the fixed tax ranges and the tax side, that is everything [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18) might measure an unlock goal by (volume, tax paid, age, or a minimum tax), so the hook can choose without changing the tax AMM.
The market state starts with an 8-byte account discriminator and a version byte, and these fields sit at fixed offsets that later versions never move, because the hook reads them directly.
Which field the unlock reads, in which unit, and whether a home market needs a minimum tax to resist wash trading are that ticket's decisions; the questions are posted there.

## Custom actions and metadata

| Action | Metadata `kind` | Signer |
| --- | --- | --- |
| `seed` | `add_liquidity` | The seeder |
| `distribute` | `claim` | Anyone (payer for a missing token account) |
| `set_taxes` | `other` | The tax authority |
| `set_recipients` | `other` | The tax authority |
| `renounce_tax_authority` | `other` | The tax authority |

- Every action that moves tokens forwards transfer-hook accounts after its own, as the template's swap does.
- Each instruction emits an event (market created, seeded, taxes changed, recipients changed, authority renounced, distributed) so Pipescope's indexer can show a market's history; Pipescope reads current values from the market state, not from events.
- The metadata follows `pipeline-strategy-metadata/1` at `5ad130d`: name, description, category `amm`, tags including `tax`, links including `source` and the IDL, `init` as above with `market_state: new_keypair`, every action above, `security.contact`, and `conformance` pointing at a published `pipeline-check` report and its SHA-256.

## Upgrades and freezing

- On devnet the program stays upgradeable, with its upgrade authority in `~/.config/testing-pipeline/devnet/`.
- It is frozen (upgrade authority removed) before any mainnet deployment, because the containment hook's unlock will trust its counters and the vaults hold locked liquidity.
- The general upgrade policy is in `docs/spec/README.md`.

## Building it

- Generate the program from Pipeline's Apache-2.0 strategy template with `scripts/new-strategy.sh`, from a scratchpad clone at `5ad130d`, and pin the Pipeline crates to `rev = "5ad130d"` in `Cargo.toml`; the template is code Pipeline means builders to copy, unlike the router (owner, 2026-11-10).
- Keep the program keypair the template creates in `~/.config/testing-pipeline/devnet/`, not `~/.config/pipeline/keys/`, and never in the repo.
- Build and test with the toolchain in `docs/toolchain.md` (`source scripts/toolchain-env.sh`).

### Done means

- LiteSVM tests through the real router cover: the tax maths both ways at 0, typical and maximum rates; the cap and the ranges; the tax authority's three actions and every refusal by anyone else; renounced markets; the split and its rounding; `distribute` for each slot, including a frozen recipient account not blocking others and burning; the virtual reserve and its real-reserve limit; refusal of exact-out, of bypass and of every refused mint extension; donations not credited; and the counters.
- `pipeline-check` passes every check on a seeded market (with `exact_out_refund` skipped), both in the tests and against devnet.
- On devnet: the program deployed and registered with the router's `register_strategy`, its metadata and conformance report published, and one market created, seeded, traded both ways through the router, and paid out with `distribute`.
- Whatever else `docs/spec/README.md` requires of our on-chain programs.
