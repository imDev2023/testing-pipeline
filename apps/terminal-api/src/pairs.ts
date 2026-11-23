// Price direction (PIPESCOPE-74, docs/spec/pipescope-screens.md, "Price direction"): which mint a
// price is quoted in, worked out here once and returned with every market and trade, so the pages
// and the Telegram bot never work it out themselves and cannot disagree.
import { QUOTE_MINT_ORDER } from "./config";

/** The quote mint among `candidates`: the first of the quote mint order present, else the one latest in the market's own order. */
function quoteAmong(candidates: readonly string[], marketOrder: readonly string[]): string {
  const preferred = QUOTE_MINT_ORDER.find((mint) => candidates.includes(mint));
  if (preferred) return preferred;
  return [...candidates].sort((a, b) => marketOrder.indexOf(a) - marketOrder.indexOf(b)).at(-1)!;
}

/** A market's default pair: its quote mint by the rule over all its mints, and its first other mint as the base. */
export function marketPair(mints: readonly string[]): { quote: string; base: string } {
  const quote = quoteAmong(mints, mints);
  return { quote, base: mints.find((mint) => mint !== quote)! };
}

/**
 * A trade's pair, by the rule over its two mints, and its side: a buy of the base when the trader
 * paid in the quote mint, a sell when they received it.
 */
export function tradePair(marketMints: readonly string[], input: string, output: string): { quote: string; base: string; side: "buy" | "sell" } {
  const quote = quoteAmong([input, output], marketMints);
  return quote === input ? { quote, base: output, side: "buy" } : { quote, base: input, side: "sell" };
}
