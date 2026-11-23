// The amount typed in the trade box (docs/spec/pipescope-screens.md, The amount typed; PIPESCOPE-76)
// is everything that leaves the wallet for the swap, fees included. Pipeline counts an exact-in
// amount as what goes into the market, with its fee and the integrator fee taken on top, each rounded
// up, so the market amount is worked back here: the largest one whose total spend fits in what was
// typed. On a trade into the market's fee mint Pipeline takes its fee out of what arrives instead.
import type { FeeSide } from "@pipeline-sol/sdk";

const BPS = 10_000n;

/** `ceil(amount × bps / 10,000)`, as the router rounds every fee. */
export const feeOf = (amount: bigint, bps: number): bigint => (amount * BigInt(bps) + BPS - 1n) / BPS;

export type TypedSplit = {
  /** What goes into the market: the swap's exact-in amount. */
  netSent: bigint;
  /** Pipeline's fee when it is taken from the input; 0 on a trade into the fee mint, where it comes out of the output. */
  pipelineFeeOnInput: bigint;
  integratorFee: bigint;
  /** Everything that leaves the wallet for the swap: at most what was typed. */
  totalSpend: bigint;
};

export function splitTyped(typed: bigint, { feeSide, pipelineBps, integratorBps }: { feeSide: FeeSide; pipelineBps: number; integratorBps: number }): TypedSplit {
  const onInput = feeSide === "input" ? pipelineBps : 0;
  const spend = (net: bigint) => net + feeOf(net, onInput) + feeOf(net, integratorBps);
  // The amount divided by one plus the rates, rounded down, then stepped down past the fees' rounding up.
  let netSent = (typed * BPS) / (BPS + BigInt(onInput) + BigInt(integratorBps));
  while (netSent > 0n && spend(netSent) > typed) netSent -= 1n;
  // And up, should the division have left room for one more unit.
  while (spend(netSent + 1n) <= typed) netSent += 1n;
  return { netSent, pipelineFeeOnInput: feeOf(netSent, onInput), integratorFee: feeOf(netSent, integratorBps), totalSpend: spend(netSent) };
}

/** What a trader keeps of `received` when Pipeline's fee comes out of the output (the SDK's `keptAfterOutputFee`, at the rate served). */
export const keptAfterOutputFee = (received: bigint, pipelineBps: number): bigint => received - feeOf(received, pipelineBps);

/** The expected output less the slippage accepted, rounded down: the swap's minimum. */
export const minimumReceived = (expected: bigint, slippageBps: number): bigint => (expected * (BPS - BigInt(slippageBps))) / BPS;
