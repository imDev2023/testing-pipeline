// Price direction (PIPESCOPE-74): the quote mint is wrapped SOL if either mint is it, else USDC,
// else the later mint in the market's own order; a market's default base is its first other mint.
import { describe, expect, it } from "vitest";
import { CLUSTER_USDC as USDC, WRAPPED_SOL as SOL } from "../src/config";
import { marketPair, tradePair } from "../src/pairs";

const A = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";
const B = "Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe";
const C = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";

describe("a market's default pair", () => {
  it("is quoted in wrapped SOL wherever it sits, then USDC, then the market's last mint", () => {
    expect(marketPair([SOL, A])).toEqual({ quote: SOL, base: A });
    expect(marketPair([A, USDC, SOL])).toEqual({ quote: SOL, base: A });
    expect(marketPair([USDC, A])).toEqual({ quote: USDC, base: A });
    expect(marketPair([A, B])).toEqual({ quote: B, base: A });
  });

  it("takes the first other mint as the base on a market of three or four mints", () => {
    expect(marketPair([A, B, C])).toEqual({ quote: C, base: A });
    expect(marketPair([B, SOL, A, C])).toEqual({ quote: SOL, base: B });
  });
});

describe("a trade's pair and side", () => {
  it("is a buy when the trader paid in the quote mint and a sell when they received it", () => {
    expect(tradePair([A, SOL], SOL, A)).toEqual({ quote: SOL, base: A, side: "buy" });
    expect(tradePair([A, SOL], A, SOL)).toEqual({ quote: SOL, base: A, side: "sell" });
  });

  it("is worked out over the trade's own two mints, by the market's order when neither is SOL or USDC", () => {
    expect(tradePair([A, B, C], A, B)).toEqual({ quote: B, base: A, side: "sell" });
    expect(tradePair([A, B, C], C, B)).toEqual({ quote: C, base: B, side: "buy" });
    expect(tradePair([A, USDC, SOL], A, USDC)).toEqual({ quote: USDC, base: A, side: "sell" });
  });
});
