// Candles (docs/spec/pipescope-architecture.md, Candles; PIPESCOPE-30): each swap is folded into
// its candle at every length as it is indexed, per market and mint pair, by trade order rather than
// arrival, and a rebuild from the trades alone comes out the same.
import { sql } from "drizzle-orm";
import { createDb, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexTransactions, pipelineHandler, pruneCandles, rebuildCandles, reindexTransactions, writtenCandles, type CandleRow } from "../src/index";
import { SWAP_MARKET, SWAP_TOKEN, swapTransaction, WSOL, type SwapSpec } from "./swaps";

const SECONDS = [1, 60, 900];
const handler = pipelineHandler({ candleSeconds: SECONDS });
const PAIR = [SWAP_TOKEN, WSOL] as const;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
beforeEach(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
});
afterEach(async () => {
  await client?.close();
  await database?.drop();
});

const T0 = 1_795_366_800; // a whole hour, so 15-minute candles start on it

/** A buy of the token with `sol` lamports for `token` base units, or a sell of `token` for `sol`. */
const buy = (id: number, slot: number, at: number, sol: bigint, token: bigint, blockIndex = 0): SwapSpec => ({ id, slot, blockIndex, at, input: WSOL, output: SWAP_TOKEN, netSent: sol, received: token });
const sell = (id: number, slot: number, at: number, token: bigint, sol: bigint, blockIndex = 0): SwapSpec => ({ id, slot, blockIndex, at, input: SWAP_TOKEN, output: WSOL, netSent: token, received: sol });

describe("folding a swap", () => {
  it("writes its candle at every length, priced in the pair's own amounts as a reduced fraction", async () => {
    await indexTransactions(client.db, handler, [swapTransaction(buy(1, 100, T0 + 61, 1_000_000_000n, 25_000_000_000_000n))]);
    for (const seconds of SECONDS) {
      const [candle, ...rest] = await writtenCandles(client.db, SWAP_MARKET, PAIR, seconds);
      expect(rest).toEqual([]);
      // The pair's mints in address order: the token (5iEQ...) before wrapped SOL (So11...); the price is token per SOL.
      expect(candle).toMatchObject({ mintA: SWAP_TOKEN, mintB: WSOL, seconds, start: Math.floor((T0 + 61) / seconds) * seconds, trades: 1 });
      for (const price of [candle!.open, candle!.high, candle!.low, candle!.close]) expect(price).toEqual({ a: 25_000n, b: 1n });
      expect(candle).toMatchObject({ volumeA: 25_000_000_000_000n, volumeB: 1_000_000_000n });
    }
  });

  it("keeps the open and close by trade order, whatever order the swaps arrive in", async () => {
    // Three swaps in one minute, delivered newest first: slot, then place in the block, decide.
    const swaps = [sell(3, 101, T0 + 10, 30n, 2n, 5), buy(2, 101, T0 + 10, 1n, 20n, 2), buy(1, 100, T0 + 5, 1n, 10n)];
    for (const spec of swaps) await indexTransactions(client.db, handler, [swapTransaction(spec)]);
    const [candle] = await writtenCandles(client.db, SWAP_MARKET, PAIR, 60);
    expect(candle).toMatchObject({ open: { a: 10n, b: 1n }, close: { a: 15n, b: 1n }, high: { a: 20n, b: 1n }, low: { a: 10n, b: 1n }, trades: 3, volumeA: 60n, volumeB: 4n });
  });

  it("is never counted twice, when a transaction arrives again or is indexed again", async () => {
    const raw = swapTransaction(buy(1, 100, T0, 3n, 9n));
    await indexTransactions(client.db, handler, [raw, raw]);
    await reindexTransactions(client.db, handler, [raw]);
    const [candle] = await writtenCandles(client.db, SWAP_MARKET, PAIR, 60);
    expect(candle).toMatchObject({ trades: 1, volumeA: 9n, volumeB: 3n });
  });
});

describe("a rebuild from trades", () => {
  it("equals the candles folded live, for every length, pair and market, after swaps arrive in any order", async () => {
    // A seeded walk of swaps over three hours on two markets, some sharing a slot, some at equal prices.
    let seed = 7;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31);
    const other = "9DmcDLMpFTuG7b9GUuXXdPxq9VdrXgxuGjYfbhKXBUQB";
    const specs: SwapSpec[] = [];
    for (let id = 1; id <= 120; id++) {
      const slot = 1_000 + Math.floor(id / 3);
      const at = T0 + slot * 90 - 90_000;
      const amount = BigInt(1 + (next() % 1_000));
      const price = BigInt(1 + (next() % 5));
      const market = next() % 4 === 0 ? other : SWAP_MARKET;
      specs.push(next() % 2 ? { ...buy(id, slot, at, amount, amount * price, id % 3), market } : { ...sell(id, slot, at, amount * price, amount, id % 3), market });
    }
    const shuffled = [...specs].sort(() => (next() % 2 ? 1 : -1));
    for (const spec of shuffled) await indexTransactions(client.db, handler, [swapTransaction(spec)]);

    for (const market of [SWAP_MARKET, other]) {
      for (const seconds of SECONDS) {
        const written = await writtenCandles(client.db, market, PAIR, seconds);
        expect(written.length).toBeGreaterThan(0);
        expect(await rebuildCandles(client.db, market, PAIR, seconds)).toEqual(written);
      }
    }
  });

  it("skips a swap with nothing sent or nothing received, which has no price, as the fold does", async () => {
    await indexTransactions(client.db, handler, [swapTransaction(buy(1, 100, T0, 0n, 5n)), swapTransaction(buy(2, 101, T0, 5n, 10n))]);
    const written = await writtenCandles(client.db, SWAP_MARKET, PAIR, 60);
    expect(written.map((c) => c.trades)).toEqual([1]);
    expect(await rebuildCandles(client.db, SWAP_MARKET, PAIR, 60)).toEqual(written);
  });
});

describe("retention", () => {
  it("drops candles past their length's retention and keeps the rest", async () => {
    const now = Math.floor(Date.now() / 1000);
    await indexTransactions(client.db, handler, [swapTransaction(buy(1, 100, now - 8 * 86_400, 1n, 2n)), swapTransaction(buy(2, 101, now - 3_600, 1n, 2n))]);
    const deleted = await pruneCandles(client.db, [{ seconds: 1, keepDays: 7 }, { seconds: 60, keepDays: null }]);
    expect(deleted).toBe(1);
    const left = (rows: CandleRow[]) => rows.map((c) => c.trades).length;
    expect(left(await writtenCandles(client.db, SWAP_MARKET, PAIR, 1))).toBe(1);
    expect(left(await writtenCandles(client.db, SWAP_MARKET, PAIR, 60))).toBe(2);
    expect((await client.db.execute(sql`select count(*)::int as n from candles`))[0]).toEqual({ n: 2 + 1 + 2 });
  });
});
