// How the shell behaves (docs/spec/pipescope-screens.md, "Colour and theme" and "On every page"):
// the theme follows the device and the footer overrides it, every colour and typeface comes from
// theme.css, panels load and fail on their own, and the "nothing there" page names the address.
import { expect, test, type Page } from "@playwright/test";
import { KEEPER_SIGNATURE, postKeeperHeartbeat, seedKeeperRecords, TEST_KEEPER_WALLET } from "./keeper";
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
    await page.route(`${API}/health`, (route) => route.abort("connectionrefused"));
    await page.goto("/");
    const panel = page.getByRole("region", { name: /on devnet$/ });
    await expect(panel.getByRole("alert")).toHaveText(/Could not load devnet's latest slot\. .+'s API did not answer\./);
    await expect(page.getByRole("heading", { name: "New on Pipeline" })).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();

    await page.unroute(`${API}/health`);
    await panel.getByRole("button", { name: "Try again" }).click();
    await expect(panel.getByText("Latest slot")).toBeVisible();
  });

  test("a refused read shows the wait the API named", async ({ page }) => {
    await page.route(`${API}/health`, (route) =>
      route.fulfill({
        status: 429,
        headers: { "content-type": "application/json", "access-control-allow-origin": "*", "retry-after": "60" },
        body: JSON.stringify({ error: "Too many requests from your address. Try again in 60 seconds.", retryAfterSeconds: 60 }),
      }),
    );
    await page.goto("/");
    await expect(page.getByRole("region", { name: /on devnet$/ }).getByRole("alert")).toHaveText("Could not load devnet's latest slot. Too many requests from your address. Try again in 60 seconds.Try again");
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

test.describe("the keeper page", () => {
  test.beforeAll(async () => {
    await seedKeeperRecords();
    await postKeeperHeartbeat();
  });

  test("shows the keeper wallet, the runner running, today's spend against the caps and the jobs with their transactions", async ({ page }) => {
    await page.goto("/keeper");
    await expect(page.getByRole("heading", { name: "Keeper", level: 1 })).toBeVisible();
    await expect(page.getByRole("status")).toHaveText(/^Running\. Its last pass, a sweep, ended (just now|\d+s ago|1m ago)\.$/);

    const wallet = page.getByRole("region", { name: "Keeper wallet" });
    await expect(wallet.getByText(TEST_KEEPER_WALLET.slice(0, 22))).toBeVisible();
    await expect(wallet.getByRole("link", { name: "Explorer" })).toHaveAttribute("href", `https://explorer.solana.com/address/${TEST_KEEPER_WALLET}?cluster=devnet`);
    await expect(wallet.getByText(/^(\d[\d.,]*|0) SOL$/)).toBeVisible();

    const spent = page.getByRole("region", { name: "Spent today" });
    await expect(spent.getByText("0.000025 SOL of 0.1 SOL DAILY_CAP")).toBeVisible();
    await expect(spent.getByText("0.000005 SOL of 0.003 SOL MAX_TX_COST")).toBeVisible();

    const waiting = page.getByRole("region", { name: "Held and parked" });
    await expect(waiting.getByRole("row", { name: /distribute, slot 2 .* Held by MARKET_DAILY_CAP/ })).toBeVisible();

    const latest = page.getByRole("region", { name: "Latest jobs" });
    await expect(latest.getByRole("row")).toHaveCount(1 + 6);
    const signature = latest.getByRole("link", { name: `${KEEPER_SIGNATURE.slice(0, 4)}...${KEEPER_SIGNATURE.slice(-4)}` });
    await expect(signature).toHaveAttribute("href", `https://explorer.solana.com/tx/${KEEPER_SIGNATURE}?cluster=devnet`);
    await expect(signature).toHaveAttribute("title", KEEPER_SIGNATURE);

    const passes = page.getByRole("region", { name: "Passes" });
    await expect(passes.getByRole("row", { name: /^Daily .* sent 4$/ })).toBeVisible();
    await expect(passes.getByRole("row", { name: /^Sweep .* sent 1, held 1$/ })).toBeVisible();
  });

  test("says the runner looks stopped once its last pass is older than its sweep interval and a few minutes", async ({ page }) => {
    await page.route(`${API}/keeper`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.liveness = { state: "looks-stopped", lastPass: { pass: "sweep", at: new Date(Date.now() - 42 * 60_000).toISOString() }, stoppedAfterMs: 900_000, sweepIntervalMs: 600_000 };
      await route.fulfill({ response, json: body });
    });
    await page.goto("/keeper");
    await expect(page.getByRole("status")).toHaveText(
      "Looks stopped. Its last pass, a sweep, ended 42m ago, and it sweeps every 10 minutes. Due jobs wait meanwhile, and anyone may send them.",
    );
  });

  test("keeps the wallet and the runner's state when the records cannot be read, and says so in each panel that needs them", async ({ page }) => {
    await page.route(`${API}/keeper`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      Object.assign(body, { records: { ok: false, error: "the database did not answer" }, recent: [], waiting: [] });
      await route.fulfill({ response, json: body });
    });
    await page.goto("/keeper");
    await expect(page.getByRole("region", { name: "Keeper wallet" }).getByText("Balance", { exact: true })).toBeVisible();
    for (const name of ["Spent today", "Held and parked", "Latest jobs"]) {
      await expect(page.getByRole("region", { name }).getByRole("alert")).toContainText("The runner's records could not be read: the database did not answer.");
    }
  });
});
