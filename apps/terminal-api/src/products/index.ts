// Our own products' parts of the explainer's evidence (docs/spec/README.md, Our products live inside
// Aviary; #57): keyed by strategy program, the facts a product's panel shows, read from its sampled
// market's state and the accounts it names at one slot, and the risks of every market of it. The
// tax AMM's (#75) and the lending AMM's (#88) join here.
import type { Fact } from "terminal-explainer";
import { BUY_WALL_AMM_PROGRAM_ADDRESS } from "buy-wall-amm-scripts/client/programs/buyWallAmm.ts";
import { BUY_WALL_RISKS, buyWallFacts } from "./buyWall";

/** One account as read with the others, at the read's one slot; null when it does not exist. */
export type ReadAccounts = (addresses: string[]) => Promise<{ slot: number; data: (Uint8Array | null)[] }>;

export type ProductEvidence = {
  /** The facts of the sampled market, from its state's address and its mints in order, with a reader of accounts at one slot. */
  facts(market: { marketState: string; mints: readonly string[] }, read: ReadAccounts): Promise<Fact[]>;
  risks: readonly Fact[];
};

export const PRODUCT_EVIDENCE: Readonly<Record<string, ProductEvidence>> = {
  [BUY_WALL_AMM_PROGRAM_ADDRESS]: {
    async facts({ marketState, mints }, read) {
      // Mint 0 is the token, mint 1 wrapped SOL (docs/spec/pool4-for-solana.md, Shape): the state and the token's mint at one slot.
      const { slot, data } = await read([marketState, mints[0]!]);
      return buyWallFacts({ state: data[0] ?? new Uint8Array(0), mint: data[1] ?? new Uint8Array(0), slot, now: BigInt(Math.floor(Date.now() / 1000)) });
    },
    risks: BUY_WALL_RISKS,
  },
};
