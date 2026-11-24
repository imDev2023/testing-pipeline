// The feed's endpoints in the zod contract (docs/spec/pipescope-architecture.md, API): strategies,
// markets newest first and paged, a market, its trades and a trader's swaps, each market and trade
// with `quote_mint` and `base_mint` by the quote mint order in ./config (PIPESCOPE-74). The database
// is filled by the indexer from real devnet transactions, with the vaults as a read would leave them.
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, marketMints, markets, mints, trades } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { indexTransactions, pipelineHandler, type RawTransaction } from "terminal-indexer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Market, MarketsPage, Strategy, StrategiesList, TraderTradesPage, TradesPage, type ApiError } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/../../../packages/terminal-indexer/test/fixtures/${name}.json`, "utf8")) as RawTransaction;
const [registered, created, swap, multi] = ["registered", "marketCreated", "swap", "multiEvent"].map(fixture) as [RawTransaction, RawTransaction, RawTransaction, RawTransaction];

const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const TOKEN = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";
const WSOL = "So11111111111111111111111111111111111111112";
const TRADER = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";
const EARLIER_SELL = "4Eyg9G7jATi6KCjgYVm9u1DdYXwehmLGKrU1QFeYyBdv6QWVWdivPdQDTmG4YpsL61aEunMkFF1yYYyU8joRAwHg";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let env: ReturnType<typeof bindings>;
beforeAll(async () => {
  database = await createTestDatabase();
  env = bindings({ databaseUrl: database.url, rpcUrl: "http://127.0.0.1:9/never-called" });
  const { db, close } = createDb(database.url);
  try {
    await indexTransactions(db, pipelineHandler({ candleSeconds: [] }), [registered, multi, created, swap]);
    // What refreshMarkets leaves after reading the market's account, vaults and mints.
    await db.update(markets).set({ feeMint: WSOL, supportsExactOut: false }).where(eq(markets.address, MARKET));
    await db.update(marketMints).set({ vault: "2yLyoJtMyVYu7G1uMCr8mJKzVZj53fFHrJ8Fzb5iT6st", vaultAmount: "774943493703585" }).where(eq(marketMints.mint, TOKEN));
    await db.update(marketMints).set({ vault: "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2", vaultAmount: "31000000000" }).where(eq(marketMints.mint, WSOL));
    await db.insert(mints).values([
      { address: TOKEN, readable: true, tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", decimals: 6, supply: "1000000000000000" },
      { address: WSOL, readable: true, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 9, supply: "0" },
    ]).onConflictDoNothing();
    // An earlier sell by the same trader on the same market, so a trader's swaps fill more than one page.
    const [bought] = await db.select().from(trades).where(eq(trades.signature, swap.transaction.signatures[0]!));
    await db.insert(trades).values({ ...bought!, signature: EARLIER_SELL, slot: 525139900n, blockIndex: 7, inputMint: TOKEN, outputMint: WSOL, netSent: "1000", received: "39" });
  } finally {
    await close();
  }
});
afterAll(async () => {
  await database?.drop();
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const { ctx, settle } = executionContext();
  const response = await app.request(path, {}, env, ctx);
  await settle();
  return { status: response.status, body: await response.json() };
}

describe("GET /v1/strategies", () => {
  it("lists every strategy with its registration and market count", async () => {
    const { status, body } = await get("/v1/strategies");
    expect(status).toBe(200);
    const { strategies } = StrategiesList.parse(body);
    expect(strategies).toContainEqual(
      expect.objectContaining({
        program: STRATEGY,
        metadata_uri: expect.stringMatching(/^https:\/\//),
        fee_paid: "10000000",
        registered_at: new Date(registered.blockTime! * 1000).toISOString(),
        registered_signature: registered.transaction.signatures[0],
        market_count: 1,
        // Its metadata not fetched yet and its program not watched yet: no name and no flags.
        name: null,
        metadata: expect.objectContaining({ status: "not-fetched" }),
        flags: [],
      }),
    );
  });

  it("answers one strategy, and a 404 that says so for an address that is none", async () => {
    expect(Strategy.parse((await get(`/v1/strategies/${STRATEGY}`)).body).market_count).toBe(1);
    const missing = await get(`/v1/strategies/${TRADER}`);
    expect(missing.status).toBe(404);
    expect((missing.body as ApiError).error).toBe("Aviary knows no strategy registered with Pipeline at this address.");
  });
});

describe("GET /v1/markets", () => {
  it("lists markets newest first, each with its pair base first, what each vault holds, and its last 24 hours in the quote mint", async () => {
    const { status, body } = await get("/v1/markets");
    expect(status).toBe(200);
    const page = MarketsPage.parse(body);
    expect(page.total).toBe(2);
    expect(page.markets.map((m) => m.address)).toEqual([MARKET, expect.any(String)]);
    expect(page.markets[0]).toEqual({
      address: MARKET,
      strategy: STRATEGY,
      market_state: "EE3ifuzvJGAtcY6xTxxr26ezaXG1cethHvA52R3r6x1U",
      created_at: new Date(created.blockTime! * 1000).toISOString(),
      created_by: TRADER,
      created_signature: created.transaction.signatures[0],
      fee_mint: WSOL,
      supports_exact_out: false,
      quote_mint: WSOL,
      base_mint: TOKEN,
      mints: [
        // Read before mints kept their flags: none known yet.
        { mint: TOKEN, symbol: null, token: null, decimals: 6, vault: "2yLyoJtMyVYu7G1uMCr8mJKzVZj53fFHrJ8Fzb5iT6st", liquidity: "774943493703585", flags: null },
        { mint: WSOL, symbol: "SOL", token: null, decimals: 9, vault: "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2", liquidity: "31000000000", flags: null },
      ],
      // The swap fixture is from 2026-11-22, more than a day before CI may run it.
      stats_24h: expect.objectContaining({ volume_quote: expect.stringMatching(/^\d+$/), trades: expect.any(Number) }),
      strategy_name: null,
      strategy_metadata: "not-fetched",
      flags: [],
      // Canary has not run it.
      canary: null,
    });
  });

  it("pages with the limit asked for and a cursor to the next page", async () => {
    const first = MarketsPage.parse((await get("/v1/markets?limit=1")).body);
    expect(first.markets).toHaveLength(1);
    expect(first.next).not.toBeNull();
    const second = MarketsPage.parse((await get(`/v1/markets?limit=1&before=${encodeURIComponent(first.next!)}`)).body);
    expect(second.markets.map((m) => m.address)).not.toContain(MARKET);
    expect(second.next).toBeNull();
  });

  it("refuses a limit above the most it serves, saying what that is", async () => {
    const { status, body } = await get("/v1/markets?limit=100000");
    expect(status).toBe(400);
    expect((body as ApiError).error).toMatch(/^limit is at most \d+\.$/);
  });

  it("answers one market, and a 404 that says so for an address that is none", async () => {
    expect(Market.parse((await get(`/v1/markets/${MARKET}`)).body).base_mint).toBe(TOKEN);
    const missing = await get(`/v1/markets/${TRADER}`);
    expect(missing.status).toBe(404);
    expect((missing.body as ApiError).error).toBe("Aviary knows no market created through Pipeline at this address.");
  });
});

describe("trades", () => {
  const expected = {
    signature: swap.transaction.signatures[0],
    event_index: 0,
    slot: 525139941,
    block_index: 4,
    block_time: new Date(swap.blockTime! * 1000).toISOString(),
    market: MARKET,
    trader: TRADER,
    input_mint: WSOL,
    output_mint: TOKEN,
    mode: "exact_in",
    net_sent: "1000000000",
    received: "25056506296415",
    pipeline_fee: "2500000",
    fee_mint: WSOL,
    integrator: null,
    integrator_fee: "0",
    quote_mint: WSOL,
    base_mint: TOKEN,
    side: "buy",
  };

  it("lists a market's trades newest first, each a buy or a sell of its base mint", async () => {
    const page = TradesPage.parse((await get(`/v1/markets/${MARKET}/trades`)).body);
    expect(page.trades[0]).toEqual(expected);
    expect(page.trades[1]).toMatchObject({ signature: EARLIER_SELL, side: "sell", quote_mint: WSOL, base_mint: TOKEN });
    expect(page.next).toBeNull();
  });

  it("lists a trader's swaps on every market, newest first, paged by a cursor", async () => {
    const all = TradesPage.parse((await get(`/v1/traders/${TRADER}/trades`)).body);
    expect(all.trades.map((t) => t.signature)).toEqual([swap.transaction.signatures[0], EARLIER_SELL]);
    const first = TradesPage.parse((await get(`/v1/traders/${TRADER}/trades?limit=1`)).body);
    expect(first.trades).toEqual([expected]);
    const rest = TraderTradesPage.parse((await get(`/v1/traders/${TRADER}/trades?limit=100&before=${encodeURIComponent(first.next!)}`)).body);
    expect(rest.trades).toEqual([all.trades[1]]);
    expect(rest.next).toBeNull();
  });

  it("names every mint a trader's page of swaps holds, with its decimals, for the wallet page (#122)", async () => {
    const page = TraderTradesPage.parse((await get(`/v1/traders/${TRADER}/trades`)).body);
    expect(page.mints).toEqual([
      { mint: TOKEN, symbol: null, token: null, decimals: 6 },
      { mint: WSOL, symbol: "SOL", token: null, decimals: 9 },
    ]);
    const none = TraderTradesPage.parse((await get(`/v1/traders/${MARKET}/trades`)).body);
    expect(none).toEqual({ trades: [], next: null, mints: [] });
  });

  it("answers a 404 for the trades of a market that is none", async () => {
    expect((await get(`/v1/markets/${TRADER}/trades`)).status).toBe(404);
  });
});

describe("a strategy's own reserves as its liquidity (PIPESCOPE-161)", () => {
  it("shows a tax market's real reserves as its liquidity, not what its vaults hold with the tax owed, and filters on them", async () => {
    const { db, close } = createDb(database.url);
    try {
      // The SOL vault holds 31 SOL, of which 2 SOL is tax booked and not yet paid out.
      await db.update(marketMints).set({ reserve: "770000000000000" }).where(eq(marketMints.mint, TOKEN));
      await db.update(marketMints).set({ reserve: "29000000000" }).where(eq(marketMints.mint, WSOL));
      const market = Market.parse((await get(`/v1/markets/${MARKET}`)).body);
      expect(market.mints.map((m) => [m.mint, m.liquidity])).toEqual([
        [TOKEN, "770000000000000"],
        [WSOL, "29000000000"],
      ]);
      const listed = MarketsPage.parse((await get("/v1/markets")).body).markets.find((m) => m.address === MARKET);
      expect(listed?.mints.map((m) => m.liquidity)).toEqual(["770000000000000", "29000000000"]);
      // At least 30 SOL: the vault holds 31, the market 29, so it is left out.
      expect(MarketsPage.parse((await get("/v1/markets?min_sol_liquidity=30000000000")).body).markets.map((m) => m.address)).not.toContain(MARKET);
      expect(MarketsPage.parse((await get("/v1/markets?min_sol_liquidity=29000000000")).body).markets.map((m) => m.address)).toContain(MARKET);
    } finally {
      await db.update(marketMints).set({ reserve: null }).where(eq(marketMints.market, MARKET));
      await close();
    }
  });
});
