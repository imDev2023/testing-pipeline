# Pipescope: architecture

Decided in [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13) with the owner on 2026-11-10.
It builds on the findings of [Where Pipescope's indexer gets its data](https://github.com/imDev2023/testing-pipeline/issues/6) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/indexer-data-source/research/indexer-data-source.md)), [Where the quoter runs for Canary checks](https://github.com/imDev2023/testing-pipeline/issues/7) ([findings](https://github.com/imDev2023/testing-pipeline/blob/research/quoter-hosting/research/quoter-hosting.md)), [Prior art for behavioural testing of Solana programs](https://github.com/imDev2023/testing-pipeline/issues/8), [Prior art for AI explanations of contracts, and what an explainer can safely say](https://github.com/imDev2023/testing-pipeline/issues/9) and [How the containment hook works with the router and unlocks](https://github.com/imDev2023/testing-pipeline/issues/10), and on the explainer spec in `pipescope-explainer.md`.
Patterns are copied from Top-pad at commit `b833a7b` (`/Volumes/Farhan/Work Folder/Dev/AI/Top-pad`, read only), whose devnet build runs on the same Cloudflare account.
[Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22) merges this file with the other Pipescope spec files.

Decisions: [ADR 0003](../adr/0003-pipescope-indexes-pipeline-itself.md) (our own indexer, not Pipeline's hosted API), [ADR 0004](../adr/0004-postgres-on-neon-is-pipescopes-record.md) (Postgres on Neon is the only system of record), [ADR 0005](../adr/0005-canary-checks-run-natively-in-a-container.md) (Canary checks run natively in a Cloudflare Container).

## Where each part runs

| Part | Runs on | Keeps its data in |
| --- | --- | --- |
| Web app | `pipescope-web` Worker: Next.js 16 through OpenNext, a pure client of the API | Nothing of its own |
| API | `pipescope-api` Worker: Hono with a zod contract | Postgres |
| Indexer | The `Indexer` Durable Object in `pipescope-api`, one instance | Postgres; Durable Object storage only for its own socket and alarm state |
| Candle builder | Inside the indexer, folded per trade | Postgres |
| Live rooms | `LiveRoom` Durable Objects in `pipescope-api`, one per market and one for the feed | Memory only |
| Metadata fetcher | `pipescope-api`, on router events and an hourly cron | Postgres |
| Canary runner | `crates/canary`, a native Rust binary in a Cloudflare Container, driven by one `CanaryRun` Durable Object per strategy version | Postgres |
| Verified builds | A GitHub Actions workflow in this repo, started and read by `pipescope-api` | Postgres |
| Explainer | Evidence built by `pipescope-api`; generation by `pnpm explainer:approve` on the owner's Mac | Postgres |

- Pipescope holds no private keys at all: traders sign in their own wallets, the integrator fee goes to a fee wallet Pipescope knows only by address, the Canary runner signs with throwaway keys inside its simulated chain, and the LLM key never leaves the owner's Mac.
- Pipeline's hosted devnet API serves none of the pages: the feed, charts and wallet page read our own indexer's data ([ADR 0003](../adr/0003-pipescope-indexes-pipeline-itself.md)).
- Nothing paid runs from Cloudflare: the only paid call, the explainer's, runs on the owner's Mac when the owner approves it.

## Platform and plans

- Everything runs on the owner's existing Cloudflare account, beside Top-pad's devnet build.
- **Workers Paid is already active; nothing is bought.**
  Checked 2026-11-09: the account runs Top-pad's vision service as a Cloudflare Container (`top-pad-api-devnet-vision-devnet`, created 2026-11-02, healthy), and Containers run only on Workers Paid.
  The billing API refused the token (403), so the plan was not read from billing itself.
- Pipescope shares the account's monthly allowances with Top-pad, so both stay inside them by design:

| Allowance (Workers Paid, per account per month) | Top-pad's devnet build | Pipescope | Overage |
| --- | --- | --- | --- |
| Durable Object duration, 400,000 GB-s | Its always-awake indexer, about 10,300 GB-s a day measured 2026-11-06 to 2026-11-09, so about 310,000 | Its indexer only while someone watches (see Indexer), Canary runs about 8,300, live rooms hibernate | None expected; an always-awake second indexer would have added about 324,000 and gone over (about $3, or $12.50 if the overage rounds up to a whole million GB-s) |
| Container memory, 25 GiB-hours | Vision, up to about 50 minutes a day | Canary, about 20 GiB-hours for four sweeps a day (`pipescope-canary.md`), plus re-runs of new markets | At worst a few GiB-hours over, cents |
| Container vCPU, 375 minutes; disk, 200 GB-hours | Small | About 90 vCPU-minutes and under 100 GB-hours | None |
| Workers requests, 10 million; CPU, 30 million ms | Small | Small at devnet volume | None |

- Prices and allowances: the owner's Cloudflare knowledge base, `build/01-compute.md` (Durable Objects pricing as of 2026-10-05; Containers pricing), from https://developers.cloudflare.com/durable-objects/platform/pricing/ and https://developers.cloudflare.com/containers/platform/pricing/.
- **Database**: a new Neon project on the free plan, `pipescope-devnet`, separate from Top-pad's (see Data).
- **RPC**: Pipescope's own free Helius key, separate from the owner's shared key, which Top-pad and every agent session use and which is already rate-limited when several sessions run at once.
  It is kept in the project's `.env` as `RPC_URL` (the Helius devnet URL carrying the key) and as the Worker secret `RPC_URL`, as Top-pad does.
  Expected use is about 400,000 credits a month for the indexer, about 53,000 requests for Canary's sweeps and some thousands for re-runs of new markets, trade-box quotes and pre-signature simulations, about 500,000 credits in all, inside the free plan's 1 million.
- **GitHub Actions**: verified builds run on GitHub's free minutes (2,000 a month while the repo is private, unlimited on standard runners once it is public).
- **LLM**: `claude-haiku-5-5` through the `ANTHROPIC_API_KEY` in the owner's `~/.config/env/global.env`, one approved batch at a time (`pipescope-explainer.md`, Model and cost).
- Nothing else is paid. The paid upgrades for mainnet (a dedicated Helius plan with LaserStream, a paid Neon plan if compute runs out) belong to the mainnet effort.

## The two Workers

### `pipescope-api`

- Hono with a zod contract, `nodejs_compat` and `global_fetch_strictly_public`, observability on, and `version_metadata` bound so the indexer can tell when the Worker calling it runs a newer version (Top-pad's lesson below).
- Durable Objects, all SQLite-backed: `Indexer`, `LiveRoom`, `CanaryRun`, and `CanaryContainer` (the Container's class).
- One Container: `crates/canary`'s image, instance type `basic` (a quarter of a vCPU, 1 GiB, 4 GB of disk), `max_instances` 1.
- Hyperdrive in front of Neon, with its query cache off.
- A rate-limiting binding for the public API (see API).
- Crons: every minute (wake the indexer for reconciliation, the ProgramData watch and, every tenth minute, the registry snapshot; poll running verified builds) every hour (re-fetch strategy metadata) and every 6 hours (Canary's sweep of every market).
- Secrets: `RPC_URL`, and `GH_ACTIONS_TOKEN`, a fine-grained GitHub token limited to this repo with Actions read and write and nothing else, for verified builds.
- No LLM key, no wallet key and no Secrets Store binding.

### `pipescope-web`

- Next.js 16 on Workers through OpenNext, a pure client of the API, built per environment because `NEXT_PUBLIC_API_URL` is baked in at build time.
- Wallets through Wallet Standard on `@solana/kit` (Top-pad's `WalletProvider`), charts with TradingView Lightweight Charts v5, live updates over the live rooms' WebSockets.
- What the pages are is settled by [Pipescope v1 scope](https://github.com/imDev2023/testing-pipeline/issues/3) and [Pipescope screens](https://github.com/imDev2023/testing-pipeline/issues/16).

## Data

[ADR 0004](../adr/0004-postgres-on-neon-is-pipescopes-record.md).

- Postgres on Neon is the only system of record, through Drizzle, reached by the Workers through Hyperdrive with its query cache off (Hyperdrive never invalidates a cached read when a write lands, and the indexer, the Canary runner and the explainer must read what was just written).
- What it holds, as tables for the build to name: strategies; strategy versions (program id, ProgramData slot, `executable_sha256`, when seen); markets and their mints; indexed transactions; trades (keyed by signature and event index, with slot and in-block position); candles; indexer cursors; metadata snapshots (URI, fetch time, outcome, hash, normalised document); Canary runs and one record per check; verified-build requests and results; explanation keys with their stored evidence, estimated cost and status; explanations; reports from the "This is wrong" control.
- Durable Object storage holds only the indexer's socket and alarm state and the Canary run's progress; KV holds only public caches up to 60 s stale; D1 and R2 are not used.
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
- **New markets**: each `MarketCreated`, and each market the registry snapshot finds, starts a Canary run of that market at once and again 10 minutes, 1 hour and 1 day later.
- **Strategy-program calls**: every instruction the indexer sees on a strategy program is stored with its caller, which Canary's `control` check reads as who has called each instruction.
- **Market accounts**: after each event or custom action that touches a market, its market state and vaults are re-read; there are no account subscriptions.
- **Mints**: when a market brings a mint not yet seen, its mint account and on-chain token metadata are read once and stored, for the facts (Pipeline's trust flags) and for symbols and images, which `pipescope.md` treats as untrusted.
- **Unknown or failed decodes** are kept with the transaction, and re-indexing transactions first indexed by older code is Top-pad's `reindexTransactions`.
- **Deploys**: an object kept awake goes on running the code from before a deploy, so the indexer resets itself whenever the Worker calling it runs another version (Top-pad's `wake`).
- **Backfill**: the router's whole history (185 transactions on 2026-11-09) is indexed as soon as the indexer first runs, because devnet history may be reset and Postgres must be the record.
- **Trades made through Pipescope** reach the indexer at once through the trade fast path (see Trading path); other people's trades show live while anyone is watching, and within a minute otherwise.
- **Parity check**: the devnet tests compare our trades and candles for a set of markets with Pipeline's hosted devnet API (`https://pipeline-devnet.up.railway.app`, `docs/API.md` in Pipeline's repo); it is a test oracle, never a source.
- **Restart test**: Top-pad's pattern (`tests/devnet/src/indexer-restart.test.ts`): stop the indexer, make swaps with this project's devnet keys (`~/.config/testing-pipeline/devnet/`), restart it, and check the indexed trades equal the swaps decoded from the chain.

### Candles

- Each trade is folded into its candle at every length as it is indexed, by trade order (slot, in-block position, event index) rather than arrival, the same fold a rebuild makes (Top-pad's `candles.ts`); any candle can be rebuilt from trades.
- Candles are kept per market and mint pair, since a market has two to four mints; a trade's price is `received / net_sent` for its pair (Pipeline's integrator guide); which mint of a pair is shown as the quote is for Pipescope's v1 scope and screens.
- Lengths and retention as Top-pad's: 1 s, 15 s, 1 m, 5 m, 15 m, 1 h, 4 h and 1 d; 1 s candles kept 7 days, 15 s candles 30 days, coarser ones and all trades forever.

### Live rooms

- One `LiveRoom` Durable Object per market and one for the feed, holding hibernatable browser WebSockets, so they cost no duration while idle; the indexer publishes each decoded trade, new market and new strategy version to its room, and rooms batch every 100 ms.
- A reconnecting browser resyncs from its last slot through the API.
- The rooms tell the indexer when the first viewer arrives and when the last one leaves, which opens and closes its socket.

## API

- **Public** (owner, 2026-11-10): the read endpoints and the prepare endpoints are open to anyone, with no key and any origin, behind a per-IP limit from the Workers rate-limiting binding, and labelled unstable until v1 ships, so other builders can use Pipescope's data.
  This is also where Canary results get their "page and API" in the map's Canary attestations fog.
- Endpoints, as a sketch for the build to settle in the zod contract:
  - strategies, a strategy's versions, and per version its facts, Canary results, verified-build status and explanation;
  - markets, a market's facts, trades and candles, with the feed's filters (liquidity, volume, age and Pipeline's trust flags);
  - search by name, mint, market address or strategy address, from Postgres;
  - a wallet's swaps through Pipeline, from our trades, and its balances in mints that trade in Pipeline markets, read through RPC;
  - a quote while the trader types;
  - `POST` prepare for a swap, a custom action and a new market, each returning the unsigned transaction with its simulation's outcome and balance changes;
  - `POST` a trade's signature (the fast path);
  - `POST` a "This is wrong" report against an explanation key.
- Owner-only operations are not in the API: the explainer's approve command and the reports list read and write Postgres directly from the owner's Mac.

## Trading path

Top-pad's flow (`apps/web/src/components/coin/QuickTrade.tsx`, `prepareSwap` then `signAndSendTransaction` then `reportTrade`), with what `pipescope.md` asks for.

1. While the trader types, the trade box shows a quote from RPC simulation of the strategy's `pipeline_quote` through the SDK's `quoteStrategy` (50 to 300 ms), asked through the API on Pipescope's Helius key; the Container quoter is never on the trading path.
2. When the trader asks to swap, the API prepares the unsigned transaction with Pipeline's Kit-based TypeScript SDK: the router `swap` instruction, our integrator fee at the rate on screen when the input is a fee mint, the transfer-hook extra accounts, wrapping and unwrapping SOL, idempotent creation of the trader's token accounts, and the market's `init_fee_account` when a sell needs it.
3. The API simulates that exact transaction (see Simulation before every signature) and returns it with the simulation's outcome; if the simulation failed, the page shows the error and the sign button stays off.
4. The wallet signs and sends through Wallet Standard's `signAndSendTransaction`.
5. The page sends the signature to the API, which waits for it to confirm (asking every 300 ms), reads it back, answers with the trade and a provisional order key, and hands it to the indexer, which later replaces it in place.

- Transfer-hook extra accounts are resolved by our own code for buys, sells and sweeps, from each mint's `ExtraAccountMetaList`, because neither Pipeline's SDK nor its Rust client does it ([How the containment hook works with the router and unlocks](https://github.com/imDev2023/testing-pipeline/issues/10)).
- Custom actions and market creation are prepared and simulated the same way, with the SDK's generic builders (`buildActionInstruction`, `buildCreateMarketFromMetadata`) from the strategy's validated metadata after the discriminator check; a custom action is signed directly on the strategy, outside the router's protections.

### Simulation before every signature

- Every transaction Pipescope prepares (swap, custom action, create market) is simulated by `pipescope-api` in the same request that builds it, with `simulateTransaction` on Pipescope's Helius key, the trader's wallet as fee payer, signature checks off and the blockhash replaced.
- The simulation is asked for the post-state of every token account the transaction touches; with their balances read just before, the API returns the wallet's balance changes, which the form shows before signing (`pipescope.md`, Custom-action and create-market forms).
- The transaction returned is exactly the one simulated, so what the trader signs is what was checked, apart from the chain moving in between.

### The integrator fee's configuration

- The rate (50 basis points), the fee mints (wrapped SOL and the cluster's USDC mint) and the fee wallet's two token accounts are vars of `pipescope-api` per environment in its `wrangler.jsonc`, so they change by a configuration deploy, with no code change; the fee wallet's key is never on a server ([`pipescope.md`](pipescope.md), The integrator fee).
- The API returns the rate it built each swap with, so the trade box shows exactly that rate.

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
  Its triggers are `pipescope-canary.md`'s: a new strategy version (all its markets), a router upgrade (every market), a market created or registered (that market at once, then 10 minutes, 1 hour and 1 day later), and every 6 hours (every market, from the cron); a manual re-run command is part of the build.
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

- A strategy version's source counts as evidence (S items) only when Pipescope rebuilt it from a named repository and commit and got the deployed bytes; OtterSec's hosted check does not cover devnet (empty hashes for all four devnet strategies on 2026-11-09; Top-pad found it runs on mainnet only), so Pipescope runs `solana-verify` itself.
- **Leads**: the strategy metadata's `source` (repository, commit, path) and any on-chain verification record left by `solana-verify verify-from-repo`; neither is evidence until the hashes match.
- **Where**: a GitHub Actions workflow in this repo, `verify-build.yml`, started by `pipescope-api` with `workflow_dispatch` for a strategy version with a lead, and read back by the every-minute cron through the run's status and its result artifact, with `GH_ACTIONS_TOKEN`.
- **Two jobs**:
  1. `build`, untrusted: no secrets, a token with no permissions, `solana-verify build` in its Docker image at the named commit, with dependencies fetched first and the build run with the network off where `solana-verify` allows it; it uploads the built program.
  2. `compare`, trusted, on a fresh runner: hashes the uploaded program, reads the on-chain executable hash at the version's slot, and uploads the result.
- **Known limit**: a hostile build script can still emit the deployed bytes, so a match shows the repository's build produced them, not that the visible source alone did; OtterSec's check has the same limit, and a verified source is evidence, never proof.
- Our own strategies are deployed only from verified builds and verified on chain at deploy, as in Top-pad (its `CLAUDE.md`).

## Metadata fetcher

- Runs in `pipescope-api` on `StrategyRegistered`, on `MetadataUpdated`, and every hour, because the document behind an unchanged URI can change with no event.
- Limits: `https:` only, at most 64 KB, a JSON content type, a 5 s timeout, at most 3 redirects, each `https:`; it never fetches a URL found inside the document.
- The document is validated with Pipeline's `parse_strategy_metadata` (the TypeScript SDK's port), giving the `metadata-missing`, `metadata-unreachable` or `metadata-invalid` fact, then normalised as `pipescope-explainer.md` says, and stored with its hash.
- A changed hash is a metadata change: it makes a new explanation key, pending approval.
- Everything works with no metadata at all, as on devnet today, where all four strategies' metadata links returned 404 on 2026-11-09.

## Explainer jobs

What the explainer is, its key, prompt, validator and presentation are in `pipescope-explainer.md`; this is where its parts run.

- When a new key arises (a new strategy version, a metadata change, changed Canary outcomes, or a new prompt or model version), `pipescope-api` builds the evidence input: P items from constant text, F items with Pipeline's trust facts from the TypeScript SDK, C items from the Canary records, S items from the verified source at its commit, and A items from the normalised metadata.
  It stores the input with the key, its estimated cost and the status pending.
- `pnpm explainer:approve`, run by the owner on their Mac, lists the pending keys with their estimated cost; for the keys the owner approves it calls `claude-haiku-5-5` with the `ANTHROPIC_API_KEY` from `~/.config/env/global.env`, runs the validator, retries once with the validator's errors, writes the explanation or the failed status to Postgres through the project's database URL, and appends one line per batch to `~/.config/spend/ledger.csv`.
- No LLM key is in Cloudflare, so nothing paid can run from the deployed product, whatever its code does.
- `pnpm explainer:reports` lists the "This is wrong" reports with the keys they refer to.
- Until a key's explanation exists, the strategy page shows the facts panel alone, with "No explanation for this version yet."

## Copied from Top-pad

Each copied file starts with a header naming Top-pad commit `b833a7b` and its path there; once copied, it is owned here.

| From Top-pad | Becomes |
| --- | --- |
| `packages/indexer/src/index.ts` (`indexTransactions`, `reindexTransactions`, `reconcileAccount`, the history source) | `packages/pipescope-indexer`, with Pipeline's decoder in place of Meteora's |
| `packages/indexer/src/live.ts` (`logsSubscribeRequest`, `parseLogsMessage`, `blockPositions`) | `packages/pipescope-indexer` |
| `packages/indexer/src/candles.ts` | `packages/pipescope-indexer`, per market and mint pair |
| `apps/api/src/indexer.ts` (the Indexer Durable Object: socket, alarm, reconciliation, version reset) | `apps/pipescope-api`, without Heat's graduated pools, Bundle Radar and keeper starts, and with the viewer-gated socket |
| The live rooms (Top-pad `docs/spec.md` section 10.2) | `apps/pipescope-api` |
| `packages/db` (Drizzle, migrations; `0000_init.sql` and `0002_indexer.sql` as the pattern) and `docker-compose.yml` | `packages/pipescope-db` |
| The API Worker's scaffold (`apps/api/wrangler.jsonc`, Hono with a zod contract, environments) | `apps/pipescope-api` |
| `apps/api/src/visionContainer.ts` (a Container behind a Durable Object that sleeps when idle) | `apps/pipescope-api`'s `CanaryContainer` |
| The web scaffold (`apps/web/open-next.config.ts`, `wrangler.jsonc`, `WalletProvider.tsx`, Lightweight Charts v5 use) | `apps/pipescope-web` |
| `tests/ui` (Playwright) | `tests/pipescope-e2e` |
| `tests/devnet/src/indexer-restart.test.ts` | `tests/devnet` |

- Not copied: Top-pad's Codama clients (Pipescope calls none of our programs, and Pipeline's SDK is already on Kit; Codama comes with our strategies' build tickets), its keeper Workflows, the vision service, Heat's decoders and anything of Heat's devnet bank.

## Repo layout

- `apps/pipescope-api`, `apps/pipescope-web`
- `packages/pipescope-db`, `packages/pipescope-indexer`
- `crates/canary`, in the root Rust workspace beside our on-chain programs
- `tests/pipescope-e2e` (Playwright), `tests/devnet` (the restart test and the parity check)
- `.github/workflows/verify-build.yml`

## Environments

- **Local**: `wrangler dev` for both Workers against devnet, with the Docker Postgres and `RPC_URL` from the project's `.env`.
- **Devnet**: `pipescope-api-devnet` and `pipescope-web-devnet` on `workers.dev`, deployed together by one root script; secrets set with `wrangler secret put --env devnet`.
- A custom domain waits for [Product and suite names](https://github.com/imDev2023/testing-pipeline/issues/17); renaming the Workers then only changes their `workers.dev` URLs.

## Owner tasks before the build

1. Make Pipescope's own free Helius key (a second free Helius project or account; whether one account can hold a second free project was not confirmed, since Helius's docs could not be fetched on 2026-11-09) and put its devnet URL in the project's `.env` as `RPC_URL`.
2. Create the Neon project `pipescope-devnet` on the free plan and put its connection string in the project's `.env` as `DATABASE_URL`.
3. Create a fine-grained GitHub token for this repo with Actions read and write only, for the verified-build workflow; the build session sets it as `GH_ACTIONS_TOKEN`.
4. Approve the explainer's first paid run, as `pipescope-explainer.md` says.

Nothing is purchased: Workers Paid is already active.

## Suggested build slices

For [Cut Pipescope's build tickets](https://github.com/imDev2023/testing-pipeline/issues/22) to adjust; each slice is meant to be demonstrable on devnet on its own.

1. Scaffold both Workers, the database and the devnet deploy, with an empty API and page.
2. The indexer: router and strategy programs, reconciliation, registry snapshot, ProgramData watch, backfill, restart test.
3. Candles, live rooms and the viewer-gated socket.
4. The trading path, with transfer-hook extra accounts and the fast path.
5. The metadata fetcher and the facts (Pipeline's trust facts) behind the facts panel.
6. The Canary runner: `crates/canary`, its image, `CanaryRun` and the records.
7. Verified builds.
8. Explainer jobs: the evidence builder, the approve command and the reports command.
9. The web app's pages, from Pipescope's v1 scope and screens.
