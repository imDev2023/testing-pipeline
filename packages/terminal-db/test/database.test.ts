import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, probe } from "../src/index.ts";
import { createTestDatabase } from "../src/testing.ts";

// A fresh database on the Docker Postgres (or CI's service container), migrated as a deploy migrates Neon.
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.drop();
});

describe("the terminal's database", () => {
  it("answers the health probe with its clock and every migration applied", async () => {
    const { db, close } = createDb(database.url);
    try {
      const before = Date.now();
      const { serverTime, migrations } = await probe(db);
      expect(Math.abs(serverTime.getTime() - before)).toBeLessThan(60_000);
      expect(migrations).toBe(await migrationCount());
    } finally {
      await close();
    }
  });

  it("holds the indexer's cursors, one per watched address", async () => {
    const { db, close } = createDb(database.url);
    try {
      const { indexerCursors } = await import("../src/schema.ts");
      await db.insert(indexerCursors).values({ account: "PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34", signature: "sig", slot: 525_000_000n });
      const rows = await db.select().from(indexerCursors);
      expect(rows).toEqual([expect.objectContaining({ account: "PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34", slot: 525_000_000n })]);
    } finally {
      await close();
    }
  });
});

/** How many migrations the journal lists, so adding one never needs this test changed. */
async function migrationCount(): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  const journal = JSON.parse(await readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: unknown[] };
  return journal.entries.length;
}
