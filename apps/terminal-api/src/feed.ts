// The feed's read endpoints (docs/spec/pipescope-architecture.md, API; the zod contract in
// ./contract): strategies with their facts, markets newest first and paged (all, or one strategy's)
// with the feed's four filters, a market, its facts, its trades and candles and a trader's swaps, all
// from Postgres, where the indexer keeps them.
import { and, desc, eq, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { FLAGS } from "@pipeline-sol/sdk";
import { marketMints, markets, mints, strategies, trades, type Db } from "terminal-db";
import { writtenCandles, type CandleRow } from "terminal-indexer";
import { CANDLES, PAGE_LIMITS, VOLUME_WINDOW_SECONDS, WRAPPED_SOL } from "./config";
import { Candles, Market, MarketFacts, MarketsPage, StrategiesList, StrategyDetail, TraderTradesPage, TradesPage } from "./contract";
import { flagFacts, marketFlagsSql, mintFacts, strategyColumns as factColumns, strategyViews } from "./facts";
import { dbOf, requestDb, type DbEnv } from "./requestDb";
import { marketPair } from "./pairs";
import { priceOf } from "./prices";
import { marketViews, mintNames, tradeViews } from "./views";

type FeedEnv = DbEnv;

export const feed = new Hono<FeedEnv>();

feed.use(requestDb);

const db = dbOf;

/** The `limit` asked for, or the default; above the most served, a 400 that says what the most is. */
export function limitOf(c: Context<FeedEnv>, { default: fallback, max }: { default: number; max: number }): number {
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

export const notFound = (what: string) => new HTTPException(404, { message: `Aviary knows no ${what} at this address.` });

// ---- Strategies ----

const strategyColumns = {
  ...factColumns,
  marketCount: sql<number>`(select count(*)::int from ${markets} where ${markets.strategyProgram} = ${strategies.program})`,
};

feed.get("/v1/strategies", async (c) => {
  const database = db(c);
  const views = await strategyViews(database, await database.select(strategyColumns).from(strategies).orderBy(desc(strategies.registeredAt), desc(strategies.program)));
  return c.json(StrategiesList.parse({ strategies: views, flags_present: flagFacts(views.flatMap((v) => v.flags)) }));
});

feed.get("/v1/strategies/:program", async (c) => {
  const database = db(c);
  const [row] = await database.select(strategyColumns).from(strategies).where(eq(strategies.program, c.req.param("program")));
  if (!row) throw notFound("strategy registered with Pipeline");
  const [view] = await strategyViews(database, [row]);
  return c.json(StrategyDetail.parse({ ...view!, flag_facts: flagFacts(view!.flags) }));
});

// ---- Markets ----

// ---- The feed's filters (PIPESCOPE-05, PIPESCOPE-72) ----

/** A whole number from the query, from `min` to `max`, or a 400 saying what it takes. */
function wholeOf(c: Context<FeedEnv>, name: string, [min, max]: [bigint, bigint], what: string): bigint | null {
  const raw = c.req.query(name);
  if (raw === undefined) return null;
  if (!/^\d{1,40}$/.test(raw) || BigInt(raw) < min || BigInt(raw) > max) throw new HTTPException(400, { message: `${name} is ${what}.` });
  return BigInt(raw);
}

/** The most lamports a filter takes, u64's largest, and the longest time since creation, a hundred years. */
const U64_MAX = 2n ** 64n - 1n;
const CREATED_WITHIN_MAX_SECONDS = 100n * 365n * 86_400n;

/** The flags to hide, each one of Pipeline's, or a 400. */
function hiddenOf(c: Context<FeedEnv>): string[] {
  const raw = c.req.query("hide");
  if (raw === undefined || raw === "") return [];
  const flags = raw.split(",");
  if (!flags.every((f) => (FLAGS as string[]).includes(f))) throw new HTTPException(400, { message: "hide names Pipeline's trust flags, separated by commas." });
  return flags;
}

/**
 * A market's SOL liquidity, as SQL: its strategy's own reserve of SOL where Aviary reads one, else what
 * its SOL vault holds (PIPESCOPE-168); zero for a market with no SOL side, which `hasSolSide` tells.
 */
const solLiquidity = sql`(select coalesce(max(coalesce(mm.reserve, mm.vault_amount)), 0) from ${marketMints} mm where mm.market = ${markets.address} and mm.mint = ${WRAPPED_SOL})`;
const hasSolSide = sql`exists (select 1 from ${marketMints} mm where mm.market = ${markets.address} and mm.mint = ${WRAPPED_SOL})`;
/** SOL moved by a market's trades since `since`, both ways: what went in as SOL and what came out as SOL. */
const solVolume = (since: bigint) =>
  sql`(select coalesce(sum(case when t.input_mint = ${WRAPPED_SOL} then t.net_sent when t.output_mint = ${WRAPPED_SOL} then t.received else 0 end), 0) from ${trades} t where t.market = ${markets.address} and t.unix_timestamp >= ${since})`;

/**
 * The filters asked for, as one condition on `markets`: liquidity and volume on the SOL side (so
 * either leaves out a market with no SOL side), the time since creation, and no hidden flag.
 */
function filtersOf(c: Context<FeedEnv>): { where: SQL | undefined; onSolSide: boolean } {
  const lamports = `a whole number of lamports, at most ${U64_MAX}`;
  const minLiquidity = wholeOf(c, "min_sol_liquidity", [0n, U64_MAX], lamports);
  const minVolume = wholeOf(c, "min_sol_volume_24h", [0n, U64_MAX], lamports);
  const within = wholeOf(c, "created_within", [1n, CREATED_WITHIN_MAX_SECONDS], `a whole number of seconds of at least 1 and at most ${CREATED_WITHIN_MAX_SECONDS}`);
  const hide = hiddenOf(c);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const conditions = [
    minLiquidity === null && minVolume === null ? undefined : hasSolSide,
    // As numeric: a u64 of lamports can pass Postgres's bigint.
    minLiquidity === null ? undefined : sql`${solLiquidity} >= ${String(minLiquidity)}::numeric`,
    minVolume === null ? undefined : sql`${solVolume(BigInt(nowSeconds - VOLUME_WINDOW_SECONDS))} >= ${String(minVolume)}::numeric`,
    within === null ? undefined : sql`${markets.createdAt} >= ${new Date((nowSeconds - Number(within)) * 1000).toISOString()}::timestamptz`,
    hide.length ? sql`not (${marketFlagsSql} && ${sql.raw(`array[${hide.map((f) => `'${f}'`).join(",")}]::text[]`)})` : undefined,
  ];
  return { where: and(...conditions), onSolSide: minLiquidity !== null || minVolume !== null };
}

feed.get("/v1/markets", async (c) => {
  const limit = limitOf(c, PAGE_LIMITS.markets);
  const cursor = cursorOf(c, /^(\d+)_([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  const strategy = c.req.query("strategy");
  const { where: filtered } = filtersOf(c);
  const database = db(c);
  const ofStrategy: SQL | undefined = strategy === undefined ? undefined : eq(markets.strategyProgram, strategy);
  const after: SQL | undefined = cursor ? sql`(${markets.createdAt}, ${markets.address}) < (${new Date(Number(cursor[0])).toISOString()}::timestamptz, ${cursor[1]})` : undefined;
  const [rows, [counts], present] = await Promise.all([
    database.select().from(markets).where(and(ofStrategy, filtered, after)).orderBy(desc(markets.createdAt), desc(markets.address)).limit(limit + 1),
    database
      .select({
        total: sql<number>`count(*)::int`,
        matching: filtered ? sql<number>`(count(*) filter (where ${filtered}))::int` : sql<number>`count(*)::int`,
        noSolSide: sql<number>`(count(*) filter (where not ${hasSolSide}))::int`,
      })
      .from(markets)
      .where(ofStrategy),
    database.execute<{ flag: string }>(sql`select distinct unnest(${marketFlagsSql}) as flag from ${markets} where ${ofStrategy ?? sql`true`}`),
  ]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return c.json(
    MarketsPage.parse({
      markets: await marketViews(database, page),
      total: counts?.total ?? 0,
      matching: counts?.matching ?? 0,
      no_sol_side: counts?.noSolSide ?? 0,
      flags_present: flagFacts([...present].map((r) => r.flag)),
      next: rows.length > limit && last ? `${last.createdAt.getTime()}_${last.address}` : null,
    }),
  );
});

feed.get("/v1/markets/:market/facts", async (c) => {
  const database = db(c);
  const [row] = await database.select().from(markets).where(eq(markets.address, c.req.param("market")));
  if (!row) throw notFound("market created through Pipeline");
  const [[market], [strategy], mintRows] = await Promise.all([
    marketViews(database, [row]),
    database.select(strategyColumns).from(strategies).where(eq(strategies.program, row.strategyProgram)),
    mintFacts(database, row.address),
  ]);
  const [view] = strategy ? await strategyViews(database, [strategy]) : [];
  if (!view) throw notFound("strategy registered with Pipeline");
  return c.json(MarketFacts.parse({ market, strategy: { ...view, flag_facts: flagFacts(view.flags) }, mints: mintRows }));
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
  const views = await tradeViews(database, page);
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

// The wallet page's swaps (#122): a trader's page, with every mint it names.
feed.get("/v1/traders/:trader/trades", async (c) => {
  const database = db(c);
  const page = await tradesPage(c, database, eq(trades.trader, c.req.param("trader")));
  return c.json(TraderTradesPage.parse({ ...page, mints: await mintNames(database, page.trades.flatMap((t) => [t.input_mint, t.output_mint])) }));
});

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
