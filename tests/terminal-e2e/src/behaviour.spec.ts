// How the shell behaves (docs/spec/pipescope-screens.md, "Colour and theme" and "On every page"):
// the theme follows the device and the footer overrides it, every colour and typeface comes from
// theme.css, panels load and fail on their own, and the "nothing there" page names the address.
import { expect, test, type Page } from "@playwright/test";
import { MarketsPage, StrategiesList } from "terminal-api/contract";
import { API } from "./target";

// The theme's own values (docs/spec/pipescope-screens.md, "Colour and theme"), as the browser computes them.
const PAPER = { light: "rgb(237, 241, 241)", dark: "rgb(14, 25, 32)" };
const AUTHOR = { light: "rgb(122, 43, 140)", dark: "rgb(221, 169, 236)" };

const paper = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe("the theme", () => {
  test("follows the device's setting", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/devnet");
    expect(await paper(page)).toBe(PAPER.light);
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await paper(page)).toBe(PAPER.dark);
    await expect(page.getByRole("radio", { name: "Device" })).toBeChecked();
  });

  test("is chosen in the footer, light, dark or the device's, and the choice holds on the next page", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/devnet");
    await page.getByRole("radio", { name: "Dark" }).check();
    expect(await paper(page)).toBe(PAPER.dark);

    await page.goto("/");
    expect(await paper(page)).toBe(PAPER.dark);
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();

    await page.emulateMedia({ colorScheme: "dark" });
    await page.getByRole("radio", { name: "Light" }).check();
    expect(await paper(page)).toBe(PAPER.light);

    await page.getByRole("radio", { name: "Device" }).check();
    expect(await paper(page)).toBe(PAPER.dark);
    await page.reload();
    expect(await paper(page)).toBe(PAPER.dark);
    await expect(page.getByRole("radio", { name: "Device" })).toBeChecked();
  });

  test("sets Aviary's words in Archivo, an AI's in Literata and an author's in purple italic", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/devnet");
    const style = (text: string) =>
      page.getByRole("contentinfo").getByText(text, { exact: true }).evaluate((el) => {
        const s = getComputedStyle(el);
        return { family: s.fontFamily.split(",")[0]!.replaceAll('"', ""), colour: s.color, italic: s.fontStyle };
      });
    expect((await style("Devnet help")).family).toBe("Archivo");
    expect((await style("Text set like this was written by an AI from those facts.")).family).toBe("Literata");
    expect(await style("Text like this was written by a strategy's or token's author and is not verified.")).toEqual({ family: "Archivo", colour: AUTHOR.light, italic: "italic" });
    await page.emulateMedia({ colorScheme: "dark" });
    expect((await style("Text like this was written by a strategy's or token's author and is not verified.")).colour).toBe(AUTHOR.dark);
  });
});

test.describe("panels", () => {
  test("a panel that cannot load says what could not be loaded and offers to try again, and the page stays", async ({ page }) => {
    await page.route(`${API}/v1/markets*`, (route) => route.abort("connectionrefused"));
    await page.goto("/");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(/^Could not load the markets and strategies\. .+'s API did not answer\.Try again$/);
    await expect(page.getByRole("heading", { name: "New on Pipeline" })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();

    await page.unroute(`${API}/v1/markets*`);
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("region", { name: "Markets" }).getByRole("row").nth(1)).toBeVisible();
  });

  test("a refused read shows the wait the API named", async ({ page }) => {
    await page.route(`${API}/v1/strategies`, (route) =>
      route.fulfill({
        status: 429,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*", "retry-after": "60" },
        body: JSON.stringify({ error: "Too many requests from your address. Try again in 60 seconds.", retryAfterSeconds: 60 }),
      }),
    );
    await page.goto("/");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText("Could not load the markets and strategies. Too many requests from your address. Try again in 60 seconds.Try again");
  });
});

test.describe("the feed", () => {
  test("says how many markets and strategies there are, as the API counts them, on its head and its tabs", async ({ page, request }) => {
    const { total } = MarketsPage.parse(await (await request.get(`${API}/v1/markets?limit=1`)).json());
    const { strategies } = StrategiesList.parse(await (await request.get(`${API}/v1/strategies`)).json());
    await page.goto("/");
    const n = (x: number) => x.toLocaleString("en-US");
    await expect(page.getByText(`${n(total)} markets on ${n(strategies.length)} strategies, newest first.`, { exact: false })).toBeVisible();
    const tabs = page.getByRole("navigation", { name: "Show" });
    await expect(tabs.getByRole("link", { name: `Markets ${n(total)}` })).toHaveAttribute("aria-current", "page");
    await expect(tabs.getByRole("link", { name: `Strategies ${n(strategies.length)}` })).toBeVisible();
  });

  test("lists the newest market first, and its row opens the market", async ({ page, request }) => {
    const { markets } = MarketsPage.parse(await (await request.get(`${API}/v1/markets?limit=1`)).json());
    await page.goto("/");
    const first = page.getByRole("region", { name: "Markets" }).getByRole("row").nth(1);
    await expect(first).toContainText(`market ${markets[0]!.address.slice(0, 4)}...${markets[0]!.address.slice(-4)}`);
    // The whole row opens the market, not only its first cell: a click where it says when the market was created.
    const created = (await first.getByText(/ago$/).boundingBox())!;
    await page.mouse.click(created.x + created.width / 2, created.y + created.height / 2);
    await expect(page).toHaveURL(`/markets/${markets[0]!.address}`);
    await expect(page.getByRole("link", { name: "Explorer" })).toHaveAttribute("href", `https://explorer.solana.com/address/${markets[0]!.address}?cluster=devnet`);
  });

  test("a market's strategy opens the strategy, from inside the market's row", async ({ page, request }) => {
    const { markets } = MarketsPage.parse(await (await request.get(`${API}/v1/markets?limit=1`)).json());
    await page.goto("/");
    const first = page.getByRole("region", { name: "Markets" }).getByRole("row").nth(1);
    await first.getByRole("link", { name: `${markets[0]!.strategy.slice(0, 4)}...${markets[0]!.strategy.slice(-4)}` }).click();
    await expect(page).toHaveURL(`/strategies/${markets[0]!.strategy}`);
    await expect(page.getByRole("heading", { name: "Strategy", exact: true })).toBeVisible();
  });

  test("loads the markets 50 at a time, and the next 50 on asking", async ({ page }) => {
    await page.goto("/");
    const rows = page.getByRole("region", { name: "Markets" }).getByRole("row");
    await expect(rows).toHaveCount(51);
    await page.getByRole("button", { name: "Show 50 more markets" }).click();
    await expect(rows).toHaveCount(101);
  });

  test("keeps the tab in the page's address, so the strategies can be linked", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Show" }).getByRole("link", { name: /^Strategies/ }).click();
    await expect(page).toHaveURL("/?tab=strategies");
    await page.reload();
    await expect(page.getByRole("region", { name: "Strategies" }).getByRole("row").nth(1)).toBeVisible();
    await page.getByRole("region", { name: "Strategies" }).getByRole("row").nth(1).click();
    await expect(page).toHaveURL(/\/strategies\/[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});

test.describe("keyboard and motion", () => {
  test("the first Tab reaches the skip link, which shows a focus ring", async ({ page }) => {
    await page.goto("/devnet");
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toHaveText("Skip to the page");
    await expect(focused).toBeInViewport();
    const outline = await focused.evaluate((el) => getComputedStyle(el).outlineStyle + " " + getComputedStyle(el).outlineWidth);
    expect(outline).toBe("solid 2px");
  });

  test("every control can be reached by keyboard and shows where the focus is", async ({ page }) => {
    await page.goto("/devnet");
    const reached = new Set<string>();
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const name = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const ring = style.outlineStyle !== "none" && style.outlineWidth !== "0px";
        return `${el.tagName.toLowerCase()}:${(el.textContent || (el as HTMLInputElement).value || "").trim()}:${ring}`;
      });
      if (name) reached.add(name);
    }
    for (const control of ["a:Feed:true", "a:Solana's faucet:true", "a:Circle's faucet:true", "button:Copy:true", "a:Explorer:true", "a:Devnet help:true"]) {
      expect([...reached]).toContain(control);
    }
    // The theme control's radios are one stop, as radios are: its checked option takes the focus.
    expect([...reached].some((r) => r.startsWith("input:device:"))).toBe(true);
  });

  test("nothing moves for a reader who asked for reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/devnet");
    const durations = await page.locator("button, a").evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).transitionDuration)));
    expect(durations.every((d) => d <= 0.001)).toBe(true);
  });
});

test.describe("nothing there", () => {
  test("an address that is no market or strategy gets a page saying so, with the address and a link to the feed", async ({ page }) => {
    const address = "6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp";
    for (const path of [`/markets/${address}`, `/strategies/${address}`]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { name: "Nothing at this address" })).toBeVisible();
      await expect(page.getByText(address)).toBeVisible();
      await expect(page.getByRole("link", { name: "Explorer" })).toHaveAttribute("href", `https://explorer.solana.com/address/${address}?cluster=devnet`);
      await page.getByRole("link", { name: "Go to the feed" }).click();
      await expect(page).toHaveURL("/");
    }
  });
});
