// Adapted from Top-pad b833a7b, packages/indexer/src/candles.ts; owned here since, per market and
// mint pair (docs/spec/pipescope-architecture.md, Candles; PIPESCOPE-30).
//
// Every swap is folded into its candle at each length as it is indexed, and any candle can be
// rebuilt from the trades. A fold keeps the open and the close by the trades' order (slot, place in
// the block, event index), not by when they arrived, so a swap that reconciliation indexes late
// still lands where it belongs, and a rebuild comes out the same.
//
// A price is a swap's amounts of the pair's two mints, `received / net_sent` for its pair (Pipeline's
// integrator guide), kept exactly as a reduced fraction: an amount of `mint_a` (the pair's first mint
// by address) for an amount of `mint_b`. So a candle reads exactly either way round and at any
// decimals, which the API works out for the pair a page asks for.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { candles, trades, type Db } from "terminal-db";

/** An exact price: `a` of the pair's first mint for `b` of its second, in their smallest units, in lowest terms. */
export type Ratio = { a: bigint; b: bigint };

/** A candle as the indexer keeps it. */
export type CandleRow = {
  market: string;
  mintA: string;
  mintB: string;
  seconds: number;
  /** Unix seconds. */
  start: number;
  open: Ratio;
  high: Ratio;
  low: Ratio;
  close: Ratio;
  openKey: string;
  closeKey: string;
  volumeA: bigint;
  volumeB: bigint;
  trades: number;
};

/** How long each length is kept, in days, or forever with null (the API's config module, `CANDLES`). */
export type CandleRetention = readonly { seconds: number; keepDays: number | null }[];

/** What a fold needs of a swap. */
export type CandleTrade = {
  market: string;
  inputMint: string;
  outputMint: string;
  netSent: bigint;
  received: bigint;
  /** When it ran, in Unix seconds: see `tradeTime`. */
  at: number;
  slot: bigint;
  blockIndex: number | null;
  eventIndex: number;
};

/** A pair's mints in address order: the order candles are kept in, whichever a page quotes in. */
export const pairOrder = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

/**
 * When a swap ran, for its candle: its block's time, which is where Pipeline's hosted API places it
 * and which can be a second later than the event's own clock (105 of devnet's 387 swaps on
 * 2026-11-23, PIPESCOPE-108); the event's clock only for a block whose time is unknown.
 */
export const tradeTime = (blockTime: Date | null, unixTimestamp: bigint): number => (blockTime ? Math.floor(blockTime.getTime() / 1000) : Number(unixTimestamp));

/** The start of the candle a moment falls in, in Unix seconds. */
export const candleStart = (at: number, seconds: number) => Math.floor(at / seconds) * seconds;

/**
 * A trade's place in the chain as text that sorts as the trades do: slot, then place in the block
 * (unknown sorts first, as the API's paging puts it), then event index.
 */
export const tradeKey = (slot: bigint, blockIndex: number | null, eventIndex: number) =>
  `${slot.toString().padStart(20, "0")}.${String((blockIndex ?? -1) + 1).padStart(10, "0")}.${String(eventIndex).padStart(5, "0")}`;

const gcd = (x: bigint, y: bigint): bigint => {
  while (y) [x, y] = [y, x % y];
  return x;
};

/** A swap's price and amounts in its pair's order, or null when it sent or received nothing and so has no price. */
export function pricedTrade(trade: Pick<CandleTrade, "inputMint" | "outputMint" | "netSent" | "received">): { mintA: string; mintB: string; price: Ratio; amountA: bigint; amountB: bigint } | null {
  if (trade.netSent <= 0n || trade.received <= 0n || trade.inputMint === trade.outputMint) return null;
  const [mintA, mintB] = pairOrder(trade.inputMint, trade.outputMint);
  const [amountA, amountB] = mintA === trade.inputMint ? [trade.netSent, trade.received] : [trade.received, trade.netSent];
  const d = gcd(amountA, amountB);
  return { mintA, mintB, price: { a: amountA / d, b: amountB / d }, amountA, amountB };
}

/** `x` is the higher price of the two, by cross-multiplying, so no division ever rounds. */
const above = (x: Ratio, y: Ratio) => x.a * y.b > y.a * x.b;

/**
 * Folds one newly indexed swap into its candle at every length in `seconds`. Run it once per swap
 * (the handler does so only for a trade row it has just written): it adds to the volumes.
 */
export async function foldTrade(db: Db, trade: CandleTrade, seconds: readonly number[]): Promise<void> {
  const priced = pricedTrade(trade);
  if (!priced || !seconds.length) return;
  const { mintA, mintB, price, amountA, amountB } = priced;
  const key = tradeKey(trade.slot, trade.blockIndex, trade.eventIndex);
  const a = String(price.a);
  const b = String(price.b);
  // Price comparisons cross-multiply; in lowest terms, equal prices are equal fractions, so neither side wins a tie.
  const higher = sql`excluded.high_a * ${candles.highB} > ${candles.highA} * excluded.high_b`;
  const lower = sql`excluded.low_a * ${candles.lowB} < ${candles.lowA} * excluded.low_b`;
  const earlier = sql`excluded.open_key < ${candles.openKey}`;
  const later = sql`excluded.close_key > ${candles.closeKey}`;
  await db
    .insert(candles)
    .values(
      seconds.map((length) => ({
        market: trade.market,
        mintA,
        mintB,
        seconds: length,
        start: BigInt(candleStart(trade.at, length)),
        openA: a,
        openB: b,
        highA: a,
        highB: b,
        lowA: a,
        lowB: b,
        closeA: a,
        closeB: b,
        openKey: key,
        closeKey: key,
        volumeA: String(amountA),
        volumeB: String(amountB),
        trades: 1,
      })),
    )
    .onConflictDoUpdate({
      target: [candles.market, candles.mintA, candles.mintB, candles.seconds, candles.start],
      set: {
        openA: sql`case when ${earlier} then excluded.open_a else ${candles.openA} end`,
        openB: sql`case when ${earlier} then excluded.open_b else ${candles.openB} end`,
        openKey: sql`least(excluded.open_key, ${candles.openKey})`,
        closeA: sql`case when ${later} then excluded.close_a else ${candles.closeA} end`,
        closeB: sql`case when ${later} then excluded.close_b else ${candles.closeB} end`,
        closeKey: sql`greatest(excluded.close_key, ${candles.closeKey})`,
        highA: sql`case when ${higher} then excluded.high_a else ${candles.highA} end`,
        highB: sql`case when ${higher} then excluded.high_b else ${candles.highB} end`,
        lowA: sql`case when ${lower} then excluded.low_a else ${candles.lowA} end`,
        lowB: sql`case when ${lower} then excluded.low_b else ${candles.lowB} end`,
        volumeA: sql`${candles.volumeA} + excluded.volume_a`,
        volumeB: sql`${candles.volumeB} + excluded.volume_b`,
        trades: sql`${candles.trades} + 1`,
      },
    });
}

type Stored = typeof candles.$inferSelect;

const rowOf = (c: Stored): CandleRow => ({
  market: c.market,
  mintA: c.mintA,
  mintB: c.mintB,
  seconds: c.seconds,
  start: Number(c.start),
  open: { a: BigInt(c.openA), b: BigInt(c.openB) },
  high: { a: BigInt(c.highA), b: BigInt(c.highB) },
  low: { a: BigInt(c.lowA), b: BigInt(c.lowB) },
  close: { a: BigInt(c.closeA), b: BigInt(c.closeB) },
  openKey: c.openKey,
  closeKey: c.closeKey,
  volumeA: BigInt(c.volumeA),
  volumeB: BigInt(c.volumeB),
  trades: c.trades,
});

/**
 * A market's candles of one length for a pair (its mints in either order), as the indexer wrote
 * them, oldest first; with `range`, only those starting in it, and with `newest`, only the newest
 * that many.
 */
export async function writtenCandles(
  db: Db,
  market: string,
  pair: readonly [string, string],
  seconds: number,
  { from, to, newest }: { from?: number; to?: number; newest?: number } = {},
): Promise<CandleRow[]> {
  const [mintA, mintB] = pairOrder(pair[0], pair[1]);
  const where = and(
    eq(candles.market, market),
    eq(candles.mintA, mintA),
    eq(candles.mintB, mintB),
    eq(candles.seconds, seconds),
    from === undefined ? undefined : sql`${candles.start} >= ${BigInt(from)}`,
    to === undefined ? undefined : sql`${candles.start} <= ${BigInt(to)}`,
  );
  if (newest === undefined) return (await db.select().from(candles).where(where).orderBy(asc(candles.start))).map(rowOf);
  const rows = await db.select().from(candles).where(where).orderBy(sql`${candles.start} desc`).limit(newest);
  return rows.reverse().map(rowOf);
}

type TradeRow = typeof trades.$inferSelect;

/** A pair's trades on a market, read once for every length a rebuild or repair writes. */
async function pairTrades(db: Db, market: string, [mintA, mintB]: readonly [string, string]): Promise<TradeRow[]> {
  return db
    .select()
    .from(trades)
    .where(
      and(
        eq(trades.market, market),
        sql`((${trades.inputMint} = ${mintA} and ${trades.outputMint} = ${mintB}) or (${trades.inputMint} = ${mintB} and ${trades.outputMint} = ${mintA}))`,
      ),
    );
}

/** Candles of one length built from a pair's trades alone, oldest first, in the shape the indexer writes them. */
function buildCandles(rows: readonly TradeRow[], market: string, [mintA, mintB]: readonly [string, string], seconds: number): CandleRow[] {
  const built = new Map<number, CandleRow>();
  const ordered = rows
    .map((t) => ({ t, key: tradeKey(t.slot, t.blockIndex, t.eventIndex) }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  for (const { t, key } of ordered) {
    const priced = pricedTrade({ inputMint: t.inputMint, outputMint: t.outputMint, netSent: BigInt(t.netSent), received: BigInt(t.received) });
    if (!priced) continue;
    const start = candleStart(tradeTime(t.blockTime, t.unixTimestamp), seconds);
    const candle = built.get(start);
    if (!candle) {
      built.set(start, {
        market,
        mintA,
        mintB,
        seconds,
        start,
        open: priced.price,
        high: priced.price,
        low: priced.price,
        close: priced.price,
        openKey: key,
        closeKey: key,
        volumeA: priced.amountA,
        volumeB: priced.amountB,
        trades: 1,
      });
      continue;
    }
    if (above(priced.price, candle.high)) candle.high = priced.price;
    if (above(candle.low, priced.price)) candle.low = priced.price;
    candle.close = priced.price;
    candle.closeKey = key;
    candle.volumeA += priced.amountA;
    candle.volumeB += priced.amountB;
    candle.trades++;
  }
  return [...built.values()].sort((x, y) => x.start - y.start);
}

/** A market's candles of one length for a pair, rebuilt from its trades alone, oldest first, in the shape the indexer writes them. */
export async function rebuildCandles(db: Db, market: string, pair: readonly [string, string], seconds: number): Promise<CandleRow[]> {
  const ordered = pairOrder(pair[0], pair[1]);
  return buildCandles(await pairTrades(db, market, ordered), market, ordered, seconds);
}

/** A market's mint pair, its mints in address order, as candles are kept. */
export type CandlePair = { market: string; mintA: string; mintB: string };

/** How many rows one insert of candles writes: 18 columns each, well inside Postgres's 65,535 parameters a query. */
const CANDLE_INSERT_ROWS = 1_000;

/**
 * Writes again, from the trades, the candles of every pair whose candles do not hold all its swaps
 * (#214): the trades a database held before migration 0003 made the table, which no fold ever
 * reached, or any candle lost since. A pair is compared at each length kept forever, where its
 * candles' trade counts must add up to its priced swaps, once the totals of every pair disagree
 * there (a pair over by as many as another is short, which no fold makes, passes); one that disagrees is rebuilt whole at every
 * length in `retention`, leaving out candles already past their length's retention, and the others
 * are not touched. Each rebuild holds the candles table's lock, so a swap folded meanwhile waits for
 * it and lands on the rebuilt candles, or was committed before it and is in them. Returns the pairs
 * it wrote again.
 */
export async function repairCandles(db: Db, retention: CandleRetention, now: number = Math.floor(Date.now() / 1000)): Promise<CandlePair[]> {
  const forever = retention.filter((r) => r.keepDays === null).map((r) => r.seconds);
  if (!forever.length) return [];
  const priced = sql`${trades.netSent} > 0 and ${trades.received} > 0 and ${trades.inputMint} <> ${trades.outputMint}`;
  // Two totals first, so a run where every swap is in its candles, as on almost every run, reads one
  // row from each table rather than one per pair.
  const [{ swaps: allSwaps }] = (await db.select({ swaps: sql<number>`count(*)::int` }).from(trades).where(priced)) as [{ swaps: number }];
  const totals = await db
    .select({ seconds: candles.seconds, n: sql<number>`coalesce(sum(${candles.trades}), 0)::int` })
    .from(candles)
    .where(inArray(candles.seconds, forever))
    .groupBy(candles.seconds);
  if (forever.every((seconds) => (totals.find((t) => t.seconds === seconds)?.n ?? 0) === allSwaps)) return [];
  // Grouped by input and output and put in pair order here, since Postgres's collation need not sort addresses as `pairOrder` does.
  const swapCounts = await db
    .select({ market: trades.market, inputMint: trades.inputMint, outputMint: trades.outputMint, n: sql<number>`count(*)::int` })
    .from(trades)
    .where(priced)
    .groupBy(trades.market, trades.inputMint, trades.outputMint);
  const keyOf = (market: string, mintA: string, mintB: string) => `${market} ${mintA} ${mintB}`;
  const pairs = new Map<string, CandlePair>();
  const swaps = new Map<string, number>();
  for (const { market, inputMint, outputMint, n } of swapCounts) {
    const [mintA, mintB] = pairOrder(inputMint, outputMint);
    const key = keyOf(market, mintA, mintB);
    pairs.set(key, { market, mintA, mintB });
    swaps.set(key, (swaps.get(key) ?? 0) + n);
  }
  const candleCounts = await db
    .select({ market: candles.market, mintA: candles.mintA, mintB: candles.mintB, seconds: candles.seconds, n: sql<number>`sum(${candles.trades})::int` })
    .from(candles)
    .where(inArray(candles.seconds, forever))
    .groupBy(candles.market, candles.mintA, candles.mintB, candles.seconds);
  const counted = new Map<string, number>();
  for (const { market, mintA, mintB, seconds, n } of candleCounts) {
    const key = keyOf(market, mintA, mintB);
    pairs.set(key, { market, mintA, mintB });
    counted.set(`${key} ${seconds}`, n);
  }
  const due = [...pairs].filter(([key]) => forever.some((seconds) => (counted.get(`${key} ${seconds}`) ?? 0) !== (swaps.get(key) ?? 0))).map(([, pair]) => pair);
  for (const pair of due) await writeRebuilt(db, pair, retention, now);
  return due.sort((x, y) => keyOf(x.market, x.mintA, x.mintB).localeCompare(keyOf(y.market, y.mintA, y.mintB)));
}

/** Replaces a pair's candles at every length in `retention` with those rebuilt from its trades, in one transaction under the table's lock. */
async function writeRebuilt(db: Db, { market, mintA, mintB }: CandlePair, retention: CandleRetention, now: number): Promise<void> {
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // Taken before the trades are read: a fold's insert waits for this transaction, and a fold already running holds it off until it commits.
    await t.execute(sql`lock table ${candles} in share row exclusive mode`);
    const rows = await pairTrades(t, market, [mintA, mintB]);
    await t.delete(candles).where(and(eq(candles.market, market), eq(candles.mintA, mintA), eq(candles.mintB, mintB)));
    const written = retention.flatMap(({ seconds, keepDays }) =>
      buildCandles(rows, market, [mintA, mintB], seconds).filter((c) => keepDays === null || c.start >= now - keepDays * 86_400),
    );
    for (let i = 0; i < written.length; i += CANDLE_INSERT_ROWS) await t.insert(candles).values(written.slice(i, i + CANDLE_INSERT_ROWS).map(storedOf));
  });
}

const storedOf = (c: CandleRow): Stored => ({
  market: c.market,
  mintA: c.mintA,
  mintB: c.mintB,
  seconds: c.seconds,
  start: BigInt(c.start),
  openA: String(c.open.a),
  openB: String(c.open.b),
  highA: String(c.high.a),
  highB: String(c.high.b),
  lowA: String(c.low.a),
  lowB: String(c.low.b),
  closeA: String(c.close.a),
  closeB: String(c.close.b),
  openKey: c.openKey,
  closeKey: c.closeKey,
  volumeA: String(c.volumeA),
  volumeB: String(c.volumeB),
  trades: c.trades,
});

/** Deletes candles past their length's retention (PIPESCOPE-30); they can always be rebuilt from the trades. Returns how many went. */
export async function pruneCandles(db: Db, retention: CandleRetention, now: number = Math.floor(Date.now() / 1000)): Promise<number> {
  let deleted = 0;
  for (const { seconds, keepDays } of retention) {
    if (keepDays === null) continue;
    const gone = await db.delete(candles).where(and(eq(candles.seconds, seconds), sql`${candles.start} < ${BigInt(now - keepDays * 86_400)}`)).returning({ start: candles.start });
    deleted += gone.length;
  }
  return deleted;
}
