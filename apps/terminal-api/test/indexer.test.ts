// The indexer's work, as the `Indexer` Durable Object runs it on the dispatcher's schedule
// (docs/spec/pipescope-architecture.md, Indexer and Data): the router's whole history backfilled on
// its first run, then reconciliation that asks the chain first and touches Postgres only when there
// is something new, so Neon sleeps while devnet is quiet; and the registry snapshot.
import { readFileSync } from "node:fs";
import { encodeAccount, getStrategyCodec, PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { address } from "@solana/kit";
import { candles, createDb, markets, strategies, trades } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { DECODER_VERSION, indexTransactions, pipelineHandler, type RawTransaction, type TransactionHandler } from "terminal-indexer";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANDLES, LIVE_ROOM_TRADES_MAX } from "../src/config";
import { IndexerCore } from "../src/indexerCore";

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
function core() {
  const openDb = vi.fn(() => createDb(database.url));
  return { indexer: new IndexerCore({ rpcUrl: rpc.url, openDb }), openDb };
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

  it("closes every database client it opens, even when indexing fails", async () => {
    let closed = 0;
    const openDb = vi.fn(() => {
      const client = createDb(database.url);
      return { db: client.db, close: () => client.close().then(() => void closed++) };
    });
    rpc.refuse.add("getMultipleAccounts");
    await expect(new IndexerCore({ rpcUrl: rpc.url, openDb }).reconcile()).rejects.toThrow("getMultipleAccounts");
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
    await indexTransactions(db, pipelineHandler({ decode: () => null, decoderVersion: DECODER_VERSION - 1 }), [kept]);
    await close();
    const real = pipelineHandler();
    const handler: TransactionHandler = async (db, raw) => {
      if (raw.transaction.signatures[0] === kept.transaction.signatures[0]) throw new Error("this transaction cannot be read");
      return real(db, raw);
    };
    const indexer = new IndexerCore({ rpcUrl: rpc.url, openDb: () => createDb(database.url), handler });
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
    const real = pipelineHandler();
    const handler: TransactionHandler = async (db, raw) => {
      if (raw.transaction.signatures[0] === bad.transaction.signatures[0]) throw new Error("this transaction cannot be read");
      return real(db, raw);
    };
    const indexer = new IndexerCore({ rpcUrl: rpc.url, openDb: () => createDb(database.url), handler });
    await indexer.reconcile();
    rpc.history.push(good, bad);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const indexed = await indexer.indexSignatures([good.transaction.signatures[0]!, bad.transaction.signatures[0]!]);
    log.mockRestore();
    expect(indexed.trades).toEqual([{ signature: good.transaction.signatures[0], eventIndex: 0 }]);
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
