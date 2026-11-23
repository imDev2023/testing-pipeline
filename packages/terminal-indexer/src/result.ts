import type { IndexResult } from "./handler";

/** Adds one result into another, and returns it. */
export function addResult(into: IndexResult, from: IndexResult): IndexResult {
  for (const [kind, n] of Object.entries(from.counts)) into.counts[kind] = (into.counts[kind] ?? 0) + n;
  into.markets = [...new Set([...into.markets, ...from.markets])];
  return into;
}
