# Aviary: the first devnet version

Decided with the owner in [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3) on 2026-11-09 and 2026-11-10.
MetalLegBob confirmed the scope stands and asked for nothing more for a start ([Record MetalLegBob's answers to the outreach](https://github.com/imDev2023/testing-pipeline/issues/5)).
Pipeline was read at commit `5ad130d` (its integrator guide, metadata standard and trust facts).
The explainer has its own file, [`pipescope-explainer.md`](pipescope-explainer.md); [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22) merges the Aviary files.

## What the first version is

- A web terminal on devnet that lists every Pipeline strategy and market as it appears, charts them from swap events, trades them through the router with our integrator fee, renders their custom-action forms, and shows a facts panel, Canary results and an explanation for each strategy version.
- Devnet only, and it never holds a user's keys: every transaction is signed in the user's own wallet.

## Pages

1. **Feed**: new strategies and markets.
2. **Market page**: a chart and the trades from swap events, the trade box, the market's facts panel, the strategy version's explanation beside it, and the strategy's custom-action forms.
3. **Strategy page**: the facts panel, Canary results for each strategy version, the explanation, the version history and the strategy's markets.
4. **Wallet page**: the connected wallet's swaps through Pipeline and its balances in mints that trade in Pipeline markets; it offers to unwrap wrapped SOL left in the wallet, which tax recipients are paid in (see [`tax-amm.md`](tax-amm.md)).
5. **Create market**: a market created from a registered strategy's `init` form, with mints that already exist.
6. **Search**: by name, mint, market address or strategy address.

Two short static pages go with them: **Fees** (see [The integrator fee](#the-integrator-fee)) and **Devnet help**, which explains how to get devnet SOL.

Not in the first version:

- a token page across markets, watchlists, alerts and leaderboards;
- launching a new token (creating a mint), and registering a strategy, which developers do from the command line;
- routing across markets, multi-hop swaps and exact-out swaps;
- USD prices;
- a faucet;
- a native app;
- the Telegram bot, which has its own spec, [`pipescope-telegram.md`](pipescope-telegram.md), and is built alongside these pages.

## Listing

- Every registered strategy and every market is listed; nothing is curated or hidden, because hiding a market is a judgement and Pipeline asks integrators for neutral facts only.
- The feed shows the newest first, with filters for liquidity, volume and age.
- Traders can also hide markets by Pipeline's trust flags (for example `permanent-delegate`, `freeze-authority`, `upgradeable`, `transfer-hook` or `metadata-missing`), the same flags Pipeline's SDK and hosted API compute.
  Every filter starts off, so the default feed lists everything.
- A strategy whose metadata is missing, unreachable or invalid (Pipeline's `metadata-missing`, `metadata-unreachable` and `metadata-invalid` flags) is listed under its program address with "Metadata unavailable", and gets no forms.
- A market that the current strategy version can no longer read is still listed, with that fact (on devnet on 2026-11-09, eight markets failed every quote after their strategies were upgraded; see [`pipescope-explainer.md`](pipescope-explainer.md)).

## Trading

- One market, one hop, exact-in only: the trader picks any two of the market's two to four mints as input and output.
- SOL is wrapped and unwrapped for the trader.
- The market's `init_fee_account` is added to the transaction when a sell needs it.
- Default slippage is 1%, and the trader can change it.

### Simulate before every signature

- Every transaction Aviary builds is simulated before the wallet is asked to sign: swaps, custom actions and creating a market.
- If the simulation fails, Aviary shows the error and the sign button stays off.

## The integrator fee

- **Rate**: 0.5% (50 basis points), one rate for every market, set in config.
  With Pipeline's 0.25%, a trader pays 0.75% in all, under the 1% usual among terminals.
- **Fee mints**: the router takes an integrator fee in the mint the trader pays with, so Aviary charges it only when the input mint is a fee mint: SOL (as wrapped SOL) or USDC.
  A swap paying with any other mint passes no integrator fee account and a rate of 0.
  The reasons: a fee account in every mint would cost about 0.002 SOL of rent each, paid by the trader's transaction; the fees would pile up in tokens that are hard to sell; and a hooked token, our own containment hook included, may refuse transfers into our account and so make sells fail.
  The cost is that Aviary earns mostly on buys.
- **Fee wallet**: a dedicated wallet that Aviary only ever pays into, holding one fee account for wrapped SOL and one for USDC, created once.
  On devnet its keypair is `~/.config/testing-pipeline/devnet/fee-wallet.json` and its USDC account is for Circle's devnet USDC mint, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`.
  The owner creates the mainnet fee wallet later; its key is never on a server, and Aviary knows only its address.
  It is a different wallet from the tax AMM's `SUITE_TREASURY` (see [`tax-amm.md`](tax-amm.md)), so each product's revenue stays visible on its own and the fee wallet can change in config without a redeploy.

### How the fee is shown before signing

- The trade box always shows the fee breakdown, never collapsed, in token amounts and percentages:
  - Pipeline fee: 0.25%;
  - Aviary fee: 0.5%, or "none on this swap" when the input is not a fee mint;
  - the strategy's own fees and taxes: "included in the quote", since strategy metadata has no field for them;
  - the expected output and the minimum received after slippage.
- The swap is built from exactly the rate on screen.
- The public Fees page states the rate, which payments carry it, and that Pipeline's fee and the strategy's own fees and taxes come on top.
- The label takes the public name from the web app's one config module ([`README.md`](README.md), Names), so it changes with the name.

## Wallets and devices

- Any wallet that implements the Solana Wallet Standard (Phantom, Solflare, Backpack and the rest), connected through `@solana/kit`, the library Pipeline's TypeScript SDK uses.
- Desktop first, and working down to phone width, inside wallets' in-app browsers, and through Mobile Wallet Adapter on Android.
- No native app.

## Facts and Canary results

- The facts panel shows neutral facts and no verdicts.
  Program and mint facts use Pipeline's trust flags and their fixed descriptions from `pipeline-client` (upgradeable or frozen and by whom, verified build, metadata status, mint and freeze authorities, transfer hook, transfer fee, permanent delegate and the rest), so Aviary's wording matches Pipeline's SDK and hosted API.
  Beside them: liquidity, market age and volume.
- Each Canary result states what was tested and what happened, in numbers, with the strategy version and the date it ran.
- There is no overall score, no safe or unsafe badge, and no green or red.
- The results a trader most needs come first, worded plainly, for example "In our test, a wallet that bought could not sell back."
- Which checks run, their thresholds and when they re-run are for [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14).

### A failed exit test in the trade box

- When the exit test of the market's current strategy version observed that a buyer could not sell back, that fact is repeated in the trade box above the swap button.
- The trader ticks one box to say they have read it before the swap button turns on.
- The trade is never blocked; other findings stay in the facts panel.

### When a strategy is upgraded

- Pages show results only for the newest strategy version.
- Until the new version has been tested and explained, the strategy page and each of its market pages show: "Upgraded on <date>; tests and explanation for this version are pending."
- Results for older versions stay in the version history, labelled as such.

## The explainer

- Specified in [`pipescope-explainer.md`](pipescope-explainer.md): one explanation per key (the strategy version, its metadata, its Canary outcomes, the prompt and the model), never made by a page view.
- Every explanation is a paid call, so it waits for the owner's approval: new keys queue with an estimated cost, and the owner approves them with one command run on their Mac, which also writes the spend ledger.
  There is no admin page in the web app, and traders cannot ask for an explanation on demand.
- It appears on the strategy page and on each market page beside that market's own facts panel, in presentation A with its label and "This is wrong" control, as that file specifies.

## Custom-action and create-market forms

- Aviary renders every `actions` form and the `init` form from any strategy's metadata, with every argument type and account source the schema allows, using the SDK's generic builders (`buildActionInstruction`, `buildCreateMarketFromMetadata`), so no strategy needs code of its own.
- Strategy metadata is untrusted user content:
  - metadata is validated with Pipeline's metadata parser, and a strategy whose metadata fails gets no forms;
  - labels and descriptions are shown as plain text, never as HTML or Markdown;
  - links are shown with their full domain;
  - each form shows the program it calls, the instruction it calls (checked in code against the program's instruction list, as in [`pipescope-explainer.md`](pipescope-explainer.md)), and every account it touches, marked writable or signer;
  - each form says that a custom action is signed directly on the strategy, outside the router's swap protections;
  - before signing, the simulation shows how the wallet's token balances would change.
- Forms are not limited to strategies we have reviewed, because that would undo the point of a permissionless router.

## Tokens and prices

- Token symbols and images come from each mint's on-chain token metadata, which is untrusted too, so they always appear with the mint's short address beside them.
- Aviary names only SOL and USDC itself; no other token gets a "verified" mark, since that would be a judgement.
- Charts and prices are in the market's own mints, for example a token priced in SOL; there are no USD prices on devnet.

## Shared

What this ticket decided for every product, that our products live inside Aviary, is in [`README.md`](README.md) ("Our products live inside Aviary"), with the engineering and security bar for our on-chain programs.

## For other tickets

- [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13): where swaps, custom actions and market creation are simulated; where the fee rate and fee wallet are configured; and whether Pipeline's hosted devnet API (`5ad130d`: markets with trust flags and filters, trades, candles, trader history, quotes and a live stream) serves the feed, charts and wallet page or our own indexer does.
- [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14): each result as a record of check, version, run date, sizes and outcome, in numbers; and which outcome counts as "a buyer could not sell back" for the trade-box notice.
- [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16): the six pages and two static pages above, the trade box with its fee breakdown and exit-test acknowledgement, the upgrade notice, and forms with their account lists.
- [Containment hook policy](https://github.com/imDev2023/testing-pipeline/issues/18), [Pool4 for Solana design](https://github.com/imDev2023/testing-pipeline/issues/20) and [Lending pool design](https://github.com/imDev2023/testing-pipeline/issues/21): say what each product's Aviary panel shows and which actions its metadata exposes.
