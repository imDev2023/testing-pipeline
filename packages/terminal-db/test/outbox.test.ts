// The outbox (docs/spec/pipescope-architecture.md, Indexer; #117): the indexer writes what it saw
// happen once, and each reader (Canary's runs, the Telegram bot's queue) reads on from its own cursor.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/index.ts";
import { ackOutbox, appendOutbox, readOutbox } from "../src/outbox.ts";
import { createTestDatabase } from "../src/testing.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
});
afterAll(async () => {
  await client?.close();
  await database?.drop();
});

const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";

describe("the outbox", () => {
  it("writes each event once, however often it is seen, and hands each reader every event in order from its own cursor", async () => {
    const { db } = client;
    expect(await appendOutbox(db, { kind: "strategy_registered", subject: STRATEGY, slot: 100n, payload: { metadataUri: "https://example.org/s.json" } })).toBe(true);
    expect(await appendOutbox(db, { kind: "strategy_registered", subject: STRATEGY, slot: 100n, payload: { metadataUri: "https://example.org/s.json" } })).toBe(false);
    await appendOutbox(db, { kind: "market_created", subject: MARKET, slot: 101n, payload: { strategy: STRATEGY } });
    await appendOutbox(db, { kind: "strategy_version", subject: STRATEGY, slot: 120n, payload: { deploySlot: "120", executableSha256: "ab".repeat(32), previousSlot: "90" } });

    const canary = await readOutbox(db, "canary");
    expect(canary.map((e) => [e.kind, e.subject, e.slot])).toEqual([
      ["strategy_registered", STRATEGY, 100n],
      ["market_created", MARKET, 101n],
      ["strategy_version", STRATEGY, 120n],
    ]);
    expect(canary[2]!.payload).toEqual({ deploySlot: "120", executableSha256: "ab".repeat(32), previousSlot: "90" });

    await ackOutbox(db, "canary", canary[1]!.id);
    expect((await readOutbox(db, "canary")).map((e) => e.kind)).toEqual(["strategy_version"]);
    // Another reader is not moved by the first.
    expect(await readOutbox(db, "telegram")).toHaveLength(3);
    expect((await readOutbox(db, "telegram", { limit: 1 })).map((e) => e.kind)).toEqual(["strategy_registered"]);
  });

  it("never lets a reader pass an event another transaction has yet to commit: writers append in commit order", async () => {
    const other = createDb(database.url);
    try {
      let releaseFirst!: () => void;
      const held = new Promise<void>((done) => (releaseFirst = done));
      let firstAppended!: () => void;
      const appended = new Promise<void>((done) => (firstAppended = done));
      const first = client.db.transaction(async (tx) => {
        await appendOutbox(tx as unknown as Db, { kind: "market_created", subject: "OrderFirst1111111111111111111111111111111111", slot: 1n, payload: { strategy: STRATEGY } });
        firstAppended();
        await held;
      });
      await appended;
      let secondDone = false;
      const second = other.db.transaction(async (tx) => {
        await appendOutbox(tx as unknown as Db, { kind: "market_created", subject: "OrderSecond111111111111111111111111111111111", slot: 2n, payload: { strategy: STRATEGY } });
      }).then(() => (secondDone = true));
      await new Promise((done) => setTimeout(done, 300));
      // The second writer waits for the first to commit, so no reader can see it and ack past the first.
      expect(secondDone).toBe(false);
      expect((await readOutbox(client.db, "order")).map((e) => e.subject)).not.toContain("OrderSecond111111111111111111111111111111111");
      releaseFirst();
      await Promise.all([first, second]);
      const seen = (await readOutbox(client.db, "order", { limit: 1000 })).map((e) => e.subject);
      expect(seen.indexOf("OrderFirst1111111111111111111111111111111111")).toBeLessThan(seen.indexOf("OrderSecond111111111111111111111111111111111"));
    } finally {
      await other.close();
    }
  });

  it("never moves a reader's cursor back", async () => {
    const { db } = client;
    const all = await readOutbox(db, "backwards");
    await ackOutbox(db, "backwards", all.at(-1)!.id);
    await ackOutbox(db, "backwards", all[0]!.id);
    expect(await readOutbox(db, "backwards")).toEqual([]);
  });
});
