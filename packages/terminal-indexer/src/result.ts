import type { IndexResult } from "./handler";

/** A result with nothing in it yet. */
export const emptyResult = (): IndexResult => ({ counts: {}, markets: [], trades: [], strategies: [] });

/** Adds one result into another, and returns it. */
export function addResult(into: IndexResult, from: IndexResult): IndexResult {
  for (const [kind, n] of Object.entries(from.counts)) into.counts[kind] = (into.counts[kind] ?? 0) + n;
  into.markets = [...new Set([...into.markets, ...from.markets])];
  into.trades = [...into.trades, ...from.trades];
  into.strategies = [...new Set([...into.strategies, ...from.strategies])];
  return into;
}
