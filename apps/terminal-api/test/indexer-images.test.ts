// The indexer fetches token images (docs/spec/pipescope-architecture.md, Metadata fetcher; PIPESCOPE-82):
// after a run that read mints, each new token metadata URI is fetched once and its image kept, and a
// run with nothing new never opens the database for it (Data: Neon's free plan must sleep).
import { readFileSync } from "node:fs";
import { createDb, mints, tokenImages } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IndexerCore } from "../src/indexerCore";
import { memoryImages } from "./fakes";

const dream = JSON.parse(readFileSync(`${import.meta.dirname}/../../../packages/terminal-indexer/test/fixtures/mintPipeDream.json`, "utf8")) as { address: string; owner: string; data: string };
const DREAM_URI = "https://ipfs.io/ipfs/QmdznmJXTyhKAJdzMUrchXaHxtuRs97n9YzF4geW8EeMZW";
const PNG = readFileSync(`${import.meta.dirname}/fixtures/images/token.png`);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let rpc: FakeRpc;
beforeEach(async () => {
  database = await createTestDatabase();
  rpc = await fakeRpc();
  rpc.accounts.set(dream.address, { owner: dream.owner, data: Uint8Array.from(Buffer.from(dream.data, "base64")) });
});
afterEach(async () => {
  await rpc.close();
  await database.drop();
});

function core() {
  const asked: string[] = [];
  const webFetch = async (url: string) => {
    asked.push(url);
    if (url === DREAM_URI) return new Response(JSON.stringify({ image: "https://example.com/dream.png" }), { headers: { "content-type": "application/json" } });
    if (url === "https://example.com/dream.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
    return new Response("not found", { status: 404 });
  };
  const openDb = vi.fn(() => createDb(database.url));
  const images = memoryImages();
  return { indexer: new IndexerCore({ rpcUrl: rpc.url, openDb, webFetch, images }), openDb, images, asked };
}

it("fetches the image of each token a read of mints named, once, and never opens the database again while nothing is new", async () => {
  const seed = createDb(database.url);
  await seed.db.insert(mints).values({ address: dream.address, readable: false });
  await seed.close();

  const { indexer, openDb, images, asked } = core();
  await indexer.refreshMints();
  expect(await indexer.fetchPendingImages()).toEqual({ fetched: 1, kept: 1 });
  expect(asked).toEqual([DREAM_URI, "https://example.com/dream.png"]);
  expect(images.kept()).toEqual([{ type: "image/png", size: PNG.length }]);

  openDb.mockClear();
  expect(await indexer.fetchPendingImages()).toEqual({ fetched: 0, kept: 0 });
  expect(openDb).not.toHaveBeenCalled();

  // The hourly read of every mint makes them due again, and finds the URI already fetched.
  await indexer.refreshMints();
  expect(await indexer.fetchPendingImages()).toEqual({ fetched: 0, kept: 0 });
  expect(asked).toHaveLength(2);
});

it("looks once, on a new instance's first call, for URIs an earlier instance left unfetched", async () => {
  const seed = createDb(database.url);
  await seed.db.insert(mints).values({ address: dream.address, readable: true, symbol: "DREAM", name: "Pipe Dream", tokenUri: DREAM_URI });
  await seed.close();
  const { indexer, openDb } = core();
  expect(await indexer.fetchPendingImages()).toEqual({ fetched: 1, kept: 1 });
  openDb.mockClear();
  await indexer.fetchPendingImages();
  expect(openDb).not.toHaveBeenCalled();
  const check = createDb(database.url);
  expect((await check.db.select({ status: tokenImages.status }).from(tokenImages)).map((r) => r.status)).toEqual(["kept"]);
  await check.close();
});
