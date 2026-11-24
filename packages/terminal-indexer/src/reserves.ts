// A strategy's own reserves, where its vaults hold more than its liquidity (PIPESCOPE-166). Pipeline's
// router names each market's vaults, and Aviary shows what they hold, but a strategy can keep in a
// vault what is not its liquidity: a tax market's tax-side vault also holds the tax not yet paid out,
// so docs/spec/tax-amm.md ("Payout") has Aviary read the real reserves from the market state instead.
//
// One reader per strategy program, each a pure function of the market state's bytes, answering the
// reserve for each of the market's mints in the market's order, or null for a state it cannot read.
// A strategy with no reader keeps no reserve, and its liquidity is what its vaults hold.
import { getTaxMarketDecoder, getTaxMarketSize, TAX_AMM_PROGRAM_ADDRESS, TAX_MARKET_DISCRIMINATOR } from "tax-amm-scripts/client/index.ts";

export type ReserveReader = (state: Uint8Array) => readonly bigint[] | null;

/** The tax AMM's market state: its real reserves, which leave out the tax owed in the tax-side vault and never count the virtual reserve. */
const taxAmm: ReserveReader = (state) => {
  if (state.length !== getTaxMarketSize() || !TAX_MARKET_DISCRIMINATOR.every((byte, i) => state[i] === byte)) return null;
  return getTaxMarketDecoder().decode(state).reserves;
};

/** The readers by strategy program; each of our products adds its own when its vaults are not its liquidity. */
export const RESERVE_READERS: Readonly<Record<string, ReserveReader>> = {
  [TAX_AMM_PROGRAM_ADDRESS]: taxAmm,
};

/** The reserve of each of a market's mints from its state, or null for each when its strategy has no reader or the state cannot be read. */
export function reservesOf(strategy: string, state: Uint8Array | null, mintCount: number): (bigint | null)[] {
  const read = state ? RESERVE_READERS[strategy]?.(state) : null;
  return Array.from({ length: mintCount }, (_, i) => read?.[i] ?? null);
}
