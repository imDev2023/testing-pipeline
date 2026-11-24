// The wallet page (docs/spec/pipescope-screens.md, Wallet page; #122) with the Playwright test wallet
// (PIPESCOPE-94): without a wallet, its one sentence and "Connect wallet"; with one, the head, the
// unwrap offer and its review, what the wallet holds that trades on Pipeline with its markets and
// the count of tokens no market trades, and its swaps through Pipeline, paged, each as the API serves
// it. Nothing here sends a transaction, so it runs on the recorded fixtures in CI as on devnet; the
// unwrap signed on devnet is src/wallet-devnet.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { Holdings, PreparedUnwrap, TraderTradesPage } from "terminal-api/contract";
import { formatTokenAmount } from "../../../apps/terminal-web/src/format";
import { API } from "./target";
import { connectTestWallet, installTestWallet, TEST_TRADER } from "./wallet";

const holdingsPanel = (page: Page) => page.getByRole("region", { name: "What you hold that trades on Pipeline" });
const swapsPanel = (page: Page) => page.getByRole("region", { name: "Your swaps through Pipeline" });
const getJson = async (path: string) => (await fetch(`${API}${path}`)).json();

async function openConnected(page: Page) {
  const wallet = await installTestWallet(page, null);
  await page.goto("/wallet");
  await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  await expect(page.getByRole("banner").getByRole("button", { name: /E69P\.\.\.JnAW/ })).toBeVisible();
  return wallet;
}

test.describe("the wallet page", () => {
  test("says what it shows and offers to connect when no wallet is connected; the header links to it", async ({ page }) => {
    await installTestWallet(page, null);
    await page.goto("/");
    await page.getByRole("banner").getByRole("link", { name: "Wallet" }).click();
    await expect(page).toHaveURL(/\/wallet$/);
    await expect(page.getByRole("heading", { level: 1, name: "Wallet" })).toBeVisible();
    await expect(page.getByText("Connect a wallet to see what it holds that trades on Pipeline, and every swap it made through Pipeline's router.")).toBeVisible();
    await page.getByRole("main").getByRole("button", { name: "Connect wallet" }).click();
    await expect(page.getByRole("menuitem", { name: "Aviary Test Wallet" })).toBeVisible();
  });

  test("shows the connected wallet's whole address with Copy and the explorer, its SOL, and Disconnect", async ({ page }) => {
    await openConnected(page);
    const holdings = Holdings.parse(await getJson(`/v1/traders/${TEST_TRADER}/holdings`));
    const head = page.getByRole("region", { name: "This wallet" });
    await expect(head.getByText(TEST_TRADER.slice(0, 22))).toBeVisible();
    await expect(head.getByRole("button", { name: "Copy" })).toBeVisible();
    await expect(head.getByRole("link", { name: "Explorer" })).toHaveAttribute("href", `https://explorer.solana.com/address/${TEST_TRADER}?cluster=devnet`);
    await expect(head.getByText(`${formatTokenAmount(BigInt(holdings.sol), 9)} SOL`)).toBeVisible();
    await head.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByRole("main").getByRole("button", { name: "Connect wallet" })).toBeVisible();
    await expect(page.getByRole("banner").getByRole("button", { name: "Connect wallet" })).toBeVisible();
  });

  test("lists what the wallet holds that trades on Pipeline, each token with its balance and markets, and counts the rest", async ({ page }) => {
    await openConnected(page);
    const holdings = Holdings.parse(await getJson(`/v1/traders/${TEST_TRADER}/holdings`));
    expect(holdings.holdings.length).toBeGreaterThan(0);
    const rows = holdingsPanel(page).getByRole("row");
    await expect(rows).toHaveCount(holdings.holdings.length + 1);
    for (const [i, h] of holdings.holdings.entries()) {
      const row = rows.nth(i + 1);
      await expect(row.getByRole("cell").nth(1)).toHaveText(`Balance${formatTokenAmount(BigInt(h.amount), h.decimals)}`);
      await expect(row.getByRole("link")).toHaveCount(h.markets.length);
      for (const market of h.markets) await expect(row.locator(`a[href="/markets/${market}"]`)).toBeVisible();
    }
    const unlisted = holdings.not_listed;
    await expect(holdingsPanel(page).getByText(/Balances are in tokens; there are no dollar prices on devnet\.$/)).toHaveText(
      unlisted === 0
        ? "Balances are in tokens; there are no dollar prices on devnet."
        : `${unlisted} ${unlisted === 1 ? "token in this wallet is not listed because no Pipeline market trades it" : "tokens in this wallet are not listed because no Pipeline market trades them"}. Balances are in tokens; there are no dollar prices on devnet.`,
    );
  });

  test("lists the wallet's swaps through Pipeline as the API serves them, newest first, with fees and transactions, and pages back", async ({ page }) => {
    await openConnected(page);
    const first = TraderTradesPage.parse(await getJson(`/v1/traders/${TEST_TRADER}/trades?limit=40`));
    expect(first.trades.length).toBeGreaterThan(0);
    const rows = swapsPanel(page).getByRole("row");
    await expect(rows).toHaveCount(first.trades.length + 1);
    for (const [i, t] of first.trades.entries()) {
      const row = rows.nth(i + 1);
      await expect(row.getByRole("link", { name: `${t.signature.slice(0, 4)}...${t.signature.slice(-4)}` })).toHaveAttribute("href", `https://explorer.solana.com/tx/${t.signature}?cluster=devnet`);
      await expect(row.locator(`a[href="/markets/${t.market}"]`)).toBeVisible();
      await expect(row.getByText(/^Pipeline /)).toBeVisible();
    }
    await expect(swapsPanel(page).getByText("Every swap this wallet made through Pipeline's router, on Aviary or anywhere else. Trades that bypass the router leave no swap event and are not here.")).toBeVisible();
    if (first.next) {
      const earlier = TraderTradesPage.parse(await getJson(`/v1/traders/${TEST_TRADER}/trades?limit=40&before=${encodeURIComponent(first.next)}`));
      await swapsPanel(page).getByRole("button", { name: "Show earlier swaps" }).click();
      await expect(rows).toHaveCount(first.trades.length + earlier.trades.length + 1);
    } else {
      await expect(swapsPanel(page).getByRole("button", { name: "Show earlier swaps" })).toHaveCount(0);
    }
  });

  test("offers to unwrap the wallet's wrapped SOL, simulates it first, and a declined signature changes nothing", async ({ page }) => {
    const wallet = await openConnected(page);
    const holdings = Holdings.parse(await getJson(`/v1/traders/${TEST_TRADER}/holdings`));
    expect(holdings.wrapped_sol).not.toBeNull();
    const unwrap = page.getByRole("region", { name: "Wrapped SOL" });
    await expect(unwrap.getByText(`This wallet holds ${formatTokenAmount(BigInt(holdings.wrapped_sol!.amount), 9)} SOL as wrapped SOL`)).toBeVisible();
    const preparing = page.waitForResponse((r) => r.url().endsWith("/v1/unwrap/prepare"));
    await unwrap.getByRole("button", { name: "Unwrap" }).click();
    const prepared = PreparedUnwrap.parse(await (await preparing).json());
    expect(prepared.simulation.ok).toBe(true);
    expect(BigInt(prepared.simulation.returned!)).toBeGreaterThan(BigInt(holdings.wrapped_sol!.amount));
    await expect(unwrap.getByText(/^The simulation went through\. It used [\d,]+ compute units\. This is what signing would change in your wallet:$/)).toBeVisible();
    const rows = unwrap.locator("dl > div");
    await expect(rows.filter({ hasText: "Wrapped SOL unwrapped" }).locator("dd")).toHaveText(`${formatTokenAmount(BigInt(prepared.wrapped), 9)} SOL`);
    await expect(rows.filter({ hasText: "Comes back as SOL, with the rent" }).locator("dd")).toHaveText(`${formatTokenAmount(BigInt(prepared.simulation.returned!), 9)} SOL`);
    await expect(rows.filter({ hasText: "Network fee" }).locator("dd")).toHaveText("0.000005 SOL");
    await expect(unwrap.getByText("Signed in your own wallet. Aviary never holds your keys.")).toBeVisible();

    wallet.declineNext();
    await unwrap.getByRole("button", { name: "Sign in wallet" }).click();
    await expect(unwrap.getByText("Your wallet did not sign it, so nothing was sent and nothing has changed.")).toBeVisible();
    await expect(unwrap.getByRole("button", { name: "Sign in wallet" })).toBeEnabled();
    expect(wallet.requests).toHaveLength(1);
    expect(wallet.sent).toHaveLength(0);
    await unwrap.getByRole("button", { name: "Back" }).click();
    await expect(unwrap.getByRole("button", { name: "Unwrap" })).toBeVisible();
  });
});
