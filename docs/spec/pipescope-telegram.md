# Aviary: the Telegram bot

Decided with the owner in [Telegram bot for Pipescope](https://github.com/imDev2023/testing-pipeline/issues/32) on 2026-11-10.
It hangs off Aviary's first devnet version ([`pipescope.md`](pipescope.md)), its architecture ([`pipescope-architecture.md`](pipescope-architecture.md)), its Canary checks ([`pipescope-canary.md`](pipescope-canary.md)) and its explainer ([`pipescope-explainer.md`](pipescope-explainer.md)).
Telegram's and the wallets' documentation was read on 2026-11-10; what it did not settle is listed under [Checked facts and open checks](#checked-facts-and-open-checks).
[Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22) merges this file with the other Aviary spec files.

Decision: [ADR 0007](../adr/0007-telegram-trades-are-signed-in-aviarys-trade-box.md) (a trade that starts in Telegram is signed in Aviary's own trade box).

## What the bot is

- A second way into Aviary's data and trade box, in Telegram: it answers lookups with the same facts and Canary results the pages show, links to the trade box, and sends alerts.
- It holds no key and signs nothing.
  It never builds, shows or sends a transaction, and it never asks for a private key, a seed phrase or a wallet address.
- Devnet only, like Aviary, and every card and alert says so.
- It shows neutral facts and no verdicts, lists everything and curates nothing, and treats strategy metadata and token metadata as untrusted author text, exactly as the pages do.

## First version

In:

- **Lookups**: a card for any market or strategy, by address or by name, with its facts and Canary results.
- **Trade links**: Buy and Sell buttons under a market card that open Aviary's trade box with the swap filled in.
- **Alerts**: new strategies and new markets, and for what a chat watches, upgrades and changed Canary outcomes.
- **A public channel** that carries every new strategy, new market and strategy upgrade, unfiltered.
- It works in private chats and in groups.

Not in the first version:

- holding keys, signing or sending transactions, in any form: that is out of scope for good, not for now (the map's Out of scope);
- a Mini App, and wallet-direct transaction links ([ADR 0007](../adr/0007-telegram-trades-are-signed-in-aviarys-trade-box.md));
- anything about a trader's wallet: no balances, no past swaps, no saved address;
- custom actions and creating a market from chat, which stay on Aviary's pages behind an Open in Aviary button;
- inline mode;
- alerts on trades, amounts or quotes;
- chart images;
- languages other than English.

## Trading from Telegram

[ADR 0007](../adr/0007-telegram-trades-are-signed-in-aviarys-trade-box.md).

- A trade that starts in Telegram is signed in Aviary's own trade box, in the trader's own wallet.
  The bot's part ends at a **trade link**: a plain link to Aviary's market page with the swap filled in.
- Nothing changes before signing, because it is the same trade box: the 0.5% integrator fee only when the trader pays with a fee mint, the fee breakdown always shown, the simulation before every signature, the 1% default slippage, and the tick box when the exit test saw a buyer who could not sell back ([`pipescope.md`](pipescope.md), Trading, The integrator fee, Facts and Canary results).
- There is one rate for every trade, wherever it started.

### The trade link

- It is the market page's address with three query parameters: `in` (the input mint), `out` (the output mint) and, optionally, `amount` (a decimal amount of the input mint).
- The page checks them: both mints must belong to the market and differ, and the amount must parse.
  A parameter that fails is ignored and the trade box opens as it would without it.
- A filled-in trade box behaves as if the trader had typed it: it shows the quote and the fee breakdown.
  Nothing is prepared for signing until the trader connects a wallet and asks to swap.
- The link carries nothing else: no Telegram account, no chat and no tracking id, so Aviary cannot tell which chat a trade came from.

### Buy, Sell and Trade

- In a two-mint market where exactly one mint is a fee mint (SOL or USDC), the card has a **Buy** button, which pays with the fee mint, and a **Sell** button, which pays with the other mint.
- Any other market (no fee mint, two fee mints, or more than two mints) gets one **Trade** button, which opens the trade box with nothing filled in.
- If [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16) gives the trade box its own rule for which mint a market is quoted in, the bot takes that rule from the same API field, so chat and page never disagree.
- The buttons carry no amount: the trader types it in the trade box, where the quote, the fees and the minimum received update as they type.
- `/buy <market> <amount>` and `/sell <market> <amount>` answer with the same link with the amount filled in, for people who prefer to type it in chat.
- A stranded market has no trade box on its page, so its card has no trade button and says the strategy's current version cannot read it.

### On a phone

- Telegram opens a link in its own in-app browser, which has no wallet.
- So Aviary's market page, when it finds no wallet on a phone, offers to reopen the same address, with the trade parameters, inside Phantom, Solflare or Backpack, through each wallet's browse link ([Checked facts and open checks](#checked-facts-and-open-checks)).
  This chooser belongs to the web app and serves every phone visitor, not only those who come from Telegram.
- On a computer, Telegram opens the link in the default browser, where the wallet's extension is.

### What the card says before the link

- Every market card states the fees: the Pipeline fee of 0.25%, the Aviary fee of 0.5% when paying in SOL or USDC and none otherwise, and that the strategy's own fees and taxes are included in the quote.
- When the latest exit test of the market's current strategy version saw a buyer who could not sell back ([`pipescope-canary.md`](pipescope-canary.md), What counts as "a buyer could not sell back"), the card repeats the trade box's notice, word for word, directly above the Buy button.
- The tick box stays in the trade box, and the bot never blocks or hides a trade.

## Lookups

### Commands

| Command | What it does |
| --- | --- |
| `/start` | Says what the bot is and what it never does, and lists the commands; with an address as its start parameter, it shows that address's card |
| `/help` | The commands, and the safety lines of `/start` |
| `/market <address or name>` | A market card, or a list when several match |
| `/strategy <address or name>` | A strategy card, or a list when several match |
| `/search <text>` | Markets and strategies by name, mint, market address or strategy address, as Aviary's search page does |
| `/new` | The newest ten strategies and markets, as the feed lists them with every filter off |
| `/buy <market> <amount>`, `/sell <market> <amount>` | The market's card with the amount filled into its trade link |
| `/watch <address>`, `/unwatch <address>`, `/watching` | The chat's watch list |
| `/alerts` | The chat's alert settings and filters |
| `/fees` | The fee rates, as on Aviary's Fees page |
| `/stop` | Deletes everything the bot stores about the chat |

- In a private chat a message that is not a command is treated as `/search`.
- A list holds at most ten entries, each a button that opens its card, and ends with an Open in Aviary button for the rest.

### The market card

In this order:

1. The market's mints: each symbol from the mint's on-chain token metadata, with the mint's short address beside it; only SOL and USDC are named by Aviary itself.
2. The market's full address, the strategy's name from its metadata with the program's short address, and the strategy version (the slot and date it was deployed).
3. The latest trade's amounts, liquidity, volume and the market's age, in the market's own mints; there are no USD figures.
4. The trust flags that are present, in Pipeline's fixed wording.
5. Canary results for the current strategy version: every fail and warn first, each with its code-written reason and its numbers, then how many checks passed, were not run or were noted, and the date of the run.
6. The "could not sell back" notice, when it applies.
7. The fees.
8. "Devnet."

Buttons: Buy and Sell (or Trade), Canary results, Facts, Explanation, Watch, and Open in Aviary.

- **Canary results** sends every result of the current version, one per check, with its outcome word, reason and numbers.
- **Facts** sends the whole facts panel.
- **Watch** adds the market to the chat's watch list, and becomes Unwatch.
- When the strategy was upgraded and the new version is not yet tested, the card says what the pages say: `Upgraded on <date>; tests and explanation for this version are pending.`

### The strategy card

- The strategy's name from its metadata, the program's full address, who can upgrade it or that it is frozen, the strategy version, verified-build status, metadata status and how many markets it has.
- The Canary roll-up for the current version: for each check, how many markets got each outcome, and how many markets are stranded.
- Buttons: Markets (its markets as a list), Canary results, Facts, Explanation, Watch, and Open in Aviary.

### The explanation

- The Explanation button sends the stored explanation's summary for the current strategy version, under the same code-written label as the pages (it begins `Written by an AI on <date>` and ends "It can be wrong. It is not an audit, a safety rating or advice."), with a button to the full explanation on Aviary, where the evidence chips, the unknowns and the "This is wrong" control are.
- The fixed notice that a strategy's metadata contains text addressed to AI tools is sent whenever the page would show it.
- When the current version has no explanation, the bot says "No explanation for this version yet."
- The bot never asks for an explanation to be made, so it makes no paid call ([`pipescope-explainer.md`](pipescope-explainer.md), Approval queue).

### How results are worded

- Outcome words only (pass, warn, fail, not run, noted), each with its number and its reason.
- No score, no badge, and no coloured or tick-and-cross emoji standing in for an outcome, which would be the green and red the pages rule out.
- A Canary result always carries its strategy version and the date it ran.

## Alerts

### What is sent

| Event | To | When |
| --- | --- | --- |
| A new strategy is registered | The channel; chats with new-strategy alerts on | When the indexer records it |
| A new market is created | The channel; chats with new-market alerts on, after their filters; chats watching its strategy | After the market's first Canary run, or after 5 minutes if that run has not finished, then saying tests are pending |
| A strategy is upgraded (a new strategy version) | The channel; chats watching the strategy or one of its markets | At once, saying tests and the explanation for the new version are pending |
| Canary finishes on that new version | The same chats and the channel, as a reply to the upgrade alert | When the Canary run of the version ends: every outcome that changed from the previous version, or that none did |
| A Canary outcome changes on a watched market | Chats watching that market | When a Canary run stores a result whose outcome differs from the one before it |

- A new-market alert is the market's card.
  It waits for the first Canary run because an alert people act on should arrive with its facts (owner, 2026-11-10).
- An upgrade alert does not wait, because a holder's position is already affected; the results follow as a second message (owner, 2026-11-10).
- A changed outcome is a change of the outcome word of any check except `custom_instructions`, which is only ever noted.
  A number that moves inside the same outcome sends nothing.
- A chat watching several markets of one strategy gets one upgrade alert and one results message, listing its watched markets.
- A stranded market reaches its watchers as the changed outcome of `readable`.
- Alerts are not a tool for trading first.
  The indexer's live socket stays open only while someone is on the site ([`pipescope-architecture.md`](pipescope-architecture.md), Indexer), and Telegram subscribers do not count, so with nobody on the site an alert follows the chain by up to a minute, plus the Canary wait for a new market.

### The channel

- One public channel, posted to by the bot as its admin: every new strategy, every new market and every strategy upgrade with its results, with no filter, because hiding a listing is a judgement.
- Following it needs no setup in the bot.
- At mainnet volume an unfiltered channel may be too busy to read; that is for the mainnet effort.

### A chat's own alerts

- New-strategy and new-market alerts are off until the chat turns them on with `/alerts`.
- A chat can filter its new-market alerts with the feed's filters that fit a market minutes old: a minimum liquidity, and hiding markets by Pipeline's trust flags.
  Every filter starts off.
- A **watch list** holds strategies and markets, up to 100 a chat.
  Watching a strategy sends its upgrades, their results and its new markets.
  Watching a market sends its strategy's upgrades, their results for that market, and its changed Canary outcomes.
- A Get alerts in Telegram link on Aviary's market and strategy pages opens the bot with the address as its start parameter, which shows the card with its Watch button.

## Private chats and groups

- In a private chat anyone can use everything.
- In a group anyone can look things up, and only the group's admins can change its alerts and its watch list.
  The bot reads the group's admin list from Telegram when asked and keeps it for 5 minutes; a command sent by an anonymous admin, which arrives in the group's own name, counts.
- Telegram's privacy mode stays on, so in a group the bot receives only commands addressed to it and replies to its own messages, never the group's other messages.
  If a group makes the bot an admin, Telegram sends it every message; it ignores and never stores anything that is not a command.
- The bot answers only where it was asked: it never sends a first message to a chat, apart from alerts the chat turned on.
- Lookups are limited to 20 a minute a chat.

## Untrusted text in messages

Telegram turns anything that looks like a link, an @name, a /command, a #tag, a $TAG or an email address into something tappable, in any text a bot sends.
So a strategy named after a link would become a link.

- One function builds every message, as text with explicit entities and no parse mode, so no text can add formatting.
- Author text (a strategy's name, a token's symbol, and a program's own error name and message inside a Canary reason) is normalised as the explainer's inputs are (control and text-direction characters stripped, a name cut at 64 characters) and always sits inside a `code` entity, with the address beside it.
  Descriptions, images and links from metadata are never sent.
- Message text never contains a link: every link is a button, and every button's address starts with Aviary's own origin.
- Link previews are off on every message.
- The explanation's summary is model text that Aviary's validator already holds to plain text with no links or domain names; before sending, the bot also checks that Telegram would find nothing tappable in it, and otherwise sends only the button to the explanation on Aviary.
- Button labels are Aviary's own fixed words, never author text.

## Safety against impersonation

Telegram trading bots are widely copied by bots that ask for a seed phrase.

- `/start` and `/help` say that this bot never asks for a private key, a seed phrase or a wallet address, never holds funds, and never messages first.
- The bot has no command or button that accepts a key, connects a wallet in chat, or takes a deposit, so nothing a copy asks for looks familiar.
- Aviary's site names the official bot and channel, and the bot's profile links the site, so each proves the other.
- Every link the bot sends goes to Aviary's own origin, and Telegram asks before opening it.
- The bot token can only send messages as the bot: it is a Worker secret, never in the repo, and if it leaked the damage would be false messages, which is why the bot's links never leave Aviary's origin and why the site names the official handles.

## Where it runs

It adds no service: the bot is part of `terminal-api` ([`pipescope-architecture.md`](pipescope-architecture.md)).

| Part | Runs on | Keeps its data in |
| --- | --- | --- |
| Commands and buttons | A webhook route in `terminal-api`, called by Telegram | Postgres, for a chat's settings and watch list |
| Message building | `packages/terminal-telegram`, pure functions with no network | Nothing |
| Alerts | A Cloudflare Queue with its consumer in `terminal-api`, fed by the `Indexer` and `CanaryRun` Durable Objects | Postgres, for alerts and deliveries |

- **Webhook**: Telegram posts each update to one route, which rejects any request without the secret token Telegram was given (`X-Telegram-Bot-Api-Secret-Token`).
  The route asks Telegram only for the update types it uses.
- **Library**: grammY, through its Cloudflare module adapter, with the bot's own description preset so no request starts with a call to Telegram.
- **Reads**: commands read through the same query functions as the public API's endpoints, so a card and a page cannot disagree.
- **Idempotent handlers**: Telegram sends an update again when it gets no answer in time, so every handler can run twice with no harm: a lookup repeats its reply, and a setting is set to a value, never toggled.
- **`packages/terminal-telegram`** holds the command parser, the renderers (API data in; text, entities and buttons out), and the rule for which chats an alert goes to, so all of it is tested without Telegram.
- **Queue**: the `Indexer` puts a message on the queue when it records a new strategy, a new market or a new strategy version, and `CanaryRun` when a market's first results, a version's run or a changed outcome is stored.
  For a new market the indexer also sends a message delayed by 5 minutes as the deadline; whichever of the two arrives first sends the alert, and the other finds it sent.
- **Fan-out**: the consumer turns one alert into one queue message per chat that should get it, the channel included, and sends each through Telegram.
- **Telegram's limits**: at most 25 messages a second in all, one a second to a chat and 20 a minute to a group, under Telegram's free ceilings; when Telegram answers 429 the message is retried after the wait it names.
  Paid broadcasts are never used.
- **Once per chat**: an alert has a key (the event and its address, version or run), and a delivery is recorded per alert and chat before the queue message is acknowledged, so a retry does not send again.
  A queue delivers at least once, so a send that succeeds just before a crash can repeat; a rare repeat is preferred to a missed alert.
- **Gone chats**: when Telegram reports that the bot was blocked or removed, by an update or by a 403 on sending, the chat's data is deleted.
- **Secrets** of `terminal-api`: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.
- **Vars** of `terminal-api`, per environment: the bot's description, the channel's id, and the site's origin for links.
- **Logs** carry the update's type, the chat's id and the outcome; never message text, a name or a username.

### Cost

- Nothing is bought, and nothing here is a paid call.
- Telegram's Bot API is free.
- Queues come with Workers Paid, which the account already has: 1 million operations a month, and a delivered message costs 3, so about 330,000 messages a month before $0.40 per million operations (the owner's Cloudflare knowledge base, `build/01-compute.md`, from https://developers.cloudflare.com/queues/platform/pricing/).
  Devnet's alerts are a few hundred a month.
- The bot adds no Durable Object, and its webhook requests count against the account's 10 million Workers requests.
- The database is touched only when someone asks or something happens, so it still sleeps when devnet is quiet.

## What the bot stores

- Per chat: Telegram's chat id, whether it is a private chat or a group, its alert settings and filters, its watch list, and when it first turned something on.
- Per alert: its key and which chats it was delivered to.
- Nothing else: no Telegram user id, username, name, phone number or language, no message text, and no wallet address.
  Who is a group admin is asked of Telegram when needed and not stored.
- `/stop` deletes the chat's data at once, and so does being blocked or removed.
- A chat that only looks things up is not stored at all.

## One place for every value

Every value below is a default that can change, and each lives in one place: the config module of `packages/terminal-telegram`, or a var of `terminal-api` where it differs by environment.

| Value | Default | Where |
| --- | --- | --- |
| Longest wait for a new market's first Canary run | 5 minutes | Config module |
| Watch list size | 100 a chat | Config module |
| Lookups | 20 a minute a chat | Config module |
| Entries in a list | 10 | Config module |
| Sending ceilings | 25 a second in all, 1 a second a chat, 20 a minute a group | Config module |
| How long a group's admin list is kept | 5 minutes | Config module |
| Alerts for a new chat | Off | Config module |
| Bot handle, channel, site origin | Per environment | Vars of `terminal-api` |
| Fee rates shown | Read from the API, which reads the fee's own configuration | [`pipescope-architecture.md`](pipescope-architecture.md), The integrator fee's configuration |

## Name and handles

- The bot's public name is Aviary and its handle `@aviarytradebot`; the channel is `@aviarytrade`, matching the site `aviary.trade` and the X handle ([`README.md`](README.md), Names).
- Neither is registered and their availability was not checked (2026-11-10); the owner registers both when the bot goes public, and nothing links to either until it exists.
- Until then the devnet build uses a private working bot under a throwaway handle and a private working channel, neither announced.
  Moving to the public ones changes two vars and a secret.

## When it is built

- Alongside Aviary's web pages (owner, 2026-11-10): its build tickets are cut with Aviary's and start once the API, the facts and the Canary records exist.
- Lookups and alerts need no web page; the trade links go live when the trade box does.

### Owner tasks

1. Before the bot's first build ticket: create the working bot in BotFather, with privacy mode on, inline mode off and groups allowed, and a private working channel with the bot as an admin; the build session sets the token with `wrangler secret put`.
2. When the bot goes public: register `@aviarytradebot` and `@aviarytrade`.

### Suggested build slices

For [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22) to adjust; each is demonstrable on devnet on its own.

1. In the web app, with its pages: the trade link's parameters on the market page, the reopen-in-your-wallet chooser on phones, the Get alerts in Telegram link, and the official handles on the site.
2. The bot's scaffold: the webhook route and its secret check, `/start`, `/help` and `/stop`, the chat's storage, the message builder with its untrusted-text rule, and the working bot wired to the devnet deploy.
3. Lookups: the market and strategy cards, search, `/new`, the Canary results, Facts and Explanation buttons, and the trade buttons.
4. Alerts: the queue, new strategies and new markets with the Canary wait, the channel, and a chat's settings and filters.
5. The watch list: upgrades with their results message, and changed Canary outcomes.

### Tests

- **Renderers**: snapshot tests of every card and alert against recorded devnet results: a stranded market, the outside builder's `cost` fail at 49%, the bonding curve's `exit_sizes` warn with its "could not sell back" notice, and an upgrade whose tests are pending.
- **Hostile text**: the explainer's hostile fixtures, plus names and symbols that are a link, an @name, a /command, a #tag, a $TAG and an email address; every one must come out inside a `code` entity.
- **Against Telegram itself**: with the working bot, send each hostile fixture and check that the message Telegram returns carries no entity the bot did not set.
- **Webhook**: a request without the secret token is refused, and the same update delivered twice leaves the same state.
- **Trade links**, in the web app's Playwright tests: a link opens the trade box with the mints and amount filled in, a bad parameter is ignored, and a devnet swap made from a link is signed in the test wallet and indexed.
- **Phones**: a trade link tapped in Telegram on iOS and on Android reaches the trade box inside each of the three wallets.
- **Delivery**: stopping the consumer in the middle of a fan-out and starting it again sends each chat its alert and no chat a second one.
- **A real chat**: each command sent to the working bot from a real Telegram account, with the replies checked against the pages.

## Checked facts and open checks

Read on 2026-11-10 from Telegram's Bot API reference, FAQ and features pages, each wallet's deep-link documentation and grammY's documentation.

- A URL button takes an HTTP or `tg://` address, and Telegram asks before opening it.
- A bot may send about 30 messages a second in all, one a second to a chat and 20 a minute to a group; a 429 answer names the seconds to wait.
- `setWebhook` takes a `secret_token`, which Telegram then sends as `X-Telegram-Bot-Api-Secret-Token` with every update.
- With privacy mode on, a bot in a group receives commands addressed to it, replies to its own messages and service messages; as a group admin it receives everything.
- Telegram's servers add entities for links, @names, hashtags, cashtags, bot commands and email addresses to message text.
- Message text holds up to 4,096 characters, a button's callback data 64 bytes, and a start parameter 64 characters of letters, digits, `_` and `-`, which fits a Solana address.
- No time limit is documented for a bot editing its own messages.
- Browse links, with the page address and a referrer both URL-encoded: `https://phantom.com/ul/browse/<url>?ref=<ref>`, `https://solflare.com/ul/v1/browse/<url>?ref=<ref>` and `https://backpack.app/ul/v1/browse/<url>?ref=<ref>`.
- Phantom's documentation says it has discontinued Blinks with no plan to resume them.
- grammY runs in a Worker through `webhookCallback(bot, "cloudflare-mod")`, checks the secret token through its `secretToken` option, and skips its start-up call to Telegram when `botInfo` is preset.

Not settled by the documentation, so the build checks each one first:

- Whether text inside a `code` entity is exempt from Telegram's own entities.
  The formatting rules say other entities cannot contain each other, which suggests it is; the test against Telegram itself proves it.
  If it is not, author text is left out of messages and only addresses are shown.
- Whether a wallet's browse link opens the wallet when tapped inside Telegram's in-app browser, on iOS and on Android.
  If one does not, the chooser shows that wallet's link as an address to copy.
- How an anonymous admin's button press arrives; until that is known, a group's settings change by command, which is settled.
- The exact text of Telegram's 403 when a user has blocked the bot; the bot treats any 403 on sending as a gone chat.

## For other tickets

- [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16): the market page accepts the trade link's `in`, `out` and `amount`; on a phone with no wallet it offers to reopen the same address inside Phantom, Solflare or Backpack; market and strategy pages carry a Get alerts in Telegram link; and the site names the official bot and channel.
- [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22): this file, [ADR 0007](../adr/0007-telegram-trades-are-signed-in-aviarys-trade-box.md), the build slices above and the first owner task.
  The bot adds to `terminal-api` a webhook route, a queue with its consumer, two secrets and three vars, and to the repo `packages/terminal-telegram`.
- [Decision register open to MetalLegBob's review](https://github.com/imDev2023/testing-pipeline/issues/43): this ticket's decisions are listed in its resolution comment, each with its alternatives and where it lives.
