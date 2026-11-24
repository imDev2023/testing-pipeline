// The devnet demo of #121: with the Playwright test wallet holding the test trader's devnet key, a
// buy paid in SOL and a sell back go through the trade box on Pipeline's example constant-product
// market; and #122's: a market of three mints is traded between each pair, in all six directions. Each trade must reach Trades within seconds through the fast path; 0.1 SOL typed must be
// exactly what leaves the wallet for the swap, split as the screens show; and the fee wallet's
// wrapped-SOL account must receive the integrator fee on the buy and nothing on the sell. It sends
// real devnet transactions, so its project exists only when asked for (`pnpm --filter terminal-e2e
// swaps:devnet`, E2E_SWAPS), never in CI; each signature is written to test-results/swaps.json for the PR.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { address, createSolanaRpc } from "@solana/kit";
import { Fees, TradesPage, type Trade } from "terminal-api/contract";
import { screenshot } from "./screenshot";
import { API } from "./target";
import { CP_MARKET, THREE_MINT_MARKET, THREE_MINT_PAIRS, THREE_MINTS, WSOL } from "./markets";
import { connectTestWallet, installTestWallet, testTraderSigner, TEST_TRADER } from "./wallet";

const rpc = () => createSolanaRpc(process.env.RPC_URL ?? "");
const box = (page: Page) => page.getByRole("region", { name: "Swap" });

async function feeAccountBalance(): Promise<bigint> {
  const fees = Fees.parse(await (await fetch(`${API}/v1/fees`)).json());
  const account = fees.fee_mints.find((m) => m.mint === WSOL)!.account;
  return BigInt((await rpc().getTokenAccountBalance(address(account), { commitment: "confirmed" }).send()).value.amount);
}

/** The trader's lamports before and after a transaction, and its fee, as the chain recorded them. */
async function onChain(signature: string) {
  for (let attempt = 0; ; attempt++) {
    const tx = await rpc().getTransaction(signature as never, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
    if (tx?.meta) {
      const keys = tx.transaction.message.accountKeys.map(String);
      const i = keys.indexOf(TEST_TRADER);
      return { before: tx.meta.preBalances[i]!, after: tx.meta.postBalances[i]!, fee: tx.meta.fee, slot: tx.slot };
    }
    if (attempt > 30) throw new Error(`${signature} was not served`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

const swaps: Record<string, unknown> = {};
/** Writes every signature so far to test-results/swaps.json, for the PR. */
const save = () => {
  mkdirSync(`${import.meta.dirname}/../test-results`, { recursive: true });
  writeFileSync(`${import.meta.dirname}/../test-results/swaps.json`, `${JSON.stringify(swaps, (_, v: unknown) => (typeof v === "bigint" ? String(v) : v), 2)}\n`);
};

/** The trade as the indexer wrote it, with its place in its block, once it has. */
async function indexedOn(market: string, signature: string): Promise<Trade> {
  for (let attempt = 0; ; attempt++) {
    const { trades } = TradesPage.parse(await (await fetch(`${API}/v1/markets/${market}/trades?limit=10`)).json());
    const found = trades.find((t) => t.signature === signature && t.block_index !== null);
    if (found) return found;
    if (attempt > 30) throw new Error(`${signature} was not indexed`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}

test.describe.configure({ mode: "serial" });

test.describe("swaps through the trade box on devnet", () => {
  /** Reviews the swap typed, signs it with the test wallet and waits for the fast path's answer; returns its signature and how long it took to reach Trades. */
  async function swap(page: Page, name: string) {
    await box(page).getByRole("button", { name: "Review swap" }).click();
    const review = page.getByRole("region", { name: "Review this swap" });
    await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeEnabled({ timeout: 30_000 });
    await screenshot(page, test.info(), `${name}-review`);
    const signed = Date.now();
    await review.getByRole("button", { name: "Sign in wallet" }).click();
    await expect(review.getByText(/^Confirmed in slot [\d,]+\. The trade is at the top of Trades\.$/)).toBeVisible({ timeout: 70_000 });
    const href = await review.getByRole("link", { name: /Transaction .* on the explorer/ }).getAttribute("href");
    const signature = decodeURIComponent(new URL(href!).pathname.split("/").pop()!);
    const trades = page.getByRole("region", { name: "Trades" });
    await expect(trades.getByRole("row").nth(1).getByRole("link", { name: signature.slice(0, 4) + "..." + signature.slice(-4) })).toBeVisible();
    const seconds = (Date.now() - signed) / 1000;
    await screenshot(page, test.info(), `${name}-confirmed`);
    return { signature, seconds };
  }

  test("a buy paid in SOL and a sell back, each in Trades within seconds, with the integrator fee only on the buy", async ({ page }) => {
    test.setTimeout(240_000);
    await installTestWallet(page, await testTraderSigner());
    await page.goto(`/markets/${CP_MARKET}`);
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    await expect(box(page).getByText(/^Balance [\d.,]+ SOL$/)).toBeVisible();

    // The buy: 0.1 SOL typed.
    const feesBefore = await feeAccountBalance();
    await box(page).getByLabel("You pay, fees included").fill("0.1");
    await expect(box(page).getByRole("button", { name: "Review swap" })).toBeEnabled();
    const buy = await swap(page, "buy");
    const buyChain = await onChain(buy.signature);
    const feesAfterBuy = await feeAccountBalance();

    // The trade the fast path served is the indexer's, with the screens' split: 0.1 SOL in all.
    const indexed = (signature: string) => indexedOn(CP_MARKET, signature);
    const bought = await indexed(buy.signature);
    expect(BigInt(bought.net_sent) + BigInt(bought.pipeline_fee) + BigInt(bought.integrator_fee)).toBe(100_000_000n);
    expect(bought).toMatchObject({ net_sent: "99255583", pipeline_fee: "248139", integrator_fee: "496278", side: "buy" });
    expect(feesAfterBuy - feesBefore).toBe(496_278n);
    // On chain the wallet paid 0.1 SOL for the swap, plus the network fee and any rent for its new token account.
    const rent = BigInt(buyChain.before) - BigInt(buyChain.after) - 100_000_000n - BigInt(buyChain.fee);
    expect(rent >= 0n && rent < 3_000_000n).toBe(true);

    // The sell: every unit of the token bought, back into SOL.
    await box(page).getByRole("button", { name: "Make another swap" }).click();
    await box(page).getByRole("button", { name: "Switch the two sides" }).click();
    await expect(box(page).getByText(/^Balance [\d.,MB]+ /)).toBeVisible();
    await box(page).getByRole("button", { name: "Use it all" }).click();
    await expect(box(page).getByRole("button", { name: "Review swap" })).toBeEnabled();
    const sell = await swap(page, "sell");
    const sold = await indexed(sell.signature);
    const feesAfterSell = await feeAccountBalance();
    expect(sold).toMatchObject({ side: "sell", integrator_fee: "0", integrator: null, input_mint: bought.output_mint, output_mint: WSOL });
    expect(feesAfterSell).toBe(feesAfterBuy);

    // The provisional row was replaced in place: each trade shows once.
    const rows = page.getByRole("region", { name: "Trades" }).getByRole("row");
    for (const s of [buy.signature, sell.signature]) await expect(rows.filter({ has: page.getByRole("link", { name: s.slice(0, 4) + "..." + s.slice(-4) }) })).toHaveCount(1);

    Object.assign(swaps, {
      market: CP_MARKET,
      trader: TEST_TRADER,
      buy: { ...buy, trade: bought, wallet_lamports: buyChain, fee_account_received: String(feesAfterBuy - feesBefore) },
      sell: { ...sell, trade: sold, fee_account_received: String(feesAfterSell - feesAfterBuy) },
    });
    save();
    console.log(JSON.stringify({ buy: buy.signature, buy_seconds: buy.seconds, sell: sell.signature, sell_seconds: sell.seconds }));
  });

  test("a market of three mints traded between each pair, in all six directions (#122)", async ({ page }) => {
    test.setTimeout(600_000);
    await installTestWallet(page, await testTraderSigner());
    await page.goto(`/markets/${THREE_MINT_MARKET}`);
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    const done: { from: string; to: string; signature: string; seconds: number; trade: Trade }[] = [];
    for (const [i, { from, to, amount }] of THREE_MINT_PAIRS.entries()) {
      if (i > 0) await box(page).getByRole("button", { name: "Make another swap" }).click();
      await box(page).getByLabel("Mint to pay with").selectOption(THREE_MINTS[from]);
      await box(page).getByLabel("Mint to receive").selectOption(THREE_MINTS[to]);
      await box(page).getByLabel("You pay, fees included").fill(amount);
      await expect(box(page).getByRole("button", { name: "Review swap" })).toBeEnabled();
      const traded = await swap(page, `three-${from}-${to}`);
      const trade = await indexedOn(THREE_MINT_MARKET, traded.signature);
      expect(trade).toMatchObject({ input_mint: THREE_MINTS[from], output_mint: THREE_MINTS[to], integrator_fee: "0" });
      done.push({ from, to, ...traded, trade });
    }
    swaps.three_mints = { market: THREE_MINT_MARKET, trader: TEST_TRADER, swaps: done };
    save();
    console.log(JSON.stringify(done.map((d) => ({ [`${d.from}->${d.to}`]: d.signature, seconds: d.seconds }))));
  });
});
