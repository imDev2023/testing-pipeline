# Where Pipescope's indexer gets its data

Research for [#6](https://github.com/imDev2023/testing-pipeline/issues/6), feeding [Pipescope architecture](https://github.com/imDev2023/testing-pipeline/issues/13).
Every fact is dated 2026-11-09 unless it says otherwise.
Sources: Pipeline's source at commit `a2d5bfb` (read-only clone in a scratchpad, never copied here), Top-pad at commit `b833a7b` (`/Volumes/Farhan/Work Folder/Dev/AI/Top-pad`), the Helius docs (through the Helius MCP knowledge tools and helius.dev), the Solana docs, the owner's Cloudflare knowledge base, and read-only devnet calls made for this note.
Items marked **unverified** were not confirmed against a primary source or on chain.

## The answer in brief

- One address covers everything the router does: every strategy registration, market creation and swap through Pipeline is a router transaction, so the indexer watches the router and needs no per-market or per-strategy address list for its trades.
- Swap events are inner instructions (a router self-CPI), not log lines, so a log subscription only says which transaction to fetch; the indexer must read the whole transaction.
- The router does not report three things Pipescope needs: strategy upgrades (new strategy versions), custom actions such as adding liquidity, and bypass swaps; those are seen only by watching the strategy programs and their accounts.
- On devnet the free tiers are enough by a wide margin: the router had 185 transactions in its first 37.5 hours, and on Helius's free tier every router transaction watched was ready to decode 1.0 to 1.5 s after its block time.
- No socket is complete on its own: the public devnet socket silently missed 1 of 6 router transactions while it was watched, so reconciliation from a cursor is required whatever the live source.
- Recommendation: port Top-pad's free-tier indexer (a Durable Object holding a standard `logsSubscribe` WebSocket on Helius devnet, `getTransaction` per reported transaction, and cursor reconciliation every minute), point it at the router and each registered strategy program, and add a registry snapshot and a ProgramData watch; keep LaserStream as the paid upgrade path for mainnet, and do not use webhooks as the primary source.

## What the indexer has to learn, from Pipeline's source

### Router events

- The router emits six events through Anchor's `emit_cpi!`: `SwapEvent`, `StrategyRegistered`, `MetadataUpdated`, `MarketCreated`, `FeesSwept` and `ConfigChanged` (`programs/pipeline/src/lib.rs` lines 80 to 646, `crates/pipeline-events/src/lib.rs`, commit `a2d5bfb`).
- An event is an inner instruction to the router whose data is `EVENT_IX_TAG` (8 bytes), the event discriminator `sha256("event:<Name>")[..8]`, then the Borsh-encoded event (`crates/pipeline-events/src/lib.rs` lines 1 to 18).
- The integrator guide says the self-CPI means an event "is not lost to log truncation" and that it "appears in the transaction's inner instructions" (`docs/INTEGRATOR-GUIDE.md` section 4).
- Consequence: the logs a `logsSubscribe` notification carries do not contain event data, so every reported transaction must be fetched (`getTransaction`) or streamed in full.
- The TypeScript SDK already decodes the shape `getTransaction` returns with `json` encoding: `extractEventsFromInnerInstructions(accountKeys, innerInstructions)`, where `accountKeys` is the static keys, then `meta.loadedAddresses.writable`, then `readonly` (`sdk/ts/src/events.ts` lines 237 to 263).
- The SDK notes that only the router's event authority PDA can sign such an instruction, so any successful inner instruction to the router with this prefix is a genuine event (`sdk/ts/src/events.ts` lines 9 to 10).
- Unknown events, for example from a newer router, decode to `None` or `null` rather than failing (`crates/pipeline-events/src/lib.rs` `decode`, `sdk/ts/src/events.ts` `decodeEvent`), so an indexer must keep such transactions to index again later.
- `SwapEvent` carries `slot` and `unix_timestamp` but no position within the block (`crates/pipeline-events/src/lib.rs` lines 30 to 50), so ordering trades inside one slot (a candle's open and close) needs another source.

### Router accounts

- Discovery by accounts is `getProgramAccounts` on the router filtered by the `Strategy` and `Market` discriminators (`docs/INTEGRATOR-GUIDE.md` section 1; `sdk/ts/src/discovery.ts` `fetchStrategies`, `fetchMarkets`).
- The router's instructions are `initialize_config`, `update_config`, `lift_pause`, `register_strategy`, `update_metadata`, `create_market`, `register_existing_market`, `init_fee_account`, `swap` and `sweep_fees`; none closes a `Strategy` or `Market` account (`programs/pipeline/src/lib.rs`, commit `a2d5bfb`).
- So the registry only grows, and a `getProgramAccounts` snapshot is a complete check of discovery that does not depend on how much transaction history an RPC keeps.
- Both `create_market` and `register_existing_market` emit `MarketCreated` (`programs/pipeline/src/lib.rs` lines 321 and 350).

### What the router never reports

- Strategy upgrades: a strategy is upgraded through the BPF upgradeable loader, not the router, so no router event marks a new strategy version.
  The integrator guide says to "Reload a program when its ProgramData changes, since strategies can be upgraded" (`docs/INTEGRATOR-GUIDE.md` section 2).
  On devnet all four registered strategies were redeployed on 2026-11-08 between 20:08 and 21:10 UTC, and the router itself at 07:11:06 UTC on 2026-11-09 (ProgramData last-deploy slots 520136342 to 520151758 and 520302321, read from `https://api.devnet.solana.com`), with no router event for any of them.
- Custom actions such as adding or removing liquidity: "Users call it directly; it costs no Pipeline fee and is not routed through the router" (`docs/STRATEGY-GUIDE.md` line 96), so vault balances change without a router transaction.
- Bypass swaps: "Trades made by calling a strategy directly, bypassing Pipeline, do not produce Pipeline events" (`docs/INTEGRATOR-GUIDE.md` section 4).
- Account state for quoting: the quoter "never talks to the network" and callers feed it account data "from RPC, WebSocket or Geyser streams" (`crates/pipeline-quoter/src/lib.rs` lines 1 to 6); the integrator guide asks integrators to "keep the market's accounts updated from your stream" (`docs/INTEGRATOR-GUIDE.md` section 2).
- Every transaction that upgrades or calls a strategy names the strategy's program id: a custom action or bypass swap invokes the program, and the loader's `Upgrade` instruction lists "The ProgramData account" and "The Program account" first (`loader-v3-interface/src/instruction.rs` in https://github.com/anza-xyz/solana-sdk at `d42ce91`).
  So a `logsSubscribe` on each strategy program sees upgrades, custom actions and bypass swaps alike, along with every routed swap into it.

### Devnet stability

- "Devnet programs can be upgraded or reset without notice while Pipeline is pre-release" (`docs/DEVNET.md`).
- "Devnet may be subject to ledger resets" (Solana docs, `apps/docs/content/docs/en/references/clusters.mdx` in https://github.com/solana-foundation/solana-com at `dd6c46a`).

## Devnet today: a census of the router's history

Read-only, through Helius devnet with the owner's free key and through `https://api.devnet.solana.com`, on 2026-11-09 (newest transaction 07:57:51 UTC):

| Measure | Value |
| --- | --- |
| Router transactions (both RPCs agree) | 185, none failed |
| First and newest | 2026-11-07 18:30:20 UTC (slot 519750724) to 2026-11-09 07:57:51 UTC (slot 520314058) |
| Rate | about 5 an hour |
| `SwapEvent` | 111 |
| `MarketCreated` | 42 |
| `StrategyRegistered` | 4 |
| `MetadataUpdated`, `FeesSwept`, `ConfigChanged` | 0 |
| Transactions with no event | 28 (`init_fee_account` emits none) |
| Most swaps in one transaction | 1 |
| Slots with more than one swap transaction | 0 |

The census script decoded each transaction's inner instructions with the tag and discriminators above; every transaction was served by `getTransaction`.

## The options compared

| Source | Latency to a decoded swap | After downtime | Devnet | Free tier | Paid |
| --- | --- | --- | --- | --- | --- |
| Standard WebSocket `logsSubscribe` (router mentions) plus `getTransaction` | Measured 2026-11-09: notified about 1 s after block time, transaction served 0.1 to 0.3 s later on Helius free | Nothing replayed; the public socket missed 1 of 6 transactions; needs reconciliation | Yes, Helius and public | Yes: 5 connections, 10 RPC requests a second, 1M credits a month | Same method on all plans |
| Polling `getSignaturesForAddress` plus `getTransaction` | Poll interval plus the fetch | Complete from a cursor, while history lasts | Yes | Yes, but a 2 s poll alone is about 1.3M credits a month | Same |
| Helius webhooks (`rawDevnet`) | "200-500ms from confirmation" (Helius, **unverified** by us) | Retries, then lost (Helius docs disagree on how long); needs reconciliation | Yes | Yes: 5 webhooks, 1 credit an event | 50 webhooks on Developer and up |
| Helius Enhanced WebSocket `transactionSubscribe` | The full transaction in the notification, no fetch | Nothing replayed; needs reconciliation | Devnet endpoint listed; refused on the free key | No: "transactionSubscribe is not available on the free plan" (devnet reply, 2026-11-09) | Developer $49 a month, or Business $499 (Helius docs disagree) |
| Helius LaserStream gRPC | Lowest; full transactions and accounts | Replays up to about 48 hours from `fromSlot` | Developer and up | No | Devnet from Developer $49; mainnet Business $499 or Professional $999 (docs disagree) |
| Helius Parsed Streams | Decoded transactions over a WebSocket | No replay documented | Not documented (**unverified**) | Yes, 1 credit an event | Same |
| Helius `getTransactionsForAddress` (history only) | Not a live source | Complete from a slot or pagination token; returns full transactions with `innerInstructions` and `transactionIndex` | Yes | Answered the free key on devnet on 2026-11-09, though the billing page says Developer and up | 10 credits per 100 full transactions |

### Notes on each

Standard WebSocket:

- Helius serves standard subscriptions (`accountSubscribe`, `programSubscribe`, `logsSubscribe`, `signatureSubscribe`, `slotSubscribe`) on all plans including Free, with 5 concurrent connections on Free and 150 on Developer, a 10-minute inactivity timeout and pings advised every minute (https://www.helius.dev/docs/api-reference/rpc/websocket-methods, last updated 2026-05-18; https://www.helius.dev/docs/rpc/websocket.md).
- The page gives no delivery guarantee and says "missed messages often indicate disconnections" (https://www.helius.dev/docs/rpc/websocket.md).
- WebSocket streaming is metered at 2 credits per 0.1 MB, and opening a connection costs 1 credit (https://www.helius.dev/docs/api-reference/rpc/websocket-methods).
- On 2026-11-09 a `logsSubscribe` on the router was accepted by both `wss://devnet.helius-rpc.com` (free key) and `wss://api.devnet.solana.com`.
- Measured from this Mac on 2026-11-09 between 08:01 and 08:16 UTC, listening to both sockets for 25 minutes while 6 router transactions landed:
  - every notification at `confirmed` arrived 0.8 to 1.2 s after the block time (which has 1 s resolution);
  - Helius's notifications came 79 to 191 ms after the public endpoint's;
  - Helius free served each transaction by `getTransaction` 74 to 333 ms after its notification, 1.0 to 1.5 s after block time;
  - the public endpoint served 4 of its 5 within 40 ms, and one only after 26 s;
  - the public socket never reported one of the 6 transactions (`5MV8DybAspyq...`, slot 520318534), with no disconnect seen, while Helius's did.
- Top-pad measured slower serving on the same provider in October: about 1.5 to 2 s after the block (`apps/api/src/indexer.ts` lines 40 to 44, measured 2026-10-29) and 2 to 3 s on its deployed site (`docs/spec.md` section 10.2), and about 5.5 s from a trade being sent to it showing on the deployed page.

Polling:

- At 1 credit a call (https://www.helius.dev/docs/billing), one `getSignaturesForAddress` every 2 s is 1,296,000 credits in 30 days, more than the free plan's 1M; one a minute is 43,200.
- The public devnet endpoint allows 100 requests per 10 s per IP, 40 per method, 40 concurrent connections and 100 MB per 30 s, and "The public RPC endpoints are not intended for production applications" (Solana docs, `clusters.mdx` at `dd6c46a`).
- Solana's public endpoints answered a Cloudflare Worker with 403 ("Your IP or provider is blocked") on 2026-10-29, so Top-pad's API runs on Helius devnet (Top-pad `docs/spec.md` section 10.5).

Webhooks:

- Webhook types include `rawDevnet` and `enhancedDevnet`; 1 credit an event and 100 credits per create, edit or delete; 5 webhooks on Free and 50 on paid plans; 100,000 addresses per webhook (https://www.helius.dev/docs/api-reference/webhooks).
- Enhanced parsing only knows Helius's catalogue of programs; for the router a raw webhook is needed, and raw webhooks "return regular Solana transaction data directly from the blockchain" (https://www.helius.dev/docs/faqs/webhooks.md); whether that includes `meta.innerInstructions` in `getTransaction`'s shape is **unverified**.
- The sources disagree on retries: the API reference says "24-hour retry with exponential backoff" (https://www.helius.dev/docs/api-reference/webhooks), while the FAQ says "We retry up to 3 times with a 1-second gap" and "If all retry attempts fail, the event is permanently lost" (https://www.helius.dev/docs/faqs/webhooks.md).
- Webhooks with a 95% or worse delivery failure rate are disabled automatically, judged over 24 hours on Free (https://www.helius.dev/docs/api-reference/webhooks).
- Helius "may deliver the same webhook event multiple times" (https://www.helius.dev/docs/faqs/webhooks.md).
- Top-pad rejected webhooks because "they carry no in-block position, can lose an event after 3 failed retries, and take minutes to watch a new address" (Top-pad `docs/spec.md` section 10.2); the last reason matters less here, since the router is one fixed address.

Enhanced WebSocket:

- `transactionSubscribe` and the filtered `accountSubscribe` "require a Developer, Business, or Professional" plan (https://www.helius.dev/docs/rpc/websocket.md), while the rate-limit table lists Enhanced WebSockets only from Business (https://www.helius.dev/docs/billing); the plan comparison lists them from Developer.
- The free key's devnet reply was `{"code":-32600,"message":"transactionSubscribe is not available on the free plan"}` (2026-11-09).

LaserStream:

- Historical replay of "up to ~48 hours", started with `fromSlot`, and "Mainnet requires a Business or Professional plan; Devnet is available on Developer and above" (https://www.helius.dev/docs/laserstream/historical-replay.md).
- The API reference lists a devnet endpoint, `https://laserstream-devnet-ewr.helius-rpc.com`, and 2 credits per 0.1 MB streamed (https://www.helius.dev/docs/api-reference/laserstream-grpc, last updated 2026-10-06).
- The same page's getting-started step says "Devnet: Developer/Business, Mainnet: Professional", and the rate-limit table lists Business as devnet only (https://www.helius.dev/docs/billing): the mainnet tier must be confirmed with Helius before buying.
- LaserStream is gRPC; a Yellowstone gRPC consumer belongs in a Cloudflare Container, not a Worker isolate (owner's Cloudflare KB, `build/01-compute.md` line 1893), and Containers are on Workers Paid only (same file, line 9); Top-pad planned exactly this (Top-pad `docs/spec.md` section 10.1).

Parsed Streams:

- It "decodes 3,600+ programs from their on-chain IDLs", streams instructions it cannot decode "as raw instruction data instead", matches inner instructions by default, is "generally available on all plans, including Free", costs 1 credit an event, and allows 5 connections on Free with 25 subscriptions each (https://www.helius.dev/docs/parsed-streams.md, https://www.helius.dev/docs/parsed-streams/quickstart.md).
- Its only endpoint is `wss://beta.helius-rpc.com`, devnet is not mentioned, and no replay is documented: it is a mainnet option to revisit, not a devnet one.

`getTransactionsForAddress`:

- Full results include `innerInstructions` and `transactionIndex`, "The zero-based index of the transaction within its block", sort `asc` or `desc`, slot filters and a `slot:position` pagination token, up to 1,000 rows per page (https://www.helius.dev/docs/rpc/gettransactionsforaddress.md).
- On 2026-11-09 the free key on devnet got answers in both modes: signatures (first router transaction at slot 519750724, `transactionIndex` 14) and full (100 rows with `meta.innerInstructions`, next token `520149127:4`).
- The billing page calls it "Developer+ only" (https://www.helius.dev/docs/billing): free access may be withdrawn, so it must sit behind the same source interface as `getSignaturesForAddress`.

## Completeness after downtime, and backfill

- No live source above, LaserStream's 48 hours aside, replays what it missed, so every design needs reconciliation from a stored cursor; the public socket's silent miss on 2026-11-09 shows a socket can drop a transaction without disconnecting.
- Top-pad's reconciliation lists each watched address's signatures newer than its cursor, oldest first, skips ones already indexed or failed, stops at the first it cannot fetch yet so the cursor never passes an unindexed transaction, and moves the cursor (`packages/indexer/src/index.ts` `reconcileAccount`, lines 82 to 145).
- Its devnet test stops the indexer, makes three swaps, restarts it and checks that the indexed trades equal the swaps decoded from the chain (`tests/devnet/src/indexer-restart.test.ts`), and it passed on 2026-10-29 (Top-pad `docs/spec.md` section 10.2).
- How long devnet history lasts: the Helius page says devnet retention for `getTransactionsForAddress` is 2 weeks (https://www.helius.dev/docs/rpc/gettransactionsforaddress.md), yet on 2026-11-09 it returned Meteora DBC's first devnet transaction from 2025-04-23, and both Helius devnet and `api.devnet.solana.com` served that transaction by `getTransaction`.
- So in practice devnet history went back at least 19 months on 2026-11-09, but the documented figure is 2 weeks and devnet can be reset: Pipescope's own database must be its record, and a first backfill of the router's whole history (185 transactions) should run as soon as the indexer exists.
- Discovery has a second, history-free check: the registry only grows, so a periodic `getProgramAccounts` snapshot of `Strategy` and `Market` accounts (10 credits a call on Helius, 5 a second on Free; https://www.helius.dev/docs/billing) proves no strategy or market was missed.
- Trades have no such check: a swap whose transaction leaves every RPC's history before the indexer reads it is gone, so downtime must stay well inside the retention an RPC actually gives.

## What carries over from Top-pad

From Top-pad at commit `b833a7b`, all of it Cloudflare Workers and Postgres:

| Piece | Where | Carries over |
| --- | --- | --- |
| One ingestion entry point with an idempotent handler, batch errors, re-indexing of transactions first indexed by older code | `packages/indexer/src/index.ts` `indexTransactions`, `reindexTransactions` | As is; the handler becomes Pipeline's |
| Cursor reconciliation over a narrow `HistorySource` (`getSignaturesForAddress` and `getTransaction`) | `packages/indexer/src/index.ts` `reconcileAccount`, `rpcSource`, `fetchRawTransaction` | As is; add a `getTransactionsForAddress` source behind the same interface |
| `logsSubscribe` request and message parsing; in-block position from `getBlock` | `packages/indexer/src/live.ts` `logsSubscribeRequest`, `parseLogsMessage`, `blockPositions` | As is |
| The indexer Durable Object: the socket, a 15 s alarm that reopens it, reconciliation every minute that asks the chain first, transactions fetched every 300 ms until served, and a reset when the Worker calling it runs a newer version | `apps/api/src/indexer.ts` | The shape, without Heat's graduated pools, Bundle Radar and keeper starts; the watched list becomes the router plus each registered strategy program, added as `StrategyRegistered` arrives, the way Top-pad added graduated pools |
| Candles folded per trade in trade order, rebuildable from trades | `packages/indexer/src/candles.ts` | As is, with trades keyed by signature and event index |
| Tables `indexed_transactions`, `trades`, `candles` and the cursor table `indexer_cursors` | `packages/db/migrations/0002_indexer.sql`, `0000_init.sql` | The pattern; `pools` becomes markets and strategies |
| Restart test | `tests/devnet/src/indexer-restart.test.ts` | The pattern, making swaps with our own devnet keys (`~/.config/testing-pipeline/devnet/`), not Heat's bank |
| Live rooms: one Durable Object per market and one for the board, hibernatable browser sockets, 100 ms batches | Top-pad `docs/spec.md` section 10.2 | The pattern |

Lessons that carry over:

- Pipeline's SDK decodes the same raw `getTransaction` JSON Top-pad's indexer passes around, so the decoder swap is small (`sdk/ts/src/events.ts`; Top-pad `packages/indexer/src/index.ts` `fetchRawTransaction`).
- A Durable Object kept awake by an outbound socket and an alarm went on running the code from before a deploy, so it must reset itself on a version mismatch (Top-pad `apps/api/src/indexer.ts` `wake`; owner's Cloudflare KB `build/01-compute.md` line 857).
- Outbound WebSockets do not hibernate and keep the object billed for duration; one always-awake object is about 324,000 GB-s a month, inside Workers Paid's 400,000 GB-s and the Free plan's 13,000 GB-s a day (owner's Cloudflare KB, `web3-launch-playbook.md` section 4.5, citing https://developers.cloudflare.com/durable-objects/best-practices/websockets/ and https://developers.cloudflare.com/workers/platform/pricing/).
- The shared Helius free key is rate-limited when several agents use it at once, and it sends 1 transaction a second (Top-pad `docs/spec.md` section 10.5); Pipescope shares that key with Top-pad unless the owner gives it its own.

What does not carry over: Top-pad decoded Meteora DBC and DAMM v2 and its own programs (`packages/indexer/src/decode.ts`, `heat.ts`), and watched configs and pools that change as coins graduate; Pipeline gives one router and its own decoder instead.

## Recommendation

For the devnet build, free tiers only:

1. Port Top-pad's indexer as above: one Durable Object holding a standard `logsSubscribe` WebSocket on Helius devnet, on the router and on every registered strategy program; every reported transaction fetched by `getTransaction` and decoded with Pipeline's SDK; in-block order from `getBlock`.
2. Reconcile every minute from per-address cursors (the router every minute; strategy programs can be every few minutes), through `getTransactionsForAddress` while the free key gets it, else `getSignaturesForAddress` plus `getTransaction`.
3. Snapshot the registry with `getProgramAccounts` (every 10 minutes is plenty at today's volume) and treat any `Strategy` or `Market` account not yet indexed as a missed event.
4. Watch every strategy's ProgramData last-deploy slot (one `getMultipleAccounts` with a 45-byte `dataSlice` covers 100 programs) and treat a change as a new strategy version, which re-runs the Canary checks and reloads the quoter; watch the router's ProgramData too, since a router upgrade can change event layouts.
5. Re-read a market's state and vaults after each event or custom action that touches it, rather than subscribing to every account, until the Pipescope architecture ticket decides how the quoter is fed.
6. Run the full backfill of the router's history as soon as the indexer runs, and keep Postgres as the record.

Estimated Helius credits at today's volume, in 30 days: about 216,000 for reconciliation of five addresses every minute, 86,400 for the registry snapshots, 43,200 for the ProgramData watch, and some tens of thousands for fetching and placing about 3,600 transactions; about 400,000 in all, inside the free plan's 1M but shared with whatever else uses the same key (prices and credits from https://www.helius.dev/docs/billing; volume from the census above).

Before mainnet, a paid choice for the owner:

- LaserStream gRPC in a Cloudflare Container gives the lowest latency and 48 hours of replay, with `getTransactionsForAddress` for anything older; it needs Workers Paid and a Helius plan from Developer ($49 a month) for devnet, and Business ($499) or Professional ($999) for mainnet, which Helius's own pages disagree on.
- Enhanced WebSockets on a paid plan remove the `getTransaction` round trip without a Container, but replay nothing; that round trip took 0.1 to 0.3 s on 2026-11-09 (1.5 to 3 s in Top-pad's October measurements), so on devnet it buys little.
- Parsed Streams is free and decodes inner instructions, but is documented only on a beta mainnet host; worth a look when mainnet nears.

Not recommended as the primary source: webhooks, because their retry policy is documented two contradictory ways and lost events need reconciliation anyway, and because the raw payload's inner instructions are unverified.
A raw devnet webhook beside the socket could still cut the fetch delay; a one-hour spike would settle whether its payload carries inner instructions and how fast it arrives.

## Contradictions and gaps in the sources

- Helius gives the plan for Enhanced WebSockets as Developer (https://www.helius.dev/docs/rpc/websocket.md and the plan comparison) and as Business (rate-limit table, https://www.helius.dev/docs/billing).
- Helius gives mainnet LaserStream as Business or Professional (https://www.helius.dev/docs/laserstream/historical-replay.md, plan comparison) and as Professional only (https://www.helius.dev/docs/api-reference/laserstream-grpc getting started; rate-limit table).
- Helius gives webhook retries as 24 hours with backoff (API reference) and as 3 tries a second apart, then lost (FAQ).
- Helius calls `getTransactionsForAddress` Developer and up (billing) and limits devnet to 2 weeks of history (method page); on 2026-11-09 the free key got it on devnet and it returned a devnet transaction from 2025-04-23.
- Not measured here: latency from a trader sending a swap to its notification, since this research sends no transactions; the 6 transactions above were someone else's and were timed from their block time.
- Not measured here: webhook latency and payload, Enhanced WebSocket and LaserStream behaviour, all of which need a webhook created or a paid plan.
