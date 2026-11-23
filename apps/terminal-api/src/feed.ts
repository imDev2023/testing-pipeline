// The feed's read endpoints (docs/spec/pipescope-architecture.md, API; the zod contract in
// ./contract): strategies, markets newest first and paged, a market, its trades and candles and a
// trader's swaps, all from Postgres, where the indexer keeps them.
import { and, desc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDb, marketMints, markets, mints, strategies, trades, type Db } from "terminal-db";
import { writtenCandles, type CandleRow } from "terminal-indexer";
import { AVIARY_MINT_NAMES, CANDLES, PAGE_LIMITS, VOLUME_WINDOW_SECONDS } from "./config";
import { Candles, Market, MarketsPage, Strategy, StrategiesList, TradesPage, type Trade } from "./contract";
import type { AppEnv } from "./index";
import { marketPair, tradePair } from "./pairs";
import { priceOf } from "./prices";

type FeedEnv = AppEnv & { Variables: { db: () => Db } };

export const feed = new Hono<FeedEnv>();

/** A database client for the request, opened on first use and closed once the handler is done with it. */
feed.use(async (c, next) => {
  let client: ReturnType<typeof createDb> | null = null;
  c.set("db", () => (client ??= createDb(c.env.HYPERDRIVE.connectionString)).db);
  try {
    await next();
  } finally {
    if (client) c.executionCtx.waitUntil((client as ReturnType<typeof createDb>).close());
  }
});

const db = (c: Context<FeedEnv>): Db => c.var.db();

/** The `limit` asked for, or the default; above the most served, a 400 that says what the most is. */
function limitOf(c: Context<FeedEnv>, { default: fallback, max }: { default: number; max: number }): number {
  const raw = c.req.query("limit");
  if (raw === undefined) return fallback;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) throw new HTTPException(400, { message: "limit is a whole number of at least 1." });
  if (limit > max) throw new HTTPException(400, { message: `limit is at most ${max}.` });
  return limit;
}

/** A page cursor's parts (`before`, or with `name` another cursor parameter), or a 400 for one this API did not write. */
function cursorOf(c: Context<FeedEnv>, pattern: RegExp, name: "before" | "after" = "before"): string[] | null {
  const value = c.req.query(name);
  if (value === undefined) return null;
  const match = pattern.exec(value);
  if (!match) throw new HTTPException(400, { message: name === "before" ? "before is not a cursor this API wrote; pass a page's next as it came." : "after is a trade's slot, place in its block and event index, as slot_block_event." });
  return match.slice(1);
}

const notFound = (what: string) => new HTTPException(404, { message: `Aviary knows no ${what} at this address.` });

// ---- Strategies ----

const strategyColumns = {
  program: strategies.program,
  metadataUri: strategies.metadataUri,
  feePaid: strategies.feePaid,
  registeredAt: strategies.registeredAt,
  registeredSignature: strategies.registeredSignature,
  marketCount: sql<number>`(select count(*)::int from ${markets} where ${markets.strategyProgram} = ${strategies.program})`,
};

type StrategyRow = { program: string; metadataUri: string; feePaid: string | null; registeredAt: Date; registeredSignature: string | null; marketCount: number };

const strategyView = (s: StrategyRow): Strategy => ({
  program: s.program,
  metadata_uri: s.metadataUri,
  fee_paid: s.feePaid,
  registered_at: s.registeredAt.toISOString(),
  registered_signature: s.registeredSignature,
  market_count: s.marketCount,
});

feed.get("/v1/strategies", async (c) => {
  const rows = await db(c).select(strategyColumns).from(strategies).orderBy(desc(strategies.registeredAt), desc(strategies.program));
  return c.json(StrategiesList.parse({ strategies: rows.map(strategyView) }));
});

feed.get("/v1/strategies/:program", async (c) => {
  const [row] = await db(c).select(strategyColumns).from(strategies).where(eq(strategies.program, c.req.param("program")));
  if (!row) throw notFound("strategy registered with Pipeline");
  return c.json(Strategy.parse(strategyView(row)));
});

// ---- Markets ----

type MarketRow = typeof markets.$inferSelect;

/** Each market's mints in order, with their vaults and decimals, and its last 24 hours, read for a page of markets at once. */
async function marketViews(database: Db, rows: MarketRow[]): Promise<Market[]> {
  if (!rows.length) return [];
  const addresses = rows.map((m) => m.address);
  const held = await database
    .select({ market: marketMints.market, position: marketMints.position, mint: marketMints.mint, vault: marketMints.vault, liquidity: marketMints.vaultAmount, decimals: mints.decimals })
    .from(marketMints)
    .leftJoin(mints, eq(mints.address, marketMints.mint))
    .where(inArray(marketMints.market, addresses))
    .orderBy(marketMints.market, marketMints.position);
  const since = BigInt(Math.floor(Date.now() / 1000) - VOLUME_WINDOW_SECONDS);
  const recent = await database
    .select({
      market: trades.market,
      inputMint: trades.inputMint,
      outputMint: trades.outputMint,
      trades: sql<number>`count(*)::int`,
      netSent: sql<string>`sum(${trades.netSent})::text`,
      received: sql<string>`sum(${trades.received})::text`,
    })
    .from(trades)
    .where(and(inArray(trades.market, addresses), gte(trades.unixTimestamp, since)))
    .groupBy(trades.market, trades.inputMint, trades.outputMint);

  return rows.map((m) => {
    const own = held.filter((h) => h.market === m.address);
    const { quote, base } = marketPair(own.map((h) => h.mint));
    let count = 0;
    let volume = 0n;
    for (const r of recent.filter((r) => r.market === m.address)) {
      count += r.trades;
      if (r.inputMint === quote) volume += BigInt(r.netSent);
      else if (r.outputMint === quote) volume += BigInt(r.received);
    }
    return {
      address: m.address,
      strategy: m.strategyProgram,
      market_state: m.marketState,
      created_at: m.createdAt.toISOString(),
      created_by: m.createdBy,
      created_signature: m.createdSignature,
      fee_mint: m.feeMint,
      supports_exact_out: m.supportsExactOut,
      mints: own.map((h) => ({ mint: h.mint, symbol: AVIARY_MINT_NAMES[h.mint] ?? null, decimals: h.decimals, vault: h.vault, liquidity: h.liquidity })),
      quote_mint: quote,
      base_mint: base,
      stats_24h: { trades: count, volume_quote: String(volume) },
    };
  });
}

feed.get("/v1/markets", async (c) => {
  const limit = limitOf(c, PAGE_LIMITS.markets);
  const cursor = cursorOf(c, /^(\d+)_([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  const database = db(c);
  const after: SQL | undefined = cursor ? sql`(${markets.createdAt}, ${markets.address}) < (${new Date(Number(cursor[0])).toISOString()}::timestamptz, ${cursor[1]})` : undefined;
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    database.select().from(markets).where(after).orderBy(desc(markets.createdAt), desc(markets.address)).limit(limit + 1),
    database.select({ total: sql<number>`count(*)::int` }).from(markets),
  ]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return c.json(MarketsPage.parse({ markets: await marketViews(database, page), total, next: rows.length > limit && last ? `${last.createdAt.getTime()}_${last.address}` : null }));
});

feed.get("/v1/markets/:market", async (c) => {
  const database = db(c);
  const [row] = await database.select().from(markets).where(eq(markets.address, c.req.param("market")));
  if (!row) throw notFound("market created through Pipeline");
  const [view] = await marketViews(database, [row]);
  return c.json(Market.parse(view));
});

// ---- Trades ----

/** A page of trades newest first, of one market or one trader, with each trade's pair by its market's order of mints. */
async function tradesPage(c: Context<FeedEnv>, database: Db, where: SQL): Promise<TradesPage> {
  const limit = limitOf(c, PAGE_LIMITS.trades);
  const pattern = /^(\d+)_(-?\d+)_(\d+)$/;
  const cursor = cursorOf(c, pattern);
  // A reconnecting page asks for only what it missed: the trades newer than the last one it saw.
  const after = cursorOf(c, pattern, "after");
  const order = sql`(${trades.slot}, coalesce(${trades.blockIndex}, -1), ${trades.eventIndex})`;
  const rows = await database
    .select()
    .from(trades)
    .where(
      and(
        where,
        cursor ? sql`${order} < (${BigInt(cursor[0]!)}, ${Number(cursor[1])}, ${Number(cursor[2])})` : undefined,
        after ? sql`${order} > (${BigInt(after[0]!)}, ${Number(after[1])}, ${Number(after[2])})` : undefined,
      ),
    )
    .orderBy(desc(trades.slot), sql`coalesce(${trades.blockIndex}, -1) desc`, desc(trades.eventIndex))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const marketsOf = [...new Set(page.map((t) => t.market))];
  const held = marketsOf.length
    ? await database.select({ market: marketMints.market, mint: marketMints.mint }).from(marketMints).where(inArray(marketMints.market, marketsOf)).orderBy(marketMints.market, marketMints.position)
    : [];
  const views = page.map((t): Trade => {
    const { quote, base, side } = tradePair(held.filter((h) => h.market === t.market).map((h) => h.mint), t.inputMint, t.outputMint);
    return {
      signature: t.signature,
      event_index: t.eventIndex,
      slot: Number(t.slot),
      block_index: t.blockIndex,
      block_time: t.blockTime?.toISOString() ?? null,
      market: t.market,
      trader: t.trader,
      input_mint: t.inputMint,
      output_mint: t.outputMint,
      mode: t.mode === 1 ? "exact_out" : "exact_in",
      net_sent: t.netSent,
      received: t.received,
      pipeline_fee: t.pipelineFee,
      fee_mint: t.feeMint,
      integrator: t.integrator,
      integrator_fee: t.integratorFee,
      quote_mint: quote,
      base_mint: base,
      side,
    };
  });
  const last = page.at(-1);
  return TradesPage.parse({ trades: views, next: rows.length > limit && last ? `${last.slot}_${last.blockIndex ?? -1}_${last.eventIndex}` : null });
}

feed.get("/v1/markets/:market/trades", async (c) => {
  const database = db(c);
  const market = c.req.param("market");
  const [known] = await database.select({ address: markets.address }).from(markets).where(eq(markets.address, market));
  if (!known) throw notFound("market created through Pipeline");
  return c.json(await tradesPage(c, database, eq(trades.market, market)));
});

feed.get("/v1/traders/:trader/trades", async (c) => c.json(await tradesPage(c, db(c), eq(trades.trader, c.req.param("trader")))));

// ---- Candles ----

const INTERVALS = CANDLES.map((c) => c.interval).join(", ");

/** A Unix time in seconds from the query, or a 400. */
function unixOf(c: Context<FeedEnv>, name: string): number | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new HTTPException(400, { message: `${name} is a time in whole Unix seconds.` });
  return value;
}

feed.get("/v1/markets/:market/candles", async (c) => {
  const length = CANDLES.find((x) => x.interval === c.req.query("interval"));
  if (!length) throw new HTTPException(400, { message: `interval is one of ${INTERVALS}.` });
  const limit = limitOf(c, PAGE_LIMITS.candles);
  const from = unixOf(c, "from");
  const database = db(c);
  const market = c.req.param("market");
  const held = await database
    .select({ mint: marketMints.mint, decimals: mints.decimals })
    .from(marketMints)
    .leftJoin(mints, eq(mints.address, marketMints.mint))
    .where(eq(marketMints.market, market))
    .orderBy(marketMints.position);
  if (!held.length) throw notFound("market created through Pipeline");

  const [base, quote] = [c.req.query("base"), c.req.query("quote")];
  let pair: { base: string; quote: string };
  if (base === undefined && quote === undefined) pair = marketPair(held.map((h) => h.mint));
  else if (base && quote && base !== quote && held.some((h) => h.mint === base) && held.some((h) => h.mint === quote)) pair = { base, quote };
  else throw new HTTPException(400, { message: "base and quote are two different mints of this market, given together." });
  const decimals = (mint: string) => held.find((h) => h.mint === mint)!.decimals;
  const [baseDecimals, quoteDecimals] = [decimals(pair.base), decimals(pair.quote)];
  if (baseDecimals === null || quoteDecimals === null) throw new HTTPException(503, { message: "This market's mints have not been read yet, so its prices cannot be written in tokens. Try again in a minute." });

  const rows = await writtenCandles(database, market, [pair.base, pair.quote], length.seconds, { from, newest: limit });
  // Every priced swap of the pair, all time: the day candles count them, however far back.
  const days = await writtenCandles(database, market, [pair.base, pair.quote], CANDLES.at(-1)!.seconds);
  const quoteIsA = (row: CandleRow) => row.mintA === pair.quote;
  const price = (row: CandleRow, p: CandleRow["open"]) => priceOf(p, quoteIsA(row), quoteDecimals, baseDecimals);
  return c.json(
    Candles.parse({
      market,
      interval: length.interval,
      seconds: length.seconds,
      base_mint: pair.base,
      quote_mint: pair.quote,
      trade_count: days.reduce((n, d) => n + d.trades, 0),
      candles: rows.map((row) => {
        // Turned round, the highest price one way is the lowest the other.
        const [high, low] = quoteIsA(row) ? [row.high, row.low] : [row.low, row.high];
        return {
          start: new Date(row.start * 1000).toISOString(),
          open: price(row, row.open),
          high: price(row, high),
          low: price(row, low),
          close: price(row, row.close),
          volume_base: String(quoteIsA(row) ? row.volumeB : row.volumeA),
          volume_quote: String(quoteIsA(row) ? row.volumeA : row.volumeB),
          trades: row.trades,
        };
      }),
    }),
  );
});
