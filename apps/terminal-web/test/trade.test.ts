import { describe, expect, it } from "vitest";
import { formatBps, parseAmount, parseSlippage, tradeButton, balanceToUse, writeAmount } from "../src/trade";

describe("the amount typed (docs/spec/pipescope-screens.md, The amount typed)", () => {
  it("is read into the mint's base units exactly, with no rounding through floating point", () => {
    expect(parseAmount("0.1", 9)).toEqual({ kind: "amount", value: 100_000_000n });
    expect(parseAmount("1234.567891", 6)).toEqual({ kind: "amount", value: 1_234_567_891n });
    expect(parseAmount(" 2 ", 9)).toEqual({ kind: "amount", value: 2_000_000_000n });
    expect(parseAmount(".5", 9)).toEqual({ kind: "amount", value: 500_000_000n });
  });

  it("is empty until something is typed, and nothing at zero", () => {
    expect(parseAmount("", 9)).toEqual({ kind: "empty" });
    expect(parseAmount("0", 9)).toEqual({ kind: "empty" });
    expect(parseAmount("0.000", 9)).toEqual({ kind: "empty" });
  });

  it("refuses more decimal places than the mint has, and anything that is not a number", () => {
    expect(parseAmount("0.0000000001", 9)).toEqual({ kind: "invalid", reason: "This token has 9 decimal places." });
    expect(parseAmount("1e3", 9)).toEqual({ kind: "invalid", reason: "Type an amount, such as 0.5." });
    expect(parseAmount("-1", 9)).toEqual({ kind: "invalid", reason: "Type an amount, such as 0.5." });
    expect(parseAmount("99999999999999999999", 9)).toEqual({ kind: "invalid", reason: "That is more than a token account can hold." });
  });

  it("is written back from base units without losing a digit", () => {
    expect(writeAmount(100_000_000n, 9)).toBe("0.1");
    expect(writeAmount(1_234_567_891n, 6)).toBe("1234.567891");
    expect(writeAmount(5n, 0)).toBe("5");
    expect(writeAmount(0n, 9)).toBe("0");
  });
});

describe("Use it all", () => {
  it("keeps 0.01 SOL back for network fees and rent when paying in SOL", () => {
    expect(balanceToUse(1_000_000_000n, { isSol: true })).toBe(990_000_000n);
    expect(balanceToUse(5_000_000n, { isSol: true })).toBe(0n);
  });

  it("uses every unit of any other token", () => {
    expect(balanceToUse(86_063_877_914n, { isSol: false })).toBe(86_063_877_914n);
  });
});

describe("the slippage the trader accepts", () => {
  it("is read in basis points, up to 50%", () => {
    expect(parseSlippage("1")).toEqual({ kind: "bps", value: 100 });
    expect(parseSlippage("0.5")).toEqual({ kind: "bps", value: 50 });
    expect(parseSlippage("12.25")).toEqual({ kind: "bps", value: 1225 });
    expect(parseSlippage("50")).toEqual({ kind: "bps", value: 5000 });
  });

  it("refuses more than 50%, finer than a basis point, and what is not a number", () => {
    expect(parseSlippage("50.01")).toEqual({ kind: "invalid", reason: "Slippage is at most 50%." });
    expect(parseSlippage("0.001")).toEqual({ kind: "invalid", reason: "Slippage is set to a hundredth of a percent at most." });
    expect(parseSlippage("abc")).toEqual({ kind: "invalid", reason: "Type a percentage, such as 2." });
  });
});

describe("a rate in basis points", () => {
  it("is written as a percentage", () => {
    expect(formatBps(25)).toBe("0.25%");
    expect(formatBps(50)).toBe("0.5%");
    expect(formatBps(100)).toBe("1%");
    expect(formatBps(0)).toBe("0%");
  });
});

describe("the trade box's button (docs/spec/pipescope-screens.md, Trade box)", () => {
  const ready = { connected: true, amount: "amount" as const, quote: "ready" as const, noticeUnticked: false, slippageReason: null };

  it("reads, in turn, Connect wallet, Enter an amount, Getting a quote, and Review swap", () => {
    expect(tradeButton({ ...ready, connected: false })).toEqual({ label: "Connect wallet", action: "connect", reason: null });
    expect(tradeButton({ ...ready, amount: "empty" })).toEqual({ label: "Enter an amount", action: null, reason: null });
    expect(tradeButton({ ...ready, quote: "loading" })).toEqual({ label: "Getting a quote", action: null, reason: null });
    expect(tradeButton(ready)).toEqual({ label: "Review swap", action: "review", reason: null });
  });

  it("is off with the reason under it when the trader can act on it", () => {
    expect(tradeButton({ ...ready, noticeUnticked: true })).toEqual({ label: "Review swap", action: null, reason: "Tick the box above to say you have read it." });
    expect(tradeButton({ ...ready, quote: "none" })).toEqual({ label: "Review swap", action: null, reason: "There is no quote to build a swap from." });
    expect(tradeButton({ ...ready, amount: "invalid" })).toEqual({ label: "Review swap", action: null, reason: "There is no quote to build a swap from." });
    expect(tradeButton({ ...ready, slippageReason: "Slippage is at most 50%." })).toEqual({ label: "Review swap", action: null, reason: "Slippage is at most 50%." });
  });
});
