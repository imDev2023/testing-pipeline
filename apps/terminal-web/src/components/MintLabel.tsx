import type { MarketMint } from "terminal-api/contract";
import { ShortAddress } from "./ShortAddress";

/**
 * A mint as Aviary names it: by its own name for SOL and USDC, which the API gives, set plainly;
 * every other mint by its short address until token names land (#120), whose author's names are
 * then set in the author's style.
 */
export function MintLabel({ mint, symbol }: Pick<MarketMint, "mint" | "symbol">) {
  return symbol ? <span title={mint}>{symbol}</span> : <ShortAddress address={mint} />;
}
