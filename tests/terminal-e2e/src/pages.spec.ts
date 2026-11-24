// Every page this ticket adds, at 1440, 390 and 360 px in the light and the dark theme
// (PIPESCOPE-96): it wears the shell, nothing scrolls sideways, it requests nothing from any origin but
// Aviary's own, fonts included, and its screenshot is saved for the PR.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { postKeeperHeartbeat, seedKeeperRecords } from "./keeper";
import { screenshot } from "./screenshot";
import { CP_MARKET, REFUSING_MARKET } from "./markets";
import { OWN_ORIGINS } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const UNKNOWN_ADDRESS = "6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp";

// A market and a strategy of devnet's, both in the recorded fixtures: the buy wall AMM's demo market and its strategy.
const MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const STRATEGY = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
// A strategy whose metadata link does not answer, and a market whose token has a transfer hook and a transfer fee.
const STRATEGY_UNAVAILABLE = "yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx";
const MARKET_HOOKED = "8XUe71aQTkUrP8SZfL2Z6PuXgdzYe9szTLEqiExrVyMW";
// Aviary's token-image check market on devnet (deployments/devnet-demo-token-image.json): its token names an image Aviary keeps.
const MARKET_TOKEN_IMAGE = "4DZbJgcdZyZUoYxKsN8atmMjTipBQ3zd6Yjzkp2i5HsR";
// Markets whose strategy's metadata is unreachable, fails Pipeline's validator, or holds Pipeline's old
// `actions` section (PIPESCOPE-141); and the tax AMM's demo market (deployments/devnet-demo-tax-amm.json),
// with its demo token, the tax side, and the suite share's wallet, whose slot anyone may pay out.
const MARKET_METADATA_UNREACHABLE = "ChLMN5jumUA3E9WBmoXUNma3SJk4sgUmWpzhAS2ifv69";
const MARKET_METADATA_INVALID = "CmDa9bCsmeDHNUp2KYv9DEGMA2nhQcxCkwQoZ7GfagVh";
const MARKET_OLD_ACTIONS = "EdMom6pkDgCgXZFSmrEadPRnZDEyqbAg9xDVKrnusSQT";
const TAX_MARKET = "4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c";
const TAX_TOKEN = "4KA1vmioSNTyGu2fsH1vaUQDMa3cC5jYDdGaRLUcHJdo";
const SUITE_TREASURY = "CbqE9TtDJf67xFnXybBrzV6Tg4Mw71hX2VhWcm4R9VZF";
const TAX_AMM = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
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

/** The strategy's forms under Actions have loaded: its forms, or why it has none. */
const actionsReady = (page: Page) => expect(page.getByRole("region", { name: "Actions" })).toHaveAttribute("aria-busy", "false");

/** A market page is ready once its chart, or the panel that stands in for it, its trades, its forms and its facts have loaded. */
const marketReady = (chart: "chart" | "none") => async (page: Page) => {
  await expect(page.getByRole("link", { name: "Explorer" }).first()).toBeVisible();
  await factsReady(page, ["This market", "Its strategy", "Its mints"]);
  await actionsReady(page);
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

/** One of a market page's action forms, by its author's label, opened. */
const actionForm = async (page: Page, label: string) => {
  const form = page.locator("details").filter({ has: page.locator("summary").getByText(label, { exact: true }) });
  if ((await form.getAttribute("open")) === null) await form.locator("summary").click();
  return form;
};

/** The tax AMM's demo market with the test wallet: an action's form filled and simulated, its review passed or refused. */
const actionReviewed = (label: string, inputs: Record<string, string>, args: Record<string, string>, then: "passed" | "refused") => async (page: Page) => {
  await marketReady("chart")(page);
  await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
  const form = await actionForm(page, label);
  for (const [name, value] of Object.entries(inputs)) await form.getByRole("textbox", { name: new RegExp(`^${name} an? `) }).fill(value);
  for (const [name, value] of Object.entries(args)) await form.getByRole("textbox", { name: new RegExp(` ${name} (u8|u16|u64|pubkey)`) }).fill(value);
  await form.getByRole("button", { name: "Simulate this action" }).click();
  const review = form.getByRole("region", { name: "Review this action" });
  if (then === "passed") {
    await expect(review.getByText(/This is what signing would change in your wallet:$/)).toBeVisible({ timeout: 30_000 });
    await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeEnabled();
  } else {
    await expect(review.getByText("The simulation failed, so there is nothing to sign.")).toBeVisible({ timeout: 30_000 });
    await review.getByText(/^The program's last \d+ log lines?$/).click();
  }
  await form.scrollIntoViewIfNeeded();
};

const PAGES: { name: string; path: string; status: number; ready: (page: Page) => Promise<unknown>; wallet?: boolean }[] = [
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
  {
    name: "market-forms-unavailable",
    path: `/markets/${MARKET_METADATA_UNREACHABLE}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      await expect(page.getByText("No forms. Aviary builds a strategy's forms from its metadata, and this strategy's metadata is unavailable: the link could not be fetched.")).toBeVisible();
      await page.getByText("What fetching the link found").click();
    },
  },
  {
    name: "market-forms-invalid",
    path: `/markets/${MARKET_METADATA_INVALID}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      await expect(page.getByText(/this strategy's metadata is unavailable: the document did not pass Pipeline's validator\.$/)).toBeVisible();
      await page.getByText("What Pipeline's validator said").click();
    },
  },
  {
    name: "market-forms-old-actions",
    path: `/markets/${MARKET_OLD_ACTIONS}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      await expect(page.getByText("These forms come from the metadata's older actions section, which Pipeline no longer reads.")).toBeVisible();
    },
  },
  {
    name: "market-forms-review",
    path: `/markets/${TAX_MARKET}`,
    status: 200,
    ready: actionReviewed("Pay out a tax slot", { tax_mint: TAX_TOKEN, recipient: SUITE_TREASURY }, { slot: "5" }, "passed"),
    wallet: true,
  },
  {
    name: "market-forms-refused",
    path: `/markets/${TAX_MARKET}`,
    status: 200,
    ready: actionReviewed("Change the taxes", {}, { buy_tax_bps: "600", sell_tax_bps: "900" }, "refused"),
    wallet: true,
  },
  { name: "create", path: "/create", status: 200, ready: (page: Page) => expect(page.getByRole("region", { name: "Choose a strategy" }).getByRole("listitem").first()).toBeVisible() },
  {
    name: "create-form",
    path: `/create?strategy=${TAX_AMM}`,
    status: 200,
    ready: async (page: Page) => {
      const form = page.getByRole("region", { name: "The create form" });
      await form.getByRole("textbox", { name: /^mint_0 a mint/ }).fill(WSOL_MINT);
      await expect(form.getByLabel("The facts of mint_0")).toBeVisible();
    },
  },
  { name: "market-no-trades", path: `/markets/${MARKET_WITHOUT_TRADES}`, status: 200, ready: marketReady("none") },
  { name: "market-trade-quote", path: `/markets/${CP_MARKET}`, status: 200, ready: typed("0.1", "none", "quote"), wallet: true },
  { name: "market-trade-review", path: `/markets/${CP_MARKET}`, status: 200, ready: typed("0.1", "connect", "review"), wallet: true },
  { name: "market-trade-too-little", path: `/markets/${CP_MARKET}`, status: 200, ready: typed("500", "connect", "failed"), wallet: true },
  { name: "market-trade-refused", path: `/markets/${REFUSING_MARKET}`, status: 200, ready: typed("0.01", "connect", "refused"), wallet: true },
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
    await expect(header.getByRole("searchbox", { name: "Search" })).toBeVisible();

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
