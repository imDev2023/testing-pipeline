// Reconciliation (docs/spec/pipescope-architecture.md, Indexer): the router's history read from its
// cursor, oldest first, through either history source, never passing a transaction it could not index.
import { readFileSync } from "node:fs";
import { asc } from "drizzle-orm";
import { createDb, indexerCursors, trades, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { heliusSource, pipelineHandler, reconcileAccount, rpcSource, type RawTransaction } from "../src/index";

/** Short waits for a block not served yet, so a test of a missing block fails fast. */
const WAITS = { waitMs: 2_000, firstRetryMs: 100, maxRetryMs: 400 };
import { fakeRpc, type FakeRpc } from "./fakeRpc";

const ROUTER = "PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34";
const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/${name}.json`, "utf8")) as RawTransaction;
const [registered, failed, created, swap] = ["registered", "failed", "marketCreated", "swap"].map(fixture) as [RawTransaction, RawTransaction, RawTransaction, RawTransaction];
const sig = (t: RawTransaction) => t.transaction.signatures[0]!;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
let rpc: FakeRpc;
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
});
afterAll(async () => {
  await client?.close();
  await database?.drop();
});
beforeEach(async () => {
  await rpc?.close();
  rpc = await fakeRpc([registered, failed, created]);
  await client.db.execute("truncate indexer_cursors, indexed_transactions, strategies, markets, market_mints, trades");
});

const cursorRow = async () => (await client.db.select().from(indexerCursors))[0];

for (const [name, source] of [
  ["Helius's getTransactionsForAddress", () => heliusSource(rpc.url)],
  ["getSignaturesForAddress and getTransaction", () => rpcSource(rpc.url, WAITS)],
] as const) {
  describe(`reconciliation through ${name}`, () => {
    it("indexes the whole history from no cursor, oldest first, and leaves the cursor at the newest transaction", async () => {
      const { result, cursor, complete } = await reconcileAccount(client.db, source(), pipelineHandler(), ROUTER);
      expect(result.counts).toEqual({ strategies: 1, markets: 1 });
      expect(complete).toBe(true);
      expect(cursor).toEqual({ signature: sig(created), slot: created.slot, blockIndex: created.transactionIndex });
      expect(await cursorRow()).toMatchObject({ account: ROUTER, signature: sig(created), slot: BigInt(created.slot), blockIndex: created.transactionIndex });
    });

    it("goes on from its cursor: only what is new is indexed, with its place in the block", async () => {
      await reconcileAccount(client.db, source(), pipelineHandler(), ROUTER);
      rpc.history.push(swap);
      const { result, cursor } = await reconcileAccount(client.db, source(), pipelineHandler(), ROUTER);
      expect(result.counts).toEqual({ trades: 1 });
      expect(cursor?.signature).toBe(sig(swap));
      expect(await client.db.select({ signature: trades.signature, blockIndex: trades.blockIndex }).from(trades)).toEqual([{ signature: sig(swap), blockIndex: swap.transactionIndex }]);
    });

    it("stops after `limit` transactions, and the next run goes on from there", async () => {
      const first = await reconcileAccount(client.db, source(), pipelineHandler(), ROUTER, { limit: 2 });
      expect(first.complete).toBe(false);
      expect(first.cursor?.signature).toBe(sig(failed));
      const second = await reconcileAccount(client.db, source(), pipelineHandler(), ROUTER, { limit: 2 });
      expect(second).toMatchObject({ complete: true, result: { counts: { markets: 1 } } });
    });
  });
}

describe("a transaction listed before it is served", () => {
  it("stops reconciliation there, so the cursor never passes it, and is indexed on the next run", async () => {
    rpc.history.push(swap);
    rpc.unserved.add(sig(created));
    const first = await reconcileAccount(client.db, rpcSource(rpc.url, WAITS), pipelineHandler(), ROUTER);
    expect(first.complete).toBe(false);
    expect(first.cursor?.signature).toBe(sig(failed));
    expect(await client.db.select().from(trades)).toEqual([]);
    rpc.unserved.clear();
    const second = await reconcileAccount(client.db, rpcSource(rpc.url, WAITS), pipelineHandler(), ROUTER);
    expect(second).toMatchObject({ complete: true, result: { counts: { markets: 1, trades: 1 } } });
    expect((await client.db.select({ s: trades.signature }).from(trades).orderBy(asc(trades.slot))).map((r) => r.s)).toEqual([sig(swap)]);
  });
});
