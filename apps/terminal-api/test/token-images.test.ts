// Keeping token images (docs/spec/pipescope-architecture.md, Data; PIPESCOPE-88): each token metadata
// URI a mint names is fetched once, and again only when a mint names another; a kept image's bytes go
// to KV under their SHA-256 and the outcome of every fetch to Postgres, so `/images/<hash>` is served
// from KV with its type fixed, `nosniff` and no script, and never wakes the database.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, mints, tokenImages, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLUSTER_USDC } from "../src/config";
import { app } from "../src/index";
import { fetchTokenImages, kvImageStore } from "../src/tokenImages";
import { bindings, executionContext } from "./fakes";

const PNG = readFileSync(`${import.meta.dirname}/fixtures/images/token.png`);
const WEBP = readFileSync(`${import.meta.dirname}/fixtures/images/token.webp`);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The web as the fetcher sees it here: each URL's answer, and every URL asked for. */
function web(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    return answers[url]?.() ?? new Response("not found", { status: 404 });
  };
  return { fetch, asked };
}
const json = (value: unknown) => () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const bytes = (body: Uint8Array, type: string) => () => new Response(body, { headers: { "content-type": type } });

/** A KV namespace in memory, as much of one as images use: bytes with metadata. */
function memoryKv() {
  const values = new Map<string, { value: ArrayBuffer; metadata: unknown }>();
  const kv = {
    puts: 0,
    async put(key: string, value: ArrayBuffer | Uint8Array, options?: { metadata?: unknown }) {
      kv.puts++;
      values.set(key, { value: value instanceof Uint8Array ? new Uint8Array(value).buffer : value, metadata: options?.metadata ?? null });
    },
    async getWithMetadata(key: string) {
      const found = values.get(key);
      return found ? { value: found.value, metadata: found.metadata } : { value: null, metadata: null };
    },
  };
  return kv as unknown as KVNamespace & { puts: number };
}

const NAMED = ["2SCfx1zDwpiWh9DUSjp4nXtbMrVTzqK1tNKhP5ktQipk", "3sQdZmPDY4qg7ZTVJkNG8QChUSHB1MxJx5KFoLAcw7C4", "5AMPgS3baS6g4gsgSGwkE2wx9dV6iJNzaCMfpDFNfvM9"];
const NAMELESS = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";
const SHARED_URI = "https://example.com/pipeline/smoke.json";
const OTHER_URI = "https://ipfs.io/ipfs/QmdznmJXTyhKAJdzMUrchXaHxtuRs97n9YzF4geW8EeMZW";

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
beforeEach(async () => {
  await client.db.delete(tokenImages);
  await client.db.delete(mints);
  await client.db.insert(mints).values([
    { address: NAMED[0]!, readable: true, symbol: "SMOKE", name: "Pipeline Smoke", tokenUri: SHARED_URI },
    { address: NAMED[1]!, readable: true, symbol: "SMOKE", name: "Pipeline Smoke", tokenUri: SHARED_URI },
    { address: NAMED[2]!, readable: true, symbol: "DREAM", name: "Pipe Dream", tokenUri: OTHER_URI },
    { address: NAMELESS, readable: true },
    // Aviary names USDC itself, so its own metadata's image is never fetched.
    { address: CLUSTER_USDC, readable: true, symbol: "USDC", name: "USD Coin", tokenUri: "https://example.com/usdc.json" },
  ]);
});

describe("fetching", () => {
  it("fetches each URI once, keeps a kept image's bytes in KV under their SHA-256 and every outcome in Postgres", async () => {
    const kv = memoryKv();
    const { fetch, asked } = web({ [SHARED_URI]: json({ image: "https://example.com/smoke.png" }), "https://example.com/smoke.png": bytes(PNG, "image/png") });
    const at = new Date("2026-11-23T12:00:00.000Z");
    expect(await fetchTokenImages(client.db, kvImageStore(kv), { fetch, now: at })).toEqual({ fetched: 2, kept: 1 });
    expect(asked.sort()).toEqual([OTHER_URI, SHARED_URI, "https://example.com/smoke.png"].sort());

    const rows = await client.db.select().from(tokenImages).orderBy(tokenImages.uri);
    expect(rows).toEqual([
      { uri: SHARED_URI, status: "kept", reason: null, imageUrl: "https://example.com/smoke.png", sha256: sha256(PNG), contentType: "image/png", size: PNG.length, fetchedAt: at },
      { uri: OTHER_URI, status: "unreachable", reason: "http-status", imageUrl: null, sha256: null, contentType: null, size: null, fetchedAt: at },
    ].sort((a, b) => a.uri.localeCompare(b.uri)));
    const stored = await kvImageStore(kv).get(sha256(PNG));
    expect(stored && Buffer.from(stored.bytes).equals(PNG)).toBe(true);
    expect(stored?.type).toBe("image/png");
  });

  it("never fetches a URI again, whatever it found, until a mint names another", async () => {
    const kv = memoryKv();
    const first = web({ [SHARED_URI]: bytes(PNG, "image/png") });
    await fetchTokenImages(client.db, kvImageStore(kv), { fetch: first.fetch });
    const again = web({ [SHARED_URI]: bytes(WEBP, "image/webp") });
    expect(await fetchTokenImages(client.db, kvImageStore(kv), { fetch: again.fetch })).toEqual({ fetched: 0, kept: 0 });
    expect(again.asked).toEqual([]);

    const newUri = "https://example.com/pipeline/smoke-2.json";
    await client.db.update(mints).set({ tokenUri: newUri }).where(eq(mints.address, NAMED[0]!));
    const changed = web({ [newUri]: bytes(WEBP, "image/webp") });
    expect(await fetchTokenImages(client.db, kvImageStore(kv), { fetch: changed.fetch })).toEqual({ fetched: 1, kept: 1 });
    expect(changed.asked).toEqual([newUri]);
  });
});

describe("trying again", () => {
  it("fetches a URI that could not be reached again on the hourly read of mints, and never one kept, missing or refused", async () => {
    const kv = memoryKv();
    const down = web({ [SHARED_URI]: () => new Response("busy", { status: 429 }), [OTHER_URI]: json({ name: "No Image" }) });
    await fetchTokenImages(client.db, kvImageStore(kv), { fetch: down.fetch });
    const up = web({ [SHARED_URI]: bytes(PNG, "image/png"), [OTHER_URI]: json({ image: "https://example.com/dream.png" }), "https://example.com/dream.png": bytes(PNG, "image/png") });
    // Between hourly reads nothing is tried again.
    expect(await fetchTokenImages(client.db, kvImageStore(kv), { fetch: up.fetch })).toEqual({ fetched: 0, kept: 0 });
    expect(await fetchTokenImages(client.db, kvImageStore(kv), { fetch: up.fetch, retryUnreachable: true })).toEqual({ fetched: 1, kept: 1 });
    expect(up.asked).toEqual([SHARED_URI]);
    const [shared] = await client.db.select().from(tokenImages).where(eq(tokenImages.uri, SHARED_URI));
    expect(shared).toMatchObject({ status: "kept", sha256: sha256(PNG) });
  });

  it("fetches nothing for a mint that names no symbol and no name, whose image no page would show", async () => {
    await client.db.update(mints).set({ symbol: null, name: null }).where(eq(mints.address, NAMED[2]!));
    const { fetch, asked } = web({});
    await fetchTokenImages(client.db, kvImageStore(memoryKv()), { fetch });
    expect(asked).toEqual([SHARED_URI]);
  });
});

describe("serving /images/<hash>", () => {
  const serve = async (path: string, kv: KVNamespace) => {
    // A database that cannot answer: serving an image must never ask it anything.
    const env = bindings({ databaseUrl: "postgres://nobody:nothing@127.0.0.1:9/none", rpcUrl: "http://127.0.0.1:9/never", TERMINAL_CACHE: kv });
    const { ctx, settle } = executionContext();
    const response = await app.fetch(new Request(`http://api.test${path}`), env, ctx);
    await settle();
    return response;
  };

  it("serves a kept image from KV with its type fixed, nosniff and a policy that runs no script, without the database", async () => {
    const kv = memoryKv();
    await kvImageStore(kv).put(sha256(WEBP), WEBP, "image/webp");
    const response = await serve(`/images/${sha256(WEBP)}`, kv);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(WEBP)).toBe(true);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it("answers 404 for a hash it does not hold, and 400 for anything that is no hash", async () => {
    const kv = memoryKv();
    expect((await serve(`/images/${sha256(PNG)}`, kv)).status).toBe(404);
    expect((await serve("/images/not-a-hash", kv)).status).toBe(400);
    expect((await serve(`/images/${sha256(PNG).toUpperCase()}`, kv)).status).toBe(400);
  });

  it("never serves bytes under a type outside the three it keeps", async () => {
    const kv = memoryKv();
    await kv.put(`image:${sha256(PNG)}`, PNG, { metadata: { type: "image/svg+xml" } });
    expect((await serve(`/images/${sha256(PNG)}`, kv)).status).toBe(404);
  });
});
