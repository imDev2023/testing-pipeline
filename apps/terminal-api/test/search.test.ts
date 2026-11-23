// Search (docs/spec/pipescope-screens.md, "Search"; PIPESCOPE-81), from Postgres: names match
// anywhere and in any case (a strategy's name from valid metadata, a token's symbol and name, and the
// names Aviary gives SOL and USDC); addresses match exactly as typed, from their start or their end
// (a strategy's program, a market, a market state or a mint), since base58 is case-sensitive; results
// come grouped as strategies, markets and mints, each with its count, at most `limit` a group.
import { createDb, marketMints, markets, metadataSnapshots, mints, strategies } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAGE_LIMITS } from "../src/config";
import { SearchResults, type ApiError } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const WSOL = "So11111111111111111111111111111111111111112";
const TAX = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const WALL = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const STATE = "EE3ifuzvJGAtcY6xTxxr26ezaXG1cethHvA52R3r6x1U";
const DREAM = "5AMPgS3baS6g4gsgSGwkE2wx9dV6iJNzaCMfpDFNfvM9";
const LONELY = "Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe";
const CREATOR = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let env: ReturnType<typeof bindings>;
let many: string[];
beforeAll(async () => {
  database = await createTestDatabase();
  env = bindings({ databaseUrl: database.url, rpcUrl: "http://127.0.0.1:9/never-called" });
  // 25 more markets whose addresses all start "Many", each trading DREAM against SOL, so a group passes the cap.
  many = Array.from({ length: 25 }, (_, i) => `Many${"ABCDEFGHJKLMNPQRSTUVWXYZa"[i]}`.padEnd(44, "z"));
  const { db, close } = createDb(database.url);
  try {
    const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 12, minutes));
    await db.insert(strategies).values([
      { program: TAX, metadataUri: "https://example.com/tax.json", registeredAt: at(0) },
      { program: WALL, metadataUri: "https://example.com/wall.json", registeredAt: at(1) },
    ]);
    const snapshot = { errors: [], warnings: [], fetchedAt: at(2), checkedAt: at(2) };
    await db.insert(metadataSnapshots).values([
      { ...snapshot, program: TAX, uri: "https://example.com/tax.json", status: "valid", normalised: { name: "Tax AMM" } },
      // The buy wall's newest snapshot is for a URI it no longer names, so its old name is not its name.
      { ...snapshot, program: WALL, uri: "https://example.com/old-wall.json", status: "valid", normalised: { name: "Buy Wall AMM" } },
    ]);
    await db.insert(markets).values([
      { address: MARKET, strategyProgram: WALL, marketState: STATE, createdBy: CREATOR, createdAt: at(10) },
      ...many.map((address, i) => ({ address, strategyProgram: TAX, marketState: address, createdBy: CREATOR, createdAt: at(20 + i) })),
    ]);
    await db.insert(marketMints).values([
      { market: MARKET, position: 0, mint: DREAM },
      { market: MARKET, position: 1, mint: WSOL },
      ...many.flatMap((market) => [
        { market, position: 0, mint: DREAM },
        { market, position: 1, mint: WSOL },
      ]),
    ]);
    await db.insert(mints).values([
      { address: DREAM, readable: true, decimals: 6, symbol: "DREAM", name: "Pipe Dream", tokenUri: "https://example.com/dream.json" },
      { address: WSOL, readable: true, decimals: 9 },
      // A token that trades on no Pipeline market never appears.
      { address: LONELY, readable: true, symbol: "LONE", name: "Lonely Dream" },
    ]);
  } finally {
    await close();
  }
});
afterAll(async () => {
  await database?.drop();
});

async function search(query: string): Promise<SearchResults> {
  const { ctx, settle } = executionContext();
  const response = await app.request(`/v1/search?${query}`, {}, env, ctx);
  await settle();
  expect(response.status).toBe(200);
  return SearchResults.parse(await response.json());
}
const q = (text: string) => search(`q=${encodeURIComponent(text)}`);

describe("addresses", () => {
  it("finds a market by the first characters of its address and by the last, exactly as typed", async () => {
    expect((await q("7BctW")).markets.results.map((m) => m.address)).toEqual([MARKET]);
    expect((await q("Ga5CAK")).markets.results.map((m) => m.address)).toEqual([MARKET]);
    expect((await q("7bctw")).markets.total).toBe(0);
    expect((await q("ctWoaS")).markets.total).toBe(0);
  });

  it("finds a market by its market state, a strategy by its program and a mint by its address", async () => {
    expect((await q("EE3if")).markets.results.map((m) => m.address)).toEqual([MARKET]);
    expect((await q("xonW9t")).strategies.results.map((s) => s.program)).toEqual([TAX]);
    expect((await q("5AMPg")).mints.results.map((m) => m.mint)).toEqual([DREAM]);
  });

  it("puts a whole address typed first in its group", async () => {
    const found = await q(MARKET);
    expect(found.markets.results[0]!.address).toBe(MARKET);
  });
});

describe("names", () => {
  it("finds a token by part of its name or symbol in any case, with the markets it trades on", async () => {
    const found = await q("pE dReA");
    expect(found.mints.results.map(({ mint, symbol, token }) => ({ mint, symbol, token }))).toEqual([{ mint: DREAM, symbol: null, token: { symbol: "DREAM", name: "Pipe Dream", image: null } }]);
    expect(found.mints.results[0]!.markets.sort()).toEqual([MARKET, ...many].sort());
    expect((await q("dream")).mints.results.map((m) => m.mint)).toEqual([DREAM]);
  });

  it("finds a strategy by part of the name its valid metadata gives now, in any case", async () => {
    expect((await q("tax a")).strategies.results.map((s) => s.program)).toEqual([TAX]);
    expect((await q("wall amm")).strategies.total).toBe(0);
  });

  it("finds SOL by the name Aviary gives it", async () => {
    expect((await q("sol")).mints.results.map(({ mint, symbol, token }) => ({ mint, symbol, token }))).toEqual([{ mint: WSOL, symbol: "SOL", token: null }]);
  });

  it("never matches a name by a wildcard typed in it", async () => {
    const found = await q("%");
    expect([found.strategies.total, found.markets.total, found.mints.total]).toEqual([0, 0, 0]);
    expect((await q("_")).mints.total).toBe(0);
  });
});

describe("groups", () => {
  it("hold at most 20 by default, the screens' number, newest market first, and count every match", async () => {
    expect(PAGE_LIMITS.search).toEqual({ default: 20, max: 100 });
    const found = await q("Many");
    expect(found.markets.total).toBe(25);
    expect(found.markets.results.map((m) => m.address)).toEqual([...many].reverse().slice(0, 20));
  });

  it("hold as many as asked for, up to 100", async () => {
    expect((await search("q=Many&limit=100")).markets.results).toHaveLength(25);
    expect((await search("q=Many&limit=3")).markets).toMatchObject({ total: 25, results: [{ address: many[24] }, { address: many[23] }, { address: many[22] }] });
  });

  it("name every market a mint trades on, however many", async () => {
    expect((await q("DREAM")).mints.results[0]!.markets).toHaveLength(26);
  });
});

describe("what it refuses", () => {
  it.each([
    ["", "q is what to search for: 1 to 100 characters."],
    ["q=", "q is what to search for: 1 to 100 characters."],
    ["q=%20%20", "q is what to search for: 1 to 100 characters."],
    [`q=${"a".repeat(101)}`, "q is what to search for: 1 to 100 characters."],
    ["q=a&limit=101", "limit is at most 100."],
  ])("%s", async (query, error) => {
    const { ctx, settle } = executionContext();
    const response = await app.request(`/v1/search?${query}`, {}, env, ctx);
    await settle();
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiError).error).toBe(error);
  });
});
