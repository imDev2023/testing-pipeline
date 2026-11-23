// Search and token names on devnet's data (docs/spec/pipescope-screens.md, "Search" and "Token names
// and images"; PIPESCOPE-22, PIPESCOPE-81, PIPESCOPE-82): the header's box on every page shows grouped
// results as the reader types and Enter opens a page whose address holds the query; addresses match
// from their start or end exactly as typed, names anywhere in any case; groups cap at 20; tokens are
// named by their own metadata in the author's style beside their short address; and a token image is
// served by Aviary's API alone, with nosniff, never wakes Postgres, and is the only image a page asks for.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { Market, MarketsPage, SearchResults } from "terminal-api/contract";
import { SEARCH_EXAMPLES } from "../../../apps/terminal-web/src/config";
import { API, OWN_ORIGINS } from "./target";

// The buy wall AMM's demo market on devnet, and a token that names itself in its own metadata.
const MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const DREAM = "5AMPgS3baS6g4gsgSGwkE2wx9dV6iJNzaCMfpDFNfvM9";
const AUTHOR = "rgb(122, 43, 140)";

const search = async (request: APIRequestContext, q: string) =>
  SearchResults.parse(await (await request.get(`${API}/v1/search?q=${encodeURIComponent(q)}`)).json());

const box = (page: Page) => page.getByRole("banner").getByRole("searchbox", { name: "Search" });
const results = (page: Page) => page.getByRole("region", { name: "Search results" });

test.describe("the header's search box", () => {
  test("is on every page, and shows a market found by the first characters of its address once the reader pauses", async ({ page }) => {
    await page.goto("/devnet");
    await box(page).click();
    await box(page).pressSequentially("7BctW", { delay: 40 });
    const markets = results(page).getByRole("region", { name: /^Markets/ });
    await expect(markets.getByRole("link", { name: "Market 7Bct...5CAK" })).toBeVisible();
    await expect(results(page).getByRole("heading", { name: /^Markets 1$/ })).toBeVisible();
  });

  test("asks the API once for what was typed in one go, not once a keystroke", async ({ page }) => {
    const asked: string[] = [];
    page.on("request", (r) => r.url().startsWith(`${API}/v1/search`) && asked.push(new URL(r.url()).searchParams.get("q")!));
    await page.goto("/devnet");
    await box(page).pressSequentially("a5CAK", { delay: 30 });
    await expect(results(page).getByRole("link", { name: "Market 7Bct...5CAK" })).toBeVisible();
    expect(asked).toEqual(["a5CAK"]);
  });

  test("finds by the last characters of an address, case-sensitively", async ({ page }) => {
    await page.goto("/devnet");
    await box(page).fill("Ga5CAK");
    await expect(results(page).getByRole("link", { name: "Market 7Bct...5CAK" })).toBeVisible();
    await box(page).fill("ga5cak");
    await expect(results(page).getByText(/^Nothing registered with Pipeline on devnet matches/)).toBeVisible();
  });

  test("opens the search page on Enter, its address holding the query", async ({ page }) => {
    await page.goto("/");
    await box(page).fill("pIpE dReAm");
    await box(page).press("Enter");
    await expect(page).toHaveURL("/search?q=pIpE%20dReAm");
    await expect(page.getByRole("heading", { name: "Search", level: 1 })).toBeVisible();
    await expect(results(page)).toHaveCount(0);
    const mints = page.getByRole("region", { name: /^Mints/ });
    await expect(mints.getByText("Pipe Dream").first()).toBeVisible();
  });

  test("says what can be searched for when nothing is typed, and each of its three examples finds something on devnet", async ({ page, request }) => {
    await page.goto("/devnet");
    await box(page).focus();
    const examples = results(page).getByRole("list", { name: "Examples" }).getByRole("link");
    await expect(examples).toHaveText(SEARCH_EXAMPLES.map((e) => e.query));
    for (const { query } of SEARCH_EXAMPLES) {
      const found = await search(request, query);
      expect(found.strategies.total + found.markets.total + found.mints.total, query).toBeGreaterThan(0);
    }
    await examples.first().click();
    await expect(page).toHaveURL(`/search?q=${SEARCH_EXAMPLES[0].query}`);
    await expect(page.getByRole("region", { name: /^Strategies/ }).getByRole("listitem").first()).toBeVisible();
  });

  test("closes on Escape", async ({ page }) => {
    await page.goto("/devnet");
    await box(page).fill("7BctW");
    await expect(results(page)).toBeVisible();
    await box(page).press("Escape");
    await expect(results(page)).toHaveCount(0);
  });
});

test.describe("the search page", () => {
  test("finds a devnet market by the first and by the last characters of its address, case-sensitively", async ({ page, request }) => {
    for (const q of ["7BctW", "C33SCrcGa5CAK"]) {
      expect((await search(request, q)).markets.results.map((m) => m.address)).toContain(MARKET);
      await page.goto(`/search?q=${q}`);
      await expect(page.getByRole("region", { name: /^Markets/ }).getByRole("link", { name: "Market 7Bct...5CAK" })).toBeVisible();
    }
    for (const q of ["7bctw", "c33scrcga5cak", "WoaSumdx"]) expect((await search(request, q)).markets.total, q).toBe(0);
  });

  test("finds a token by part of its name in any case, with the markets it trades on linked", async ({ page, request }) => {
    const found = await search(request, "pE dREA");
    const dream = found.mints.results.find((m) => m.mint === DREAM);
    expect(dream?.token?.name).toBe("Pipe Dream");
    await page.goto("/search?q=pE%20dREA");
    const item = page.getByRole("region", { name: /^Mints/ }).getByRole("listitem").filter({ hasText: "5AMP...fvM9" });
    await expect(item.getByText("DREAM", { exact: true })).toHaveCSS("color", AUTHOR);
    const first = item.getByRole("link").first();
    await first.click();
    await expect(page).toHaveURL(`/markets/${dream!.markets[0]}`);
  });

  test("caps each group at 20 and says how many there are", async ({ page, request }) => {
    const found = await search(request, "e");
    expect(found.mints.total).toBeGreaterThan(20);
    expect(found.mints.results).toHaveLength(20);
    await page.goto("/search?q=e");
    const mints = page.getByRole("region", { name: /^Mints/ });
    await expect(mints.getByRole("list").first().locator(":scope > li")).toHaveCount(20);
    await expect(mints.getByText(`The first 20 of ${found.mints.total}. Type more of the address to narrow it.`)).toBeVisible();
    await expect(page.getByText("Token names are each token's own claim. Aviary names only SOL and USDC itself, and marks no other token as verified, so check the mint address.")).toBeVisible();
  });

  test("says when nothing matches, and why a token may be missing", async ({ page }) => {
    await page.goto("/search?q=Nothing0Here");
    await expect(page.getByText("Nothing registered with Pipeline on devnet matches Nothing0Here.")).toBeVisible();
    await expect(page.getByText("A token that trades on no Pipeline market does not appear here, and two tokens can share one name.")).toBeVisible();
  });
});

test.describe("token names and images", () => {
  test("name a token by its own symbol in the author's style beside its short address, and SOL plainly", async ({ page, request }) => {
    const market = Market.parse(await (await request.get(`${API}/v1/markets/${MARKET}`)).json());
    await page.goto(`/markets/${MARKET}`);
    const heading = page.getByRole("heading", { level: 1 });
    for (const mint of market.mints) {
      if (mint.symbol) await expect(heading.getByText(mint.symbol, { exact: true })).not.toHaveCSS("font-style", "italic");
      else if (mint.token) await expect(heading.getByText(mint.token.symbol ?? mint.token.name!, { exact: true })).toHaveCSS("color", AUTHOR);
      else await expect(heading.getByText(`${mint.mint.slice(0, 4)}...${mint.mint.slice(-4)}`)).toBeVisible();
    }
  });

  test("show every image a page asks for from Aviary's own API, served with nosniff, its type fixed and no script", async ({ page, request }) => {
    // Every market a token with a kept image trades on, from the feed's first pages.
    const { markets } = MarketsPage.parse(await (await request.get(`${API}/v1/markets?limit=200`)).json());
    const pictured = markets.find((m) => m.mints.some((x) => x.token?.image));
    expect(pictured, "a devnet market whose token names an image Aviary keeps").toBeDefined();
    const images: string[] = [];
    page.on("request", (r) => r.resourceType() === "image" && images.push(r.url()));
    await page.goto(`/markets/${pictured!.address}`);
    const hash = pictured!.mints.find((x) => x.token?.image)!.token!.image!;
    const img = page.getByRole("heading", { level: 1 }).locator(`img[src="${API}/images/${hash}"]`);
    await expect(img).toBeVisible();
    expect(await img.evaluate((el: HTMLImageElement) => [el.naturalWidth > 0, el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([true, 20, 20]);
    await page.waitForLoadState("networkidle");
    expect(images.length).toBeGreaterThan(0);
    expect(images.filter((url) => !url.startsWith("data:") && !OWN_ORIGINS.includes(new URL(url).origin))).toEqual([]);

    const served = await request.get(`${API}/images/${hash}`);
    expect(served.status()).toBe(200);
    expect(served.headers()["x-content-type-options"]).toBe("nosniff");
    expect(served.headers()["content-type"]).toMatch(/^image\/(png|jpeg|webp)$/);
    expect(served.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
  });
});
