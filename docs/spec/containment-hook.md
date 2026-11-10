# Containment hook

Decided in [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18) on 2026-11-10 with the owner, building on the findings of [How the containment hook works with the router and unlocks](https://github.com/imDev2023/testing-pipeline/issues/10) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/containment-hook-mechanics/research/containment-hook-mechanics.md)) and on the tax AMM's rules in `docs/spec/tax-amm.md`.
Pipeline facts are from its repo at commit `5ad130d` (the router's `Market` account and seeds are unchanged since `a2d5bfb`, where the research read them).
[Cut the containment hook and tax AMM build tickets](https://github.com/imDev2023/testing-pipeline/issues/23) cuts the build tickets from this file, `docs/spec/tax-amm.md` and `docs/spec/README.md`.
MetalLegBob is not building this product himself, so it stays in scope ([Record MetalLegBob's answers to the follow-up DM](https://github.com/imDev2023/testing-pipeline/issues/27)).

## What it is

- One Token-2022 transfer hook program, deployed once, that serves every contained token.
- While a token is contained, every transfer of it must go into or come out of its one home market; everything else is refused.
- Once its home market has collected the unlock goal in tax, or its unlock deadline passes, anyone can unlock it: the hook removes itself and the token becomes an ordinary Token-2022 token, tradable everywhere.
- It answers MetalLegBob's ask for a hook that keeps a young token in one pool until a goal is reached, so third-party LPs cannot vamp it, and then nulls itself.
- In v1 every home market is a tax AMM market whose tax side is the quote mint, on devnet only.

## Lifecycle

1. The launcher creates the mint with the transfer hook pointing at this program and the token's unlock PDA as hook authority, and mints the supply (minting never calls the hook).
2. The launcher creates the home market on the tax AMM, binds it and seeds it (see "Launch in v1").
3. While contained, the token trades only in its home market, and its tax builds up there.
4. Once the unlock is due, anyone calls `unlock`.
5. After the unlock, Token-2022 no longer calls any hook for this mint.

Until `bind`, the hook refuses every transfer, so no liquidity can go in before the rules are fixed.

## Accounts

All are PDAs of the containment hook program, one set per contained mint.

| Account | Seeds | Holds |
| --- | --- | --- |
| Config | `["config", mint]` | The mint, the home market (the router's `Market` address), its market state, the token's vault in it, its fee account, the quote mint, the unlock goal, the unlock deadline, when it was bound, when it was unlocked (or never), bumps |
| Validation account | `["extra-account-metas", mint]` (the standard transfer hook interface seed) | One extra account for Token-2022 to pass on every transfer: the config, read-only |
| Unlock PDA | `["unlock", mint]` | No data; it is the mint's transfer hook authority and signs the unlock |

The config is never closed, so it stays as the record of the token's containment after the unlock.

## Binding (`bind`)

- Signed by the mint's mint authority, which is how the hook knows the caller is the launcher; nobody else can bind a mint, so binding cannot be front-run.
- Creates the config and the validation account; it fails if the config already exists, which makes binding write-once.
- No instruction changes the config afterwards: not the launcher, not us.
- Arguments: the unlock goal (greater than zero, in quote-mint base units) and the unlock deadline (a Unix timestamp later than now and at most 90 days after the binding).

### Checks on the mint

- Owned by Token-2022.
- Its transfer hook program is this program, and its transfer hook authority is its unlock PDA.
- Its only extensions are on an allowlist: transfer hook, metadata pointer, token metadata, group pointer, group member pointer, token group and token group member (the tax AMM's own mint allowlist, none of which gives power over anyone's balance).
  Every other extension is refused, including permanent delegate (it can move or burn anyone's tokens), confidential transfer (the hook would see `u64::MAX` instead of the amount), default account state (accounts that start frozen), transfer fee (Token-2022 withdraws withheld fees without calling the hook, an escape route), pausable, and any extension Token-2022 adds later.
- Its freeze authority is unset, because freezing the home market's vault would trap every holder with nowhere else to sell; this is stricter than the tax AMM, which allows freeze authorities.
- The mint authority may stay set; the launcher can revoke it after binding, and Canary checks report it as they do for any mint.

### Checks on the home market

- The `Market` account is owned by Pipeline's router and sits at its PDA `["market", strategy, market_state]`.
- Its strategy is the tax AMM, whose program id is fixed in the hook at build time.
- One of its two mints is the contained mint; the other is the quote mint.
- The market state passed in is the one the `Market` records, owned by the tax AMM, and its tax side is the quote mint's index, so its tax collected is counted in the quote mint.
- `bind` reads the token's vault from `Market.vaults` and derives the fee account (the Token-2022 associated token account of the router PDA `["fees", market]` for the contained mint), rather than taking either from the caller.

One home market per token: several would split the liquidity that containment exists to concentrate, and summing tax in different quote mints would need a price on chain.

## The allow rule

The hook's `Execute` fails closed: it refuses the transfer unless all of these hold.

- The validation account and the config are present and at their PDAs for this mint, and the mint is the one Token-2022 is transferring.
- The source token account has Token-2022's `transferring` flag set, so nobody can call `Execute` directly.
- The source or the destination is one of the two allowed accounts: the home market's vault for the token, or the market's fee account for the token.

It makes no CPI, because on a buy it already runs at the last call level the runtime allows (router, strategy, Token-2022, hook).
The allowed sets are the same for sources and destinations, and neither allowed account is controlled by a wallet: the vault is moved only by the tax AMM and the fee account only by the router's `sweep_fees`.

### What this allows

- Buys and sells through the router (sells pass on the destination, buys on the source).
- The Pipeline fee on sells, paid in the token into the fee account.
- `sweep_fees`, which moves the fee account to Pipeline's treasury (it passes on the source, so the treasury needs no entry).
- The tax AMM's one-time `seed` into the vault.
- The tax AMM's `distribute`, which pays tax out of the vault; with the tax side on the quote mint it never moves the contained token anyway.

Bypass needs no rule: the tax AMM refuses it, so every trade in the home market goes through the router, pays Pipeline's fee and counts in the market's counters.

### What this refuses

- Every wallet-to-wallet transfer, including between a holder's own wallets and to a CEX deposit address; a holder who wants to move the token sells it and buys again.
- Funding a second market for the token anywhere, on Pipeline or elsewhere, and paying out of one.
- Any integrator fee on a sell, because the router pays it in the token into the integrator's own account, which is not allowed.
  Integrators must pass a zero integrator fee on sells of a contained token (at zero the router makes no transfer); buys pay their integrator fee in the quote mint as usual.

A buy may deliver the token to anyone's account, since the router does not check who owns the output account; that account can then only sell into the home market, so it is a gift, not an escape.

## Unlock (`unlock`)

- Permissionless: any signer can call it and pays the transaction fee.
- Due when either holds:
  - the home market's `tax_collected`, read from the tax AMM market state recorded at binding (owner and address checked), is at least the unlock goal;
  - the clock's Unix timestamp is at or past the unlock deadline.
- Signed by the unlock PDA, it calls Token-2022's `TransferHookInstruction::Update` with no program id, then `SetAuthority(TransferHookProgramId, None)`, and records the unlock time in the config.
- Both fields must be cleared: Meteora's DAMM v2 and DLMM accept a mint with the transfer hook extension permissionlessly only when the hook program and the hook authority are both unset.
- A second call fails, because the authority is gone.

There is no keeper job for the unlock in v1.
Nothing breaks while an unlock waits, since sells into the home market keep working, and whoever wants out or wants the token trading elsewhere can press Pipescope's Unlock button.

### After the unlock

- Token-2022 skips the hook; the mint keeps a transfer hook extension with both fields unset, as graduated Meteora DBC mints do.
- Integrators stop passing hook accounts; stale ones are ignored.
- The deprecated `Transfer` instruction without a mint still fails for this mint, as for any mint with the extension; wallets and routers use `transfer_checked`.

## Unlock goal

- The tax collected by the home market, in quote-mint base units (lamports when the quote mint is wrapped SOL): the tax AMM's `tax_collected` counter, which only router swaps change, buys and sells alike.
- Why the tax AMM counts it and not the hook: [ADR 0001](../adr/0001-unlock-goal-counted-by-the-home-market.md).
- Set by the launcher at binding and never changed.
- Why tax collected rather than volume:
  - A tax authority may lower its market's taxes to the bottom of a range fixed at creation, which may be 0, and the tax AMM has no LP fee; at a 0% tax, faking volume would cost only Pipeline's 0.25%, so a vamp could wait for a low-tax window and force a permanent unlock cheaply.
  - Counting tax collected, forcing an early unlock always costs a third party the whole goal in tax, whatever the rate; at 0% the goal stops moving and the deadline unlocks the token.
  - It measures what containment protects: the token's tax income, until it has earned a set amount.
- The only party who can reach the goal cheaply is whoever receives the tax (they pay Pipeline's fee and the suite share and get the rest back), and they would be undoing their own protection.
- No minimum age: the deadline already bounds how long containment lasts, and the goal is the launcher's commitment.

## Unlock deadline

- Required at binding, at most 90 days after it; once it passes, the unlock is due even if the goal was never met.
- A contained token is a honeypot by construction if its home market stops working, for example after a bad tax AMM upgrade or a router upgrade that changes the fee account's derivation; the deadline caps how long holders can be stuck.

## Hook accounts callers must pass

- Every transfer of a contained token needs the same tail: the hook program, the validation account and the config, read-only.
- Sells put it in the router's `input_hook_accounts`; buys put it after the strategy's own accounts; `sweep_fees` takes it as remaining accounts; the tax AMM's `seed` takes it after its own accounts.
- Neither Pipeline client resolves hook accounts, and Pipeline's hosted API refuses to build swaps whose input mint has a transfer hook (`docs/API.md` at `5ad130d`), so Pipescope, our scripts and anyone sweeping fees resolve them from the validation account and build those transactions with the SDK; a call that leaves them out is refused.

## Launch in v1

- A devnet CLI script in this repo launches a contained token.
  - Create the mint with only allowed extensions and no freeze authority, with the hook and its authority set as in "Lifecycle", and mint the supply.
  - Then the tax AMM's market creation (`docs/spec/tax-amm.md`, "Creating a market") with `bind` inserted before the seed: the router's `create_market` with the tax side on the quote mint, `init_fee_account` for each mint, `bind` with the goal and deadline given as required flags (no defaults), then the tax AMM's `seed`.
- `bind` belongs in the same transaction as the market's creation, but may go in a later one with the seed if the transaction is too large: nothing can move the token before `bind`, the market is closed to swaps until its seed, and only the seeder can seed.
- Revoking the mint authority is an optional last step; it must come after `bind`, which needs the mint authority's signature, or the token can never be bound and never transfer.
- Graduating a contained token from a launchpad through `pipeline_seed_liquidity` is not supported in v1, because the seed would move tokens before the `Market` account that `bind` reads exists.
- Whether Pipescope also gets a launch page is for [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3) to decide; if it does, its launch form fixes the tax side to the quote mint for contained tokens.

## What Pipescope must do

Posted on [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3) for its spec to take in.

- Recognise a contained token: its transfer hook program is ours, its hook authority is its unlock PDA, and its config exists.
- Resolve the hook accounts for every swap of it, and build its swaps with the SDK rather than Pipeline's hosted API.
- Show it as contained, with its home market, the tax collected against the unlock goal and the unlock deadline.
- Warn before a buy that the token can only be sold back into its home market until it unlocks, and cannot be sent to another wallet.
- Pass a zero integrator fee on sells of a contained token, and charge its integrator fee on buys as usual.
- Show an Unlock button to anyone once the unlock is due, and show the token as unlocked afterwards.

## Depends on

- The tax AMM (`docs/spec/tax-amm.md`): `tax_collected` and the tax side at fixed offsets that later versions never move, vaults at PDAs `["vault", market_state, mint]`, bypass refused, liquidity locked, tax paid out of the vault only, and the program frozen before mainnet because the unlock trusts its counter.
- [Engineering and security bar for our on-chain programs](https://github.com/imDev2023/testing-pipeline/issues/4): the hook's guarantees rest on its program, so while it is upgradeable its upgrade authority can change the rules or the unlock; the hook must be frozen before any mainnet use, and its devnet upgrade policy follows that ticket.
- Pipeline's router: the fee account's derivation belongs to the router, which is upgradeable on devnet; if an upgrade changed it, sells of contained tokens would fail until their deadline.

## Ruled out

- Allowing wallet-to-wallet transfers between keypair wallets signed by their owner: it needs an on-curve check, and an RFQ market maker quoting from a hot wallet could still take the home market's trading.
- A launcher-set list of integrator fee accounts allowed as destinations: it makes the allow rule asymmetric and gives launchers a list that could name a bid-only vamp pool, for a fee that only lasts until the unlock.
- Volume as the unlock goal, with or without a minimum-tax floor checked at binding: without a floor it is cheap to fake in a low-tax window, and a floor needs an arbitrary constant while still letting a third party force the unlock for the floor times the goal.
- Counting the goal in the hook, which would also count liquidity moves and donations, or from transfers into the fee account, which donations could fake; or a wrapper program reading the router's return data, which misses direct router swaps.
- A tax side on the contained token for home markets: the goal would be counted in the token itself, whose price the launcher's supply sets.
- Several home markets per token.
- Changing the goal or the deadline after binding, even only lowering them.
- A minimum age as part of the goal.
- A keeper job for the unlock in v1.
- Launchpad graduation into a contained home market in v1.
- Starting from Pipeline's `test-hook`, which approves every transfer when its extra accounts are left out.

## Not measured yet

- The compute cost of the hook on each hooked transfer: into the vault and into the fee account on a sell, out of the vault on a buy; measured in the build.
- Whether the creation transaction with `bind` fits in one transaction with an address lookup table; if not, `bind` and the seed go in a second one, as above.
