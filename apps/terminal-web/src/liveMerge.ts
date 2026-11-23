// What the pages do with live events and a resync through the API (docs/spec/pipescope-architecture.md,
// Live rooms): every trade shown once, newest first, whatever order and however often it arrives,
// and a candle replaced by its newer self. The API says which mint a pair is quoted in; this reads a
// trade for the pair a page shows, turned round when the reader flips it.
import type { Candle, Trade } from "terminal-api/contract";

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
};

/** A trade read for the pair on show (the API's, or flipped): its side, what it paid and received in tokens, and its price. */
export function readTrade(trade: Trade, pair: { base: string; quote: string }, decimals: Readonly<Record<string, number | null>>): ReadTrade {
  const tokens = (raw: string, mint: string) => {
    const d = decimals[mint];
    return d === null || d === undefined ? null : Number(raw) / 10 ** d;
  };
  const paid = { mint: trade.input_mint, amount: tokens(trade.net_sent, trade.input_mint) };
  const received = { mint: trade.output_mint, amount: tokens(trade.received, trade.output_mint) };
  const side = trade.input_mint === pair.quote ? "Buy" : "Sell";
  const [quote, base] = side === "Buy" ? [paid.amount, received.amount] : [received.amount, paid.amount];
  return { side, paid, received, price: quote === null || base === null || base === 0 ? null : quote / base };
}
