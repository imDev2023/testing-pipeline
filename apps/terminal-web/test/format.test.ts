import { describe, expect, it } from "vitest";
import { formatAge, formatAmount, formatDate, formatDay, formatInteger, formatPrice, formatTokenAmount, shortAddress } from "../src/format";

// The examples are the screens' own (docs/spec/pipescope-screens.md, "On every page").
describe("addresses", () => {
  it("are shown as their first four and last four characters", () => {
    expect(shortAddress("6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp")).toBe("6efY...dnYp");
  });
});

describe("amounts", () => {
  it("are written to four significant figures", () => {
    expect(formatAmount(1234.5678)).toBe("1,235");
    expect(formatAmount(0.012345)).toBe("0.01235");
    expect(formatAmount(12.5)).toBe("12.5");
    expect(formatAmount(0)).toBe("0");
  });

  it("use M for millions and B for billions", () => {
    expect(formatAmount(1_234_567)).toBe("1.235M");
    expect(formatAmount(2_500_000_000)).toBe("2.5B");
    expect(formatAmount(999_950)).toBe("1M");
    expect(formatAmount(999_949_999)).toBe("999.9M");
  });

  it("are read from a token's base units and decimals", () => {
    expect(formatTokenAmount(99_255_583n, 9)).toBe("0.09926");
    expect(formatTokenAmount(1_000_000_000_000_000n, 6)).toBe("1B");
  });
});

describe("counts", () => {
  it("such as slots are whole numbers with their thousands grouped", () => {
    expect(formatInteger(520_629_097)).toBe("520,629,097");
  });
});

describe("prices", () => {
  it("below 0.0001 count their zeros in a subscript", () => {
    expect(formatPrice(0.00000002307)).toBe("0.0₇2307");
    expect(formatPrice(0.00009999)).toBe("0.0₄9999");
    expect(formatPrice(0.000000000000123)).toBe("0.0₁₂123");
  });

  it("from 0.0001 up are written like amounts", () => {
    expect(formatPrice(0.0001)).toBe("0.0001");
    expect(formatPrice(0.000099996)).toBe("0.0001");
    expect(formatPrice(0.0123456)).toBe("0.01235");
    expect(formatPrice(25_000_000)).toBe("25M");
  });
});

describe("dates", () => {
  it("are in UTC, as the screens write them", () => {
    expect(formatDate(new Date("2026-11-10T04:54:31Z"))).toBe("10 Nov 2026, 04:54 UTC");
    expect(formatDate(new Date("2026-01-02T23:05:00Z"))).toBe("2 Jan 2026, 23:05 UTC");
  });

  it("can be a day alone", () => {
    expect(formatDay("2026-11-22")).toBe("22 Nov 2026");
  });

  it("show an age in lists", () => {
    const now = new Date("2026-11-12T05:00:00Z");
    expect(formatAge(new Date("2026-11-10T04:54:00Z"), now)).toBe("2d ago");
    expect(formatAge(new Date("2026-11-12T02:00:00Z"), now)).toBe("3h ago");
    expect(formatAge(new Date("2026-11-12T04:56:00Z"), now)).toBe("4m ago");
    expect(formatAge(new Date("2026-11-12T04:59:48Z"), now)).toBe("12s ago");
    expect(formatAge(new Date("2026-11-12T05:00:03Z"), now)).toBe("just now");
  });
});
