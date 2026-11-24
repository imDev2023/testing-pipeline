// Our own products' parts of the explainer's evidence (docs/spec/README.md, Our products live inside
// Aviary; #57): keyed by strategy program, the facts a product's panel shows, read from its sampled
// market's state and the accounts it names at one slot, and the risks of every market of it. The
// tax AMM's (#75) and the lending AMM's (#88) join here.
import type { Fact } from "terminal-explainer";
import { BUY_WALL_AMM_PROGRAM_ADDRESS } from "buy-wall-amm-scripts/client/programs/buyWallAmm.ts";
import { BUY_WALL_RISKS, buyWallFacts, CLOCK_SYSVAR, clockTime } from "./buyWall";

/** One account as read with the others, at the read's one slot; null when it does not exist. */
export type ReadAccounts = (addresses: string[]) => Promise<{ slot: number; data: (Uint8Array | null)[] }>;

export type ProductEvidence = {
  /** The facts of the sampled market, from its state's address and its mints in order, with a reader of accounts at one slot. */
  facts(market: { marketState: string; mints: readonly string[] }, read: ReadAccounts): Promise<Fact[]>;
  risks: readonly Fact[];
};


/** A product's facts could not be read this time: the key waits for a later run rather than keep evidence without them. */
export class ProductNotRead extends Error {
  override name = "ProductNotRead";
}

export const PRODUCT_EVIDENCE: Readonly<Record<string, ProductEvidence>> = {
  [BUY_WALL_AMM_PROGRAM_ADDRESS]: {
    async facts({ marketState, mints }, read) {
      // Mint 0 is the token, mint 1 wrapped SOL (docs/spec/pool4-for-solana.md, Shape): the state, the token's mint and the clock at one slot.
      const token = mints[0];
      if (!token) throw new ProductNotRead("the sampled market's mints are not indexed yet");
      const { slot, data } = await read([marketState, token, CLOCK_SYSVAR]);
      const [state, mint, clock] = data;
      const now = clock ? clockTime(clock) : null;
      if (!state || !mint || now === null) throw new ProductNotRead("the sampled market's state, its token's mint or the clock was not there");
      return buyWallFacts({ state, mint, slot, now });
    },
    risks: BUY_WALL_RISKS,
  },
};
