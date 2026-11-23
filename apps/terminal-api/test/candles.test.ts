// A market's candles (docs/spec/pipescope-architecture.md, Candles): for the pair the caller names
// by `base` and `quote`, or the market's own pair by the quote mint order (PIPESCOPE-74), each price
// an amount of the quote mint for one of the base mint, after both mints' decimals; and the trades
// newer than a cursor, which a reconnecting page resyncs from (Live rooms).
import { readFileSync } from "node:fs";
import { createDb, mints } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { indexTransactions, pipelineHandler, type RawTransaction } from "terminal-indexer";
import { SWAP_MARKET, SWAP_TOKEN, swapTransaction, WSOL } from "terminal-indexer/swaps";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CANDLES } from "../src/config";
import { Candles, TradesPage, type ApiError } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const created = JSON.parse(readFileSync(`${import.meta.dirname}/../../../packages/terminal-indexer/test/fixtures/marketCreated.json`, "utf8")) as RawTransaction;
const T0 = 1_795_366_800;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let env: ReturnType<typeof bindings>;
beforeAll(async () => {
  database = await createTestDatabase();
  env = bindings({ databaseUrl: database.url, rpcUrl: "http://127.0.0.1:9/never-called" });
  const { db, close } = createDb(database.url);
  try {
    const handler = pipelineHandler({ candleSeconds: CANDLES.map((c) => c.seconds) });
    await indexTransactions(db, handler, [
      created,
      // Two buys and a sell in the first minute, one buy in the third: the token has 6 decimals, SOL 9.
      swapTransaction({ id: 1, slot: 100, blockIndex: 0, at: T0 + 1, input: WSOL, output: SWAP_TOKEN, netSent: 1_000_000_000n, received: 25_000_000_000n }),
      swapTransaction({ id: 2, slot: 101, blockIndex: 0, at: T0 + 2, input: WSOL, output: SWAP_TOKEN, netSent: 1_000_000_000n, received: 20_000_000_000n }),
      swapTransaction({ id: 3, slot: 102, blockIndex: 0, at: T0 + 3, input: SWAP_TOKEN, output: WSOL, netSent: 40_000_000_000n, received: 1_000_000_000n }),
      swapTransaction({ id: 4, slot: 103, blockIndex: 0, at: T0 + 125, input: WSOL, output: SWAP_TOKEN, netSent: 3_000_000_000n, received: 100_000_000_000n }),
    ]);
    await db.insert(mints).values([
      { address: SWAP_TOKEN, readable: true, decimals: 6 },
      { address: WSOL, readable: true, decimals: 9 },
    ]);
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

describe("GET /v1/markets/{market}/candles", () => {
  it("answers the market's own pair, SOL for one token, from the oldest candle to the newest", async () => {
    const { status, body } = await get(`/v1/markets/${SWAP_MARKET}/candles?interval=1m`);
    expect(status).toBe(200);
    const answer = Candles.parse(body);
    expect(answer).toMatchObject({ market: SWAP_MARKET, interval: "1m", seconds: 60, base_mint: SWAP_TOKEN, quote_mint: WSOL, trade_count: 4 });
    expect(answer.candles).toEqual([
      {
        start: new Date(T0 * 1000).toISOString(),
        // 1 SOL for 25,000 tokens, then for 20,000, then 1 SOL back for 40,000.
        open: "0.00004",
        high: "0.00005",
        low: "0.000025",
        close: "0.000025",
        volume_base: "85000000000",
        volume_quote: "3000000000",
        trades: 3,
      },
      { start: new Date((T0 + 120) * 1000).toISOString(), open: "0.00003", high: "0.00003", low: "0.00003", close: "0.00003", volume_base: "100000000000", volume_quote: "3000000000", trades: 1 },
    ]);
  });

  it("turns the pair round for the base and quote asked for, so the high is the other way's low", async () => {
    const answer = Candles.parse((await get(`/v1/markets/${SWAP_MARKET}/candles?interval=1m&base=${WSOL}&quote=${SWAP_TOKEN}`)).body);
    expect(answer).toMatchObject({ base_mint: WSOL, quote_mint: SWAP_TOKEN });
    expect(answer.candles[0]).toMatchObject({ open: "25000", high: "40000", low: "20000", close: "40000", volume_base: "3000000000", volume_quote: "85000000000" });
  });

  it("writes a price that never ends to the API's significant digits, exactly rounded", async () => {
    const answer = Candles.parse((await get(`/v1/markets/${SWAP_MARKET}/candles?interval=1m&base=${WSOL}&quote=${SWAP_TOKEN}`)).body);
    expect(answer.candles[1]!.open).toBe("33333.3333333333333333333333333333333");
  });

  it("serves the newest candles up to a limit, and those from a start on", async () => {
    expect(Candles.parse((await get(`/v1/markets/${SWAP_MARKET}/candles?interval=1m&limit=1`)).body).candles.map((c) => c.trades)).toEqual([1]);
    expect(Candles.parse((await get(`/v1/markets/${SWAP_MARKET}/candles?interval=1m&from=${T0 + 60}`)).body).candles.map((c) => c.trades)).toEqual([1]);
    expect(Candles.parse((await get(`/v1/markets/${SWAP_MARKET}/candles?interval=1h`)).body).candles.map((c) => c.trades)).toEqual([4]);
  });

  it("refuses an interval it does not keep, naming those it does", async () => {
    for (const path of [`/v1/markets/${SWAP_MARKET}/candles`, `/v1/markets/${SWAP_MARKET}/candles?interval=2m`]) {
      const { status, body } = await get(path);
      expect(status).toBe(400);
      expect((body as ApiError).error).toBe("interval is one of 1s, 15s, 1m, 5m, 15m, 1h, 4h, 1d.");
    }
  });

  it("refuses a base or quote that is not one of the market's mints, or the same mint twice", async () => {
    for (const query of [`base=${SWAP_TOKEN}&quote=${SWAP_TOKEN}`, `base=${SWAP_TOKEN}&quote=9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt`, `base=${SWAP_TOKEN}`]) {
      const { status, body } = await get(`/v1/markets/${SWAP_MARKET}/candles?interval=1m&${query}`);
      expect(status).toBe(400);
      expect((body as ApiError).error).toBe("base and quote are two different mints of this market, given together.");
    }
  });

  it("answers a 404 for a market that is none", async () => {
    expect((await get(`/v1/markets/9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt/candles?interval=1m`)).status).toBe(404);
  });
});

describe("trades after a cursor", () => {
  it("answers only the trades newer than the one a page saw last, newest first", async () => {
    const all = TradesPage.parse((await get(`/v1/markets/${SWAP_MARKET}/trades`)).body).trades;
    const second = all[2]!;
    const after = `${second.slot}_${second.block_index ?? -1}_${second.event_index}`;
    const newer = TradesPage.parse((await get(`/v1/markets/${SWAP_MARKET}/trades?after=${after}`)).body);
    expect(newer).toEqual({ trades: all.slice(0, 2), next: null });
  });

  it("says there is more between when the newer trades fill the page", async () => {
    const all = TradesPage.parse((await get(`/v1/markets/${SWAP_MARKET}/trades`)).body).trades;
    const oldest = all.at(-1)!;
    const newer = TradesPage.parse((await get(`/v1/markets/${SWAP_MARKET}/trades?limit=2&after=${oldest.slot}_${oldest.block_index ?? -1}_${oldest.event_index}`)).body);
    expect(newer.trades).toEqual(all.slice(0, 2));
    expect(newer.next).not.toBeNull();
  });
});
