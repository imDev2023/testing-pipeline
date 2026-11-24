// A new strategy and a new market reach the outbox once, whether the indexer learns of it from its
// router event or from the registry snapshot, or from both (docs/spec/pipescope-architecture.md,
// Indexer; #117).
import { readFileSync } from "node:fs";
import { createDb, readOutbox, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { indexRegistry, indexTransactions, pipelineHandler, type RawTransaction, type Registry } from "../src/index";

const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/${name}.json`, "utf8")) as RawTransaction;
const [registered, created] = ["registered", "marketCreated"].map(fixture) as [RawTransaction, RawTransaction];
const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const SNAPSHOT_STRATEGY = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const SNAPSHOT_MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
beforeEach(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
});
afterEach(async () => {
  await client.close();
  await database.drop();
});

const registry = (strategies: string[], markets: { address: string; strategy: string }[]): Registry => ({
  strategies: strategies.map((program) => ({ program, metadataUri: `https://example.org/${program}.json`, registeredAt: new Date(1_795_000_000_000) })),
  markets: markets.map(({ address, strategy }) => ({
    address,
    strategyProgram: strategy,
    marketState: "EE3ifuzvJGAtcY6xTxxr26ezaXG1cethHvA52R3r6x1U",
    createdBy: "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt",
    createdAt: new Date(1_795_200_000_000),
    supportsExactOut: true,
    feeMint: null,
    mints: [{ mint: "So11111111111111111111111111111111111111112", vault: "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2" }],
  })),
});

it("writes a strategy_registered and a market_created event from the router's events", async () => {
  await indexTransactions(client.db, pipelineHandler({ candleSeconds: [] }), [registered, created]);
  expect((await readOutbox(client.db, "test")).map((e) => [e.kind, e.subject, e.slot, e.payload])).toEqual([
    ["strategy_registered", STRATEGY, BigInt(registered.slot), { metadataUri: expect.any(String) }],
    ["market_created", MARKET, BigInt(created.slot), { strategy: STRATEGY }],
  ]);
});

it("writes them from the registry snapshot for what the events missed, and never twice when the event arrives later", async () => {
  await indexRegistry(client.db, registry([SNAPSHOT_STRATEGY, STRATEGY], [{ address: SNAPSHOT_MARKET, strategy: SNAPSHOT_STRATEGY }, { address: MARKET, strategy: STRATEGY }]));
  await indexTransactions(client.db, pipelineHandler({ candleSeconds: [] }), [registered, created]);
  expect((await readOutbox(client.db, "test")).map((e) => [e.kind, e.subject, e.slot])).toEqual([
    ["strategy_registered", SNAPSHOT_STRATEGY, null],
    ["strategy_registered", STRATEGY, null],
    ["market_created", SNAPSHOT_MARKET, null],
    ["market_created", MARKET, null],
  ]);
});
