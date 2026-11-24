import { describe, expect, it } from "vitest";
import { extensionTypes, notPlain } from "../src/trading/market";

/** A Token-2022 mint's bytes: the 165-byte base, its account type, then each extension as type, length and value. */
function mint(...extensions: { type: number; length: number }[]) {
  const size = 166 + extensions.reduce((n, e) => n + 4 + e.length, 0);
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  data[165] = 1;
  let at = 166;
  for (const e of extensions) {
    view.setUint16(at, e.type, true);
    view.setUint16(at + 2, e.length, true);
    at += 4 + e.length;
  }
  return data;
}

describe("which mints are plain (PIPESCOPE-135)", () => {
  it("reads a mint's extensions in order", () => {
    expect(extensionTypes(mint({ type: 18, length: 64 }, { type: 19, length: 90 }))).toEqual([18, 19]);
    expect(extensionTypes(new Uint8Array(82))).toEqual([]);
  });

  it("keeps a mint whose extensions leave transfers as sent: metadata, a permanent delegate, a close authority", () => {
    expect(notPlain(mint({ type: 18, length: 64 }, { type: 19, length: 90 }, { type: 12, length: 32 }, { type: 3, length: 32 }))).toBeNull();
  });

  it("refuses a transfer fee, a transfer hook, non-transferable and pausable mints, saying which", () => {
    expect(notPlain(mint({ type: 18, length: 64 }, { type: 1, length: 108 }))).toBe("a transfer fee, so less arrives than is sent");
    expect(notPlain(mint({ type: 14, length: 64 }))).toBe("a transfer hook, whose accounts Aviary does not resolve yet");
    expect(notPlain(mint({ type: 9, length: 0 }))).toBe("no transfers at all");
    expect(notPlain(mint({ type: 26, length: 33 }))).toBe("a pause switch that can refuse every transfer");
  });
});
