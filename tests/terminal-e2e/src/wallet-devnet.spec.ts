// The wallet page's devnet demo (#122): the Playwright test wallet holds the project's devnet wallet
// (~/.config/testing-pipeline/devnet/wallet.json). The swaps the page lists, every page of them, are
// exactly the hosted API's `/v1/traders/{address}/trades` for that wallet, Pipeline's own record
// (PIPESCOPE-93, a test oracle); then its wrapped SOL is unwrapped from the page, signed with the test
// wallet, and the wallet holds no wrapped SOL after; then the same amount is wrapped back, since other
// devnet tests and demos trade from that account (tests/devnet's swap on the demo market). It sends
// real devnet transactions, so its project exists only when asked for (`pnpm --filter terminal-e2e
// wallet:devnet`, E2E_WALLET_DEVNET), never in CI; the signatures go to test-results/unwrap.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { address, createSolanaRpc } from "@solana/kit";
import { Holdings, TraderTradesPage, type Trade } from "terminal-api/contract";
import { wrapSol } from "../demo/wrap-sol.ts";
import { screenshot } from "./screenshot";
import { API } from "./target";
import { connectTestWallet, installTestWallet, projectWalletSigner } from "./wallet";

const HOSTED = "https://pipeline-devnet.up.railway.app";
const WSOL = "So11111111111111111111111111111111111111112";
const swapsPanel = (page: Page) => page.getByRole("region", { name: "Your swaps through Pipeline" });

type HostedTrade = Pick<Trade, "signature" | "slot" | "market" | "trader" | "input_mint" | "output_mint" | "mode" | "net_sent" | "received" | "pipeline_fee" | "fee_mint" | "integrator" | "integrator_fee">;

/** Every swap of `wallet` the hosted API holds, newest first, paged by slot as its docs say. */
async function hostedTrades(wallet: string): Promise<HostedTrade[]> {
  const all: HostedTrade[] = [];
  let before: number | null = null;
  for (;;) {
    const response = await fetch(`${HOSTED}/v1/traders/${wallet}/trades?limit=1000${before === null ? "" : `&before_slot=${before}`}`, { signal: AbortSignal.timeout(30_000) });
    const { trades } = (await response.json()) as { trades: HostedTrade[] };
    all.push(...trades);
    if (trades.length < 1000) return all;
    before = trades.at(-1)!.slot;
  }
}

/** Every swap of `wallet` Aviary's API serves, newest first, through its own cursor. */
async function ourTrades(wallet: string): Promise<Trade[]> {
  const all: Trade[] = [];
  let before: string | null = null;
  for (;;) {
    const page = TraderTradesPage.parse(await (await fetch(`${API}/v1/traders/${wallet}/trades?limit=1000${before ? `&before=${encodeURIComponent(before)}` : ""}`)).json());
    all.push(...page.trades);
    if (!page.next) return all;
    before = page.next;
  }
}

const fields = (t: HostedTrade) => ({
  signature: t.signature,
  slot: t.slot,
  market: t.market,
  trader: t.trader,
  input_mint: t.input_mint,
  output_mint: t.output_mint,
  mode: t.mode,
  net_sent: t.net_sent,
  received: t.received,
  pipeline_fee: t.pipeline_fee,
  fee_mint: t.fee_mint,
  integrator: t.integrator,
  integrator_fee: t.integrator_fee,
});
/** Within a slot neither API promises an order, so both lists are compared in one order of their own. */
const sorted = (trades: HostedTrade[]) => trades.map(fields).sort((a, b) => b.slot - a.slot || a.signature.localeCompare(b.signature));

test.describe.configure({ mode: "serial" });

test.describe("the project's devnet wallet on the wallet page", () => {
  test("lists exactly the swaps the hosted API holds for it, every page of them", async ({ page }) => {
    test.setTimeout(300_000);
    const signer = await projectWalletSigner();
    await installTestWallet(page, signer);
    await page.goto("/wallet");
    await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
    await expect(swapsPanel(page).getByRole("table")).toBeVisible({ timeout: 30_000 });
    // Every page, as a reader would load them.
    const more = swapsPanel(page).getByRole("button", { name: /^(Show earlier swaps|Loading earlier swaps…)$/ });
    while (await more.count()) {
      await more.click();
      await expect(swapsPanel(page).getByRole("button", { name: "Loading earlier swaps…" })).toHaveCount(0, { timeout: 30_000 });
    }
    const shown = await swapsPanel(page)
      .getByRole("row")
      .locator('a[href^="https://explorer.solana.com/tx/"]')
      .evaluateAll((links) => links.map((a) => decodeURIComponent(new URL((a as HTMLAnchorElement).href).pathname.split("/").pop()!)));
    const [ours, theirs] = await Promise.all([ourTrades(signer.address), hostedTrades(signer.address)]);
    expect(theirs.length).toBeGreaterThan(0);
    // The page shows what Aviary's API serves, in its order, and that is what the hosted API holds.
    expect(shown).toEqual(ours.map((t) => t.signature));
    expect(sorted(ours)).toEqual(sorted(theirs));
    await screenshot(page, test.info(), "wallet-devnet-swaps");
    mkdirSync(`${import.meta.dirname}/../test-results`, { recursive: true });
    writeFileSync(`${import.meta.dirname}/../test-results/wallet-swaps.json`, `${JSON.stringify({ wallet: signer.address, shown: shown.length, hosted: theirs.length }, null, 2)}\n`);
  });

  test("unwraps its wrapped SOL from the page, signed with the test wallet", async ({ page }) => {
    test.setTimeout(180_000);
    const signer = await projectWalletSigner();
    const rpc = createSolanaRpc(process.env.RPC_URL ?? "");
    const before = Holdings.parse(await (await fetch(`${API}/v1/traders/${signer.address}/holdings`)).json());
    expect(before.wrapped_sol, "the project's devnet wallet holds no wrapped SOL to unwrap").not.toBeNull();
    await installTestWallet(page, signer);
    await page.goto("/wallet");
    await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
    const unwrap = page.getByRole("region", { name: "Wrapped SOL" });
    await unwrap.getByRole("button", { name: "Unwrap" }).click();
    await expect(unwrap.getByRole("button", { name: "Sign in wallet" })).toBeEnabled({ timeout: 30_000 });
    await screenshot(page, test.info(), "wallet-devnet-unwrap-review");
    await unwrap.getByRole("button", { name: "Sign in wallet" }).click();
    const done = page.getByRole("status", { name: "Unwrapped" });
    await expect(done.getByText(/^Your wrapped SOL is SOL again: confirmed in slot [\d,]+\.$/)).toBeVisible({ timeout: 70_000 });
    const href = await done.getByRole("link", { name: /Transaction .* on the explorer/ }).getAttribute("href");
    const signature = decodeURIComponent(new URL(href!).pathname.split("/").pop()!);
    await expect(unwrap).toHaveCount(0);
    await screenshot(page, test.info(), "wallet-devnet-unwrapped");
    // On chain the wallet holds no wrapped SOL any more.
    const { value: left } = await rpc.getTokenAccountsByOwner(address(signer.address), { mint: address(WSOL) }, { encoding: "jsonParsed", commitment: "confirmed" }).send();
    expect(left).toHaveLength(0);
    // Put back what was unwrapped, as one associated account, for the devnet tests and demos that trade from it.
    const restored = await wrapSol(process.env.RPC_URL ?? "", signer, BigInt(before.wrapped_sol!.amount));
    mkdirSync(`${import.meta.dirname}/../test-results`, { recursive: true });
    writeFileSync(`${import.meta.dirname}/../test-results/unwrap.json`, `${JSON.stringify({ wallet: signer.address, wrapped: before.wrapped_sol!.amount, accounts: before.wrapped_sol!.accounts, signature, restored: restored.signature }, null, 2)}\n`);
    console.log(JSON.stringify({ unwrap: signature, restored: restored.signature }));
  });
});
