// Strategy metadata in Postgres (docs/spec/pipescope-architecture.md, Metadata fetcher): each
// strategy's document fetched from the URI its account names, stored with its hash and its author
// text as the explainer's normaliser leaves it; a fetch that finds the same keeps one row, a changed
// document (or URI, or status) adds a row, so a changed hash is seen as a metadata change.
import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { createDb, metadataSnapshots, strategies, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchStrategiesMetadata } from "../src/metadata";
import type { FetchLike } from "../src/metadataFetch";

const PROGRAM = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const OTHER = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const URI = "https://example.org/tax-amm.json";
const doc = (name: string, description = "A strategy.") => JSON.stringify({ schema: "pipeline-strategy-metadata/1", name, description });
const sha = (body: string) => createHash("sha256").update(body).digest("hex");

/** A fetch serving `documents` by URL, as JSON, and 404 for any other URL; every URL asked is kept. */
function serving(documents: Record<string, string>) {
  const asked: string[] = [];
  const fetch: FetchLike = async (url) => {
    asked.push(url);
    const body = documents[url];
    return body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
  };
  return { fetch, asked };
}

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
});
beforeEach(async () => {
  await client.db.delete(metadataSnapshots);
  await client.db.delete(strategies);
  await client.db.insert(strategies).values([
    { program: PROGRAM, metadataUri: URI, registeredAt: new Date("2026-11-20T00:00:00Z") },
    { program: OTHER, metadataUri: "", registeredAt: new Date("2026-11-20T00:00:00Z") },
  ]);
});
afterAll(async () => {
  await client?.close();
  await database?.drop();
});

const snapshots = (program = PROGRAM) => client.db.select().from(metadataSnapshots).where(eq(metadataSnapshots.program, program)).orderBy(asc(metadataSnapshots.id));

describe("fetchStrategiesMetadata", () => {
  it("stores a valid document with its hash, the document as validated, and its author text normalised", async () => {
    const body = doc("Tax‮ AMM", "Taxes\u0007 each trade.");
    const { fetch } = serving({ [URI]: body });
    expect(await fetchStrategiesMetadata(client.db, [PROGRAM], { fetch, now: new Date("2026-11-23T10:00:00Z") })).toEqual({ fetched: 1, changed: [PROGRAM] });
    const [row] = await snapshots();
    expect(row).toMatchObject({
      uri: URI,
      status: "valid",
      reason: null,
      errors: [],
      warnings: [],
      url: URI,
      sha256: sha(body),
      document: { schema: "pipeline-strategy-metadata/1", name: "Tax‮ AMM", description: "Taxes\u0007 each trade." },
      normalised: { name: "Tax AMM", description: "Taxes each trade.", category: null, tags: [], init: null, audits: [] },
      removed: { characters: 2, truncated: [], images: 0, links: 0 },
      fetchedAt: new Date("2026-11-23T10:00:00Z"),
      checkedAt: new Date("2026-11-23T10:00:00Z"),
    });
  });

  it("keeps one row while the document stays the same, moving only when it was last checked", async () => {
    const { fetch } = serving({ [URI]: doc("Tax AMM") });
    await fetchStrategiesMetadata(client.db, [PROGRAM], { fetch, now: new Date("2026-11-23T10:00:00Z") });
    expect(await fetchStrategiesMetadata(client.db, [PROGRAM], { fetch, now: new Date("2026-11-23T11:00:00Z") })).toEqual({ fetched: 1, changed: [] });
    const rows = await snapshots();
    expect(rows.map((r) => [r.fetchedAt.toISOString(), r.checkedAt.toISOString()])).toEqual([["2026-11-23T10:00:00.000Z", "2026-11-23T11:00:00.000Z"]]);
  });

  it("adds a row with the new hash when the document behind the same URI changes", async () => {
    await fetchStrategiesMetadata(client.db, [PROGRAM], { fetch: serving({ [URI]: doc("Tax AMM") }).fetch });
    const changed = doc("Tax AMM", "Now with a cap.");
    expect(await fetchStrategiesMetadata(client.db, [PROGRAM], { fetch: serving({ [URI]: changed }).fetch })).toEqual({ fetched: 1, changed: [PROGRAM] });
    expect((await snapshots()).map((r) => r.sha256)).toEqual([sha(doc("Tax AMM")), sha(changed)]);
  });

  it("adds a row when the strategy's URI changed, and fetches only the URI its account names now", async () => {
    await fetchStrategiesMetadata(client.db, [PROGRAM], { fetch: serving({ [URI]: doc("Tax AMM") }).fetch });
    await client.db.update(strategies).set({ metadataUri: "https://example.org/v2.json" }).where(eq(strategies.program, PROGRAM));
    const { fetch, asked } = serving({ "https://example.org/v2.json": doc("Tax AMM") });
    await fetchStrategiesMetadata(client.db, [PROGRAM], { fetch });
    expect(asked).toEqual(["https://example.org/v2.json"]);
    expect((await snapshots()).map((r) => r.uri)).toEqual([URI, "https://example.org/v2.json"]);
  });

  it("records a link that stops answering as unreachable, with no document", async () => {
    await fetchStrategiesMetadata(client.db, [PROGRAM], { fetch: serving({ [URI]: doc("Tax AMM") }).fetch });
    await fetchStrategiesMetadata(client.db, [PROGRAM], { fetch: serving({}).fetch });
    const rows = await snapshots();
    expect(rows.at(-1)).toMatchObject({ status: "unreachable", reason: "http-status", errors: ["HTTP 404"], sha256: null, document: null, normalised: null, removed: null });
  });

  it("records an invalid document with Pipeline's validator's errors and its hash, and no document", async () => {
    const body = JSON.stringify({ schema: "pipeline-strategy-metadata/1" });
    await fetchStrategiesMetadata(client.db, [PROGRAM], { fetch: serving({ [URI]: body }).fetch });
    expect((await snapshots())[0]).toMatchObject({ status: "invalid", reason: "invalid", errors: ["name: must be a non-empty string"], sha256: sha(body), document: null, normalised: null });
  });

  it("records an empty URI as missing without fetching anything", async () => {
    const { fetch, asked } = serving({});
    await fetchStrategiesMetadata(client.db, [OTHER], { fetch });
    expect(asked).toEqual([]);
    expect((await snapshots(OTHER))[0]).toMatchObject({ uri: "", status: "missing", errors: ["no metadata URI"], url: null });
  });

  it("skips a program that is no registered strategy", async () => {
    expect(await fetchStrategiesMetadata(client.db, ["11111111111111111111111111111111"], { fetch: serving({}).fetch })).toEqual({ fetched: 0, changed: [] });
  });
});
