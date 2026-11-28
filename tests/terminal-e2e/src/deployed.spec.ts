// Every page built so far, on Aviary's hosted devnet deployment (#192; PIPESCOPE-96): at 1440, 390
// and 360 px in the light and the dark theme, each page loads from `terminal-web-devnet`, reads
// devnet's real data through `terminal-api-devnet`, wears the shell, stays inside the window, asks
// nothing of any origin but the deployment's two, and has its screenshot saved for the PR.
//
// Unlike src/pages.spec.ts it seeds nothing: the deployment's database is Neon, the record of what
// the indexer read from devnet, so each page waits only for what real data always shows.
import { expect, test, type Page } from "@playwright/test";
import { CP_MARKET, THREE_MINT_MARKET } from "./markets";
import { screenshot } from "./screenshot";
import { expectShell } from "./shell";
import { DEPLOYED_ORIGINS } from "./deployedTarget";

// Our products' devnet demo markets and strategies (deployments/devnet-demo-*.json), devnet's
// Counterflow strategy, which is none of ours, and an address that is no market.
const BUY_WALL_MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const BUY_WALL_AMM = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const TAX_MARKET = "4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c";
const TAX_AMM = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const LENDING_MARKET = "AMJ4eVWMgqc9hZMmKDipbvwU6EQkmAvhUf4F42dNSDuu";
const CONTAINED_MARKET = "6eqVrhnojqZpW9bZCpYYYRUnxuNUeStTXinNuA6f4yQ3";
const COUNTERFLOW = "9jd6k8HQkcU2jxe2AcTZVLDGccbo3S8Py6e6E6Aee7QP";
const UNKNOWN_ADDRESS = "6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp";

/** The facts panel or section has loaded: each part's heading is there. */
const factsReady = async (page: Page, parts: string[]) => {
  const facts = page.getByRole("region", { name: "Facts" });
  for (const part of parts) await expect(facts.getByRole("heading", { name: part, exact: true })).toBeVisible();
};

/** A market page with its facts and its forms loaded, and its product's panel when it has one. */
const marketReady = (panel?: string) => async (page: Page) => {
  await expect(page.getByRole("link", { name: "Explorer" }).first()).toBeVisible();
  await factsReady(page, ["This market", "Its strategy", "Its mints"]);
  await expect(page.getByRole("region", { name: "Actions" })).toHaveAttribute("aria-busy", "false");
  if (panel) await expect(page.getByRole("region", { name: panel, exact: true }).getByRole("heading").first()).toBeVisible();
};

const PAGES: { name: string; path: string; status: number; ready: (page: Page) => Promise<unknown> }[] = [
  { name: "feed", path: "/", status: 200, ready: (page) => expect(page.getByRole("region", { name: "Markets" }).getByRole("row").nth(1)).toBeVisible() },
  { name: "feed-strategies", path: "/?tab=strategies", status: 200, ready: (page) => expect(page.getByRole("region", { name: "Strategies" }).getByRole("row").nth(1)).toBeVisible() },
  { name: "market", path: `/markets/${CP_MARKET}`, status: 200, ready: marketReady() },
  { name: "market-three-mints", path: `/markets/${THREE_MINT_MARKET}`, status: 200, ready: marketReady() },
  { name: "market-buy-wall", path: `/markets/${BUY_WALL_MARKET}`, status: 200, ready: marketReady("Buy wall AMM") },
  { name: "market-tax", path: `/markets/${TAX_MARKET}`, status: 200, ready: marketReady("Taxes") },
  { name: "market-lending", path: `/markets/${LENDING_MARKET}`, status: 200, ready: marketReady("Lending AMM") },
  { name: "market-contained", path: `/markets/${CONTAINED_MARKET}`, status: 200, ready: marketReady("Containment") },
  {
    name: "strategy",
    path: `/strategies/${BUY_WALL_AMM}`,
    status: 200,
    ready: async (page) => {
      await expect(page.getByRole("region", { name: /^Its markets/ }).getByRole("row").last()).toBeVisible();
      await expect(page.getByRole("region", { name: /^Version history/ }).getByRole("row").last()).toBeVisible();
      await factsReady(page, ["Its program", "Its trust flags", "Instructions beyond Pipeline's own"]);
    },
  },
  { name: "create", path: "/create", status: 200, ready: (page) => expect(page.getByRole("region", { name: "Choose a strategy" }).getByRole("listitem").first()).toBeVisible() },
  { name: "create-tax-launch", path: `/create?strategy=${TAX_AMM}`, status: 200, ready: (page) => expect(page.getByRole("region", { name: "Launch a tax market" })).toBeVisible() },
  { name: "create-buy-wall", path: `/create?strategy=${BUY_WALL_AMM}`, status: 200, ready: (page) => expect(page.getByRole("region", { name: "The create form" }).getByRole("textbox").first()).toBeVisible() },
  { name: "create-form", path: `/create?strategy=${COUNTERFLOW}`, status: 200, ready: (page) => expect(page.getByRole("region", { name: "The create form" }).getByRole("textbox").first()).toBeVisible() },
  { name: "wallet", path: "/wallet", status: 200, ready: (page) => expect(page.getByText(/^Connect a wallet to see what it holds that trades on Pipeline/)).toBeVisible() },
  { name: "search", path: "/search?q=e", status: 200, ready: (page) => expect(page.getByRole("region", { name: /^Mints/ })).toBeVisible() },
  { name: "search-nothing-typed", path: "/search", status: 200, ready: (page) => expect(page.getByRole("list", { name: "Examples" })).toBeVisible() },
  { name: "fees", path: "/fees", status: 200, ready: (page) => expect(page.getByRole("heading", { name: "An example" })).toBeVisible() },
  { name: "devnet-help", path: "/devnet", status: 200, ready: (page) => expect(page.getByRole("heading", { name: "Get devnet USDC" })).toBeVisible() },
  { name: "keeper", path: "/keeper", status: 200, ready: (page) => expect(page.getByRole("heading", { level: 1 })).toBeVisible() },
  { name: "nothing-there", path: `/markets/${UNKNOWN_ADDRESS}`, status: 404, ready: (page) => expect(page.getByText(UNKNOWN_ADDRESS)).toBeVisible() },
  { name: "no-page", path: "/no-such-page", status: 404, ready: (page) => expect(page.getByRole("heading", { name: "No page here" })).toBeVisible() },
];

for (const { name, path, status, ready } of PAGES) {
  test(`${name} on the deployment wears the shell, stays inside the window and calls only the deployment's origins`, async ({ page }, testInfo) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    const failed: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 400 && !response.request().isNavigationRequest()) failed.push(`${response.status()} ${response.url()}`);
    });

    const response = await page.goto(path);
    expect(response?.status()).toBe(status);
    await ready(page);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);

    await expectShell(page, requested, DEPLOYED_ORIGINS);
    // Nothing the page asked for was refused, a 429 from the API's per-IP limits included.
    expect(failed).toEqual([]);
    await screenshot(page, testInfo, name);
  });
}
