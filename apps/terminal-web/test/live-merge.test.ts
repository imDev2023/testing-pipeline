// What the market page and the feed do with live events and a resync through the API
// (docs/spec/pipescope-architecture.md, Live rooms): every trade shown once, newest first, whatever
// order and however often it arrives; a candle replaced by its newer self; a trade read as a buy or a
// sell of the base mint on show, at its price in the quote mint.
import type { Candle, Market, Trade } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { afterCursor, mergeCandles, mergeTrades, placeMarkets, readTrade, sortArrivals } from "../src/liveMerge";

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

  it("names the pair a trade's price is in: the pair on show, flipped or not", () => {
    expect(readTrade(trade(1, 0), { base: TOKEN, quote: SOL }, decimals).pricedIn).toEqual({ base: TOKEN, quote: SOL, onShow: true });
    expect(readTrade(trade(1, 0), { base: SOL, quote: TOKEN }, decimals).pricedIn).toEqual({ base: SOL, quote: TOKEN, onShow: true });
  });

  describe("on a market of three mints (#122)", () => {
    // Counterflow's order: QUOTE, X, BEAR; the pair on show is X for QUOTE.
    const QUOTE = "JDjofR4qaaKLxhHc8YvfEQvJK7vryJC2kKjiLnZZ9GQi";
    const X = "DHV6HBt5uahFGYE1D2kWDX7bt2n5aeWvqoYmnagtavHj";
    const BEAR = "8JJThUNA5iPcAuZtLQP4PywLf5QR8eFZhAC6bwdtvG1L";
    const three = { [QUOTE]: 6, [X]: 9, [BEAR]: 9 };
    const onShow = { base: X, quote: QUOTE };

    it("reads a trade between two mints other than the pair on show by its own pair, as the API gives it, not as a sell", () => {
      // X sold for BEAR: by the quote mint order BEAR, later in the market's order, is that trade's quote, so it sold X.
      const read = readTrade(trade(1, 0, 0, { input_mint: X, output_mint: BEAR, net_sent: "2000000000", received: "500000000", quote_mint: BEAR, base_mint: X, side: "sell" }), onShow, three);
      expect(read.side).toBe("Sell");
      expect(read.price).toBeCloseTo(0.5 / 2, 12);
      expect(read.pricedIn).toEqual({ base: X, quote: BEAR, onShow: false });

      const bought = readTrade(trade(1, 0, 0, { input_mint: BEAR, output_mint: QUOTE, net_sent: "1000000000", received: "3000000", quote_mint: QUOTE, base_mint: BEAR, side: "sell" }), onShow, three);
      expect(bought.side).toBe("Sell");
      expect(bought.pricedIn).toEqual({ base: BEAR, quote: QUOTE, onShow: false });
      expect(bought.price).toBeCloseTo(3 / 1, 12);
    });

    it("reads a buy of BEAR paid in QUOTE as a buy, priced in QUOTE for one BEAR, never in the pair on show's mints", () => {
      const read = readTrade(trade(1, 0, 0, { input_mint: QUOTE, output_mint: BEAR, net_sent: "3000000", received: "1000000000", quote_mint: QUOTE, base_mint: BEAR, side: "buy" }), onShow, three);
      expect(read.side).toBe("Buy");
      expect(read.pricedIn).toEqual({ base: BEAR, quote: QUOTE, onShow: false });
      expect(read.price).toBeCloseTo(3, 12);
    });

    it("still reads a trade of the pair on show by the pair on show, flipped too", () => {
      const sold = trade(1, 0, 0, { input_mint: X, output_mint: QUOTE, net_sent: "1000000000", received: "2000000", quote_mint: QUOTE, base_mint: X, side: "sell" });
      expect(readTrade(sold, onShow, three)).toMatchObject({ side: "Sell", pricedIn: { base: X, quote: QUOTE, onShow: true } });
      expect(readTrade(sold, { base: QUOTE, quote: X }, three)).toMatchObject({ side: "Buy", pricedIn: { base: QUOTE, quote: X, onShow: true } });
    });
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

describe("placing markets on the feed", () => {
  const market = (address: string, created_at: string, trades = 0) => ({ address, created_at, stats_24h: { trades } }) as unknown as Market;
  const shown = [market("B", "2026-11-23T12:00:00.000Z"), market("A", "2026-11-22T12:00:00.000Z")];

  it("updates a market shown in place and adds a newer one at the top", () => {
    const { markets, added } = placeMarkets(shown, [market("A", "2026-11-22T12:00:00.000Z", 5), market("C", "2026-11-23T13:00:00.000Z")]);
    expect(added.map((m) => m.address)).toEqual(["C"]);
    expect(markets.map((m) => [m.address, m.stats_24h.trades])).toEqual([
      ["B", 0],
      ["A", 5],
    ]);
  });

  it("leaves out an older market not loaded yet, which a swap touched, so it never jumps to the top", () => {
    const { markets, added } = placeMarkets(shown, [market("Z", "2026-11-20T12:00:00.000Z", 1)]);
    expect(added).toEqual([]);
    expect(markets).toEqual(shown);
  });
});

describe("trades arriving on a page (the fast path's provisional rows, PIPESCOPE-118)", () => {
  it("are new when not shown, and updates in place when they replace a provisional row of the same trade", () => {
    const provisional = trade(20, null);
    const shown = [provisional, trade(19, 3)];
    const indexed = { ...provisional, block_index: 7 };
    const { fresh, updates } = sortArrivals(shown, [indexed, trade(21, 0), trade(19, 3)]);
    expect(fresh.map((t) => t.signature)).toEqual(["sig-21-0-0"]);
    expect(updates).toEqual([indexed]);
    expect(mergeTrades(shown, updates).find((t) => t.signature === provisional.signature)?.block_index).toBe(7);
  });

  it("never let a provisional copy replace a row the indexer has already placed", () => {
    const placed = trade(20, 7);
    const { fresh, updates } = sortArrivals([placed], [{ ...placed, block_index: null }]);
    expect(fresh).toEqual([]);
    expect(updates).toEqual([]);
  });
});
