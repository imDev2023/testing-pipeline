// The ticket's devnet criterion (#125), on the local run against devnet with Canary's container, after
// its sweep: the open bonding curves' notice holds the swap button off until it is ticked, and is asked
// again on the next visit; the outside builder's markets show the `cost` fail at about 49% back; and a
// stranded market has no trade box and says why. The markets are found from the API, not named, since
// devnet moves. The Playwright test wallet holds no key: it connects and reviews, and never signs.
// Its project exists only on a devnet run (playwright.config.ts), never on CI's recorded fixtures.
import { expect, test, type Page } from "@playwright/test";
import { CanaryResults, MarketsPage, type Market } from "terminal-api/contract";
import { screenshot } from "./screenshot";
import { API } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const OUTSIDE_BUILDER = "9mAV3pMKXx67poy98jHizWM6TEeKJ5g48ZeD83xFa1UF";

async function allMarkets(): Promise<Market[]> {
  const all: Market[] = [];
  let before: string | null = null;
  do {
    const page: MarketsPage = MarketsPage.parse(await (await fetch(`${API}/v1/markets?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`)).json());
    all.push(...page.markets);
    before = page.next;
  } while (before);
  return all;
}

const box = (page: Page) => page.getByRole("region", { name: "Swap" });

test("the open bonding curves show the notice and its tick, and the swap button stays off until it is ticked", async ({ page }) => {
  const markets = await allMarkets();
  const withNotice: string[] = [];
  for (const m of markets.filter((m) => m.canary?.lead?.check === "exit_sizes" || m.canary?.lead?.phrase.includes("could not sell back"))) {
    const canary = CanaryResults.parse(await (await fetch(`${API}/v1/markets/${m.address}/canary`)).json());
    if (canary.could_not_sell_back.length) withNotice.push(m.address);
  }
  // The open bonding curves that showed it were stranded by the curve's upgrade of 2026-11-25 (#75); a
  // devnet with no market whose buyer could not sell back has nothing for this test to show.
  test.skip(withNotice.length === 0, "No market on devnet has a Canary result saying a buyer could not sell back.");
  console.log(`markets with the notice: ${withNotice.join(", ")}`);
  await installTestWallet(page, null);
  for (const market of withNotice) {
    await page.goto(`/markets/${market}`);
    const notice = box(page).locator('[data-canary="notice"]');
    await expect(notice).toContainText(/^In Canary's test on \d{1,2} [A-Z][a-z]{2} \d{4}, a wallet that bought/);
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    await box(page).getByLabel("You pay, fees included").fill("0.01");
    await expect(page.getByRole("region", { name: "What this swap costs" }).getByText("Leaves your wallet")).toBeVisible();
    const button = box(page).getByRole("button", { name: "Review swap" });
    await expect(page.getByRole("region", { name: "What this swap costs" }).getByText(/^none yet$/)).toHaveCount(0, { timeout: 20_000 });
    await expect(button).toBeDisabled();
    await expect(box(page).getByText("Tick the box above to say you have read it.")).toBeVisible();
    await screenshot(page, test.info(), "devnet-notice-unticked");
    const tick = notice.getByRole("checkbox", { name: "I have read this" });
    await tick.check();
    await expect(button).toBeEnabled();
    await button.click();
    const review = page.getByRole("region", { name: "Review this swap" });
    await expect(review.getByText(/^The simulation went through\./)).toBeVisible({ timeout: 30_000 });
    await screenshot(page, test.info(), "devnet-notice-ticked-review");
    // Asked again on every visit, and stored nowhere.
    await page.reload();
    await expect(box(page).locator('[data-canary="notice"]').getByRole("checkbox", { name: "I have read this" })).not.toBeChecked();
  }
});

test("the outside builder's markets show the cost fail at about 49% back", async ({ page }) => {
  const markets = (await allMarkets()).filter((m) => m.strategy === OUTSIDE_BUILDER);
  expect(markets.length).toBeGreaterThan(0);
  for (const m of markets) {
    expect(m.canary?.lead).toEqual(expect.objectContaining({ check: "cost", outcome: "fail" }));
    const back = m.canary!.ordinary!.return_ppm / 10_000;
    console.log(`${m.address}: the ordinary trade returns ${back.toFixed(1)}%`);
    expect(back).toBeGreaterThan(45);
    expect(back).toBeLessThan(50);
    await page.goto(`/markets/${m.address}`);
    const cost = page.locator('details[data-check="cost"]');
    await expect(cost).toHaveAttribute("open", "");
    await expect(cost.locator("summary")).toContainText(/fail\s*What a round trip costs/);
    await expect(cost.getByRole("row", { name: /^0\.01 SOL 4\d\.\d% back$/ })).toBeVisible();
  }
  await screenshot(page, test.info(), "devnet-cost-fail");
});

test("stranded markets have no trade box and say why", async ({ page }) => {
  const stranded = (await allMarkets()).filter((m) => m.canary?.stranded);
  expect(stranded.length).toBeGreaterThan(0);
  console.log(`${stranded.length} stranded markets`);
  for (const m of stranded.slice(0, 5)) {
    await page.goto(`/markets/${m.address}`);
    await expect(page.getByRole("region", { name: "This market cannot be traded" })).toContainText(/^This market cannot be traded through Pipeline\. The current version of its strategy, deployed in slot [\d,]+, cannot read this market's state, so it can give no quote and take no swap\./);
    await expect(box(page)).toHaveCount(0);
    await expect(page.locator("header").getByText("the strategy's current version cannot read this market")).toBeVisible();
  }
  await screenshot(page, test.info(), "devnet-stranded");
});
