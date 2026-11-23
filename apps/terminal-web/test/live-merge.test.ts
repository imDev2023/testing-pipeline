// What the market page and the feed do with live events and a resync through the API
// (docs/spec/pipescope-architecture.md, Live rooms): every trade shown once, newest first, whatever
// order and however often it arrives; a candle replaced by its newer self; a trade read as a buy or a
// sell of the base mint on show, at its price in the quote mint.
import type { Candle, Trade } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { afterCursor, mergeCandles, mergeTrades, readTrade } from "../src/liveMerge";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN = "4gqiCkoxxD72nbXGc7XtxQx4UjBHD3KiJyXpMvEZ6u8c";

const trade = (slot: number, blockIndex: number | null, eventIndex = 0, over: Partial<Trade> = {}): Trade => ({
  signature: `sig-${slot}-${blockIndex}-${eventIndex}`,
  event_index: eventIndex,
  slot,
  block_index: blockIndex,
  block_time: "2026-11-23T12:12:38.000Z",
  market: "C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w",
  trader: "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt",
  input_mint: SOL,
  output_mint: TOKEN,
  mode: "exact_in",
  net_sent: "1000000",
  received: "241072692",
  pipeline_fee: "2500",
  fee_mint: SOL,
  integrator: null,
  integrator_fee: "0",
  quote_mint: SOL,
  base_mint: TOKEN,
  side: "buy",
  ...over,
});

describe("merging trades", () => {
  it("keeps every trade once, newest first by slot, place in the block and event index", () => {
    const shown = [trade(10, 2), trade(10, 1), trade(9, 0)];
    const merged = mergeTrades(shown, [trade(11, 0), trade(10, 2), trade(10, 1, 1), trade(9, 0)]);
    expect(merged.map((t) => t.signature)).toEqual(["sig-11-0-0", "sig-10-2-0", "sig-10-1-1", "sig-10-1-0", "sig-9-0-0"]);
  });

  it("names the newest trade shown as the cursor a resync asks after", () => {
    expect(afterCursor([trade(12, null, 3), trade(9, 0)])).toBe("12_-1_3");
    expect(afterCursor([])).toBeNull();
  });
});

describe("reading a trade for the pair on show", () => {
  const decimals = { [SOL]: 9, [TOKEN]: 6 };

  it("calls paying in the quote mint a buy, and prices it in the quote mint for one base", () => {
    const read = readTrade(trade(1, 0), { base: TOKEN, quote: SOL }, decimals);
    expect(read.side).toBe("Buy");
    expect(read.price).toBeCloseTo(0.001 / 241.072692, 15);
    expect(read.paid).toEqual({ mint: SOL, amount: 0.001 });
    expect(read.received).toEqual({ mint: TOKEN, amount: 241.072692 });
  });

  it("turns round with Flip: the same trade sells the other base, at the inverse price", () => {
    const read = readTrade(trade(1, 0), { base: SOL, quote: TOKEN }, decimals);
    expect(read.side).toBe("Sell");
    expect(read.price).toBeCloseTo(241.072692 / 0.001, 6);
  });

  it("has no price when a mint's decimals are unknown", () => {
    expect(readTrade(trade(1, 0), { base: TOKEN, quote: SOL }, { [SOL]: 9, [TOKEN]: null }).price).toBeNull();
  });
});

describe("merging candles", () => {
  const candle = (start: string, close: string, trades = 1): Candle => ({ start, open: "1", high: close, low: "1", close, volume_base: "1", volume_quote: "1", trades });

  it("replaces the forming candle with its newer self and adds the next, oldest first", () => {
    const shown = [candle("2026-11-23T12:00:00.000Z", "1"), candle("2026-11-23T12:15:00.000Z", "2")];
    const merged = mergeCandles(shown, [candle("2026-11-23T12:15:00.000Z", "3", 2), candle("2026-11-23T12:30:00.000Z", "4")]);
    expect(merged.map((c) => [c.start.slice(11, 16), c.close, c.trades])).toEqual([
      ["12:00", "1", 1],
      ["12:15", "3", 2],
      ["12:30", "4", 1],
    ]);
  });
});
