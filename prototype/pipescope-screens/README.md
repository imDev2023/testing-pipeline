# PROTOTYPE: Pipescope screens (throwaway)

Rough, clickable screens for the wayfinder ticket [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16).
The question it answers: what do Pipescope's v1 screens look like and how do they behave?
It is not production code: no tests, no build step, no framework, and nothing is ever signed or sent.
The decisions it led to are in `docs/spec/pipescope-screens.md` on `main`; this branch is the primary source behind them and is never merged.

## Run it

```sh
cd prototype/pipescope-screens
python3 -m http.server 4716 --bind 127.0.0.1
open http://127.0.0.1:4716/
```

Opening `index.html` straight from the folder works too.
`node build-data.mjs` refreshes `data.js` from devnet; it needs this repo's `origin/prototype/canary-checks` and `origin/prototype/explainer-samples` branches fetched.

## What is in it

Eight pages, as `docs/spec/pipescope.md` lists them: the feed, a market page, a strategy page, the wallet page, create market, search, and the two static pages (Fees, Devnet help).
A ninth page, "Decisions behind these screens" (linked in the footer), lists every choice the screens rest on, each with its alternatives, so whoever looks can say which to change.

Three pages come in more than one layout.
The blue pill at the bottom, or the left and right arrow keys, switches them; the layout is in the URL as `?variant=`.

| Page | A | B | C |
| --- | --- | --- | --- |
| Feed | A flat table of markets, strategies on a second tab | Markets grouped under their strategy, with the version's Canary roll-up | One time-ordered log of registrations, new markets, upgrades and swaps |
| Market | Chart and trade box first, explanation beside the facts below | Canary's findings and the explanation first, chart and trade box in a side column | |
| Strategy | Canary by check, with how many markets got each outcome | Canary as a grid of markets against checks | |

The pill's Options menu also switches the theme, the candle colours and whether strategy metadata that failed validation is treated as valid (to see forms), and links to the states worth a look: a buyer who could not sell back, a 48.8% round trip, a launch-time tax, a token authority that could act, a stranded market, a market closed by its own rules, a pending upgrade.

## What is real

- Strategies, markets, trust flags, liquidity, 24-hour figures and trades: a snapshot of Pipeline's hosted devnet API (`https://pipeline-devnet.up.railway.app`, no key), taken by `build-data.mjs`.
- Charts: candles built in the page from those swap events.
- Quotes in the trade box: live, from the hosted API's `/v1/quote`, which runs the strategy's own code.
- The review step: the hosted API builds the real unsigned swap and the public devnet RPC simulates it, so a failed simulation is a real one.
- Canary results: the Canary prototype's run of 2026-11-10 on all 61 devnet markets (`origin/prototype/canary-checks`), turned into Canary result records by the outcome rules of `docs/spec/pipescope-canary.md`, with sentences written by code in `build-data.mjs`.
- Explanations: the samples the owner approved on 2026-11-10 for four strategies (`origin/prototype/explainer-samples`); the other four strategies show "No explanation for this version yet."
- Token names: each mint's own Token-2022 metadata; no devnet mint in a Pipeline market has Metaplex metadata.
- The wallet page: this project's own devnet wallet, by public address only, with its real swaps and balances.

## What is faked

- Connecting a wallet: no wallet is opened; the page shows the project's devnet wallet.
- Signing: every sign button ends in a note that nothing was signed or sent.
- Custom-action forms, create market and unwrap: the forms are drawn from real published metadata, and their simulate buttons answer with a note.
- The review step simulates the swap without Pipescope's fee account, which does not exist on devnet yet; the fee shown is the quote's.
- Version history lists every transaction on the program's code account, not one row per upgrade.
- "Pretend it is valid": on devnet today no strategy's metadata passes Pipeline's validator, so the product would draw no forms at all; the switch draws the forms three real documents would give.
- "Just upgraded" and the unwrap offer are switched on by a prototype control, because devnet has no example of either today.

## Verdict

To be written once the owner has reacted.
