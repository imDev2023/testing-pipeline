// A strategy's quote at a change of its own rates that falls due within a transaction's lifetime
// (docs/spec/tax-amm.md, "In Aviary"; #75). A tax market's `set_taxes` waits `RATE_CHANGE_DELAY_SLOTS`
// before quotes and swaps apply it, and a blockhash lasts about 150 slots, so a swap signed late in the
// delay may land after the change. The trade box then sets its minimum output from the worse of the
// quotes at the rates in force and at the pending rates; since it is the worse, a pending decrease never
// lowers the bar, and an announced decrease, which can be cancelled before its slot, is never relied on.
//
// The pending quote is worked out from the market state with the spec's own formulas (`spec-model.ts`
// in the tax AMM's scripts, written apart from the program), since the chain quotes only at its clock.
import { getTaxMarketDecoder, getTaxMarketSize, SUITE_SHARE_BPS, TAX_AMM_PROGRAM_ADDRESS, TAX_MARKET_DISCRIMINATOR } from "tax-amm-scripts/client/index.ts";
import { price } from "tax-amm-scripts/spec-model.ts";
import { TRANSACTION_LIFETIME_SLOTS } from "../config";

export type PendingTrade = { inputIndex: number; outputIndex: number; credited: bigint };

/** What the strategy would send at its pending rates, and the slot they apply from; null when no change falls due within a transaction's lifetime. */
export function pendingRateQuote(strategy: string, state: Uint8Array, slot: bigint, trade: PendingTrade): { fromSlot: bigint; strategyOut: bigint } | null {
  if (strategy !== TAX_AMM_PROGRAM_ADDRESS) return null;
  if (state.length !== getTaxMarketSize() || !TAX_MARKET_DISCRIMINATOR.every((byte, i) => state[i] === byte)) return null;
  const market = getTaxMarketDecoder().decode(state);
  const from = market.pendingFromSlot;
  // A change already due is what the chain's own quote applies; one past the lifetime cannot reach a swap signed now.
  if (from === 0n || from <= slot || from > slot + BigInt(TRANSACTION_LIFETIME_SLOTS)) return null;
  const priced = price(
    {
      suiteShareBps: SUITE_SHARE_BPS,
      taxSide: market.taxSide,
      buyTaxBps: market.pendingBuyTaxBps,
      sellTaxBps: market.pendingSellTaxBps,
      shares: [...market.shares],
      burnShareBps: market.burnShareBps,
      virtualSide: market.virtualSide,
      virtualReserve: market.virtualReserve,
      reserves: [...market.reserves],
      owed: [...market.owed],
      taxCollected: market.taxCollected,
      volume: [...market.volume],
      swapCount: market.swapCount,
    },
    trade.inputIndex,
    trade.outputIndex,
    trade.credited,
  );
  // A trade the pending rates refuse would fail on chain after the change, taking nothing, so the minimum stays the one in force.
  return typeof priced === "string" ? null : { fromSlot: from, strategyOut: priced.out };
}
