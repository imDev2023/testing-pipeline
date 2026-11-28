// The indexer's work, as the `Indexer` Durable Object runs it on the dispatcher's schedule
// (docs/spec/pipescope-architecture.md, Indexer and Data): the router's whole history backfilled on
// its first run, then reconciliation that asks the chain first and touches Postgres only when there
// is something new, so Neon sleeps while devnet is quiet; and the registry snapshot.
import { readFileSync } from "node:fs";
import { encodeAccount, getStrategyCodec, PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { address } from "@solana/kit";
import { candles, createDb, markets, metadataSnapshots, mints, strategies, trades } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { DECODER_VERSION, historySource, indexTransactions, pipelineHandler, type HistorySource, type RawTransaction, type TransactionHandler } from "terminal-indexer";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANDLES, LIVE_ROOM_TRADES_MAX, RPC_WAITS } from "../src/config";
import { IndexerCore } from "../src/indexerCore";
import { memoryImages, metadataWeb } from "./fakes";

const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/../../../packages/terminal-indexer/test/fixtures/${name}.json`, "utf8")) as RawTransaction;
const [registered, created, swap] = ["registered", "marketCreated", "swap"].map(fixture) as [RawTransaction, RawTransaction, RawTransaction];

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let rpc: FakeRpc;
let reader: ReturnType<typeof createDb>;
beforeEach(async () => {
  database = await createTestDatabase();
  reader = createDb(database.url);
  rpc = await fakeRpc([registered, created]);
});
afterEach(async () => {
  await rpc.close();
  await reader.close();
  await database.drop();
});
afterAll(() => vi.restoreAllMocks());

/** The core with a spy on its database client: every client it opens is counted, and each is a real one. */
function core(web = metadataWeb()) {
  const openDb = vi.fn(() => createDb(database.url));
  return { indexer: new IndexerCore({ rpcUrl: rpc.url, openDb, webFetch: web.fetch, images: memoryImages() }), openDb, web };
}

describe("reconciliation of the router", () => {
  it("backfills the router's whole history on its first run", async () => {
    const { indexer } = core();
    const status = await indexer.reconcile();
    expect(status.indexed.counts).toEqual({ strategies: 1, markets: 1 });
    expect(await reader.db.select({ program: strategies.program }).from(strategies)).toEqual([{ program: "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t" }]);
  });

  it("sends no query to Postgres when the chain has nothing new", async () => {
    const { indexer, openDb } = core();
    await indexer.reconcile();
    openDb.mockClear();
    const status = await indexer.reconcile();
    expect(openDb).not.toHaveBeenCalled();
    expect(status).toMatchObject({ quiet: true, indexed: { counts: {} } });
  });

  it("opens the database again as soon as the chain has something new", async () => {
    const { indexer, openDb } = core();
    await indexer.reconcile();
    openDb.mockClear();
    rpc.history.push(swap);
    expect((await indexer.reconcile()).indexed.counts).toEqual({ trades: 1 });
    expect(openDb).toHaveBeenCalledTimes(1);
    expect(await reader.db.select({ signature: trades.signature }).from(trades)).toEqual([{ signature: swap.transaction.signatures[0] }]);
  });

  it("reports what a run indexed to the one call that started it, so a call that joined it never publishes it again (#214)", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    rpc.history.push(swap);
    // The cron's run and the socket's open-time run at once: one run, and its swap reported once.
    const [cron, socket] = await Promise.all([indexer.reconcile(), indexer.reconcile()]);
    expect([...cron.indexed.trades, ...socket.indexed.trades]).toEqual([{ signature: swap.transaction.signatures[0], eventIndex: 0 }]);
    expect(socket.cursor).toEqual(cron.cursor);
  });

  it("runs again after a run it joined, so the socket's open-time call covers what landed after that run read the chain (#214)", async () => {
    const real = historySource(rpc.url, RPC_WAITS.block);
    let joined: Promise<{ indexed: { trades: unknown[] } }> | null = null;
    const source: HistorySource = {
      hasAfter: (account, cursor) => real.hasAfter(account, cursor),
      after: async (account, cursor, limit) => {
        const page = await real.after(account, cursor, limit);
        // The cron's run has read the chain; a swap lands, and the socket's call arrives and joins it.
        if (!joined && rpc.history.length === 2) {
          rpc.history.push(swap);
          joined = indexer.reconcile();
        }
        return page;
      },
    };
    const indexer = new IndexerCore({ rpcUrl: rpc.url, openDb: () => createDb(database.url), webFetch: metadataWeb().fetch, images: memoryImages(), source });
    const cron = await indexer.reconcile();
    expect(cron.indexed.trades).toEqual([]);
    expect((await joined!).indexed.trades).toEqual([{ signature: swap.transaction.signatures[0], eventIndex: 0 }]);
  });

  it("closes every database client it opens, even when indexing fails", async () => {
    let closed = 0;
    const openDb = vi.fn(() => {
      const client = createDb(database.url);
      return { db: client.db, close: () => client.close().then(() => void closed++) };
    });
    rpc.refuse.add("getMultipleAccounts");
    await expect(new IndexerCore({ rpcUrl: rpc.url, openDb, webFetch: metadataWeb().fetch, images: memoryImages() }).reconcile()).rejects.toThrow("getMultipleAccounts");
    expect(openDb).toHaveBeenCalledTimes(1);
    expect(closed).toBe(1);
  });
});

describe("reading a market's accounts", () => {
  it("is tried again on the next run when it failed, though the chain has nothing new", async () => {
    const { indexer } = core();
    rpc.refuse.add("getMultipleAccounts");
    await expect(indexer.reconcile()).rejects.toThrow("getMultipleAccounts");
    rpc.refuse.clear();
    await indexer.reconcile();
    expect(await reader.db.select({ address: markets.address, readSlot: markets.readSlot }).from(markets)).toEqual([{ address: "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz", readSlot: 525_200_000n }]);
  });

  it("is done on a new instance's first run for every market never read, as after a restart", async () => {
    rpc.refuse.add("getMultipleAccounts");
    await expect(core().indexer.reconcile()).rejects.toThrow("getMultipleAccounts");
    rpc.refuse.clear();
    await core().indexer.reconcile();
    expect((await reader.db.select({ readSlot: markets.readSlot }).from(markets))[0]?.readSlot).toBe(525_200_000n);
  });
});

describe("reading again what older code could not decode", () => {
  it("never stops the router's reconciliation, even when a kept transaction cannot be read again", async () => {
    // A transaction an older decoder kept as unknown, which the current handler fails on.
    const kept = fixture("swap");
    const { db, close } = createDb(database.url);
    await indexTransactions(db, pipelineHandler({ decode: () => null, decoderVersion: DECODER_VERSION - 1, candleSeconds: [] }), [kept]);
    await close();
    const real = pipelineHandler({ candleSeconds: [] });
    const handler: TransactionHandler = async (db, raw) => {
      if (raw.transaction.signatures[0] === kept.transaction.signatures[0]) throw new Error("this transaction cannot be read");
      return real(db, raw);
    };
    const indexer = new IndexerCore({ rpcUrl: rpc.url, openDb: () => createDb(database.url), handler, webFetch: metadataWeb().fetch, images: memoryImages() });
    expect((await indexer.reconcile()).indexed.counts).toEqual({ strategies: 1, markets: 1 });
  });
});

describe("the registry snapshot", () => {
  it("touches Postgres only when the router holds an account not indexed yet", async () => {
    const strategyAccount = (program: string) =>
      encodeAccount("Strategy", getStrategyCodec(), { programId: address(program), metadataUri: "https://example.org/s.json", interfaceVersion: 1, registeredAt: 1_795_000_000n, marketCount: 0n, bump: 255 });
    rpc.accounts.set("StrategyPdaA", { owner: PIPELINE_PROGRAM_ADDRESS, data: strategyAccount("J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t") });
    const { indexer, openDb } = core();
    await indexer.reconcile();
    await indexer.snapshot();
    openDb.mockClear();

    expect(await indexer.snapshot()).toEqual({ strategies: [], markets: [] });
    expect(openDb).not.toHaveBeenCalled();

    rpc.accounts.set("StrategyPdaB", { owner: PIPELINE_PROGRAM_ADDRESS, data: strategyAccount("BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6") });
    expect(await indexer.snapshot()).toEqual({ strategies: ["BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6"], markets: [] });
    expect(openDb).toHaveBeenCalledTimes(1);
  });
});

describe("candles", () => {
  it("are folded from each swap reconciliation indexes, at every length the config module lists", async () => {
    rpc.history.push(swap);
    await core().indexer.reconcile();
    const lengths = (await reader.db.select({ seconds: candles.seconds }).from(candles)).map((c) => c.seconds).sort((a, b) => a - b);
    expect(lengths).toEqual(CANDLES.map((c) => c.seconds));
  });

  it("missing for trades indexed before candles were kept are written by a new instance's first run (#214)", async () => {
    rpc.history.push(swap);
    await core().indexer.reconcile();
    const folded = await reader.db.select().from(candles);
    // As in a database that held trades before migration 0003 made the table.
    await reader.db.delete(candles);
    await core().indexer.reconcile();
    const sorted = (rows: typeof folded) => [...rows].sort((x, y) => x.seconds - y.seconds);
    // Every length within its retention: the swap's 1 s and 15 s candles are past theirs only after a week and a month.
    const kept = folded.filter((c) => CANDLES.find((l) => l.seconds === c.seconds)!.keepDays === null || Number(c.start) >= Date.now() / 1000 - CANDLES.find((l) => l.seconds === c.seconds)!.keepDays! * 86_400);
    expect(sorted(await reader.db.select().from(candles))).toEqual(sorted(kept));
  });

  it("past their retention are dropped by the daily prune, which leaves the rest", async () => {
    rpc.history.push(swap);
    const { indexer } = core();
    await indexer.reconcile();
    // The swap is from 2026-11-22; a week and a day later its 1 s candle has gone and the rest stay.
    const deleted = await indexer.prune(swap.blockTime! + 8 * 86_400);
    expect(deleted).toBe(1);
    expect((await reader.db.select({ seconds: candles.seconds }).from(candles)).map((c) => c.seconds)).not.toContain(1);
  });
});

describe("the live path", () => {
  it("indexes a transaction the socket reported, once the RPC serves it, with its place in its block", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    rpc.history.push(swap);
    rpc.unserved.add(swap.transaction.signatures[0]!);
    setTimeout(() => rpc.unserved.clear(), 300);
    const indexed = await indexer.indexSignatures([swap.transaction.signatures[0]!]);
    expect(indexed.trades).toEqual([{ signature: swap.transaction.signatures[0], eventIndex: 0 }]);
    expect(await reader.db.select({ blockIndex: trades.blockIndex }).from(trades)).toEqual([{ blockIndex: swap.transactionIndex }]);
  });

  it("asks the RPC for nothing the database already holds", async () => {
    rpc.history.push(swap);
    const { indexer } = core();
    await indexer.reconcile();
    rpc.requests.length = 0;
    expect((await indexer.indexSignatures([swap.transaction.signatures[0]!])).trades).toEqual([]);
    expect(rpc.requests.filter((r) => r.method === "getTransaction")).toEqual([]);
  });

  it("turns what it indexed into events for the rooms with a viewer: the swap for its market's room, the market for the feed's", async () => {
    const { indexer, openDb } = core();
    await indexer.reconcile();
    rpc.history.push(swap);
    const indexed = await indexer.indexSignatures([swap.transaction.signatures[0]!]);
    const market = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
    const events = await indexer.events(indexed, ["feed", `market:${market}`, "market:SomeOtherMarket11111111111111111111111111"]);
    expect([...events.keys()].sort()).toEqual(["feed", `market:${market}`]);
    expect(events.get(`market:${market}`)!.map((e) => e.type)).toEqual(["trade", "market"]);
    expect(events.get(`market:${market}`)![0]).toMatchObject({ type: "trade", trade: { signature: swap.transaction.signatures[0], side: "buy", market } });
    expect(events.get("feed")).toEqual([{ type: "market", market: expect.objectContaining({ address: market, stats_24h: expect.anything() }) }]);

    openDb.mockClear();
    expect((await indexer.events(indexed, [])).size).toBe(0);
    expect(openDb).not.toHaveBeenCalled();
  });
});

describe("the live path, when part of a batch fails", () => {
  it("still hands on what it indexed when another reported transaction cannot be indexed", async () => {
    const { swapTransaction, SWAP_TOKEN, WSOL } = await import("terminal-indexer/swaps");
    const good = swapTransaction({ id: 1, slot: 525_139_990, blockIndex: 0, at: 1_795_367_000, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n });
    const bad = swapTransaction({ id: 2, slot: 525_139_991, blockIndex: 0, at: 1_795_367_001, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n });
    const real = pipelineHandler({ candleSeconds: [] });
    const handler: TransactionHandler = async (db, raw) => {
      if (raw.transaction.signatures[0] === bad.transaction.signatures[0]) throw new Error("this transaction cannot be read");
      return real(db, raw);
    };
    const indexer = new IndexerCore({ rpcUrl: rpc.url, openDb: () => createDb(database.url), handler, webFetch: metadataWeb().fetch, images: memoryImages() });
    await indexer.reconcile();
    rpc.history.push(good, bad);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const indexed = await indexer.indexSignatures([good.transaction.signatures[0]!, bad.transaction.signatures[0]!]);
    log.mockRestore();
    expect(indexed.trades).toEqual([{ signature: good.transaction.signatures[0], eventIndex: 0 }]);
  });
});

describe("the live path, when the RPC is slow or refuses (#214)", () => {
  it("hands on each reported transaction as soon as it is indexed, while another is still not served", async () => {
    const { swapTransaction, SWAP_TOKEN, WSOL } = await import("terminal-indexer/swaps");
    const quick = swapTransaction({ id: 1, slot: 525_139_990, blockIndex: 0, at: 1_795_367_000, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n });
    const late = swapTransaction({ id: 2, slot: 525_139_991, blockIndex: 0, at: 1_795_367_001, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n });
    const { indexer } = core();
    await indexer.reconcile();
    rpc.history.push(quick, late);
    // The later report first: the batch never waits on it to index and hand on the one already served.
    rpc.unserved.add(late.transaction.signatures[0]!);
    const started = Date.now();
    const handed: { signature: string; afterMs: number }[] = [];
    setTimeout(() => rpc.unserved.clear(), 1_500);
    const indexed = await indexer.indexSignatures([late.transaction.signatures[0]!, quick.transaction.signatures[0]!], async (one) => {
      for (const t of one.trades) handed.push({ signature: t.signature, afterMs: Date.now() - started });
    });
    expect(handed.map((h) => h.signature)).toEqual([quick.transaction.signatures[0], late.transaction.signatures[0]]);
    expect(handed[0]!.afterMs).toBeLessThan(1_000);
    expect(indexed.trades).toHaveLength(2);
  });

  it("indexes a batch reported while an earlier one still waits at once, the two sharing one database client", async () => {
    const { swapTransaction, SWAP_TOKEN, WSOL } = await import("terminal-indexer/swaps");
    const late = swapTransaction({ id: 1, slot: 525_139_990, blockIndex: 0, at: 1_795_367_000, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n });
    const quick = swapTransaction({ id: 2, slot: 525_139_991, blockIndex: 0, at: 1_795_367_001, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n });
    const { indexer, openDb } = core();
    await indexer.reconcile();
    rpc.history.push(late, quick);
    rpc.unserved.add(late.transaction.signatures[0]!);
    setTimeout(() => rpc.unserved.clear(), 1_500);
    openDb.mockClear();
    const started = Date.now();
    const first = indexer.indexSignatures([late.transaction.signatures[0]!]);
    let quickAfterMs = Infinity;
    await indexer.indexSignatures([quick.transaction.signatures[0]!], async (one) => {
      if (one.trades.length) quickAfterMs = Date.now() - started;
    });
    expect(quickAfterMs).toBeLessThan(1_000);
    expect((await first).trades).toEqual([{ signature: late.transaction.signatures[0], eventIndex: 0 }]);
    expect(openDb).toHaveBeenCalledTimes(1);
  });

  it("waits out a rate limit within the wait, as a burst of reports can draw one", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    rpc.history.push(swap);
    rpc.limited.add("getTransaction");
    setTimeout(() => rpc.limited.clear(), 700);
    expect((await indexer.indexSignatures([swap.transaction.signatures[0]!])).trades).toEqual([{ signature: swap.transaction.signatures[0], eventIndex: 0 }]);
  });

  it("asks for at most RPC_WAITS.transaction.atOnce reported transactions at a time, so a burst never floods the RPC", async () => {
    const { swapTransaction, SWAP_TOKEN, WSOL } = await import("terminal-indexer/swaps");
    const burst = [1, 2, 3, 4, 5, 6].map((id) => swapTransaction({ id, slot: 525_139_990 + id, blockIndex: 0, at: 1_795_367_000 + id, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n }));
    const { indexer } = core();
    await indexer.reconcile();
    rpc.history.push(...burst);
    for (const t of burst) rpc.unserved.add(t.transaction.signatures[0]!);
    rpc.requests.length = 0;
    const done = Promise.all(burst.map((t) => indexer.indexSignatures([t.transaction.signatures[0]!])));
    await new Promise((settle) => setTimeout(settle, 900));
    // Each asked every 300 ms: six at once would ask about 24 times in 900 ms, the cap's few about a third of that.
    const asked = rpc.requests.filter((r) => r.method === "getTransaction").length;
    expect(asked).toBeLessThanOrEqual(RPC_WAITS.transaction.atOnce * 5);
    rpc.unserved.clear();
    expect((await done).flatMap((r) => r.trades)).toHaveLength(6);
  });

  it("gives up at once on a transaction the RPC refuses, rather than asking until the wait runs out", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    rpc.history.push(swap);
    rpc.refuse.add("getTransaction");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const started = Date.now();
    const indexed = await indexer.indexSignatures([swap.transaction.signatures[0]!]);
    log.mockRestore();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(indexed.trades).toEqual([]);
    expect(rpc.requests.filter((r) => r.method === "getTransaction")).toHaveLength(1);
    // Reconciliation, which never passes a transaction by, indexes it once the RPC answers again.
    rpc.refuse.clear();
    expect((await indexer.reconcile()).indexed.trades).toEqual([{ signature: swap.transaction.signatures[0], eventIndex: 0 }]);
  });
});

describe("the live path's batches (#214)", () => {
  it("count each as a use of the database, so a batch that joined another's client still has Canary's outbox read after it", async () => {
    const { swapTransaction, SWAP_TOKEN, WSOL } = await import("terminal-indexer/swaps");
    const [a, b] = [1, 2].map((id) => swapTransaction({ id, slot: 525_139_990 + id, blockIndex: 0, at: 1_795_367_000 + id, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n }));
    const { indexer } = core();
    await indexer.reconcile();
    rpc.history.push(a!, b!);
    rpc.unserved.add(b!.transaction.signatures[0]!);
    setTimeout(() => rpc.unserved.clear(), 600);
    const before = indexer.databaseUses();
    const first = indexer.indexSignatures([b!.transaction.signatures[0]!]);
    const second = indexer.indexSignatures([a!.transaction.signatures[0]!]);
    await Promise.all([first, second]);
    expect(indexer.databaseUses() - before).toBe(2);
  });

  it("never hold the next transaction's indexing behind a slow publish of the one before", async () => {
    const { swapTransaction, SWAP_TOKEN, WSOL } = await import("terminal-indexer/swaps");
    const [a, b] = [1, 2].map((id) => swapTransaction({ id, slot: 525_139_990 + id, blockIndex: 0, at: 1_795_367_000 + id, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n }));
    const { indexer } = core();
    await indexer.reconcile();
    rpc.history.push(a!, b!);
    let secondHanded: () => void = () => {};
    const handedSecond = new Promise<void>((done) => (secondHanded = done));
    const order: string[] = [];
    let firstWait = "";
    const indexed = await indexer.indexSignatures([a!.transaction.signatures[0]!, b!.transaction.signatures[0]!], async (one) => {
      order.push(one.trades[0]!.signature);
      // The first publish waits until the second transaction has been handed on: it can only if indexing goes on meanwhile.
      if (order.length === 1) firstWait = await Promise.race([handedSecond.then(() => "the second was handed on"), new Promise<string>((settle) => setTimeout(() => settle("timed out"), 3_000))]);
      else secondHanded();
    });
    expect(indexed.trades).toHaveLength(2);
    expect(order).toHaveLength(2);
    expect(firstWait).toBe("the second was handed on");
  });
});

describe("events after a large backlog", () => {
  it("tell a market's room to resync through the API rather than send it more swaps than LIVE_ROOM_TRADES_MAX", async () => {
    const { swapTransaction, SWAP_MARKET, SWAP_TOKEN, WSOL } = await import("terminal-indexer/swaps");
    const { indexer } = core();
    await indexer.reconcile();
    for (let id = 1; id <= LIVE_ROOM_TRADES_MAX + 1; id++) {
      rpc.history.push(swapTransaction({ id, slot: 525_140_000 + id, blockIndex: 0, at: 1_795_367_000 + id, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n }));
    }
    const { indexed } = await indexer.reconcile();
    expect(indexed.trades).toHaveLength(LIVE_ROOM_TRADES_MAX + 1);
    const events = await indexer.events(indexed, ["feed", `market:${SWAP_MARKET}`]);
    expect(events.get(`market:${SWAP_MARKET}`)!.map((e) => e.type)).toEqual(["resync", "market"]);
    expect(events.get("feed")!.map((e) => e.type)).toEqual(["market"]);
  });
});

describe("strategy metadata", () => {
  const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
  const doc = (name: string) => JSON.stringify({ schema: "pipeline-strategy-metadata/1", name });
  const uriOf = async () => (await reader.db.select({ uri: strategies.metadataUri }).from(strategies))[0]!.uri;
  const statuses = async () => (await reader.db.select({ status: metadataSnapshots.status, name: metadataSnapshots.normalised }).from(metadataSnapshots).orderBy(metadataSnapshots.id)).map((r) => [r.status, (r.name as { name?: string } | null)?.name ?? null]);

  it("is fetched after the router's reconciliation indexes the strategy's registration, and not again while nothing new happens", async () => {
    const web = metadataWeb();
    const { indexer } = core(web);
    await indexer.reconcile();
    // Reconciliation only notes it, so what it indexed reaches the live rooms first; the fetch follows.
    expect(web.asked).toEqual([]);
    expect(await indexer.fetchPendingMetadata()).toEqual({ fetched: 1, changed: ["J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t"] });
    expect(web.asked).toEqual([await uriOf()]);
    expect(await statuses()).toEqual([["unreachable", null]]);
    await indexer.reconcile();
    expect(await indexer.fetchPendingMetadata()).toEqual({ fetched: 0, changed: [] });
    expect(web.asked).toHaveLength(1);
  });

  it("is fetched by one turn at a time, so a re-fetch and a pending fetch together write one row", async () => {
    const web = metadataWeb();
    const { indexer } = core(web);
    await indexer.reconcile();
    web.documents[await uriOf()] = doc("Once");
    await Promise.all([indexer.fetchPendingMetadata(), indexer.refetchMetadata()]);
    expect(await statuses()).toEqual([["valid", "Once"]]);
  });

  it("is fetched again from the new URI once a MetadataUpdated is indexed", async () => {
    const { metadataUpdatedTransaction } = await import("terminal-indexer/swaps");
    const web = metadataWeb({ "https://example.org/v2.json": doc("Tax AMM") });
    const { indexer } = core(web);
    await indexer.reconcile();
    await indexer.fetchPendingMetadata();
    rpc.history.push(metadataUpdatedTransaction({ id: 77, slot: 525_500_000, strategy: STRATEGY, uri: "https://example.org/v2.json" }));
    await indexer.reconcile();
    await indexer.fetchPendingMetadata();
    expect(web.asked.at(-1)).toBe("https://example.org/v2.json");
    expect(await statuses()).toEqual([["unreachable", null], ["valid", "Tax AMM"]]);
  });

  it("is fetched for a MetadataUpdated the live socket reported, by the next fetch, never holding up the live path", async () => {
    const { metadataUpdatedTransaction } = await import("terminal-indexer/swaps");
    const web = metadataWeb({ "https://example.org/live.json": doc("Live") });
    const { indexer } = core(web);
    await indexer.reconcile();
    await indexer.fetchPendingMetadata();
    const update = metadataUpdatedTransaction({ id: 78, slot: 525_500_001, strategy: STRATEGY, uri: "https://example.org/live.json" });
    rpc.history.push(update);
    expect((await indexer.indexSignatures([update.transaction.signatures[0]!])).strategies).toEqual([STRATEGY]);
    expect(web.asked).not.toContain("https://example.org/live.json");
    await indexer.fetchPendingMetadata();
    expect((await statuses()).at(-1)).toEqual(["valid", "Live"]);
  });

  it("is fetched again for every strategy by the hourly re-fetch, which stores a changed document", async () => {
    const web = metadataWeb();
    const { indexer } = core(web);
    await indexer.reconcile();
    await indexer.fetchPendingMetadata();
    web.documents[await uriOf()] = doc("Changed Behind The Same URI");
    expect(await indexer.refetchMetadata()).toEqual({ fetched: 1, changed: [STRATEGY] });
    expect((await statuses()).at(-1)).toEqual(["valid", "Changed Behind The Same URI"]);
  });

  it("is fetched by a new instance for a strategy that has none yet, as after this code's first deploy, or whose newest is for an earlier URI", async () => {
    const first = core().indexer;
    await first.reconcile();
    await first.fetchPendingMetadata();
    await reader.db.delete(metadataSnapshots);
    const web = metadataWeb();
    const second = core(web).indexer;
    await second.reconcile();
    await second.fetchPendingMetadata();
    expect(web.asked).toEqual([await uriOf()]);

    // A URI changed while the fetch after it failed: the next instance fetches it.
    await reader.db.update(strategies).set({ metadataUri: "https://example.org/moved.json" });
    const third = core(web).indexer;
    await third.reconcile();
    await third.fetchPendingMetadata();
    expect(web.asked.at(-1)).toBe("https://example.org/moved.json");
  });

  it("is fetched for a strategy the registry snapshot finds", async () => {
    const strategyAccount = (program: string) =>
      encodeAccount("Strategy", getStrategyCodec(), { programId: address(program), metadataUri: "https://example.org/found.json", interfaceVersion: 1, registeredAt: 1_795_000_000n, marketCount: 0n, bump: 255 });
    rpc.accounts.set("StrategyPdaB", { owner: PIPELINE_PROGRAM_ADDRESS, data: strategyAccount("BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6") });
    const web = metadataWeb({ "https://example.org/found.json": doc("Found") });
    const { indexer } = core(web);
    await indexer.reconcile();
    await indexer.snapshot();
    await indexer.fetchPendingMetadata();
    expect(web.asked).toContain("https://example.org/found.json");
  });
});

describe("the hourly read of mints", () => {
  it("reads every mint again", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    await reader.db.update(mints).set({ flags: ["stale"] });
    expect(await indexer.refreshMints()).toBe(2);
    expect((await reader.db.select({ flags: mints.flags }).from(mints)).every((m) => !m.flags?.includes("stale"))).toBe(true);
  });
});

// The explainer's keys (EXPLAINER-23) depend only on what Postgres holds, so they are made only
// after something was written there (a new version, a metadata change, a deploy's first run) or
// Canary recorded results: every 5 minutes of a quiet devnet would otherwise keep Neon's free
// compute from ever suspending (#192).
describe("the explainer's keys", () => {
  it("are made on the first run, then only after the database was written or Canary recorded results", async () => {
    const { indexer, openDb } = core();
    const made = vi.fn(async () => "made");
    expect(await indexer.explainerKeys(made)).toBe("made");
    expect(await indexer.explainerKeys(made)).toBeNull();
    await indexer.reconcile();
    openDb.mockClear();
    expect(await indexer.explainerKeys(made)).toBe("made");
    expect(openDb).toHaveBeenCalledTimes(1);
    await indexer.reconcile();
    openDb.mockClear();
    expect(await indexer.explainerKeys(made)).toBeNull();
    expect(openDb).not.toHaveBeenCalled();
    indexer.canaryRecorded();
    expect(await indexer.explainerKeys(made)).toBe("made");
    expect(made).toHaveBeenCalledTimes(3);
  });

  it("are tried again on the next run when making them failed", async () => {
    const { indexer } = core();
    await expect(indexer.explainerKeys(async () => Promise.reject(new Error("the RPC refused")))).rejects.toThrow("the RPC refused");
    expect(await indexer.explainerKeys(async () => "made")).toBe("made");
  });
});
