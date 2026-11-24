import { describe, expect, it } from "vitest";
import { getAddressDecoder } from "@solana/kit";
import { extensionTypes, notPlain, transferHookProgram } from "../src/trading/market";

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

  it("refuses a transfer fee, non-transferable and pausable mints, saying which", () => {
    expect(notPlain(mint({ type: 18, length: 64 }, { type: 1, length: 108 }))).toBe("a transfer fee, so less arrives than is sent");
    expect(notPlain(mint({ type: 9, length: 0 }))).toBe("no transfers at all");
    expect(notPlain(mint({ type: 26, length: 33 }))).toBe("a pause switch that can refuse every transfer");
  });

  it("trades a mint with a transfer hook (#122), whose accounts are resolved from its own list", () => {
    expect(notPlain(mint({ type: 14, length: 64 }))).toBeNull();
  });
});

describe("a mint's transfer hook program", () => {
  /** A mint whose transfer hook extension holds `authority` and `program` (zeroes for none). */
  function hooked(authority: Uint8Array, program: Uint8Array) {
    const data = mint({ type: 18, length: 64 }, { type: 14, length: 64 });
    const at = 166 + 4 + 64 + 4;
    data.set(authority, at);
    data.set(program, at + 32);
    return data;
  }

  it("reads the program its transfers call, after the hook's authority", () => {
    const program = new Uint8Array(32).fill(9);
    expect(transferHookProgram(hooked(new Uint8Array(32).fill(3), program))).toBe(getAddressDecoder().decode(program));
  });

  it("finds none on a mint without the extension, or with no program set", () => {
    expect(transferHookProgram(mint({ type: 18, length: 64 }))).toBeNull();
    expect(transferHookProgram(new Uint8Array(82))).toBeNull();
    expect(transferHookProgram(hooked(new Uint8Array(32).fill(3), new Uint8Array(32)))).toBeNull();
  });
});
