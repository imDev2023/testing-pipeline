// Every page this ticket adds, at 1440, 390 and 360 px in the light and the dark theme
// (PIPESCOPE-96): it wears the shell, nothing scrolls sideways, it requests nothing from any origin but
// Aviary's own, fonts included, and its screenshot is saved for the PR.
import { expect, test, type Page } from "@playwright/test";
import { postKeeperHeartbeat, seedKeeperRecords } from "./keeper";
import { screenshot } from "./screenshot";
import { CP_MARKET, REFUSING_MARKET } from "./markets";
import { OWN_ORIGINS } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const UNKNOWN_ADDRESS = "6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp";

// A market and a strategy of devnet's, both in the recorded fixtures: the buy wall AMM's demo market and its strategy.
const MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const STRATEGY = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
// A market no swap has gone through, and one with a single swap, whose lone candle the chart still draws.
const MARKET_WITHOUT_TRADES = "DH7QCdTHGsjHcsm7SgXYRgdQvX34VT8oMQkFWVoCe3SQ";
const MARKET_WITH_ONE_TRADE = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";

/** A market page is ready once its chart, or the panel that stands in for it, and its trades have loaded. */
const marketReady = (chart: "chart" | "none") => async (page: Page) => {
  await expect(page.getByRole("link", { name: "Explorer" }).first()).toBeVisible();
  const trades = page.getByRole("region", { name: "Trades" });
  if (chart === "chart") {
    await expect(page.getByText(/^Built from Pipeline's swap events on this market: [\d,]+ swaps? so far\./)).toBeVisible();
    await expect(trades.getByRole("table")).toBeVisible();
  } else {
    await expect(page.getByText("No swap has gone through Pipeline on this market yet, so there is no price to chart.")).toBeVisible();
    await expect(trades.getByText("No swap has gone through Pipeline on this market yet.")).toBeVisible();
  }
};

/** The trade box on Pipeline's example market, 0.1 SOL typed: quoted, and with the test wallet, reviewed or failed. */
const swapBox = (page: Page) => page.getByRole("region", { name: "Swap" });
const typed = (amount: string, wallet: "connect" | "none", then: "quote" | "review" | "failed" | "refused") => async (page: Page) => {
  await marketReady("chart")(page);
  if (wallet === "connect") await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
  await swapBox(page).getByLabel("You pay, fees included").fill(amount);
  if (then === "refused") return void (await expect(swapBox(page).getByText(/^No quote: /)).toBeVisible());
  await expect(page.getByRole("region", { name: "What this swap costs" }).getByText("Leaves your wallet")).toBeVisible();
  await expect(swapBox(page).getByRole("button", { name: wallet === "connect" ? "Review swap" : "Connect wallet" })).toBeEnabled();
  if (then === "quote") return;
  await swapBox(page).getByRole("button", { name: "Review swap" }).click();
  const review = page.getByRole("region", { name: "Review this swap" });
  if (then === "review") await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeEnabled();
  else {
    await expect(review.getByText("The simulation failed, so there is nothing to sign.")).toBeVisible();
    await review.getByText(/^The program's last \d+ log lines?$/).click();
  }
};

const PAGES: { name: string; path: string; status: number; ready: (page: Page) => Promise<unknown>; wallet?: boolean }[] = [
  { name: "feed", path: "/", status: 200, ready: (page: Page) => expect(page.getByRole("region", { name: "Markets" }).getByRole("row").nth(1)).toBeVisible() },
  { name: "feed-strategies", path: "/?tab=strategies", status: 200, ready: (page: Page) => expect(page.getByRole("region", { name: "Strategies" }).getByRole("row").nth(1)).toBeVisible() },
  { name: "market", path: `/markets/${MARKET}`, status: 200, ready: marketReady("chart") },
  { name: "market-flipped", path: `/markets/${MARKET}?flip=1&interval=1h`, status: 200, ready: marketReady("chart") },
  { name: "market-one-trade", path: `/markets/${MARKET_WITH_ONE_TRADE}`, status: 200, ready: marketReady("chart") },
  { name: "market-no-trades", path: `/markets/${MARKET_WITHOUT_TRADES}`, status: 200, ready: marketReady("none") },
  { name: "market-trade-quote", path: `/markets/${CP_MARKET}`, status: 200, ready: typed("0.1", "none", "quote"), wallet: true },
  { name: "market-trade-review", path: `/markets/${CP_MARKET}`, status: 200, ready: typed("0.1", "connect", "review"), wallet: true },
  { name: "market-trade-too-little", path: `/markets/${CP_MARKET}`, status: 200, ready: typed("500", "connect", "failed"), wallet: true },
  { name: "market-trade-refused", path: `/markets/${REFUSING_MARKET}`, status: 200, ready: typed("0.01", "connect", "refused"), wallet: true },
  { name: "strategy", path: `/strategies/${STRATEGY}`, status: 200, ready: (page: Page) => expect(page.getByRole("heading", { name: "Strategy", exact: true })).toBeVisible() },
  { name: "fees", path: "/fees", status: 200, ready: (page: Page) => expect(page.getByRole("heading", { name: "An example" })).toBeVisible() },
  { name: "devnet-help", path: "/devnet", status: 200, ready: (page: Page) => expect(page.getByRole("heading", { name: "Get devnet USDC" })).toBeVisible() },
  { name: "keeper", path: "/keeper", status: 200, ready: (page: Page) => expect(page.getByRole("region", { name: "Latest jobs" }).getByRole("table")).toBeVisible() },
  { name: "nothing-there", path: `/markets/${UNKNOWN_ADDRESS}`, status: 404, ready: (page: Page) => expect(page.getByText(UNKNOWN_ADDRESS)).toBeVisible() },
  { name: "no-page", path: "/no-such-page", status: 404, ready: (page: Page) => expect(page.getByRole("heading", { name: "No page here" })).toBeVisible() },
];

// The keeper page shows the test keeper's records and its latest heartbeat (src/keeper.ts).
test.beforeAll(async () => {
  await seedKeeperRecords();
  await postKeeperHeartbeat();
});

for (const { name, path, status, ready, wallet } of PAGES) {
  test(`${name} wears the shell, stays inside the window and calls only Aviary's own origins`, async ({ page }, testInfo) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    // The Playwright test wallet, holding no key: it connects and reviews as recorded, and never signs.
    if (wallet) await installTestWallet(page, null);

    const response = await page.goto(path);
    expect(response?.status()).toBe(status);
    await ready(page);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);

    // The header: the name, linking to the feed, and the devnet tag.
    const header = page.getByRole("banner");
    const brand = header.getByRole("link").filter({ hasNotText: "Skip to the page" }).first();
    await expect(brand).toHaveAttribute("href", "/");
    await expect(brand).not.toHaveText("");
    await expect(header.getByText("devnet", { exact: true })).toBeVisible();

    // The header's wallet button.
    await expect(header.getByRole("button", { name: /^(Connect wallet|E69P\.\.\.JnAW)$/ })).toBeVisible();

    // The footer: the three styles of "Who is speaking", the devnet line, Fees, Devnet help and the theme control.
    const footer = page.getByRole("contentinfo");
    await expect(footer.getByText(/^Plain text was read from the chain or measured by /)).toBeVisible();
    await expect(footer.getByText("Text set like this was written by an AI from those facts.")).toBeVisible();
    await expect(footer.getByText("Text like this was written by a strategy's or token's author and is not verified.")).toBeVisible();
    await expect(footer.getByText(/^Devnet only\. .+ never holds your keys: every transaction is signed in your own wallet, after a simulation you see first\.$/)).toBeVisible();
    await expect(footer.getByRole("link", { name: "Fees" })).toHaveAttribute("href", "/fees");
    await expect(footer.getByRole("link", { name: "Devnet help" })).toBeVisible();
    await expect(footer.getByRole("link", { name: "Keeper" })).toHaveAttribute("href", "/keeper");
    await expect(footer.getByRole("radio")).toHaveCount(3);

    // Nothing scrolls sideways at any width down to 360 px.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);

    // Every request went to Aviary's own origins, and both typefaces came from there and loaded.
    const foreign = requested.filter((url) => !url.startsWith("data:") && !OWN_ORIGINS.includes(new URL(url).origin));
    expect(foreign).toEqual([]);
    const fonts = requested.filter((url) => url.endsWith(".woff2"));
    expect(fonts.length).toBeGreaterThan(0);
    const loaded = await page.evaluate(() => [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', "")));
    expect(loaded).toEqual(expect.arrayContaining(["Archivo", "Literata"]));

    await screenshot(page, testInfo, name);
  });
}
