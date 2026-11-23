# Aviary: architecture

Decided in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13) with the owner on 2026-11-10.
It builds on the findings of [Where Pipescope's indexer gets its data](https://github.com/imDev2023/testing-pipeline/issues/6) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/indexer-data-source/research/indexer-data-source.md)), [Where the quoter runs for Canary checks](https://github.com/imDev2023/testing-pipeline/issues/7) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/quoter-hosting/research/quoter-hosting.md)), [Prior art for behavioural testing of Solana programs](https://github.com/imDev2023/testing-pipeline/issues/8), [Prior art for AI explanations of contracts, and what an explainer can safely say](https://github.com/imDev2023/testing-pipeline/issues/9) and [How the containment hook works with the router and unlocks](https://github.com/imDev2023/testing-pipeline/issues/10), and on the explainer spec in `pipescope-explainer.md`.
Patterns are copied from Top-pad at commit `b833a7b` (`/Volumes/Farhan/Work Folder/Dev/AI/Top-pad`, read only), whose devnet build runs on the same Cloudflare account.
[Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22) reconciled this file with the other Aviary spec files on 2026-11-12 and cut the build tickets listed under [Build tickets](#build-tickets); the files stay separate, one per topic, because the decision register and every product's tickets link into their sections (`PIPESCOPE-86`).

Decisions: [ADR 0003](../adr/0003-pipescope-indexes-pipeline-itself.md) (our own indexer, not Pipeline's hosted API), [ADR 0004](../adr/0004-postgres-on-neon-is-pipescopes-record.md) (Postgres on Neon is the only system of record), [ADR 0005](../adr/0005-canary-checks-run-natively-in-a-container.md) (Canary checks run natively in a Cloudflare Container).

## Where each part runs

| Part | Runs on | Keeps its data in |
| --- | --- | --- |
| Web app | `terminal-web` Worker: Next.js 16 through OpenNext, a pure client of the API | Nothing of its own |
| API | `terminal-api` Worker: Hono with a zod contract | Postgres |
| Indexer | The `Indexer` Durable Object in `terminal-api`, one instance | Postgres; Durable Object storage only for its own socket and alarm state |
| Candle builder | Inside the indexer, folded per trade | Postgres |
| Live rooms | `LiveRoom` Durable Objects in `terminal-api`, one per market and one for the feed | Memory only |
| Metadata fetcher | `terminal-api`, on router events and an hourly cron | Postgres |
| Canary runner | `crates/canary`, a native Rust binary in a Cloudflare Container, driven by one `CanaryRun` Durable Object per strategy version | Postgres |
| Verified builds | A GitHub Actions workflow in this repo, started and read by `terminal-api` | Postgres |
| Explainer | Evidence built by `terminal-api`; generation by `pnpm explainer:approve` on the owner's Mac | Postgres |

- Aviary holds no private keys at all: traders sign in their own wallets, the integrator fee goes to a fee wallet Aviary knows only by address, the Canary runner signs with throwaway keys inside its simulated chain, and the LLM key never leaves the owner's Mac.
- Pipeline's hosted devnet API serves none of the pages: the feed, charts and wallet page read our own indexer's data ([ADR 0003](../adr/0003-pipescope-indexes-pipeline-itself.md)).
- Nothing paid runs from Cloudflare: the only paid call, the explainer's, runs on the owner's Mac when the owner approves it.

## Platform and plans

- Everything runs on the owner's existing Cloudflare account, beside Top-pad's devnet build.
- **Workers Paid is already active; nothing is bought.**
  Checked 2026-11-09: the account runs Top-pad's vision service as a Cloudflare Container (`top-pad-api-devnet-vision-devnet`, created 2026-11-02, healthy), and Containers run only on Workers Paid.
  The billing API refused the token (403), so the plan was not read from billing itself.
- Aviary shares the account's monthly allowances with Top-pad, so both stay inside them by design:

| Allowance (Workers Paid, per account per month) | Top-pad's devnet build | Aviary | Overage |
| --- | --- | --- | --- |
| Durable Object duration, 400,000 GB-s | Its always-awake indexer, about 10,300 GB-s a day measured 2026-11-06 to 2026-11-09, so about 310,000 | Its indexer only while someone watches (see Indexer), Canary runs about 8,300, live rooms hibernate | None expected; an always-awake second indexer would have added about 324,000 and gone over (about $3, or $12.50 if the overage rounds up to a whole million GB-s) |
| Container memory, 25 GiB-hours | Vision, up to about 50 minutes a day | Canary, about 20 GiB-hours for four sweeps a day (`pipescope-canary.md`), plus re-runs of new markets | At worst a few GiB-hours over, cents |
| Container vCPU, 375 minutes; disk, 200 GB-hours | Small | About 90 vCPU-minutes and under 100 GB-hours | None |
| Workers requests, 10 million; CPU, 30 million ms | Small | Small at devnet volume | None |

- Prices and allowances: the owner's Cloudflare knowledge base, `build/01-compute.md` (Durable Objects pricing as of 2026-10-05; Containers pricing), from https://developers.cloudflare.com/durable-objects/platform/pricing/ and https://developers.cloudflare.com/containers/platform/pricing/.
- **Database**: a new Neon project on the free plan, `terminal-devnet`, separate from Top-pad's (see Data).
- **RPC**: Aviary's own free Helius key, separate from the owner's shared key, which Top-pad and every agent session use and which is already rate-limited when several sessions run at once.
  It is kept in the project's `.env` as `RPC_URL` (the Helius devnet URL carrying the key) and as the Worker secret `RPC_URL`, as Top-pad does.
  Expected use is about 400,000 credits a month for the indexer, about 53,000 requests for Canary's sweeps and some thousands for re-runs of new markets, trade-box quotes and pre-signature simulations, about 500,000 credits in all, inside the free plan's 1 million.
- **GitHub Actions**: verified builds run on GitHub's free minutes (2,000 a month while the repo is private, unlimited on standard runners once it is public).
- **LLM**: the explainer's model (`EXPLAINER-18`) through the `ANTHROPIC_API_KEY` in the owner's `~/.config/env/global.env`, one approved batch at a time (`pipescope-explainer.md`, Model and cost).
- Nothing else is paid. The paid upgrades for mainnet (a dedicated Helius plan with LaserStream, a paid Neon plan if compute runs out) belong to the mainnet effort.

## Pipeline's packages

Pipeline published its TypeScript SDK and its Rust crates on 2026-11-10 (commit `5ac3121`, release 0.1.0; 0.1.1 followed on 2026-11-11 with the `checks-*` and `conformance-stale` flags), all under Apache-2.0 (`PIPESCOPE-87`).

- The web app, `terminal-api`, the indexer, the explainer package and the Telegram package use `@pipeline-sol/sdk` from npm, at one exact version in the pnpm catalog of `pnpm-workspace.yaml`, the one place the terminal's TypeScript pins Pipeline.
  Nothing of the terminal links to a clone of Pipeline's repo.
- `crates/canary` uses `pipeline-check`, `pipeline-quoter`, `pipeline-client` and `pipeline-strategy-interface` from crates.io, at exact (`=`) versions in the `[workspace.dependencies]` of `crates/Cargo.toml`, the one place the terminal's Rust pins Pipeline.
  `crates/` is its own Cargo workspace, apart from the on-chain workspace in `programs/`, so a native dependency of Canary's can never change a program's bytes ([`README.md`](README.md), Framework and toolchain).
- The router's program is never a package and never copied: Canary and the tests load the router's deployed bytes.
- A move to a newer Pipeline release is a PR of its own that moves both pins together and re-runs the parity checks.

## The two Workers

### `terminal-api`

- Hono with a zod contract, `nodejs_compat` and `global_fetch_strictly_public`, observability on, and `version_metadata` bound so the indexer can tell when the Worker calling it runs a newer version (Top-pad's lesson below).
- Durable Objects, all SQLite-backed: `Indexer`, `LiveRoom`, `CanaryRun`, and `CanaryContainer` (the Container's class).
- One Container: `crates/canary`'s image, instance type `basic` (a quarter of a vCPU, 1 GiB, 4 GB of disk), `max_instances` 1.
- Hyperdrive in front of Neon, with its query cache off.
- A rate-limiting binding for the public API (see API).
- One cron, every minute, which runs whatever is due by the intervals in the config module ([One place for every value](#one-place-for-every-value)): the indexer's reconciliation, ProgramData watch and registry snapshot, polling running verified builds, the hourly metadata re-fetch and Canary's scheduled sweep ([`pipescope-canary.md`](pipescope-canary.md), When Canary runs).
  So no interval is written in `wrangler.jsonc`, and changing one is a change to one constant.
  A job is due on each minute whose count since the Unix epoch its interval in whole minutes divides, so deciding what to run never wakes the database, and a job that fails is logged without stopping the others (`PIPESCOPE-99`).
- Secrets: `RPC_URL`, and `GH_ACTIONS_TOKEN`, a fine-grained GitHub token limited to this repo with Actions read and write and nothing else, for verified builds.
- A KV namespace, `TERMINAL_CACHE`, for public caches and for the copies of token images ([Data](#data)).
- No LLM key, no wallet key and no Secrets Store binding.

### `terminal-web`

- Next.js 16 on Workers through OpenNext, a pure client of the API, built per environment because `NEXT_PUBLIC_API_URL` is baked in at build time.
- The public name (Aviary), the address (`aviary.trade`) and the fee label ("Aviary fee") live in one module, `apps/terminal-web/src/brand.ts`, the only place in code that carries them ([`README.md`](README.md), Names).
- Wallets through Wallet Standard on `@solana/kit` (Top-pad's `WalletProvider`), charts with TradingView Lightweight Charts v5, live updates over the live rooms' WebSockets.
- The pages live at `/` (the feed), `/devnet` (Devnet help), `/markets/<address>` and `/strategies/<address>`, written once in `apps/terminal-web/src/routes.ts`; an address that is neither gets the "nothing there" page with a 404 (`PIPESCOPE-101`).
- Archivo (upright and italic, with its width and weight axes) and Literata are served from Aviary's own origin as WOFF2 files in `apps/terminal-web/src/fonts`, cut by `scripts/subset-fonts.py` from Google Fonts' repository to Latin, general punctuation and the subscript digits prices count their zeros with, and declared only in `theme.css` (`PIPESCOPE-103`).
- What the pages are is settled by [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3) and [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16).

## Data

[ADR 0004](../adr/0004-postgres-on-neon-is-pipescopes-record.md).

- Postgres on Neon is the only system of record, through Drizzle, reached by the Workers through Hyperdrive with its query cache off (Hyperdrive never invalidates a cached read when a write lands, and the indexer, the Canary runner and the explainer must read what was just written).
- What it holds, as tables for the build to name: strategies; strategy versions (program id, ProgramData slot, `executable_sha256`, when seen); markets and their mints; indexed transactions; trades (keyed by signature and event index, with slot and in-block position); candles; indexer cursors; metadata snapshots (URI, fetch time, outcome, hash, normalised document); Canary runs and one record per check; verified-build requests and results; explanation keys with their stored evidence, estimated cost and status; explanations; reports from the "This is wrong" control; each strategy version's instruction list; token image records; the keeper runner's `keeper_runs` and `keeper_run_jobs` ([`keeper-runner.md`](keeper-runner.md), What it records); and the Telegram bot's chats, watch lists, alerts and deliveries ([`pipescope-telegram.md`](pipescope-telegram.md), What the bot stores).
- Durable Object storage holds only the indexer's socket and alarm state and the Canary run's progress.
- KV holds public caches up to 60 s stale, the keeper runner's newest heartbeat of each kind of pass (`SUITE-57`, a liveness signal a later heartbeat replaces, so Postgres stays the only record), and the copies of token images, keyed by the SHA-256 of their bytes (`PIPESCOPE-88`): Postgres records, per mint, the image's URI, hash, type, size and fetch outcome, and KV holds only bytes that a re-fetch could replace, so Postgres stays the only record ([ADR 0004](../adr/0004-postgres-on-neon-is-pipescopes-record.md)).
  Serving an image never wakes the database: the page gets the hash with the mint, and `terminal-api` serves `/images/<hash>` from KV.
  KV is already in the architecture and inside the account's allowance (devnet holds a few dozen images of at most 1 MB), so nothing new is bought or added.
- D1 and R2 are not used.
- The free plan gives 100 compute-hours a project a month, so the database must sleep when devnet is quiet: reconciliation asks the chain first and touches the database only when there is something new, as Top-pad's does.
- Local development uses a Docker Postgres, as Top-pad's `docker-compose.yml` does.

## Indexer

[ADR 0003](../adr/0003-pipescope-indexes-pipeline-itself.md).
The design is the recommendation of [Where Pipescope's indexer gets its data](https://github.com/imDev2023/testing-pipeline/issues/6), ported from Top-pad's indexer.

- **What it watches**: the router and every registered strategy program; a strategy joins the watched list when its `StrategyRegistered` event arrives or the registry snapshot finds it.
  Watching the strategy programs is what shows custom actions, bypass swaps and upgrades, none of which the router reports.
- **Live source, only while someone watches**: one standard `logsSubscribe` socket on Helius devnet, holding a subscription per watched program, open only while at least one browser is connected to a live room, and closed a few minutes after the last one leaves.
  An outbound socket cannot hibernate and keeps the object billed, so an always-open socket would push the account past its Durable Object allowance (see Platform and plans).
  While the socket is open, a 15 s alarm reopens it if it drops; when it opens, a reconciliation runs at once, so nothing between the last cron run and the socket is missed.
- **Every reported transaction** is fetched whole (`getTransaction`), because swap events are inner instructions, not log lines, and decoded with Pipeline's TypeScript SDK (`extractEventsFromInnerInstructions`); its position in the block comes from `getBlock`, or from `transactionIndex` when `getTransactionsForAddress` served it.
- **Reconciliation** from a cursor per watched address, every minute for the router and every five minutes for strategy programs, oldest first, stopping at the first transaction it cannot fetch yet so the cursor never passes an unindexed one (Top-pad's `reconcileAccount`), through `getTransactionsForAddress` while the free key gets it, else `getSignaturesForAddress` plus `getTransaction`, behind one history-source interface.
- **Registry snapshot** every 10 minutes: `getProgramAccounts` on the router for `Strategy` and `Market` accounts; any account not yet indexed is a missed event and is indexed from its account.
- **ProgramData watch** every minute: one `getMultipleAccounts` with a 45-byte `dataSlice` per 100 programs reads each strategy's and the router's last-deploy slot.
  A changed slot on a strategy is a new strategy version: it is recorded, a Canary run of all its markets starts, a verified build is requested if a source lead exists, and the strategy's markets are re-read.
  A changed slot on the router is recorded and flagged, and starts a Canary run of every market, since a router upgrade can change event layouts; events the decoder does not know are kept and indexed again by newer code.
  A version is the code of one deploy or upgrade (the loader's `DeployWithMaxDataLen` or `Upgrade`, at the top level or through a multisig), keyed by that transaction's slot; an `ExtendProgram`, which a deploy tool sends just before an upgrade to make room, moves the ProgramData slot and keeps the code, so it is no new version, and a deploy in the same slot as an extension wins over it; while the RPC has not served the transaction that moved the slot and the code is the version's before, nothing is recorded and the next watch asks again, since an extension and an upgrade to the same bytes look alike until then (`PIPESCOPE-113`).
  The ProgramData slot last seen is kept with the version in force, so a new instance of the indexer does not take an extension for a change; a version recorded before its transaction is served is looked for again on each watch, at most `VERSION_TRANSACTION_LOOKS` times.
  A program seen for the first time has its version in force recorded with its bytes, and its earlier versions backfilled from the deploys in its ProgramData account's history, without bytes, since those are gone; a first sight is no upgrade and starts nothing.
- **New markets**: each `MarketCreated`, and each market the registry snapshot finds, starts that market's Canary runs on the schedule of [`pipescope-canary.md`](pipescope-canary.md), When Canary runs.
- **Strategy-program calls**: every instruction the indexer sees on a strategy program is stored with its caller, which Canary's `custom_instructions` result reads as who has called each instruction.
  An instruction's callers are the transaction's signers among its accounts, and the program that invoked it is kept beside them; a failed transaction changed nothing and stores no call (`PIPESCOPE-114`).
  Calls are counted by discriminator over the strategy program's whole history, so an instruction keeps its count across versions.
- **Instruction lists**: when a strategy version is recorded, `terminal-api` reads its program's bytes once and stores the instructions compiled into it, as [`pipescope-canary.md`](pipescope-canary.md) (Custom instructions are listed, not called) defines them; the facts panel, the forms' instruction check, the explainer's F items and Canary's snapshot all read that one list (`PIPESCOPE-92`).
  A name is every prefix of the letters and digits after "Instruction: ", since the next string in the bytes can begin with any letter (devnet's outside builder compiles in "SetMetadatafactory"), and the longest whose discriminator is in the code is kept; a discriminator counts side by side, or split over two instruction slots as a 64-bit immediate, as `match` arms compile it (`PIPESCOPE-115`).
- **Events for what follows**: a new strategy, a new market, a new strategy version and a router upgrade are each written once to one outbox table, `outbox_events`, in the order seen, keyed so the same thing seen twice (by its event and by the snapshot) is one event; Canary's runs and the Telegram bot's queue each read on from a cursor of their own in `outbox_cursors` (`readOutbox`, `ackOutbox` in `packages/terminal-db`), so a reader that fails reads the event again (`PIPESCOPE-116`).
- **Market accounts**: after each event or custom action that touches a market, its market state and vaults are re-read; there are no account subscriptions.
- **Mints**: when a market brings a mint not yet seen, its mint account and on-chain token metadata are read once and stored, for the facts (Pipeline's trust flags) and for symbols and images, which `pipescope.md` treats as untrusted.
- **Unknown or failed decodes** are kept with the transaction, and re-indexing transactions first indexed by older code is Top-pad's `reindexTransactions`.
- **Deploys**: an object kept awake goes on running the code from before a deploy, so the indexer resets itself whenever the Worker calling it runs another version (Top-pad's `wake`).
- **Backfill**: the router's whole history (185 transactions on 2026-11-09) is indexed as soon as the indexer first runs, because devnet history may be reset and Postgres must be the record.
- **Trades made through Aviary** reach the indexer at once through the trade fast path (see Trading path); other people's trades show live while anyone is watching, and within a minute otherwise.
- **Parity checks**: Pipeline's hosted devnet API (`https://pipeline-devnet.up.railway.app`, `docs/API.md` in Pipeline's repo) is a test oracle, never a source ([ADR 0003](../adr/0003-pipescope-indexes-pipeline-itself.md)), and the devnet tests lean on it wherever it answers the same question (`PIPESCOPE-93`):
  - trades, per market and per trader, equal its `/v1/markets/{market}/trades` and `/v1/traders/{address}/trades`;
  - candles, for the lengths it serves, equal its `/v1/markets/{market}/candles` for the same base and quote;
  - the trust flags of every strategy, market and mint equal its `flags`, apart from `checks-passed`, `checks-failed` and `checks-pending`, which record its own `pipeline-check` runs; Aviary shows its own Canary `conformance` result instead, and a test checks the two agree for the same code hash;
  - a quote equals its `/v1/quote` for the same market, mints, amount and integrator fee;
  - a prepared swap of an unhooked mint carries the same router instruction as its `POST /v1/swap-transaction`; for a hooked input mint, which it refuses, our own hook accounts are checked against the mint's `ExtraAccountMetaList` instead.
- **Restart test**: Top-pad's pattern (`tests/devnet/src/indexer-restart.test.ts`): stop the indexer, make swaps with this project's devnet keys (`~/.config/testing-pipeline/devnet/`), restart it, and check the indexed trades equal the swaps decoded from the chain.

### Candles

- Each trade is folded into its candle at every length the config module lists as it is indexed, by trade order (slot, in-block position, event index) rather than arrival, the same fold a rebuild makes (Top-pad's `candles.ts`); any candle can be rebuilt from trades.
- Candles are kept per market and mint pair, since a market has two to four mints; a trade's price is `received / net_sent` for its pair (Pipeline's integrator guide); which mint of a pair is shown as the quote is for Aviary's v1 scope and screens.
- Lengths and retention as Top-pad's, kept in the config module (`PIPESCOPE-30`): 1 s, 15 s, 1 m, 5 m, 15 m, 1 h, 4 h and 1 d; 1 s candles kept 7 days, 15 s candles 30 days, coarser ones and all trades forever.
  Candles past their retention are dropped once a day, so the database wakes for it rarely (`PIPESCOPE-109`).
- A swap's candle is the one its block's time falls in, which is where Pipeline's hosted API places it and can be a second later than the event's own clock; the event's clock serves only a block whose time is unknown (`PIPESCOPE-108`).
- Prices are kept exactly: each open, high, low and close is the reduced fraction of the two amounts of the swap that set it, the pair's mints kept in address order, so a candle reads exactly either way round and at any decimals (`PIPESCOPE-107`).
- `GET /v1/markets/{market}/candles?interval=&base=&quote=&limit=&from=` serves a length's newest candles, oldest first, 1,000 unless asked for up to 5,000 (`PAGE_LIMITS`), for the pair named by `base` and `quote` or the market's own, each price written to 36 significant digits (`PRICE_SIGNIFICANT_DIGITS`) and each series with `trade_count`, every swap of the pair it is built from (`PIPESCOPE-107`).
- The API returns `quote_mint` and `base_mint` with every market, candle series and trade, from the quote mint order in the config module ([`pipescope-screens.md`](pipescope-screens.md), Price direction).

### Live rooms

- One `LiveRoom` Durable Object per market and one for the feed, holding hibernatable browser WebSockets, so they cost no duration while idle; the indexer publishes each decoded trade, new market and new strategy version to its room, and rooms batch at the interval in the config module, 100 ms (`PIPESCOPE-31`).
- A browser opens `/v1/live/markets/{market}` or `/v1/live/feed`; a market's room is sent each new swap as the API's trade, and the feed's room and the market's own each market new or changed (its vaults, its last 24 hours) as the API's market, so a page puts each in place by its key and shows it once (`PIPESCOPE-110`).
  The indexer publishes what the live path and reconciliation index, and only to rooms with a viewer, so with none it reads and sends nothing; a room due more than 100 new swaps at once (`LIVE_ROOM_TRADES_MAX`, as after a long backlog) is told to resync instead.
- A browser resyncs through the API from its last slot each time it joins a room, the first time included: `GET /v1/markets/{market}/trades?after=` answers only the trades newer than the newest it shows, and when they fill a page, that page replaces the list (`PIPESCOPE-110`).
- The rooms tell the indexer as each viewer arrives and when the last one leaves, which opens and closes its socket (a room the indexer did not hear of, as during a deploy, is counted at its next viewer); while it is open, its alarm also asks each room with a viewer how many it holds, so a room whose browsers left unseen never keeps the socket open (`PIPESCOPE-110`).
- `GET /v1/indexer` shows the socket's state, the rooms keeping it open and when it closes, from the indexer's storage, which also records when and why it last opened or closed; the indexer logs each.

## API

- **Public** (owner, 2026-11-10): the read endpoints and the prepare endpoints are open to anyone, with no key and any origin, behind a per-IP limit from the Workers rate-limiting binding, and labelled unstable until v1 ships, so other builders can use Aviary's data.
- **Rate limits** (`PIPESCOPE-90`), per IP, in the rate-limiting bindings of `terminal-api`'s `wrangler.jsonc`, their one place: 300 reads a minute; 60 a minute for quotes, prepares and trade signatures together; 10 "This is wrong" reports a minute.
  A page view of the feed or a market makes about ten reads, and a quote is asked at most once per pause in typing, so a reader never meets them; an answer over the limit is a 429 that names the wait, and the page says so in the panel that asked.
  Every `GET` counts as a read, `/health` and unknown paths included, keyed by the reader's IP; the 429 carries `Retry-After` and "Too many requests from your address. Try again in 60 seconds.", whose wait is `RATE_LIMIT_PERIOD_SECONDS` in the config module, kept equal to every binding's period by a test (`PIPESCOPE-100`).
  This is also where Canary results get their "page and API" in the map's Canary attestations fog.
- Endpoints, as a sketch for the build to settle in the zod contract:
  - strategies, a strategy's versions, and per version its facts, Canary results, verified-build status and explanation;
  - markets, a market's facts, trades and candles, with the feed's filters (liquidity, volume, age and Pipeline's trust flags);
  - search by name, mint, market address or strategy address, from Postgres;
  - a wallet's swaps through Pipeline, from our trades, and its balances in mints that trade in Pipeline markets, read through RPC;
  - a quote while the trader types;
  - `POST` prepare for a swap, a custom action and a new market, each returning the unsigned transaction with its simulation's outcome and balance changes;
  - `POST` a trade's signature (the fast path);
  - `POST` a "This is wrong" report against an explanation key;
  - the keeper page's `GET /keeper`, and `POST /keeper/heartbeat`, which keeps only heartbeats the keeper wallet signed ([`keeper-runner.md`](keeper-runner.md), How Aviary shows it; `SUITE-57`, `PIPESCOPE-104`).
- **Paging** (`PIPESCOPE-105`): markets are listed newest first and trades newest first, each page ending with a `next` cursor that the following page passes as `before`, so a page never repeats or skips a row when new ones arrive; a page holds what the caller asks for up to 200 markets or 1,000 trades (the hosted API's own limit for trades), and the pages ask for what the screens' config says, 50 feed rows and 40 trades.
  Both limits are `PAGE_LIMITS` in the config module.
- Owner-only operations are not in the API: the explainer's approve command and the reports list read and write Postgres directly from the owner's Mac.

## Trading path

Top-pad's flow (`apps/web/src/components/coin/QuickTrade.tsx`, `prepareSwap` then `signAndSendTransaction` then `reportTrade`), with what `pipescope.md` asks for.

1. While the trader types, the trade box shows a quote from RPC simulation of the strategy's `pipeline_quote` through the SDK's `quoteStrategy` (50 to 300 ms), asked through the API on Aviary's Helius key; the Container quoter is never on the trading path.
2. When the trader asks to swap, the API prepares the unsigned transaction with Pipeline's Kit-based TypeScript SDK: the router `swap` instruction, our integrator fee at the rate on screen when the input is a fee mint, the transfer-hook extra accounts, wrapping and unwrapping SOL, idempotent creation of the trader's token accounts, and the market's `init_fee_account` when a sell needs it.
3. The API simulates that exact transaction (see Simulation before every signature) and returns it with the simulation's outcome; if the simulation failed, the page shows the error and the sign button stays off.
4. The wallet signs and sends through Wallet Standard's `signAndSendTransaction`.
5. The page sends the signature to the API, which waits for it to confirm (asking every 300 ms), reads it back, answers with the trade and a provisional order key, and hands it to the indexer, which later replaces it in place.

As built in [#121](https://github.com/imDev2023/testing-pipeline/issues/121):

- `GET /v1/quote` takes the amount typed and works the market amount back from it (`pipescope-screens.md`, The amount typed), `POST /v1/swaps/prepare` builds and simulates the swap for the trader named, and `POST /v1/trades` takes the signature; all three count against the 60-a-minute limit (`PIPESCOPE-90`), and a refusal from a strategy or the chain is a 422 carrying the failure decoded, its raw error and the program's log lines.
- A quote's simulation is paid for by the fee wallet, which does not sign, so a quote works before the trader's wallet holds any SOL (`PIPESCOPE-117`).
- The fast path gives up after 60 s, about a blockhash's life, and says the trade joins Trades once the indexer reads it if it lands; its provisional key is the trade's slot and event index with no place in its block, which the indexer's own row, sent to the market's live room, replaces (`PIPESCOPE-118`).
- A prepared swap older than 45 s when the trader asks to sign is built and simulated again before the wallet is asked, since its blockhash would soon expire (`PIPESCOPE-119`).
- The swap carries the strategy's quoted output in its `amount_out` argument, which exact-in does not read, as Pipeline's own builder does, so its router instruction is the hosted API's (`PIPESCOPE-93`).
- `GET /v1/traders/{trader}/balances` reads the wallet's balance in up to four mints through RPC for the trade box, answering wrapped SOL with plain SOL, since a swap paying in it wraps SOL for the trader.
- A mint with a transfer hook gets no quote until [hooked mints](https://github.com/imDev2023/testing-pipeline/issues/122) resolve its accounts.

- Transfer-hook extra accounts are resolved by our own code for buys, sells and sweeps, from each mint's `ExtraAccountMetaList`, because neither Pipeline's SDK nor its Rust client does it ([How the containment hook works with the router and unlocks](https://github.com/imDev2023/testing-pipeline/issues/10)).
- Custom actions and market creation are prepared and simulated the same way, with the SDK's generic builders (`buildActionInstruction`, `buildCreateMarketFromMetadata`) from the strategy's validated metadata after the discriminator check; a custom action is signed directly on the strategy, outside the router's protections.

### Simulation before every signature

- Every transaction Aviary prepares (swap, custom action, create market) is simulated by `terminal-api` in the same request that builds it, with `simulateTransaction` on Aviary's Helius key, the trader's wallet as fee payer, signature checks off and the blockhash replaced.
- The simulation is asked for the post-state of every token account the transaction touches; with their balances read just before, the API returns the wallet's balance changes, which the form shows before signing (`pipescope.md`, Custom-action and create-market forms).
- The transaction returned is exactly the one simulated, so what the trader signs is what was checked, apart from the chain moving in between.

### The integrator fee's configuration

- The rate ([`pipescope.md`](pipescope.md), The integrator fee), the fee mints (wrapped SOL and the cluster's USDC mint) and the fee wallet's two token accounts are vars of `terminal-api` per environment in its `wrangler.jsonc`, so they change by a configuration deploy, with no code change; the fee wallet's key is never on a server ([`pipescope.md`](pipescope.md), The integrator fee).
- The API returns the rate it built each swap with, so the trade box shows exactly that rate.
- Pipeline's own fee is the router's setting, not ours: since Pipeline 0.3 the router keeps it as a constant of its program, not in its config account, so `terminal-api` takes it from Pipeline's SDK at the version pinned with the router (`PIPELINE_FEE_BPS`) and returns it with every quote and on the fees endpoint, so the trade box, the Fees page, the Telegram bot and Canary's cost split never write it as a number (`PIPESCOPE-91`, changed on 2026-11-23); a router release that changes it moves the SDK pin with it.

## Canary runner

[ADR 0005](../adr/0005-canary-checks-run-natively-in-a-container.md).
The hosting is the recommendation of [Where the quoter runs for Canary checks](https://github.com/imDev2023/testing-pipeline/issues/7).
What the checks are, how a run copies a market and when runs happen are in [`pipescope-canary.md`](pipescope-canary.md), from [Canary checks on the four devnet strategies](https://github.com/imDev2023/testing-pipeline/issues/14); this section says where Canary runs and where its results go.

- **Binary**: `crates/canary` in the root Rust workspace, a native Rust program on `litesvm` (0.18.2) and Pipeline's Apache-2.0 crates at a pinned commit through Cargo (`pipeline-check`, `pipeline-quoter`, `pipeline-client` and `pipeline-strategy-interface`), never copied into this repo; Rust per `docs/toolchain.md`.
  It serves one HTTP endpoint that takes one market's snapshot and returns one Canary result per check, or the addresses of accounts the snapshot lacks.
- **Image and instance**: linux/amd64, which keeps the sBPF JIT measured on x86_64; a `basic` instance, one at a time, sleeping 2 minutes after its last run; internet access off (`enableInternet = false`), so the container never holds an RPC key and never reaches the network.
  The build measures a sweep on `basic` before trusting the cost below, and whether a shorter sleep or the `lite` instance (1/16 vCPU, 256 MiB) serves as well.
- **Orchestration**: one `CanaryRun` Durable Object per strategy version, keyed by program id and ProgramData slot, which runs that version on all of its markets or on one of them.
  For each market it builds the snapshot through Helius, posts it to the single `CanaryContainer`, fetches any accounts the binary names as missing and posts again, at most four times, stores the results in Postgres, and retries on its alarm if the container restarts mid-run.
  Its triggers are those of [`pipescope-canary.md`](pipescope-canary.md), When Canary runs, the one place that states them; a manual re-run command is part of the build.
- **Snapshot**: per market, the router's and the strategy's ProgramData, the router config, the market with its market state, mints, vaults and fee accounts, whatever `pipeline_resolve_accounts` asks for, and the cluster's slot, epoch and time; about 7 RPC requests a market (442 for all 61 devnet markets on 2026-11-10).
  The router is loaded from its deployed bytes, never a local build, so checks test what is on chain.
- **Results**: one Canary result per check, market, strategy version and slot, kept as `pipescope-canary.md` says (the latest of each check per market and version, and every earlier one whose outcome differed from the next); the facts panel and the explainer read them as C items, and changed outcomes make a new explanation key.
- **Licence seam**: `simulate_swap` executes the router program, which is BSL 1.1 with no Additional Use Grant until 2028-11-08; every trade in Canary's checks goes through one swap function with two implementations, through the router (used on devnet) and calling the strategy directly plus Pipeline's Apache-2.0 settlement code, so Canary can switch without a rewrite unless MetalLegBob grants production use.
  The conformance report is the exception, since `pipeline-check` itself runs the router; without the router it is "not run".
  The question was not put to him as of 2026-11-10.
- **Cost**: four sweeps a day are about 960 runs a month and about 53,000 RPC requests; if each sweep keeps the container awake about ten minutes, that is about 20 GiB-hours of the 25 included, and re-runs of new markets add their 2-minute sleeps (`pipescope-canary.md`, When Canary runs).
  With Top-pad's vision service (about 10 GiB-hours a month at its pace since 2026-11-01), the account may go a few GiB-hours over, a few cents a month.
- **Fallback**: a small server elsewhere (Fly.io from $2.19 a month) runs the same binary if Containers misbehave; it is not built unless needed.

## Verified builds

- A strategy version's source counts as evidence (S items) only when Aviary rebuilt it from a named repository and commit and got the deployed bytes; OtterSec's hosted check does not cover devnet (empty hashes for all four devnet strategies on 2026-11-09; Top-pad found it runs on mainnet only), so Aviary runs `solana-verify` itself.
- **Leads**: the strategy metadata's `source` (repository, commit, path) and any on-chain verification record left by `solana-verify verify-from-repo`; neither is evidence until the hashes match.
- **Where**: a GitHub Actions workflow in this repo, `verify-build.yml`, started by `terminal-api` with `workflow_dispatch` for a strategy version with a lead, and read back by the every-minute cron through the run's status and its result artifact, with `GH_ACTIONS_TOKEN`.
- **Two jobs**:
  1. `build`, untrusted: no secrets, a token with no permissions, `solana-verify build` in its Docker image at the named commit, with dependencies fetched first and the build run with the network off where `solana-verify` allows it; it uploads the built program.
  2. `compare`, trusted, on a fresh runner: hashes the uploaded program, reads the on-chain executable hash at the version's slot, and uploads the result.
- **Known limit**: a hostile build script can still emit the deployed bytes, so a match shows the repository's build produced them, not that the visible source alone did; OtterSec's check has the same limit, and a verified source is evidence, never proof.
- Our own strategies are deployed only from verified builds and verified on chain at deploy, as in Top-pad (its `CLAUDE.md`).

## Metadata fetcher

- Runs in `terminal-api` on `StrategyRegistered`, on `MetadataUpdated`, and every hour, because the document behind an unchanged URI can change with no event.
- Limits, in the config module (`PIPESCOPE-36`): `https:` only, at most 64 KB, a JSON content type, a 5 s timeout, at most 3 redirects, each `https:`; it never fetches a URL found inside the document.
- The same fetcher, under the same limits apart from the size, fetches the image a mint's on-chain token metadata names, once per URI and again when the URI changes, and keeps it only as [`pipescope-screens.md`](pipescope-screens.md) (Token names and images) allows.
- The document is validated with Pipeline's `parse_strategy_metadata` (the TypeScript SDK's port), giving the `metadata-missing`, `metadata-unreachable` or `metadata-invalid` fact, then normalised as `pipescope-explainer.md` says, and stored with its hash.
- A changed hash is a metadata change: it makes a new explanation key, pending approval.
- Everything works with no metadata at all, as on devnet today, where all four strategies' metadata links returned 404 on 2026-11-09.

## Explainer jobs

What the explainer is, its key, prompt, validator and presentation are in `pipescope-explainer.md`; this is where its parts run.

- When a new key arises (a new strategy version, a metadata change, changed Canary outcomes, or a new prompt or model version), `terminal-api` builds the evidence input: P items from constant text, F items with Pipeline's trust facts from the TypeScript SDK, C items from the Canary records, S items from the verified source at its commit, and A items from the normalised metadata.
  It stores the input with the key, its estimated cost and the status pending.
- `pnpm explainer:approve`, run by the owner on their Mac, lists the pending keys with their estimated cost; for the keys the owner approves it calls the model named in the explainer's rules module ([`pipescope-explainer.md`](pipescope-explainer.md), One place for every value) with the `ANTHROPIC_API_KEY` from `~/.config/env/global.env`, runs the validator, retries once with the validator's errors, writes the explanation or the failed status to Postgres through the project's database URL, and appends one line per batch to `~/.config/spend/ledger.csv`.
- No LLM key is in Cloudflare, so nothing paid can run from the deployed product, whatever its code does.
- `pnpm explainer:reports` lists the "This is wrong" reports with the keys they refer to.
- Until a key's explanation exists, the strategy page shows the facts panel alone, with "No explanation for this version yet."

## One place for every value

`terminal-api`'s config module, `apps/terminal-api/src/config.ts`, holds every policy value of the API, the indexer and the jobs that is not a per-environment var (`PIPESCOPE-89`).
Each is a named constant; the pages and the Telegram bot read what they show from the API and never repeat it.

| Value | Default | Decision |
| --- | --- | --- |
| Reconciliation: router, strategy programs | every minute, every 5 minutes | `PIPESCOPE-28` |
| Registry snapshot, ProgramData watch | every 10 minutes, every minute | `PIPESCOPE-28` |
| Socket: reopen alarm, close after the last viewer | 15 s, 3 minutes | `PIPESCOPE-27`, `PIPESCOPE-28` |
| Candle lengths and retention | as [Candles](#candles) | `PIPESCOPE-30` |
| Candle pruning | once a day | `PIPESCOPE-109` |
| Candle prices written to; candles a request is served, by default and at most | 36 significant digits; 1,000 and 5,000 | `PIPESCOPE-107` |
| Live-room batching | 100 ms | `PIPESCOPE-31` |
| Fast path: confirmation poll, and how long it waits | every 300 ms, 60 s | `PIPESCOPE-33`, `PIPESCOPE-118` |
| Metadata fetcher limits and re-fetch interval | as [Metadata fetcher](#metadata-fetcher), every hour | `PIPESCOPE-36` |
| Quote mint order | wrapped SOL, then the cluster's USDC, then the later mint of the pair | `PIPESCOPE-74` |
| Token image types and size | PNG, JPEG or WebP, at most 1 MB | `PIPESCOPE-82` |
| Canary's schedule | as [`pipescope-canary.md`](pipescope-canary.md), When Canary runs | `CANARY-22`, `CANARY-23` |
| ProgramData watch: looks for a version's transaction the RPC had not served | 30 | `PIPESCOPE-113` |
| Signers listed with each of a strategy's instructions, most calls first | 100 | `PIPESCOPE-114` |
| Public caches | up to 60 s stale | `PIPESCOPE-32` |
| Keeper page: "looks stopped" after the runner's `SWEEP_INTERVAL` plus, and the latest jobs shown | 5 minutes, 20 | `PIPESCOPE-104` |
| Keeper heartbeats: largest clock difference, fewest seconds between two of one kind | 2 minutes, 30 s | `SUITE-57` |

- Per-environment values are vars or bindings in `terminal-api`'s `wrangler.jsonc`: the integrator fee's settings (`PIPESCOPE-13`), the rate limits (`PIPESCOPE-90`), the Telegram bot's handles and origin (`PIPESCOPE-62`) and the keeper wallet, `KEEPER_WALLET` (`PIPESCOPE-104`).
- The web app's own values are in its screens' config module, theme stylesheet and brand module ([`pipescope-screens.md`](pipescope-screens.md), One place for every value); Canary's are in `crates/canary/src/config.rs` ([`pipescope-canary.md`](pipescope-canary.md), One place for every value); the explainer's in `packages/terminal-explainer/src/rules.ts`; the bot's in `packages/terminal-telegram`'s config module.

## Copied from Top-pad

Each copied file starts with a header naming Top-pad commit `b833a7b` and its path there; once copied, it is owned here.

| From Top-pad | Becomes |
| --- | --- |
| `packages/indexer/src/index.ts` (`indexTransactions`, `reindexTransactions`, `reconcileAccount`, the history source) | `packages/terminal-indexer`, with Pipeline's decoder in place of Meteora's |
| `packages/indexer/src/live.ts` (`logsSubscribeRequest`, `parseLogsMessage`, `blockPositions`) | `packages/terminal-indexer` |
| `packages/indexer/src/candles.ts` | `packages/terminal-indexer`, per market and mint pair |
| `apps/api/src/indexer.ts` (the Indexer Durable Object: socket, alarm, reconciliation, version reset) | `apps/terminal-api`, without Heat's graduated pools, Bundle Radar and keeper starts, and with the viewer-gated socket |
| The live rooms (Top-pad `docs/spec.md` section 10.2) | `apps/terminal-api` |
| `packages/db` (Drizzle, migrations; `0000_init.sql` and `0002_indexer.sql` as the pattern) and `docker-compose.yml` | `packages/terminal-db` |
| The API Worker's scaffold (`apps/api/wrangler.jsonc`, Hono with a zod contract, environments) | `apps/terminal-api` |
| `apps/api/src/visionContainer.ts` (a Container behind a Durable Object that sleeps when idle) | `apps/terminal-api`'s `CanaryContainer` |
| The web scaffold (`apps/web/open-next.config.ts`, `wrangler.jsonc`, `WalletProvider.tsx`, Lightweight Charts v5 use) | `apps/terminal-web` |
| `tests/ui` (Playwright) | `tests/terminal-e2e` |
| `tests/devnet/src/indexer-restart.test.ts` | `tests/devnet` |

- Not copied: Top-pad's Codama clients (Aviary calls none of our programs, and Pipeline's SDK is already on Kit; Codama comes with our strategies' build tickets), its keeper Workflows, the vision service, Heat's decoders and anything of Heat's devnet bank.

## Repo layout

- `apps/terminal-api`, `apps/terminal-web`
- `packages/terminal-db`, `packages/terminal-indexer`, `packages/terminal-explainer` (the prompt, its rules module, the normaliser and the validator, shared by `terminal-api` and the approve command), `packages/terminal-telegram`
- `crates/canary`, in its own Cargo workspace, `crates/Cargo.toml` ([Pipeline's packages](#pipelines-packages))
- `tests/terminal-e2e` (Playwright), `tests/devnet` (the restart test and the parity checks)
- `.github/workflows/verify-build.yml`
- Each joins the root pnpm workspace or, for Rust, `crates/`; none is built by the on-chain CI jobs, and CI gets a terminal job of its own behind the same `gate` check.

## Environments

- **Local**: `wrangler dev` for both Workers against devnet, with the Docker Postgres and `RPC_URL` from the project's `.env`; [`docs/toolchain.md`, "Aviary's local run"](../toolchain.md#aviarys-local-run) has the commands.
  Aviary runs only here for now (owner, 2026-11-22; `PIPESCOPE-98`): `RPC_URL` is the owner's shared Helius devnet key until Aviary has its own, and `DATABASE_URL` names the Docker Postgres of `packages/terminal-db/docker-compose.yml`.
- **Devnet**: `terminal-api-devnet` and `terminal-web-devnet` on `workers.dev`, deployed together by one root script; secrets set with `wrangler secret put --env devnet`.
  This hosted deploy, with Neon through Hyperdrive, Aviary's own Helius key and the secrets check, is [Aviary: the hosted devnet deploy](https://github.com/imDev2023/testing-pipeline/issues/192), after the owner's setup in [#110](https://github.com/imDev2023/testing-pipeline/issues/110).
- The custom domain is `aviary.trade`, from [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17); it is attached to `terminal-web` once the owner has registered it, and the Workers' own names do not change with the public name.

## Owner tasks before the build

1. Make Aviary's own free Helius key (a second free Helius project or account; whether one account can hold a second free project was not confirmed, since Helius's docs could not be fetched on 2026-11-09) and put its devnet URL in the project's `.env` as `RPC_URL`.
2. Create the Neon project `terminal-devnet` on the free plan and put its connection string in the project's `.env` as `DATABASE_URL`.
3. Create a fine-grained GitHub token for this repo with Actions read and write only, for the verified-build workflow; the build session sets it as `GH_ACTIONS_TOKEN`.
4. Approve the explainer's first paid run, as `pipescope-explainer.md` says.

Nothing is purchased: Workers Paid is already active.

## Build tickets

Cut by [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22) on 2026-11-12, labelled `build`, one session each, with native blocking edges on GitHub (`PIPESCOPE-95`).
They replace the slices this section first suggested: each ticket is a vertical slice, from the database to the page it shows on, so each is demonstrable on devnet on its own.
Every ticket works as [`docs/agents/build-tickets.md`](../agents/build-tickets.md) says, and in addition:

- **Verified on devnet data** (`PIPESCOPE-96`): its criteria run on Aviary's local run against devnet ([Environments](#environments), `PIPESCOPE-98`), and on Aviary's devnet deployment once [#192](https://github.com/imDev2023/testing-pipeline/issues/192) has deployed it; every page it adds or changes is checked at 1440, 390 and 360 px wide in the light and the dark theme, with Playwright screenshots in its PR (`pnpm terminal:e2e`, which saves them); CI runs the same tests on recorded devnet fixtures with no network.
- **Recorded fixtures** (`PIPESCOPE-102`): in CI the local API reads devnet's RPC answers from `tests/terminal-e2e/fixtures/devnet-rpc.json` through a fixture server the Playwright run starts; a ticket whose API asks devnet something new records it with `pnpm --filter terminal-e2e record` against live devnet, and a request with no recording fails its test.
- **Signing in tests** (`PIPESCOPE-94`): Playwright registers a Wallet Standard test wallet, only in test builds, that signs with a devnet test key from `~/.config/testing-pipeline/devnet/`; each ticket that adds a signing flow also runs it once in a real wallet extension set to devnet, driven in the owner's Chrome.
- **The keeper page** lives at `/keeper`, linked from every page's footer and from each product panel's due keeper jobs (`PIPESCOPE-97`).

Owner tasks first, each a HITL task ticket on the map:

1. [Aviary: owner setup for the first deploy (Aviary's Helius key and the Neon project)](https://github.com/imDev2023/testing-pipeline/issues/110), before the scaffold.
2. [Aviary: owner setup for verified builds and the Telegram bot (GitHub token and working bot)](https://github.com/imDev2023/testing-pipeline/issues/111), before verified builds and the bot.

The terminal, in run order:

1. [Aviary: scaffold both Workers, the database, the page shell with its themes, and the devnet deploy](https://github.com/imDev2023/testing-pipeline/issues/113), built and verified on the local run; its hosted deploy is [#192](https://github.com/imDev2023/testing-pipeline/issues/192), after the owner's setup in #110
2. [Aviary: index the router's history into Postgres, with the feed's two tables](https://github.com/imDev2023/testing-pipeline/issues/116)
3. [Aviary: index strategy programs and their versions, with the strategy page's version history](https://github.com/imDev2023/testing-pipeline/issues/117) and [Aviary: candles, live rooms and the market page's chart and trades](https://github.com/imDev2023/testing-pipeline/issues/118), side by side
4. [Aviary: strategy metadata, trust facts and the facts panel, with the feed's filters](https://github.com/imDev2023/testing-pipeline/issues/119) (after strategy versions) and [Aviary: trade plain mints: quotes, the trade box, review and sign, the fast path and the Fees page](https://github.com/imDev2023/testing-pipeline/issues/121) (after the market page), side by side
5. [Aviary: token names and images, and search](https://github.com/imDev2023/testing-pipeline/issues/120), [Aviary: hooked mints, markets of three or four mints, and the wallet page](https://github.com/imDev2023/testing-pipeline/issues/122) and [Aviary: custom-action forms, the create-market page and a place for product panels](https://github.com/imDev2023/testing-pipeline/issues/123)

Canary, whose binary needs none of the above and starts at once:

1. [Aviary: Canary's binary, with readability, conformance, the exit test over sizes, quote against swap and cost](https://github.com/imDev2023/testing-pipeline/issues/112)
2. [Aviary: Canary over time and across wallets (holding, later, launch clock, insiders, transferred tokens, a queue of buyers)](https://github.com/imDev2023/testing-pipeline/issues/114) and [Aviary: Canary's control checks, token authorities acting, and transfer-hook accounts](https://github.com/imDev2023/testing-pipeline/issues/115), side by side
3. [Aviary: Canary in a Container, run by CanaryRun, with results in Postgres](https://github.com/imDev2023/testing-pipeline/issues/124), after both and the strategy versions
4. [Aviary: Canary's results on the pages and the trade box's exit-test notice](https://github.com/imDev2023/testing-pipeline/issues/125), after the facts panel and the trade box

Then the explainer and the rest:

1. [Aviary: explainer jobs: the evidence, the validator, the approval queue and the approve command](https://github.com/imDev2023/testing-pipeline/issues/126), after Canary in the Container and the facts; its first paid run waits for the owner's approval
2. [Aviary: the explanation on the strategy and market pages](https://github.com/imDev2023/testing-pipeline/issues/127)
3. [Aviary: verified builds of strategy versions](https://github.com/imDev2023/testing-pipeline/issues/128), after the explainer jobs, the GitHub token and [Tax AMM: deploy on devnet, register with Pipeline and create a demo market](https://github.com/imDev2023/testing-pipeline/issues/66), whose program is the first verified match
4. [Aviary: the keeper page and the keeper runner's records](https://github.com/imDev2023/testing-pipeline/issues/129), after the scaffold and [Keeper runner: the runner, its wallet and the tax AMM's `distribute`](https://github.com/imDev2023/testing-pipeline/issues/94)

The Telegram bot, built alongside the pages ([`pipescope-telegram.md`](pipescope-telegram.md), When it is built):

1. [Aviary: arriving from Telegram (trade links, the wallet chooser on phones, alert links and the official handles)](https://github.com/imDev2023/testing-pipeline/issues/130), after the trade box
2. [Aviary: the Telegram bot's scaffold](https://github.com/imDev2023/testing-pipeline/issues/131), after the scaffold and the working bot
3. [Aviary: Telegram lookups (cards, search and the trade buttons)](https://github.com/imDev2023/testing-pipeline/issues/132), after Canary in the Container, the facts and the explainer jobs
4. [Aviary: Telegram alerts and the public channel](https://github.com/imDev2023/testing-pipeline/issues/133)
5. [Aviary: the Telegram watch list (upgrades with their results, changed Canary outcomes)](https://github.com/imDev2023/testing-pipeline/issues/134)

Each product's Aviary ticket waits for the terminal tickets it builds on, wired as native edges:

- [Tax AMM in Aviary: the launch form and the tax panel](https://github.com/imDev2023/testing-pipeline/issues/75) and [Containment hook in Aviary: the containment panel and the Unlock button](https://github.com/imDev2023/testing-pipeline/issues/76): the market page, the facts, hooked mints, the forms and product-panel place, and Canary on the pages; the tax AMM's also the keeper page, for its due `distribute` jobs.
- [Buy wall AMM: Aviary panel and forms](https://github.com/imDev2023/testing-pipeline/issues/57): the market page, the facts, hooked mints, the forms, the explainer jobs and the keeper page.
- [Lending AMM: Aviary panel, forms and explainer facts](https://github.com/imDev2023/testing-pipeline/issues/88): the strategy-program calls, the market page, the trading path, hooked mints, the forms, the explainer jobs and the keeper page.
