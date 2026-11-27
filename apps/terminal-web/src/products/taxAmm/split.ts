// Where every tax of a tax market goes (docs/spec/tax-amm.md, "Where the tax goes"): the suite share
// first, then each tax recipient's share and the burn's of what is left, the creator's part. The
// launch form shows it before signing and the tax panel shows a market's, both from here, with the
// suite share and its treasury read from the program's IDL.
import { address, type Address } from "@solana/kit";
import { BURN_SLOT, SUITE_SHARE_BPS, SUITE_SLOT, SUITE_TREASURY } from "tax-amm-scripts/client/index.ts";

/** Basis points in a whole. */
const BPS = 10_000;

/** The all-zero key: an unused recipient slot, a market with no tax authority, and the burn slot's wallet. */
export const DEFAULT_ADDRESS = address("11111111111111111111111111111111");

export type SlotWho = "recipient" | "burn" | "suite";

/** One part of every tax: the suite share, a tax recipient's or the burn's, as basis points of the whole tax and of the creator's part. */
export type SplitPart = { slot: number; who: SlotWho; wallet: Address | null; ofCreatorBps: number | null; ofTaxBps: number };

/** The part of the whole tax a share of the creator's part is, after the suite share. */
const ofTax = (share: number) => Math.floor((share * (BPS - SUITE_SHARE_BPS)) / BPS);

/** The whole split, the suite share first, then each used recipient slot and the burn when it has a share. */
export function splitOf(recipients: readonly Address[], shares: readonly number[], burnShareBps: number): SplitPart[] {
  return [
    { slot: SUITE_SLOT, who: "suite", wallet: SUITE_TREASURY, ofCreatorBps: null, ofTaxBps: SUITE_SHARE_BPS },
    ...recipients.flatMap((wallet, slot) => (wallet === DEFAULT_ADDRESS ? [] : [{ slot, who: "recipient" as const, wallet, ofCreatorBps: shares[slot]!, ofTaxBps: ofTax(shares[slot]!) }])),
    ...(burnShareBps > 0 ? [{ slot: BURN_SLOT, who: "burn" as const, wallet: null, ofCreatorBps: burnShareBps, ofTaxBps: ofTax(burnShareBps) }] : []),
  ];
}
