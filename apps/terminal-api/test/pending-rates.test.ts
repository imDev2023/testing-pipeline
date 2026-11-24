// A tax market's pending change of rates and the trade box's minimum output (docs/spec/tax-amm.md,
// "In Aviary"; hardening round 2 of #67): when a change falls due within a transaction's lifetime (150
// blocks), a swap signed now may land after it, so the minimum received is set from the worse of the
// quotes at the rates in force and at the pending rates, never from a pending decrease.
import { address, type Address } from "@solana/kit";
import { getTaxMarketEncoder, MarketStatus, TAX_AMM_PROGRAM_ADDRESS, type TaxMarketArgs } from "tax-amm-scripts/client/index.ts";
import { describe, expect, it } from "vitest";
import { TRANSACTION_LIFETIME_SLOTS } from "../src/config";
import { pendingRateQuote } from "../src/trading/pendingRates";

const TOKEN = address("AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx");
const WSOL = address("So11111111111111111111111111111111111111112");
const ONE = address("E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW");
const ZERO = address("11111111111111111111111111111111");
const SLOT = 525_000_000n;

const state = (over: Partial<TaxMarketArgs>): Uint8Array =>
  new Uint8Array(
    getTaxMarketEncoder().encode({
      version: 1,
      status: MarketStatus.Open,
      taxSide: 1,
      virtualSide: 0,
      authorityBump: 255,
      taxAuthorityRenounced: false,
      mints: [TOKEN, WSOL],
      vaults: [ONE, ONE] as Address[],
      marketSigner: ONE,
      buyTaxBps: 300,
      sellTaxBps: 500,
      buyTaxMinBps: 0,
      buyTaxMaxBps: 1000,
      sellTaxMinBps: 0,
      sellTaxMaxBps: 1000,
      taxAuthority: ONE,
      seeder: ONE,
      recipients: [ONE, ZERO, ZERO, ZERO],
      shares: [10_000, 0, 0, 0],
      burnShareBps: 0,
      virtualReserve: 0n,
      reserves: [100_000_000_000n, 500_000_000n],
      owed: [0n, 0n, 0n, 0n, 0n, 0n],
      taxCollected: 0n,
      volume: [0n, 0n],
      swapCount: 0n,
      createdSlot: 1n,
      createdAt: 1n,
      pendingBuyTaxBps: 0,
      pendingSellTaxBps: 0,
      pendingFromSlot: 0n,
      reserved: new Uint8Array(52),
      ...over,
    }),
  );

describe("pendingRateQuote", () => {
  // A buy: 0.05 SOL credited from the tax side (1) into the token (0), the buy tax taken from the input.
  const buy = { inputIndex: 1, outputIndex: 0, credited: 50_000_000n };

  it("quotes at the pending rates when the change falls due within the transaction's lifetime", () => {
    const due = state({ pendingBuyTaxBps: 900, pendingSellTaxBps: 500, pendingFromSlot: SLOT + 100n });
    const quoted = pendingRateQuote(TAX_AMM_PROGRAM_ADDRESS, due, SLOT, buy);
    // At 9%: tax = ceil(50,000,000 × 900 / 10,000) = 4,500,000; c = 45,500,000; out = floor(100e9 × c / (500e6 + c)).
    expect(quoted).toEqual({ fromSlot: SLOT + 100n, strategyOut: (100_000_000_000n * 45_500_000n) / (500_000_000n + 45_500_000n), upcoming: true });
  });

  it("prices a change whose slot has come too, since the chain's quote may have been simulated just before it, saying it is no longer to come", () => {
    const inForce = state({ pendingBuyTaxBps: 900, pendingSellTaxBps: 500, pendingFromSlot: SLOT });
    expect(pendingRateQuote(TAX_AMM_PROGRAM_ADDRESS, inForce, SLOT, buy)).toEqual({ fromSlot: SLOT, strategyOut: (100_000_000_000n * 45_500_000n) / (500_000_000n + 45_500_000n), upcoming: false });
  });

  it("asks nothing of a change due after the transaction's lifetime, of no change, or of another strategy", () => {
    const later = state({ pendingBuyTaxBps: 900, pendingSellTaxBps: 500, pendingFromSlot: SLOT + BigInt(TRANSACTION_LIFETIME_SLOTS) + 1n });
    expect(pendingRateQuote(TAX_AMM_PROGRAM_ADDRESS, later, SLOT, buy)).toBeNull();
    expect(pendingRateQuote(TAX_AMM_PROGRAM_ADDRESS, state({}), SLOT, buy)).toBeNull();
    expect(pendingRateQuote(ONE, state({ pendingBuyTaxBps: 900, pendingSellTaxBps: 500, pendingFromSlot: SLOT + 1n }), SLOT, buy)).toBeNull();
    expect(pendingRateQuote(TAX_AMM_PROGRAM_ADDRESS, Uint8Array.from([1, 2, 3]), SLOT, buy)).toBeNull();
  });

  it("quotes a sell at the pending sell tax, taken from the curve's output", () => {
    const due = state({ pendingBuyTaxBps: 300, pendingSellTaxBps: 1000, pendingFromSlot: SLOT + 10n });
    const sell = { inputIndex: 0, outputIndex: 1, credited: 1_000_000_000n };
    const g = (500_000_000n * 1_000_000_000n) / (100_000_000_000n + 1_000_000_000n);
    expect(pendingRateQuote(TAX_AMM_PROGRAM_ADDRESS, due, SLOT, sell)).toEqual({ fromSlot: SLOT + 10n, strategyOut: g - (g * 1000n + 9_999n) / 10_000n, upcoming: true });
  });
});
