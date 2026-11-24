// Trades that arrive while the reader's pointer or focus is on the market page's Trades table wait
// behind a "Show new trades" button and join the list when the reader leaves it, so no row moves
// under them (PIPESCOPE-111). That holds for a resync that brings more than a page of trades too,
// which would replace the list: it waits as well, and replaces the list only on leaving (#214).
import type { Trade } from "terminal-api/contract";
import { mergeTrades } from "./liveMerge";

/** The trades listed, newest first, and the API's cursor to earlier ones. */
export type TradesShown = { list: Trade[]; next: string | null };

/**
 * The trades waiting, newest first; with `replaces`, they are the newest page of a resync that found
 * more than a page, which takes the list's place with its own cursor to earlier trades.
 */
export type Held = { trades: Trade[]; replaces: { next: string | null } | null };

/** New trades from the room, a resync or the fast path, added to those waiting. */
export function holdArrivals(held: Held, arriving: readonly Trade[]): Held {
  return { ...held, trades: mergeTrades(held.trades, arriving) };
}

/**
 * A resync through the API that returned a full page, so more landed than it holds: the page
 * replaces the list, at once when the reader is not on the table, else once they leave it. The page
 * is the newest trades, past every one listed or waiting, so it takes their place.
 */
export function takeResyncPage(shown: TradesShown, held: Held, page: { trades: Trade[]; next: string | null }, holding: boolean): { shown: TradesShown; held: Held } {
  if (!holding) return { shown: { list: page.trades, next: page.next }, held: { trades: [], replaces: null } };
  return { shown, held: { trades: mergeTrades([], page.trades), replaces: { next: page.next } } };
}

/** The list once the reader leaves the table: the trades waiting at its top, or in its place when they replace it. */
export function releaseHeld(shown: TradesShown, held: Held): TradesShown {
  if (held.replaces) return { list: held.trades, next: held.replaces.next };
  return held.trades.length ? { ...shown, list: mergeTrades(shown.list, held.trades) } : shown;
}

/** How many trades wait, for the button's label, and whether more landed than wait (a replacing page). */
export function heldCount(held: Held): { trades: number; more: boolean } {
  return { trades: held.trades.length, more: held.replaces !== null };
}
