// Token names and images on every mint the API serves (docs/spec/pipescope.md, "Tokens and prices";
// PIPESCOPE-22, PIPESCOPE-82): a market's mints, its facts' mints and its trades' pair carry each
// token's own symbol, name and kept image as `token`, the author's claim, apart from `symbol`, the
// name Aviary gives SOL and USDC itself; a mint Aviary names never carries its author's claim.
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, marketMints, markets, mints, tokenImages } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { indexTransactions, pipelineHandler, type RawTransaction } from "terminal-indexer";
import { afterAll, beforeAll, expect, it } from "vitest";
import { Market, MarketFacts } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/../../../packages/terminal-indexer/test/fixtures/${name}.json`, "utf8")) as RawTransaction;
const [registered, created] = ["registered", "marketCreated"].map(fixture) as [RawTransaction, RawTransaction];
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const TOKEN = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";
const WSOL = "So11111111111111111111111111111111111111112";
const IMAGE = "a".repeat(64);
const URI = "https://example.com/token.json";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let env: ReturnType<typeof bindings>;
beforeAll(async () => {
  database = await createTestDatabase();
  env = bindings({ databaseUrl: database.url, rpcUrl: "http://127.0.0.1:9/never-called" });
  const { db, close } = createDb(database.url);
  try {
    await indexTransactions(db, pipelineHandler({ candleSeconds: [] }), [registered, created]);
    await db.update(markets).set({ feeMint: WSOL, supportsExactOut: false }).where(eq(markets.address, MARKET));
    await db.update(marketMints).set({ vault: "2yLyoJtMyVYu7G1uMCr8mJKzVZj53fFHrJ8Fzb5iT6st", vaultAmount: "1" }).where(eq(marketMints.mint, TOKEN));
    await db.insert(mints).values([
      { address: TOKEN, readable: true, decimals: 6, symbol: "DREAM", name: "Pipe Dream", tokenUri: URI },
      // Wrapped SOL claiming another name: Aviary names it, so its claim is never served.
      { address: WSOL, readable: true, decimals: 9, symbol: "FAKE", name: "Not SOL", tokenUri: "https://example.com/fake.json" },
    ]);
    await db.insert(tokenImages).values([
      { uri: URI, status: "kept", imageUrl: "https://example.com/dream.png", sha256: IMAGE, contentType: "image/png", size: 394, fetchedAt: new Date() },
      { uri: "https://example.com/fake.json", status: "kept", imageUrl: "https://example.com/fake.png", sha256: "b".repeat(64), contentType: "image/png", size: 394, fetchedAt: new Date() },
    ]);
  } finally {
    await close();
  }
});
afterAll(async () => {
  await database?.drop();
});

async function get(path: string): Promise<unknown> {
  const { ctx, settle } = executionContext();
  const response = await app.request(path, {}, env, ctx);
  await settle();
  expect(response.status).toBe(200);
  return response.json();
}

it("gives a market's mints the token's own symbol, name and kept image, and none to a mint Aviary names", async () => {
  const market = Market.parse(await get(`/v1/markets/${MARKET}`));
  expect(market.mints.map(({ mint, symbol, token }) => ({ mint, symbol, token }))).toEqual([
    { mint: TOKEN, symbol: null, token: { symbol: "DREAM", name: "Pipe Dream", image: IMAGE } },
    { mint: WSOL, symbol: "SOL", token: null },
  ]);
});

it("gives the facts panel's mints the same", async () => {
  const facts = MarketFacts.parse(await get(`/v1/markets/${MARKET}/facts`));
  expect(facts.mints.map(({ mint, symbol, token }) => ({ mint, symbol, token }))).toEqual([
    { mint: TOKEN, symbol: null, token: { symbol: "DREAM", name: "Pipe Dream", image: IMAGE } },
    { mint: WSOL, symbol: "SOL", token: null },
  ]);
});

it("serves no image for a token whose image was not kept, and no token for a mint that names none", async () => {
  const { db, close } = createDb(database.url);
  try {
    await db.update(tokenImages).set({ status: "refused", reason: "type", sha256: null }).where(eq(tokenImages.uri, URI));
    expect(Market.parse(await get(`/v1/markets/${MARKET}`)).mints[0]!.token).toEqual({ symbol: "DREAM", name: "Pipe Dream", image: null });
    await db.update(mints).set({ symbol: null, name: null, tokenUri: null }).where(eq(mints.address, TOKEN));
    expect(Market.parse(await get(`/v1/markets/${MARKET}`)).mints[0]!.token).toBeNull();
  } finally {
    await close();
  }
});
