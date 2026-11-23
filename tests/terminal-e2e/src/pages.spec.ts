// Every page this ticket adds, at 1440, 390 and 360 px in the light and the dark theme
// (PIPESCOPE-96): it wears the shell, nothing scrolls sideways, it requests nothing from any origin but
// Aviary's own, fonts included, and its screenshot is saved for the PR.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { postKeeperHeartbeat, seedKeeperRecords } from "./keeper";
import { screenshot } from "./screenshot";
import { OWN_ORIGINS } from "./target";

const UNKNOWN_ADDRESS = "6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp";

// A market and a strategy of devnet's, both in the recorded fixtures: the buy wall AMM's demo market and its strategy.
const MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const STRATEGY = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
// A strategy whose metadata link does not answer, and a market whose token has a transfer hook and a transfer fee.
const STRATEGY_UNAVAILABLE = "yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx";
const MARKET_HOOKED = "8XUe71aQTkUrP8SZfL2Z6PuXgdzYe9szTLEqiExrVyMW";
// Aviary's token-image check market on devnet (deployments/devnet-demo-token-image.json): its token names an image Aviary keeps.
const MARKET_TOKEN_IMAGE = "4DZbJgcdZyZUoYxKsN8atmMjTipBQ3zd6Yjzkp2i5HsR";
// A market no swap has gone through, and one with a single swap, whose lone candle the chart still draws.
const MARKET_WITHOUT_TRADES = "DH7QCdTHGsjHcsm7SgXYRgdQvX34VT8oMQkFWVoCe3SQ";
const MARKET_WITH_ONE_TRADE = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";

/** A token image has loaded and has a picture: one that failed is complete too, so its width says. */
const imageLoaded = (img: Locator) => expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

/** The facts panel or section has loaded: each part's heading is there. */
const factsReady = async (page: Page, parts: string[]) => {
  const facts = page.getByRole("region", { name: "Facts" });
  for (const part of parts) await expect(facts.getByRole("heading", { name: part, exact: true })).toBeVisible();
};

/** A market page is ready once its chart, or the panel that stands in for it, its trades and its facts have loaded. */
const marketReady = (chart: "chart" | "none") => async (page: Page) => {
  await expect(page.getByRole("link", { name: "Explorer" }).first()).toBeVisible();
  await factsReady(page, ["This market", "Its strategy", "Its mints"]);
  const trades = page.getByRole("region", { name: "Trades" });
  if (chart === "chart") {
    await expect(page.getByText(/^Built from Pipeline's swap events on this market: [\d,]+ swaps? so far\./)).toBeVisible();
    await expect(trades.getByRole("table")).toBeVisible();
  } else {
    await expect(page.getByText("No swap has gone through Pipeline on this market yet, so there is no price to chart.")).toBeVisible();
    await expect(trades.getByText("No swap has gone through Pipeline on this market yet.")).toBeVisible();
  }
};

const PAGES = [
  { name: "feed", path: "/", status: 200, ready: (page: Page) => expect(page.getByRole("region", { name: "Markets" }).getByRole("row").nth(1)).toBeVisible() },
  {
    name: "feed-filtered",
    path: "/?liquidity=0.1&hide=metadata-unreachable",
    status: 200,
    ready: (page: Page) => expect(page.getByText(/^Showing [\d,]+ of [\d,]+ markets\./)).toBeVisible(),
  },
  { name: "feed-strategies", path: "/?tab=strategies", status: 200, ready: (page: Page) => expect(page.getByRole("region", { name: "Strategies" }).getByRole("row").nth(1)).toBeVisible() },
  { name: "market", path: `/markets/${MARKET}`, status: 200, ready: marketReady("chart") },
  { name: "market-flipped", path: `/markets/${MARKET}?flip=1&interval=1h`, status: 200, ready: marketReady("chart") },
  { name: "market-hooked", path: `/markets/${MARKET_HOOKED}`, status: 200, ready: async (page: Page) => factsReady(page, ["This market", "Its strategy", "Its mints"]) },
  { name: "market-one-trade", path: `/markets/${MARKET_WITH_ONE_TRADE}`, status: 200, ready: marketReady("chart") },
  {
    name: "market-token-image",
    path: `/markets/${MARKET_TOKEN_IMAGE}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      await imageLoaded(page.getByRole("heading", { level: 1 }).locator("img"));
    },
  },
  { name: "market-no-trades", path: `/markets/${MARKET_WITHOUT_TRADES}`, status: 200, ready: marketReady("none") },
  {
    name: "strategy",
    path: `/strategies/${STRATEGY}`,
    status: 200,
    ready: async (page: Page) => {
      // A body row: on a phone the table's head is not a row, so the last row is one either way.
      await expect(page.getByRole("region", { name: /^Its markets/ }).getByRole("row").last()).toBeVisible();
      await expect(page.getByRole("region", { name: /^Version history/ }).getByRole("row").last()).toBeVisible();
      await factsReady(page, ["Its program", "Its trust flags", "Instructions beyond Pipeline's own"]);
      await expect(page.getByRole("list", { name: "Instructions beyond Pipeline's own" })).toBeVisible();
    },
  },
  {
    name: "strategy-unavailable",
    path: `/strategies/${STRATEGY_UNAVAILABLE}`,
    status: 200,
    ready: async (page: Page) => {
      await expect(page.getByText("Metadata unavailable, so it is listed under its address")).toBeVisible();
      await factsReady(page, ["Its program", "Its trust flags", "Instructions beyond Pipeline's own"]);
    },
  },
  {
    name: "search",
    path: "/search?q=e",
    status: 200,
    ready: (page: Page) => expect(page.getByRole("region", { name: /^Mints/ }).getByText(/^The first 20 of [\d,]+\./)).toBeVisible(),
  },
  { name: "search-market", path: "/search?q=7BctW", status: 200, ready: (page: Page) => expect(page.getByRole("link", { name: "Market 7Bct...5CAK" })).toBeVisible() },
  { name: "search-token-image", path: "/search?q=image%20check", status: 200, ready: (page: Page) => imageLoaded(page.getByRole("region", { name: /^Mints/ }).locator("img").first()) },
  { name: "search-nothing-typed", path: "/search", status: 200, ready: (page: Page) => expect(page.getByRole("list", { name: "Examples" })).toBeVisible() },
  { name: "search-no-match", path: "/search?q=Nothing0Here", status: 200, ready: (page: Page) => expect(page.getByText(/^Nothing registered with Pipeline on devnet matches/)).toBeVisible() },
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

for (const { name, path, status, ready } of PAGES) {
  test(`${name} wears the shell, stays inside the window and calls only Aviary's own origins`, async ({ page }, testInfo) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));

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
    await expect(header.getByRole("searchbox", { name: "Search" })).toBeVisible();

    // The footer: the three styles of "Who is speaking", the devnet line, Devnet help and the theme control.
    const footer = page.getByRole("contentinfo");
    await expect(footer.getByText(/^Plain text was read from the chain or measured by /)).toBeVisible();
    await expect(footer.getByText("Text set like this was written by an AI from those facts.")).toBeVisible();
    await expect(footer.getByText("Text like this was written by a strategy's or token's author and is not verified.")).toBeVisible();
    await expect(footer.getByText(/^Devnet only\. .+ never holds your keys: every transaction is signed in your own wallet, after a simulation you see first\.$/)).toBeVisible();
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
