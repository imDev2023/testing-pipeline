// The local demo run of #122: on a local validator running devnet's router, constant-product markets
// of Pipeline's test-strategy-cp with Token-2022 mints whose transfer hooks are Pipeline's test-hook
// (an allowlist with one extra account) and test-hook-refill (four fixed extra accounts, two of them
// writable), made by demo/hooked-mints.ts, are bought and sold from the trade box with the Playwright
// test wallet. Each prepared swap must carry the accounts the mint's ExtraAccountMetaList names, where
// the router and the strategy look for them, with the roles the list gives them, and pass its
// simulation; then it is signed, sent and read back into Trades.
//
// It runs only as `pnpm --filter terminal-e2e hooked:local` (E2E_RPC=local), after the validator and
// the setup; docs/toolchain.md, "Aviary's hooked-mints demo". Each signature goes to
// test-results/hooked.json for the PR.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { getSwapArgsCodec, PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { PreparedSwap } from "terminal-api/contract";
import { HOOKED_MARKETS, type HookedMarket } from "../demo/hooked-mints.ts";
import { screenshot } from "./screenshot";
import { connectTestWallet, installTestWallet, testTraderSigner } from "./wallet";

const RESULTS = `${import.meta.dirname}/../test-results`;
const { markets } = JSON.parse(readFileSync(HOOKED_MARKETS, "utf8")) as { markets: HookedMarket[] };
const box = (page: Page) => page.getByRole("region", { name: "Swap" });
const results: Record<string, unknown> = {};

/** The router's `swap` in a prepared transaction: its accounts in order with whether each is writable, and how many trail as the input's hook accounts. */
function routerSwap(prepared: PreparedSwap) {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction!)).messageBytes);
  if (message.version !== "legacy") throw new Error(`the swap is a version ${message.version} transaction; this market records no lookup table`);
  const { staticAccounts: keys, header } = message;
  const writable = (i: number) =>
    i < header.numSignerAccounts ? i < header.numSignerAccounts - header.numReadonlySignerAccounts : i < keys.length - header.numReadonlyNonSignerAccounts;
  const swap = message.instructions.find((ix) => keys[ix.programAddressIndex] === PIPELINE_PROGRAM_ADDRESS)!;
  const accounts = (swap.accountIndices ?? []).map((i) => ({ address: keys[i]!, writable: writable(i) }));
  const args = getSwapArgsCodec().decode(swap.data!.subarray(8));
  return { accounts, inputHookAccounts: args.inputHookAccounts };
}

/** What the mint's list names, as a swap must carry it: its extra accounts with their roles, then the hook program and the validation account, read-only. */
const named = (m: HookedMarket) => [...m.extras, { address: m.hookProgram, writable: false }, { address: m.validation, writable: false }];

test.describe.configure({ mode: "serial" });

for (const m of markets) {
  test(`buys and sells a mint hooked by ${m.kind === "allowlist" ? "Pipeline's test-hook" : "Pipeline's test-hook-refill"}, each swap carrying its hook's accounts`, async ({ page }) => {
    test.setTimeout(240_000);
    await installTestWallet(page, await testTraderSigner());
    await page.goto(`/markets/${m.market}`);
    await expect(box(page).getByLabel("You pay, fees included")).toBeVisible({ timeout: 60_000 });
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    await expect(box(page).getByText(/^Balance [\d.,]+ SOL$/)).toBeVisible();

    /** Reviews the swap typed, checks what was prepared, signs it and waits until it is confirmed and in Trades. */
    const swap = async (name: string, check: (prepared: PreparedSwap) => void) => {
      const preparing = page.waitForResponse((r) => r.url().endsWith("/v1/swaps/prepare"));
      await box(page).getByRole("button", { name: "Review swap" }).click();
      const prepared = PreparedSwap.parse(await (await preparing).json());
      expect(prepared.simulation.failure).toBeNull();
      expect(prepared.simulation.ok).toBe(true);
      check(prepared);
      const review = page.getByRole("region", { name: "Review this swap" });
      await expect(review.getByText(/^The simulation went through\. It used [\d,]+ compute units\./)).toBeVisible();
      await screenshot(page, test.info(), `hooked-${m.kind}-${name}-review`);
      await review.getByRole("button", { name: "Sign in wallet" }).click();
      await expect(review.getByText(/^Confirmed in slot [\d,]+\. The trade is at the top of Trades\.$/)).toBeVisible({ timeout: 70_000 });
      const href = await review.getByRole("link", { name: /Transaction .* on the explorer/ }).getAttribute("href");
      const signature = decodeURIComponent(new URL(href!).pathname.split("/").pop()!);
      await expect(page.getByRole("region", { name: "Trades" }).getByRole("link", { name: `${signature.slice(0, 4)}...${signature.slice(-4)}` })).toBeVisible();
      await screenshot(page, test.info(), `hooked-${m.kind}-${name}-confirmed`);
      return { signature, compute_units: prepared.simulation.compute_units, received: prepared.simulation.received };
    };

    // The buy, 0.1 SOL typed: the vault pays the trader the token, so the hook's accounts follow the strategy's own, and the input has none.
    await box(page).getByLabel("You pay, fees included").fill("0.1");
    await expect(box(page).getByRole("button", { name: "Review swap" })).toBeEnabled();
    const buy = await swap("buy", (prepared) => {
      const { accounts, inputHookAccounts } = routerSwap(prepared);
      expect(inputHookAccounts).toBe(0);
      expect(accounts.slice(-named(m).length)).toEqual(named(m));
    });

    // The sell, every token bought: the trader's transfer into the vault is the router's, so the hook's accounts are its input hook accounts.
    await box(page).getByRole("button", { name: "Make another swap" }).click();
    await box(page).getByRole("button", { name: "Switch the two sides" }).click();
    await expect(box(page).getByText(/^Balance [\d.,MB]+ /)).toBeVisible();
    await box(page).getByRole("button", { name: "Use it all" }).click();
    await expect(box(page).getByRole("button", { name: "Review swap" })).toBeEnabled();
    const sell = await swap("sell", (prepared) => {
      const { accounts, inputHookAccounts } = routerSwap(prepared);
      expect(inputHookAccounts).toBe(named(m).length);
      expect(accounts.slice(-inputHookAccounts)).toEqual(named(m));
    });

    results[m.kind] = { market: m.market, mint: m.mint, hook_program: m.hookProgram, validation: m.validation, extras: m.extras, buy, sell };
    writeFileSync(`${RESULTS}/hooked.json`, `${JSON.stringify(results, null, 2)}\n`);
  });
}
