import { describe, expect, it } from "vitest";
import { minimumReceived, splitTyped } from "../src/trading/amounts";

describe("the amount typed, worked back to what goes into the market (PIPESCOPE-76)", () => {
  it("splits 0.1 SOL typed into the market amount and both fees, which add up to exactly 0.1 SOL (the screens' devnet check of 2026-11-12)", () => {
    const split = splitTyped(100_000_000n, { feeSide: "input", pipelineBps: 25, integratorBps: 50 });
    expect(split).toEqual({ netSent: 99_255_583n, pipelineFeeOnInput: 248_139n, integratorFee: 496_278n, totalSpend: 100_000_000n });
  });

  it("divides by Pipeline's rate alone when the trader pays in a mint that carries no integrator fee", () => {
    const split = splitTyped(1_000_000n, { feeSide: "input", pipelineBps: 25, integratorBps: 0 });
    expect(split.netSent).toBe(997_506n);
    expect(split.integratorFee).toBe(0n);
    expect(split.totalSpend).toBeLessThanOrEqual(1_000_000n);
    expect(split.netSent + split.pipelineFeeOnInput).toBe(split.totalSpend);
  });

  it("on a trade into the market's fee mint, takes only the integrator fee from the input, since Pipeline's comes out of what arrives", () => {
    expect(splitTyped(100_750n, { feeSide: "output", pipelineBps: 25, integratorBps: 75 })).toEqual({ netSent: 100_000n, pipelineFeeOnInput: 0n, integratorFee: 750n, totalSpend: 100_750n });
    expect(splitTyped(5_000n, { feeSide: "output", pipelineBps: 25, integratorBps: 0 })).toEqual({ netSent: 5_000n, pipelineFeeOnInput: 0n, integratorFee: 0n, totalSpend: 5_000n });
  });

  it("never spends more than was typed, whatever the rounding of the fees, which are rounded up", () => {
    for (let typed = 1n; typed < 3_000n; typed += 7n) {
      for (const integratorBps of [0, 1, 50, 333]) {
        const s = splitTyped(typed, { feeSide: "input", pipelineBps: 25, integratorBps });
        expect(s.totalSpend).toBeLessThanOrEqual(typed);
        // The largest market amount that fits: one more would overspend.
        const next = splitTyped(typed + 1000n, { feeSide: "input", pipelineBps: 25, integratorBps });
        expect(next.netSent).toBeGreaterThanOrEqual(s.netSent);
        const ceil = (x: bigint, bps: number) => (x * BigInt(bps) + 9_999n) / 10_000n;
        const plusOne = s.netSent + 1n;
        expect(plusOne + ceil(plusOne, 25) + ceil(plusOne, integratorBps)).toBeGreaterThan(typed);
      }
    }
  });

  it("works nothing into the market from an amount too small to pay its fees", () => {
    expect(splitTyped(0n, { feeSide: "input", pipelineBps: 25, integratorBps: 50 }).netSent).toBe(0n);
    expect(splitTyped(1n, { feeSide: "input", pipelineBps: 25, integratorBps: 50 }).netSent).toBe(0n);
  });
});

describe("the minimum received after slippage", () => {
  it("is the expected output less the slippage, rounded down", () => {
    expect(minimumReceived(1_000_000n, 100)).toBe(990_000n);
    expect(minimumReceived(999n, 50)).toBe(994n);
    expect(minimumReceived(123n, 0)).toBe(123n);
  });
});
