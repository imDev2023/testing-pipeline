// klend's `refresh_reserve` for our devnet reserves, which anyone may send: it brings the
// reserve's stored rate and its last update up to the current slot. A lending AMM market quotes
// and trades only on a reserve refreshed within its `TRADE_MAX_RESERVE_AGE_SLOTS`
// (docs/spec/lending-pool.md, "The stored rate, everywhere"), which the keeper runner keeps so
// (LENDING-95); until it does, this command refreshes them by hand, as before `pipeline-check`.
import type { Context } from "./context.ts";
import { refreshReserve } from "./kamino.ts";
import { RESERVES, type ReserveKey } from "./policy.ts";

/** One reserve refreshed: its key, the transaction and the slot it landed in. */
export interface Refreshed {
  key: ReserveKey;
  signature: string;
  slot: bigint;
}

/** Refreshes each reserve named, one transaction each, paid by the devnet wallet. */
export async function refreshReserves(ctx: Context, keys: readonly ReserveKey[]): Promise<Refreshed[]> {
  const refreshed: Refreshed[] = [];
  for (const key of keys) {
    const signature = await ctx.chain.send(
      `refresh the ${RESERVES[key].label} reserve`,
      [refreshReserve(ctx.book, ctx.book.reserves[key])],
      ctx.keys.wallet,
    );
    refreshed.push({ key, signature, slot: await ctx.chain.slotOf(signature) });
  }
  return refreshed;
}
