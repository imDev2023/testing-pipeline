// What the pages do with live events and a resync through the API (docs/spec/pipescope-architecture.md,
// Live rooms): every trade shown once, newest first, whatever order and however often it arrives,
// and a candle replaced by its newer self. The API says which mint a pair is quoted in; this reads a
// trade for the pair a page shows, turned round when the reader flips it.
import type { Candle, Market, Trade } from "terminal-api/contract";

/** A trade's identity: its transaction and its place among the transaction's events. */
const idOf = (t: Trade) => `${t.signature}:${t.event_index}`;

/** Newer trades first: by slot, then place in the block (unknown first, as the API pages them), then event index. */
const newerFirst = (a: Trade, b: Trade) => b.slot - a.slot || (b.block_index ?? -1) - (a.block_index ?? -1) || b.event_index - a.event_index;

/** The trades shown and those arriving, each once, newest first. */
export function mergeTrades(shown: readonly Trade[], arriving: readonly Trade[]): Trade[] {
  const byId = new Map<string, Trade>();
  for (const t of [...shown, ...arriving]) byId.set(idOf(t), t);
  return [...byId.values()].sort(newerFirst);
}

/**
 * Trades arriving, from a room, a resync or the fast path, sorted against those shown: `fresh` ones
 * not shown yet, which join the top, and `updates`, the indexer's copy of a trade shown under the fast
 * path's provisional order key (no place in its block yet), which replaces it in place.
 */
export function sortArrivals(shown: readonly Trade[], arriving: readonly Trade[]): { fresh: Trade[]; updates: Trade[] } {
  const byId = new Map(shown.map((t) => [idOf(t), t]));
  const fresh: Trade[] = [];
  const updates: Trade[] = [];
  for (const t of arriving) {
    const current = byId.get(idOf(t));
    if (!current) fresh.push(t);
    else if (current.block_index === null && t.block_index !== null) updates.push(t);
  }
  return { fresh, updates };
}

/** The API's `after` cursor for the newest trade shown, from which a reconnecting page resyncs; null with none. */
export function afterCursor(shown: readonly Trade[]): string | null {
  const newest = [...shown].sort(newerFirst)[0];
  return newest ? `${newest.slot}_${newest.block_index ?? -1}_${newest.event_index}` : null;
}

/** The candles shown and those arriving, by start, the arriving one winning, oldest first. */
export function mergeCandles(shown: readonly Candle[], arriving: readonly Candle[]): Candle[] {
  const byStart = new Map<string, Candle>();
  for (const c of [...shown, ...arriving]) byStart.set(c.start, c);
  return [...byStart.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** A trade as the Trades table shows it, for the pair on show. */
export type ReadTrade = {
  /** A buy when the trader paid in the quote mint, a sell when they received it (docs/spec/pipescope-screens.md, Price direction). */
  side: "Buy" | "Sell";
  paid: { mint: string; amount: number | null };
  received: { mint: string; amount: number | null };
  /** The quote mint for one of the base mint, or null when a mint's decimals are not read. */
  price: number | null;
  /**
   * The pair the side and price are read for: the pair on show (`onShow`), flipped or not, when the
   * trade is between its two mints; else, on a market of three or four mints, the trade's own pair,
   * as the API gives it, so a trade is never priced in mints the pair on show does not hold.
   */
  pricedIn: { base: string; quote: string; onShow: boolean };
};

/** A trade read for the pair on show (the API's, or flipped), or by its own pair when it is between two other mints: its side, what it paid and received in tokens, and its price. */
export function readTrade(trade: Trade, pair: { base: string; quote: string }, decimals: Readonly<Record<string, number | null>>): ReadTrade {
  const tokens = (raw: string, mint: string) => {
    const d = decimals[mint];
    return d === null || d === undefined ? null : Number(raw) / 10 ** d;
  };
  const paid = { mint: trade.input_mint, amount: tokens(trade.net_sent, trade.input_mint) };
  const received = { mint: trade.output_mint, amount: tokens(trade.received, trade.output_mint) };
  const onShow = [trade.input_mint, trade.output_mint].every((m) => m === pair.base || m === pair.quote);
  const pricedIn = onShow ? { ...pair, onShow } : { base: trade.base_mint, quote: trade.quote_mint, onShow };
  const side = trade.input_mint === pricedIn.quote ? "Buy" : "Sell";
  const [quote, base] = side === "Buy" ? [paid.amount, received.amount] : [received.amount, paid.amount];
  return { side, paid, received, price: quote === null || base === null || base === 0 ? null : quote / base, pricedIn };
}

/** Newest first, as the feed lists markets: by when they were created, then by address. */
const newestMarketFirst = (a: Market, b: Market) => b.created_at.localeCompare(a.created_at) || b.address.localeCompare(a.address);

/**
 * Markets from the feed's room or a resync, put in place: one already shown is updated where it is,
 * one newer than every market shown is new and returned in `added`, newest first, for the top, and
 * any other (an older market not loaded yet, which a swap touched) is left for its own page to load.
 */
export function placeMarkets(shown: readonly Market[], arriving: readonly Market[]): { markets: Market[]; added: Market[] } {
  const byAddress = new Map(arriving.map((m) => [m.address, m]));
  const known = new Set(shown.map((m) => m.address));
  const newest = shown[0];
  const added = arriving.filter((m) => !known.has(m.address) && (!newest || newestMarketFirst(m, newest) < 0)).sort(newestMarketFirst);
  return { markets: shown.map((m) => byAddress.get(m.address) ?? m), added: [...new Map(added.map((m) => [m.address, m])).values()] };
}
