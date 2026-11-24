# Aviary: screens

Decided in [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16) on 2026-11-12, from a clickable prototype on real devnet data that the owner was given on 2026-11-10.
This file says what each page of [`pipescope.md`](pipescope.md) shows and how it behaves.
That file says what the first version is, and [`pipescope-architecture.md`](pipescope-architecture.md) says where the data comes from.
Pipeline was read at commit `5ad130d`.

## How the screens were decided

- The prototype is throwaway code on the branch [`prototype/pipescope-screens`](https://github.com/imDev2023/testing-pipeline/tree/prototype/pipescope-screens/prototype/pipescope-screens), which is never merged; its README says how to run it, what in it is real and what is faked.
  It was built before the names were settled, so it says Pipescope where the product says Aviary.
- It drew every page on a snapshot of devnet taken on 2026-11-10 (8 strategies, 61 markets, 131 swaps), with that day's Canary run on every market, the four approved explainer samples, live quotes from the strategies' own code and a real simulation of each swap.
- It was checked at 1440, 390 and 360 px wide, with no sideways scrolling.
- Three pages were drawn in more than one layout, and the session put six questions to the owner with a recommended answer for each: the feed's layout, the market page's layout, how the strategy page shows Canary results, what the amount typed in the trade box means, the look, and token images.
- The owner told the session to go ahead with its recommended answers, changing none and without reacting to the screens one by one.
- So every answer in this file is a default: the decision register, [`../decisions.md`](../decisions.md), holds them as `PIPESCOPE-65` to `PIPESCOPE-85`, and MetalLegBob or the owner may change any of them.
- The wording quoted below is the prototype's, and it is the starting copy.
  Where it names Aviary, the build takes the name from the web app's brand module ([`README.md`](README.md), Names).

## One place for every value

Every value below is a default that can change, and each lives in exactly one place.

- **The screens' config module**, `apps/terminal-web/src/config.ts`: every number and list that a page uses.
- **The theme stylesheet**, `apps/terminal-web/src/theme.css`: every colour and typeface, as named tokens for the light theme and the dark theme.
  No component writes a colour or a typeface of its own.
- **The brand module**, `apps/terminal-web/src/brand.ts`: the public name, the address and the fee label ([`pipescope-architecture.md`](pipescope-architecture.md), "`terminal-web`").
- **`terminal-api`**: the rule for which mint a pair is quoted in and the limits on token images, in its config module, and the fee rates, the fee mints and the Telegram handles, in its vars.
  The pages read these from the API and never repeat them.

| Value | Default | Where |
| --- | --- | --- |
| Default slippage | 1% | Screens' config module |
| Slippage choices one tap away | 0.5%, 1% and 3% | Screens' config module |
| Highest slippage the trader may type | 50% | Screens' config module |
| Pause after the last keystroke before a quote is asked | 350 ms | Screens' config module |
| SOL kept back when the trader uses their whole balance | 0.01 SOL | Screens' config module |
| Oldest a prepared swap may be when the trader signs, before it is built again | 45 s | Screens' config module |
| Log lines a failed simulation or a refused quote shows behind its disclosure | the last 12 | Screens' config module |
| Candle lengths on the chart | 1 m, 5 m, 15 m, 1 h, 4 h and 1 d | Screens' config module |
| Candle length a chart opens at | 15 m | Screens' config module |
| Room the chart gives each candle | 16 px | Screens' config module |
| Shortest gap between two reads of the forming candle while trades land | 1 s | Screens' config module |
| Longest wait before a dropped live room is joined again | 15 s | Screens' config module |
| Trades shown before "Show earlier trades" | 40 | Screens' config module |
| Rows of the feed loaded at a time | 50 | Screens' config module |
| Feed filter, liquidity | at least 0.1, 1 or 10 SOL | Screens' config module |
| Feed filter, volume in 24 hours | at least 0.01, 0.1 or 1 SOL | Screens' config module |
| Feed filter, created | in the last hour, 24 hours or 7 days | Screens' config module |
| Pause after the last keystroke before a search runs | 220 ms | Screens' config module |
| Search results shown a group | 20 | Screens' config module |
| Search examples shown when nothing is typed | "Sniper", "7BctW" and "dream", each checked to find something on devnet | Screens' config module |
| Width at which the market page becomes one column | 1080 px | Theme stylesheet |
| Width at which tables become labelled blocks | 720 px | Theme stylesheet |
| Colours and typefaces | the tables under [Colour and theme](#colour-and-theme) | Theme stylesheet |
| Quote mint order | wrapped SOL, then the cluster's USDC, then the later mint of the pair | `terminal-api`'s config module |
| Token images | PNG, JPEG or WebP, at most 1 MB, drawn 20 px square | `terminal-api`'s config module, and the theme stylesheet for the size |
| Public name, address, fee label | Aviary, `aviary.trade`, "Aviary fee" | Brand module |
| Fee rates and fee mints shown | read from the API | [`pipescope-architecture.md`](pipescope-architecture.md), The integrator fee's configuration |
| Telegram bot and channel handles | read from the API, empty until they exist | [`pipescope-telegram.md`](pipescope-telegram.md), One place for every value |

The default slippage is the 1% of [`pipescope.md`](pipescope.md) (Trading); this table gives it its home in code.

## Who is speaking

A page of Aviary carries three kinds of text, and a reader has to tell them apart at a glance, because Aviary can vouch for only one of them.

- **What Aviary read or measured** is set plainly, in the sans-serif typeface: chain facts, Canary results and every sentence written by code.
- **What an AI wrote**, an explanation, is set in the serif typeface, a size larger, under its code-written label ([`pipescope-explainer.md`](pipescope-explainer.md), Presentation).
- **What an author wrote** is set in purple italic and always as plain text: a strategy's name and description, the labels of its forms, and a token's symbol and name.
  An author's name always has the short address beside it.
- An author's label is never set plainly.
  The identifiers a form carries (the name of an instruction, an argument or an account) are shown as code beside the label.
- Nothing of Aviary's own is ever set in purple italic or in the serif.
- The footer of every page shows the three styles, each with one line saying whose words it marks:
  - "Plain text was read from the chain or measured by Aviary."
  - "Text set like this was written by an AI from those facts."
  - "Text like this was written by a strategy's or token's author and is not verified."

## Colour and theme

- The pages are drawn in ink on a pale, cool paper, with one accent, canary yellow.
- Canary yellow appears in two places only: the mark beside the heading of Canary's results, and the notice in the trade box when the exit test saw a buyer who could not sell back.
- Purple appears only on an author's words.
- Nothing is green or red, anywhere: not an outcome, not a price change, not a buy or a sell, not a candle ([`pipescope.md`](pipescope.md), Facts and Canary results).
- There is a light theme and a dark theme.
  The page follows the device's setting, and a control in the footer lets the reader choose light, dark or the device's.
- The light theme is the one the design was drawn in; the dark theme uses the same tokens with its own values, chosen for it and not flipped by rule.

| Token | Light | Dark | Used for |
| --- | --- | --- | --- |
| `--paper` | `#EDF1F1` | `#0E1920` | the page |
| `--sheet` | `#F9FBFB` | `#14222B` | panels, and the inside of a hollow candle |
| `--wash` | `#E2E8E9` | `#1C2D37` | code and pressed controls |
| `--ink` | `#13222C` | `#E6EDEF` | text, outcome shapes and candles |
| `--ink2` | `#465863` | `#A9B9C1` | secondary text |
| `--ink3` | `#5D6D77` | `#8799A3` | notes |
| `--rule` | `#CFD8DB` | `#24353F` | hairlines |
| `--rule2` | `#9CADB4` | `#435863` | underlines and control borders |
| `--canary` | `#FFD60A` | `#FFD60A` | Canary's mark and the trade-box notice |
| `--on-canary` | `#13222C` | `#13222C` | text on canary yellow |
| `--author` | `#7A2B8C` | `#DDA9EC` | an author's words |

| Typeface | Used for |
| --- | --- |
| Archivo, the variable font with its width and weight axes | everything Aviary says: 14 px on a 1.5 line, with tabular figures so columns of numbers line up |
| Literata | AI-written text: 16 px on a 1.6 line |

- Headings are Archivo, slightly wider and heavier than the text, in sentence case.
- Both typefaces are served from Aviary's own origin, so a page view calls no font service.

## Canary outcomes

- An outcome is its word (pass, warn, fail, not run or noted, as [`pipescope-canary.md`](pipescope-canary.md) defines them) beside one of five small ink shapes.
- The shapes get heavier the more a trader needs to look:

| Outcome | Shape |
| --- | --- |
| fail | a solid disc |
| warn | a ring with its lower half filled |
| pass | a ring |
| not run | a dashed ring |
| noted | a short dash |

- The shape is never shown without the word, and neither is ever coloured.
- A market's results are never added up: no count of passes, no score and no badge.
  The strategy page counts markets for one check ("fail, 6 of 8"), which says how widely one finding holds and is not a score of the strategy.
  Pipeline's own conformance report keeps the counts its checker prints, because that line is the checker's report and not ours.
- Every result carries the sentence that code wrote for it, its numbers, and a last line naming the check, the run's date and slot and the strategy version: "Check `exit_sizes`: buys each size and sells everything bought in the same slot. Run on 10 Nov 2026, 04:54 UTC at slot 520,629,097, on the strategy version deployed in slot 520,151,724."
- A result that was refused shows who refused it, the error's name, number and message, and the stage it was raised at.
- The sentences are written once, by code in `terminal-api`, and served with the result, so the page, the trade box and the Telegram bot show the same words.
- As built (`PIPESCOPE-148`): the checks' fixed order on the pages, and each check's plain name, are the prototype's: Reading the market (`readable`), Buy, then sell straight back (`exit_sizes`), What a round trip costs (`cost`), Buy, wait, then sell (`exit_hold`), Fresh wallets and insiders (`exit_wallets`), Selling tokens someone sent you (`exit_transferred`), Five buyers leaving in turn (`exit_queue`), Arriving later (`exit_late`), The clock set back to launch (`exit_launch_clock`), Token authorities acting (`token_authorities`), Supply held outside the pool (`outside_supply`, added after the prototype), Quote against swap (`quote_matches_swap`), Calling the strategy without the router (`direct_call`), Telling a test from a real trade (`transaction_accounts`), Transfer hook (`contained_mint`), Pipeline's own conformance check (`conformance`) and Instructions beyond Pipeline's own (`custom_instructions`).
  They live in one list in `terminal-api` (`canaryView.ts`), which serves each result with its name and in that order.
- As built: a result that runs one round trip a step is served with its steps, each size, wait, wallet or buyer with what came back or "could not sell back", which the page draws as a row with its bar in ink; every refused step a record names is served as who refused it, the program, the error's name, number and message, the stage and where Anchor says it was raised.

## On every page

- **Header**: the name, a "devnet" tag, links to Feed, Create market and Wallet, the search box, and the wallet button, which reads "Connect wallet" or the connected wallet's short address.
- **Footer**: the three styles of [Who is speaking](#who-is-speaking); the line "Devnet only. Aviary never holds your keys: every transaction is signed in your own wallet, after a simulation you see first."; links to Fees and Devnet help; the theme control; and the official Telegram bot and channel once they exist ([Arriving from Telegram](#arriving-from-telegram)).
- **Addresses** are shown short, as the first four and the last four characters ("6efY...dnYp"), with the whole address on hover, a Copy control wherever an address is the subject of the page, and a link to a block explorer.
- **Amounts** are in tokens, never dollars, to four significant figures, with "M" and "B" for millions and billions.
- **Prices** below 0.0001 are written with the count of zeros as a subscript, as "0.0₇2307" for 0.00000002307, on the chart's axis and everywhere else, so one page never mixes two notations.
- **Dates** are in UTC, as "10 Nov 2026, 04:54 UTC".
  Lists show an age ("2d ago") with the date on hover.
- **Loading**: each panel loads on its own under its heading, so a slow panel never blanks the page.
- **Failure**: a panel that cannot load says what could not be loaded and offers to try again.
  An error from a strategy or the chain is shown decoded, with the raw error beneath it.
- **Nothing there**: an address that is no market or strategy gets a page saying so, with the address, and links to the feed and to search.
- **Keyboard and motion**: every control is reachable by keyboard with a visible focus ring, and nothing moves for a reader who has asked for reduced motion.

## Feed

The feed is one table of markets, newest first, with strategies on a second tab.

- **Head**: "New on Pipeline", and one sentence: how many markets on how many strategies, that anyone can register a strategy and Pipeline vets none of them, and that every one is listed with what Aviary read and measured.
- **Tabs**: Markets and Strategies, each with its count.
- **A market's row**:
  - the pair, base first then quote ([Price direction](#price-direction)), with the market's short address beneath it;
  - its strategy, by name and short address, or by short address with "Metadata unavailable";
  - when it was created;
  - liquidity, as what each vault holds;
  - volume in the last 24 hours in the quote mint, with the number of trades; on a market of three or four mints the count takes every trade, and the volume those with the quote mint on one side, since no other trade has an amount of it (`PIPESCOPE-106`);
  - Canary ([What a row says about Canary](#what-a-row-says-about-canary));
  - Pipeline's trust flags.
- **A strategy's row**: its name and short address; when it was registered; how many markets it has; its current version's slot and who can upgrade it; the range of Canary's round-trip return over its markets that trade, and how many of its markets its current version cannot read; and its trust flags.
- The whole row opens the market or the strategy.
- The two layouts that were drawn and not chosen: markets grouped under their strategy with that version's Canary results summed up above them, and one time-ordered log of registrations, new markets, upgrades and swaps.
  The grouping already lives on the strategy page.

### What a row says about Canary

- A market's row shows the round-trip return of Canary's ordinary trade as a number: "98.5% back".
  That trade is a 0.01 SOL buy sold straight back, or the reference size Canary uses on a market with no SOL side ([`pipescope-canary.md`](pipescope-canary.md), The money side and sizes).
- Beside it, at most one result, the one a trader most needs, as an outcome and a short phrase.
  It is chosen in this order:
  1. a stranded market: fail, "the strategy's current version cannot read this market";
  2. a market that refuses every trade by its own rules: not run, with the strategy's error;
  3. the first fail, in the checks' fixed order;
  4. the first warn among the exit test's checks;
  5. the first other warn.
- A market with nothing in that list shows the number alone.
- A row never shows a count of outcomes, because a count reads as a score.
- As built (`PIPESCOPE-149`): the phrase is written by `terminal-api` from the result's own numbers, such as "a 0.01 SOL round trip returned 48.6%", "buys of 1 SOL or more could not sell back" or "five buyers leaving in turn got back 49.5% together", or else the check's plain name; on a market of three or four mints the ordinary trade's return is that of the pair that returned least.
  A strategy's row counts its markets that the version cannot read ("6 of 8 markets cannot be read by this version"), a count of markets and never of outcomes.

### Filters

- Four filters sit above the markets table: liquidity, volume in 24 hours, created, and "Hide markets with", which lists Pipeline's trust flags that are present, each with Pipeline's fixed description.
- Every filter starts off ([`pipescope.md`](pipescope.md), Listing).
  With none on, the line under them reads "All 61 markets are listed. Nothing is curated or hidden."
  With any on, it reads "Showing 12 of 61 markets." with a link that clears them.
- The filters live in the page's address, so a filtered feed can be linked: `liquidity` and `volume` hold a step in SOL, `created` holds `1h`, `24h` or `7d`, and `hide` holds flags separated by commas; any other value is ignored (`PIPESCOPE-119`).
- Liquidity and volume are measured on a market's SOL side, since there are no dollar prices to compare other mints by.
  While either is on, a market with no SOL side is left out, and the line under the filters says so.
  On 2026-11-10 that was 28 of devnet's 61 markets.
- A filter that leaves nothing shows "No market matches these filters. Loosen one, or clear them all."

## Market page

At desktop width the page has two bands.
The top band is the chart with the trades beneath it, and the trade box in a column on the right that stays in view while the page scrolls.
The lower band is the explanation and the strategy's forms on the left, and the facts panel on the right.

- **Head**: the pair, base first; the market's short address with Copy; its strategy, linked; when it was created; an explorer link; and "Get alerts in Telegram" once the bot exists.
- The layout that was drawn and not chosen put Canary's results and the explanation first, with the chart and the trade box in a side column.
  Canary's most pressing finding already reaches a trader where they act, in the trade box, so the page keeps the order every terminal has taught.

### Price direction

- A price is always an amount of the **quote mint** for one of the **base mint**.
- For any two mints of a market, the quote mint is wrapped SOL if either is it, else USDC if either is it, else the one that comes later in the market's own order of mints.
- A market's default pair is its quote mint by that rule over all its mints, and its first other mint as the base.
- `terminal-api` works this out, from the quote mint order in its config module, and returns a `quote_mint` and a `base_mint` with every market, candle series and trade.
  The pages and the Telegram bot read those fields and never work it out themselves, so they cannot disagree.
- A "Flip" control beside the chart's price shows it the other way round, and the choice stays in the page's address.
- A trade is a **Buy** when the trader paid in the quote mint and a **Sell** when they received it.
  The bot's Buy button pays with the fee mint of a two-mint market that has exactly one ([`pipescope-telegram.md`](pipescope-telegram.md), Buy, Sell and Trade); by the rule above that mint is the quote mint, so chat and page use the words alike.

### Chart

- Candles drawn by TradingView Lightweight Charts from Aviary's own candles, for the pair on show.
- Above it: the last price, as "0.0₇2307 SOL for one PE2E", with the Flip control, and the candle lengths.
- A chart opens at 15 minutes.
  The lengths offered are 1 m, 5 m, 15 m, 1 h, 4 h and 1 d; the indexer also keeps 1 s and 15 s candles ([`pipescope-architecture.md`](pipescope-architecture.md), Candles), which the list in the config module can add.
- An up candle is hollow and a down candle is solid, both in ink.
  The convention on other terminals is green and red; it was drawn behind a switch and not chosen, so that the page keeps one rule about colour.
- Under the chart, one line gives the candle under the pointer, or the latest: its start, open, high, low and close, and how many trades it holds.
- A note says where the chart comes from: "Built from Pipeline's swap events on this market: 5 swaps so far. Prices are in the market's own mints; there are no dollar prices on devnet."
- A market with no trades shows a short panel and no empty grid: "No swap has gone through Pipeline on this market yet, so there is no price to chart. The trade box gives a live quote from the strategy itself."
- A market with one trade still shows its one candle, at a readable size: the chart gives each candle 16 px whatever its width, the newest at the right, and a reader scrolls back for older ones (`PIPESCOPE-112`).

### Trade box

From top to bottom:

1. **"You pay, fees included"**: the amount, and the mint to pay with.
   When a wallet is connected, the balance in that mint sits beneath it with "Use it all", which for SOL keeps 0.01 SOL back for network fees and rent.
2. **"Switch the two sides"**, which swaps the two mints and clears the amount.
3. **"You receive, expected"**: the quote's output, and the mint to receive.
4. **"Slippage you accept"**: 0.5%, 1% and 3%, and a box for another value up to 50%.
5. **"What this swap costs"**, always open:
   - Goes into the market;
   - Pipeline fee, 0.25%: of what goes into the market, or, on a trade into the market's fee mint (since Pipeline 0.3, wrapped SOL on a market that trades it, `BAR-44`), of what arrives, shown in that mint;
   - Aviary fee, 0.5%, or "Aviary fee, none on this swap: only charged when you pay in SOL or USDC";
   - The strategy's own fees and taxes: included in the quote;
   - Leaves your wallet;
   - Expected output;
   - Minimum received, after 1% slippage.
6. The exit-test notice, when there is one.
7. The button.
8. One line: "One market, one hop, exact in. Every swap is simulated before your wallet is asked to sign. Devnet tokens have no value."

- The box opens paying the quote mint and receiving the base mint.
- Each side lists every mint of the market, so a market with three or four mints is traded between any two; choosing the mint the other side already has moves the other side to another mint.
- A quote is asked 350 ms after the last keystroke, and an answer to an earlier amount is thrown away.
- The fee rates are the ones the API returns, never numbers written in the page.
- **The button** reads, in turn: "Connect wallet"; "Enter an amount", off; "Getting a quote", off; "Review swap".
  When it is off for a reason the trader can act on, the reason is under it: "Tick the box above to say you have read it." or "There is no quote to build a swap from."
- **A refused quote** shows in the box, decoded, with the raw error beneath: "No quote: the strategy refused. `WrongStatus`: Not allowed in the curve's current status".
  The quote is itself a simulation, so the program's last log lines go behind a disclosure beneath it, as a failed simulation's do; with no quote there is nothing to review.
- **The exit-test notice** ([`pipescope.md`](pipescope.md), A failed exit test in the trade box) sits directly above the button, on canary yellow: "In Canary's test on 10 Nov 2026, a wallet that bought 1 SOL or more could not sell back; buys of 0.1 SOL and less sold back. The strategy refused the sale: WrongStatus, "Not allowed in the curve's current status"."
  Beneath it is one tick box, "I have read this", and the button stays off until it is ticked.
  The tick is asked again on every visit to the page and is stored nowhere.

### The amount typed

- The amount the trader types is everything that leaves their wallet for the swap, fees included.
- Pipeline counts an exact-in amount as what goes into the market, with its fee and the integrator fee taken on top.
  So the page works the market amount back: the amount typed, divided by one plus the two fee rates, rounded down to a whole base unit.
  With both fees that is the amount divided by 1.0075, and with Pipeline's alone by 1.0025.
- The breakdown shows both ends: "Goes into the market" and "Leaves your wallet", and the second equals what was typed.
- On a trade into the market's fee mint (since Pipeline 0.3, wrapped SOL on a market that trades it, `BAR-44`) Pipeline takes its fee out of what arrives instead, so the page divides by one plus the integrator rate alone, and the expected output and the minimum received are what the trader keeps after Pipeline's fee (the SDK's `keptAfterOutputFee`); the swap's minimum is the kept amount, as the router checks it.
- Checked on devnet on 2026-11-12: for 0.1 SOL typed, 0.099255583 SOL goes into the market, Pipeline's fee is 0.000248139 SOL and the integrator fee is 0.000496278 SOL, which add up to exactly 0.1 SOL.
- The amount in a trade link and in the bot's `/buy` and `/sell` means the same, since a filled-in trade box behaves as if the trader had typed it ([`pipescope-telegram.md`](pipescope-telegram.md), The trade link).
- The alternative, Pipeline's own meaning with the fees added on top, was not chosen: a trader who types 1 SOL would see 1.0075 SOL leave.

### Review and sign

Asking to swap never opens the wallet straight away; the trader first sees what was checked.

1. "Review swap" replaces the breakdown with a panel headed "Review this swap", which reads "Building the swap and simulating it, exactly as it would be signed."
2. When the simulation passes: "The simulation went through. It used 101,315 compute units. This is what signing would change in your wallet:", then what leaves in the mint paid, what arrives in the mint received as "expected, at least", and the network fee, with the rent for a new token account when one is created.
3. "Sign in wallet" turns on, beside "Back", with the line "Signed in your own wallet. Aviary never holds your keys."
4. When the simulation fails: "The simulation failed, so there is nothing to sign.", the error decoded ("The strategy refused it: WrongStatus"), the last lines of the program's log behind a disclosure, and the line "The sign button stays off while the simulation fails."
   A wallet that holds too little is told so in those words.
5. After the wallet signs and sends, the panel shows the transaction as sent, with its explorer link, then as confirmed once the API has read it back, and the trade appears at the top of Trades ([`pipescope-architecture.md`](pipescope-architecture.md), Trading path).
6. If the trader declines in the wallet, the panel returns to step 3 and nothing has changed.

- Changing the amount, a mint or the slippage leaves the review and asks for a new quote.
- A custom action, creating a market and unwrapping SOL follow the same steps: simulate, show the balance changes, then sign.

### Markets that cannot trade

- **A stranded market** has no trade box.
  In its place: "This market cannot be traded through Pipeline. The current version of its strategy, deployed in slot 520,151,758, cannot read this market's state, so it can give no quote and take no swap. The market was left behind by an upgrade of the strategy.", and what its vaults still hold.
  The page's head carries the same fact as a fail, and the chart and the trades stay.
- **A market that refuses every trade by its own rules** keeps its trade box, under the line "This market refuses every trade by its own rules (WrongStatus: Not allowed in the curve's current status). A quote here returns the strategy's own error."
  Its rules may let it trade again, and the strategy's own answer is the best evidence of whether they do.
- Neither is hidden from any list ([`pipescope.md`](pipescope.md), Listing).
- As built (`PIPESCOPE-151`): "The market was left behind by an upgrade of the strategy." is said only when the market was created before its strategy's current version was deployed, since a market created on a version that cannot read it was never left behind.
  What Canary saw is read with the page, so the head, the trade box and the facts panel agree from the first paint; when it cannot be read, Canary's part says so with Try again, and the trade box says it cannot repeat what Canary saw.

### Trades

- A table of the market's swaps, newest first: when, Buy or Sell, paid, received, price, trader and a link to the transaction.
- The 40 most recent show, with "Show earlier trades" beneath them.
- No trades: "No swap has gone through Pipeline on this market yet."
- On a market of three or four mints, a trade between two mints other than the pair on show is read by its own pair, as the API gives it: Buy or Sell of that pair's base, priced in that pair's quote mint, with the pair named under the price (`PIPESCOPE-155`).

### Explanation, actions and facts

- **Explanation**: presentation A, as [`pipescope-explainer.md`](pipescope-explainer.md) specifies it.
  On a market page one code-written line follows the summary: "It describes the strategy version, not this market: where it says "the sampled market", it means the strategy's busiest one. This market's own facts are in the facts panel."
  With none yet: "No explanation for this version yet.", then that one is written once for each strategy version, only after its cost is approved, and that opening a page never makes one.
- **Actions**: one form for each action in the strategy's metadata, closed except the first.
  A form's heading is the author's label with "calls `<instruction>`" beside it.
  Inside, in order:
  - a result line saying which instruction of which program it calls and whether an instruction of that name is in the deployed program: a pass when it is, and a warn, "what this form calls could not be checked", when it is not;
  - the line "You sign this directly on the strategy. The router's swap protections (a minimum received, nothing taken beyond what you signed) do not apply to it.";
  - the fields, each with the author's label and, plainly, the argument's name and type;
  - a table headed "Every account it touches": the account's name, what it is in words ("your wallet", "the market's vault for SOL", "an address derived from the program itself by a rule in the metadata", "a fixed address"), whether the action can change it, and whether it signs;
  - "Simulate this action", which leads to the same review as a swap.
- A strategy whose metadata is unavailable shows, under Actions: "No forms. Aviary builds a strategy's forms from its metadata, and this strategy's metadata is unavailable: the link could not be fetched.", what Pipeline's validator said about the document behind a disclosure, and how many instructions the deployed program has beyond Pipeline's own.
- **Facts**, under the line "Read from the chain and measured by Aviary. No score, and no verdict.", in four parts:
  1. **What Canary saw**, with Canary's mark: "Canary traded a private copy of this market on 10 Nov 2026, 04:54 UTC, as a trader would, and recorded what happened. It detects; it cannot prove a market safe, and a result is no promise about a later trade or a later version."
     Fails come first and open, then warns, then what was not run with like reasons folded into one line, and last a disclosure, "The checks that passed, and what Canary only noted".
     A check over several sizes or waits shows one row a step, as "1 SOL: could not sell back" and "0.1 SOL: 98.6% back", each with a bar in ink.
  2. **This market**: its address and market state, who created it and when, what each vault holds, the last 24 hours, and whether the strategy supports exact-out swaps, which Aviary does not trade.
  3. **Its strategy**: the program, who can upgrade it, the current version's slot, the verified build or "None: source not verified", the metadata's status, and Pipeline's trust flags with their fixed descriptions.
  4. **Its mints**: for each, where its name comes from, its token program, decimals and supply, its mint and freeze authorities, its extensions, what share of the supply this market's vault holds, and its trust flags.
     SOL and USDC read "Named by Aviary. It names SOL and USDC itself, and no other token."
- Until the explanation and the forms land beside it, the facts panel has the lower band to itself, at its full width, its parts side by side and one under another on narrow screens (`PIPESCOPE-121`).
  Since [#123](https://github.com/imDev2023/testing-pipeline/issues/123) the forms sit on the left and the facts panel on the right, its parts one under another.
- **A product's panel**: when the market's strategy is one of our products, its panel sits on the left of the lower band, after the trades and before the explanation, and its own forms under Actions after the strategy's, from a registry in `terminal-web` keyed by strategy program (`PIPESCOPE-147`, `apps/terminal-web/src/products/registry.ts`); no other market shows them; a product may name the metadata forms its own fill in, which Actions then leaves out, and give its own create form, which the create-market page shows in place of the metadata's (`PIPESCOPE-162`).
- **After an upgrade** ([`pipescope.md`](pipescope.md), When a strategy is upgraded): the notice "Upgraded on <date>; tests and explanation for this version are pending." sits under the page's head, and Canary's part and the explanation each read as pending until the new version has its own.
  As built (`PIPESCOPE-150`): the notice is shown while the strategy's current version has no Canary result of its own and an older version is recorded: on a market page created before the upgrade until that market has one, since a market made since never saw the version before, and on the strategy page until any of its markets has one; the date is the day the upgrade's transaction landed, or the day Aviary first saw the version when that transaction is not found yet.
  The explanation's own part reads as pending until it exists ([Aviary: the explanation on the pages](https://github.com/imDev2023/testing-pipeline/issues/127)): as built, it says "No explanation for this version yet." until the new version's key has its explanation, and from then on the notice reads "Upgraded on <date>; tests for this version are pending." until Canary's results arrive, so it never contradicts the explanation below it (`PIPESCOPE-159`).

### Arriving from Telegram

What [`pipescope-telegram.md`](pipescope-telegram.md) asks of the pages, and where each sits.
None of it was in the prototype, which was shown before that spec landed.

- **A trade link** fills the trade box from `in`, `out` and `amount` in the page's address, and the box then asks for a quote as if the trader had typed.
  A value that fails its check is ignored without a message.
- **On a phone with no wallet**, the trade box's button and the header's wallet button both open a short list in place of "Connect wallet": "Open in Phantom", "Open in Solflare" and "Open in Backpack", each a link that reopens the same address, parameters kept, in that wallet's browser.
- **"Get alerts in Telegram"** is a link in the head of every market page and strategy page, beside the explorer link.
- **The official bot and channel** are named in the footer of every page.
- The last two appear only when the API returns a handle, so nothing links to a handle that does not exist yet.

## Strategy page

From top to bottom, with the explanation beside the facts at desktop width.

1. **Head**: the strategy's name and short address, with its description under the name, both in the author's style (`PIPESCOPE-120`), or its short address and "Metadata unavailable, so it is listed under its address" ("Metadata not read yet" before its metadata is first fetched); how many markets it has; when it was registered; an explorer link; and "Get alerts in Telegram" once the bot exists.
2. **Explanation**: presentation A.
3. **Facts**, under the line "Read from the chain by Aviary, worded as Pipeline's own SDK words them. No score, and no verdict.": the program; who can upgrade it; the current version's slot and date; its code hash; the verified build; the metadata's status, with the link itself as plain text; when it was registered and the listing fee paid; its markets; its trust flags; and its instructions beyond Pipeline's own, with the line "Found by name in the deployed program. People call these directly on the strategy, outside the router. Canary lists them and does not call them."
4. **What Canary saw on this version**:
   - one sentence first: "Canary traded a private copy of each of this version's 8 markets on 10 Nov 2026, as a trader would. 6 of 8 cannot be read by this version. On the markets that trade, a 0.01 SOL buy sold straight back returned 98.3% to 98.4%. Canary detects; it cannot prove a strategy safe.";
   - then one line for each check, in the checks' fixed order: its plain name ("Buy, then sell straight back"), what it does, and how many of the version's markets got each outcome ("fail, 6 of 8", "pass, 2 of 8", "not run, all 8 markets");
   - a line with a fail or a warn opens to the sentence and to the markets it holds for, each linked.
5. **Its markets**: the feed's table without the strategy column.
6. **Version history**: one row for each strategy version, newest first, with its date, its slot and a link to the transaction.
   The newest reads "The current version. The results and explanation on this page are for it."
   An older one keeps its own results, labelled as that version's.

- As built (`PIPESCOPE-161`, [#127](https://github.com/imDev2023/testing-pipeline/issues/127)): the explanation sits beside the facts above 1080 px and above them at 1080 px and narrower, as on the market page; in the full explanation a stated point has a solid bullet, an inferred one a hollow bullet and the word "inferred", and an author point a bullet and a sentence in the author's colour, upright since only Literata's upright face is served, with "the author's words" beside it, under a key to the three.
- The layout that was drawn and not chosen was a grid of markets against checks.
  It needs a pointer to read a cell, which a phone does not have, and a strategy with 23 markets does not fit one.

## Wallet page

- **Not connected**: one sentence saying what the page shows, and the "Connect wallet" button.
- **Head**: the whole address with Copy, the SOL balance, an explorer link and "Disconnect".
- **Unwrap**: when the wallet holds wrapped SOL, an offer naming the amount, with "Unwrap", which simulates closing the wrapped SOL account, shows the SOL that would come back, and then asks the wallet to sign.
- **"What you hold that trades on Pipeline"**: each token, its balance, and the markets it trades on, linked.
  Beneath: "1 token in this wallet is not listed because no Pipeline market trades it. Balances are in tokens; there are no dollar prices on devnet."
- **"Your swaps through Pipeline"**: when, the market, paid, received, the fees and a link to the transaction.
  Beneath: "Every swap this wallet made through Pipeline's router, on Aviary or anywhere else. Trades that bypass the router leave no swap event and are not here."
- As built ([#122](https://github.com/imDev2023/testing-pipeline/issues/122)):
  - wrapped SOL is not listed among the tokens: the offer names it, "Wrapped SOL" its panel, and "Unwrap" closes the wrapped-SOL accounts the wallet owns into it, empty ones too for their rent, as many as one transaction holds, the rest offered again after (`PIPESCOPE-152`);
  - the tokens listed are those the wallet holds a non-zero balance of that a market Aviary has indexed trades, ordered by the name shown, each with its markets as pairs, base first, newest first; tokens no market trades are counted, empty token accounts not at all (`PIPESCOPE-153`);
  - each swap's market is its pair, base first, linked; its fees are Pipeline's in the fee mint and, when charged, the integrator's in the input, named "Aviary" when it is Aviary's fee wallet; 40 swaps show, with "Show earlier swaps" beneath.

## Create market

- **Head**: "Create a market", and "A market is made from a registered strategy's own create form, with mints that already exist. Aviary does not create tokens or register strategies; developers register a strategy from the command line."
- **"Choose a strategy"**: every registered strategy, by name and short address, with how many markets it has and who can upgrade it.
  One with a create form opens it.
  One without says why: "No create form: its metadata is unavailable (the link could not be fetched)."
- **The create form** is built like an action form: the instruction it calls and whether it could be checked, the author's labels marked as the author's, every account it touches, then simulate, review and sign.
- A mint is entered by address, and its facts appear beneath the field as soon as it is read, so a creator sees what they are about to list.
- After the market is created, the page links to its market page.
- When no strategy has valid metadata, as on devnet on 2026-11-10, the page says so above the list: "No strategy on devnet has valid metadata today, so none offers a create form here. Their markets were created from their authors' own tools."

## Search

- The search box is in the header of every page.
  Results appear as the reader types, 220 ms after the last keystroke, and on Enter, on a page whose address holds the query.
- Results are grouped as Strategies, Markets and Mints, each with its count, and at most 20 a group, with "The first 20 of 34. Type more of the name or the address to narrow it." (as built; the prototype's "Type more of the address" missed groups matched by name).
- **Names** match anywhere and in any case: a strategy's name from valid metadata, and a token's symbol and name.
- **Addresses** match exactly as typed, from their start or their end, the two parts people copy or remember: a strategy's program, a market, a market state or a mint.
  Base58 is case-sensitive, so "AbC" and "abc" are different addresses.
- A mint's result names the markets it trades on, linked.
- Beneath the mints: "Token names are each token's own claim. Aviary names only SOL and USDC itself, and marks no other token as verified, so check the mint address."
- **Nothing typed**: what can be searched for, with three examples that work.
- **No match**: "Nothing registered with Pipeline on devnet matches <query>.", and that a token trading on no Pipeline market does not appear and two tokens can share one name.

## Fees and Devnet help

- **Fees** is one table and three short parts.
  - The table has a row each for the Pipeline fee, the Aviary fee, the strategy's own fees and taxes, and the Solana network fee, with its rate, when it is charged and who gets it.
  - "An example": 1 SOL paid for a token, with what goes into the market and what each fee takes.
  - "What carries no Aviary fee": swaps paid in any token other than SOL or USDC, a strategy's own actions, and creating a market.
  - "What the fee cannot do": the swap is built from exactly the rate on screen, every swap is simulated before signing, and Aviary never holds tokens or keys.
  - Every rate on the page is read from the API, and Pipeline's own from the router's settings; none is written into the page.
- **Devnet help** has four parts: "Point your wallet at devnet", with the steps for Phantom, Solflare and Backpack; "Get devnet SOL", naming Solana's web faucet; "Get devnet USDC", naming Circle's faucet and the devnet USDC mint; and "What is different on devnet", which says there are no dollar prices, that an upgrade can leave older markets unreadable, and that nothing here says anything about a later mainnet version of the same program.
  Aviary has no faucet of its own.
  The faucets named are checked on the day the page ships and kept in one content file, because which of them work changes ([Checked facts and open checks](#checked-facts-and-open-checks)).

## Token names and images

- A token is shown by the symbol from its mint's own metadata, in the author's style, with the mint's short address beside it ([`pipescope.md`](pipescope.md), Tokens and prices).
  A mint with no metadata is shown by its short address alone.
- SOL and USDC are named by Aviary, plainly, with marks that ship with the app.
  As built (`PIPESCOPE-125`): marks Aviary draws itself in the page's ink at 20 px, three slanted bars for SOL and a ringed dollar sign for USDC, since the brands' own logos would bring colours the page never uses.
- As built (`PIPESCOPE-122`): the name is read from the mint's Token-2022 token metadata extension, or else its Metaplex metadata account, and kept as the author-text normaliser leaves it, the symbol capped at 16 characters and the name at 64; a token that gives no symbol is shown by its name.
- **A token's image is shown**, 20 px square, beside its symbol wherever the symbol appears.
  Its box has a fixed size, so no row's height depends on an author's file.
- An image is an author's claim like the name: it gets no border, tick or mark of ours, and the short address stays beside it.
- **A reader's browser never asks an author's server for anything.**
  `terminal-api` fetches the image named by the token's metadata once, under the metadata fetcher's limits ([`pipescope-architecture.md`](pipescope-architecture.md), Metadata fetcher), and serves its own copy.
- Only PNG, JPEG and WebP are kept, told by the file's first bytes and not by what the server claims, and at most 1 MB.
  SVG is never kept, since it can carry script.
- The copy is served with its type fixed, with `X-Content-Type-Options: nosniff`, and from a path that runs no script.
- A token whose image is missing, too large, of another type or unreachable shows no image and no placeholder.
- The alternatives were leaving images out, and linking to the author's file, which would tell the author who looked at a market and when, and let them change the picture for each viewer.

## Phones and narrow windows

- Nothing scrolls sideways at any width down to 360 px.
- At 1080 px and narrower the market page is one column, in this order: head, chart, trade box, trades, explanation, actions, facts.
  The trade box is no wider than 560 px and no longer stays in view.
- At 720 px and narrower every table becomes a list of small blocks, one a row, with each value under its column's name.
- At that width the header is three rows: the name with the wallet button, the three links, and the search box at full width.
  Text is 15 px, and every field and button is at least 44 px high.
- The alternatives were tables that scroll sideways, and a Trade bar fixed to the bottom of the screen, which covers the page in wallets' in-app browsers.

## What the prototype did not show

Each of these is specified above or in another file, and none was seen running, so the build's first look at it is its first test.

- Live updates: new rows arriving on the feed and on Trades, and a candle that moves as trades land.
  New rows are added at the top, the row under the pointer never moves, and nothing flashes for a reader who has asked for reduced motion.
  As built (`PIPESCOPE-111`): while the pointer or the keyboard focus is on the table, new rows wait behind a "Show 2 new trades" button beside the table's heading and join the top as soon as it leaves, and a resync that brings more than a page waits there too, as "Show 40+ new trades", replacing the list on leaving; a row already shown is updated in place; a new row is washed for a moment only for a reader who allows motion; the forming candle is read again from the API at most once a second; and a dropped room is joined again after a wait that doubles from a second (`LIVE_RECONNECT_FIRST_MS`) up to 15 s (`LIVE_RECONNECT_MAX_MS`).
- A real wallet: connecting, the wallet's own prompt, a declined signature, and a wallet set to another cluster.
- The steps after signing: sent, confirmed, and the trade appearing.
- A form from valid metadata, simulated and signed, and the create form end to end.
- A market with three or four mints.
- Token images.
- Everything under [Arriving from Telegram](#arriving-from-telegram).
- The panels that the tax AMM, the containment hook, the buy wall AMM and the lending AMM add to a market page.
- Paging on the feed, on Trades and on the wallet's swaps.

## Checked facts and open checks

- **Checked on devnet, 2026-11-10 and 2026-11-12**:
  - Pipeline's hosted devnet API answers a quote with the amount into the market, both fees and the total leaving the wallet, and the total equals the amount typed when the market amount is worked back as [The amount typed](#the-amount-typed) says.
  - A swap built for this project's devnet wallet simulated successfully on the public devnet RPC and used 101,315 compute units.
  - A quote on a market that refuses trades returns the strategy's own error (`Custom(6004)`), which decodes to its name and message.
  - No strategy on devnet had valid metadata: five links could not be fetched, and three documents failed Pipeline's validator.
    The forms were drawn from those three documents behind a prototype switch.
  - 18 of the 81 mints in Pipeline markets name themselves, all through Token-2022 metadata, and none has Metaplex metadata.
  - No devnet market has more than two mints, and 28 of 61 have no SOL side.
  - The public devnet RPC answers an airdrop request with 410, "The RPC faucet is closed on this cluster", so `solana airdrop` against it fails and Devnet help names the web faucet.
  - The dark theme was looked at on the feed at desktop and phone width, on a strategy page and on a market page; the wallet, create market, search and static pages were not opened in it.
- **Open, for the build**:
  - Whether any devnet mint's metadata names an image, and what the first real ones look like at 20 px: answered by [Aviary: token names and images, and search](https://github.com/imDev2023/testing-pipeline/issues/120), see its pull request.
  - How Phantom, Solflare and Backpack behave when asked to sign for devnet while set to mainnet; Devnet help's words about a mismatch wait on it.
  - Which faucets work on the day Devnet help ships.

## For other tickets

- [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22):
  - this file, and the prototype branch as its primary source;
  - the three homes for values under [One place for every value](#one-place-for-every-value), of which the screens' config module and the theme stylesheet are new;
  - `quote_mint` and `base_mint` on every market, candle series and trade the API returns, and Canary's sentences served with each result;
  - where `terminal-api` keeps its copies of token images, since the architecture's Data section names no store for files;
  - the default slippage, which [`pipescope.md`](pipescope.md) (Trading) still writes as a number and this file gives a home.
- [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32): the trade box has its own rule for which mint a market is quoted in ([Price direction](#price-direction)), so the bot reads `quote_mint` from the API; its Buy button already pays with that mint.
  The amount in a trade link is everything that leaves the wallet, fees included.
- The products' panel tickets ([the tax AMM's](https://github.com/imDev2023/testing-pipeline/issues/75), [the containment hook's](https://github.com/imDev2023/testing-pipeline/issues/76), [the buy wall AMM's](https://github.com/imDev2023/testing-pipeline/issues/57) and [the lending AMM's](https://github.com/imDev2023/testing-pipeline/issues/88)): a panel is Aviary's own reading of the chain, so it is set plainly, takes its colours from the theme stylesheet, and uses no green or red.
  It sits on the market page between the trades and the explanation, and its forms go under Actions with the strategy's others, as built in #123 (`PIPESCOPE-147`); a panel reads the chain through the API's one-slot read (`PIPESCOPE-146`).
