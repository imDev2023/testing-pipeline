import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findTestWallet, TEST_WALLET_MARKS } from "../scripts/check-no-test-wallet";

describe("the production build's check for the test wallet (PIPESCOPE-94)", () => {
  it("looks for the marks the test wallet really carries", () => {
    const wallet = readFileSync(join(import.meta.dirname, "../../../tests/terminal-e2e/src/wallet.ts"), "utf8");
    for (const mark of TEST_WALLET_MARKS) expect(wallet).toContain(mark);
  });

  it("finds a mark in any file of a build, however deep, and passes a clean one", () => {
    const build = mkdtempSync(join(tmpdir(), "build-"));
    mkdirSync(join(build, "assets/_next/static/chunks"), { recursive: true });
    writeFileSync(join(build, "assets/_next/static/chunks/page.js"), "const name = 'Connect wallet';");
    expect(findTestWallet(build)).toEqual([]);
    writeFileSync(join(build, "assets/_next/static/chunks/leak.js"), "window.__testWalletSignAndSend(tx)");
    expect(findTestWallet(build)).toEqual(["assets/_next/static/chunks/leak.js: __testWalletSignAndSend"]);
  });
});
