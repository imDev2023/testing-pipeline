// The indexer's work, as the `Indexer` Durable Object runs it on the dispatcher's schedule
// (docs/spec/pipescope-architecture.md, Indexer and Data): the router's whole history backfilled on
// its first run, then reconciliation that asks the chain first and touches Postgres only when there
// is something new, so Neon sleeps while devnet is quiet; and the registry snapshot.
import { readFileSync } from "node:fs";
import { encodeAccount, getStrategyCodec, PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { address } from "@solana/kit";
import { createDb, strategies, trades } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import type { RawTransaction } from "terminal-indexer";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
