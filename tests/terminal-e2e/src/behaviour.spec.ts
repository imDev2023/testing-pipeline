// How the shell behaves (docs/spec/pipescope-screens.md, "Colour and theme" and "On every page"):
// the theme follows the device and the footer overrides it, every colour and typeface comes from
// theme.css, panels load and fail on their own, and the "nothing there" page names the address.
import { expect, test, type Page } from "@playwright/test";
import { MarketsPage, StrategiesList, StrategyVersions } from "terminal-api/contract";
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
    // Its page is headed by the name its valid metadata gives, or "Strategy" without one.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(markets[0]!.strategy_name ?? "Strategy");
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

test.describe("a strategy's page", () => {
  // The buy wall AMM's strategy: upgraded once on devnet, with its demo market.
  const STRATEGY = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";

  test("lists its markets in the feed's table without the strategy column", async ({ page, request }) => {
    const { markets, total } = MarketsPage.parse(await (await request.get(`${API}/v1/markets?strategy=${STRATEGY}`)).json());
    expect(total).toBeGreaterThan(0);
    await page.goto(`/strategies/${STRATEGY}`);
    const section = page.getByRole("region", { name: /^Its markets/ });
    await expect(section.getByRole("heading")).toHaveText(`Its markets ${total}`);
    await expect(section.getByRole("columnheader")).toHaveText(["Market", "Created", "Liquidity", "Volume, 24h", "Trust flags"]);
    await expect(section.getByRole("row")).toHaveCount(markets.length + 1);
    await section.getByRole("row").nth(1).getByRole("link").first().click();
    await expect(page).toHaveURL(`/markets/${markets[0]!.address}`);
  });

  test("lists its versions newest first with their slots and transactions, the newest marked as the one the page is for", async ({ page, request }) => {
    const { versions } = StrategyVersions.parse(await (await request.get(`${API}/v1/strategies/${STRATEGY}/versions`)).json());
    expect(versions.length).toBeGreaterThanOrEqual(2);
    await page.goto(`/strategies/${STRATEGY}`);
    const rows = page.getByRole("region", { name: /^Version history/ }).getByRole("row");
    await expect(rows).toHaveCount(versions.length + 1);
    for (const [i, v] of versions.entries()) {
      const row = rows.nth(i + 1);
      await expect(row).toContainText(v.deploy_slot.toLocaleString("en-US"));
      await expect(row).toContainText(i === 0 ? "The current version. The results and explanation on this page are for it." : "An earlier version, replaced by an upgrade.");
      await expect(row.getByRole("link")).toHaveAttribute("href", `https://explorer.solana.com/tx/${v.signature}?cluster=devnet`);
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

// The feed's filters (docs/spec/pipescope-screens.md, Feed, "Filters"; PIPESCOPE-05, PIPESCOPE-72):
// each one changes the page's address, the address reopens the same filters, and the line under them
// counts what the API counts, with each filter on and with them together.
test.describe("the feed's filters", () => {
  type Counts = { total: number; matching: number; no_sol_side: number };
  const counted = async (query: string): Promise<Counts> => MarketsPage.parse(await (await fetch(`${API}/v1/markets?limit=1${query ? `&${query}` : ""}`)).json());
  const line = (page: Page) => page.getByRole("region", { name: "Markets" }).locator("p[aria-live]");
  const n = (value: number) => value.toLocaleString("en-US");

  test("start off, listing every market, and each one alone counts what the API counts", async ({ page }) => {
    await page.goto("/");
    const all = await counted("");
    await expect(line(page)).toHaveText(`All ${n(all.total)} markets are listed. Nothing is curated or hidden.`);

    const bar = page.getByRole("form", { name: "Filter the markets" });
    const cases: [string, () => Promise<unknown>, string, string][] = [
      ["liquidity", () => bar.getByLabel("Liquidity").selectOption("0.1"), "liquidity=0.1", "min_sol_liquidity=100000000"],
      ["volume", () => bar.getByLabel("Volume, 24 hours").selectOption("0.01"), "volume=0.01", "min_sol_volume_24h=10000000"],
      ["created", () => bar.getByLabel("Created").selectOption("168"), "created=7d", "created_within=604800"],
    ];
    for (const [name, choose, address, query] of cases) {
      await page.goto("/");
      await choose();
      await expect(page).toHaveURL(`/?${address}`);
      const want = await counted(query);
      const sol = name === "created" ? "" : ` The ${n(want.no_sol_side)} ${want.no_sol_side === 1 ? "market" : "markets"} with no SOL side ${want.no_sol_side === 1 ? "is" : "are"} left out while a liquidity or volume filter is on.`;
      await expect(line(page), name).toHaveText(`Showing ${n(want.matching)} of ${n(want.total)} markets.${sol} Clear the filters`);
    }
  });

  test("hide markets with a flag chosen among those present, each with Pipeline's description", async ({ page }) => {
    await page.goto("/");
    await page.getByText("Hide markets with").click();
    const { flags_present } = MarketsPage.parse(await (await fetch(`${API}/v1/markets?limit=1`)).json());
    const boxes = page.getByRole("group", { name: /These are Pipeline's trust flags/ }).getByRole("checkbox");
    await expect(boxes).toHaveCount(flags_present.length);
    const flag = flags_present.find((f) => f.flag === "metadata-unreachable")!;
    await expect(page.getByText(flag.description, { exact: true })).toBeVisible();
    const box = page.getByRole("checkbox", { name: new RegExp(`^${flag.flag} `) });
    await box.check();
    await expect(page).toHaveURL("/?hide=metadata-unreachable");
    await expect(box).toBeChecked();
    const want = await counted("hide=metadata-unreachable");
    await expect(line(page)).toHaveText(`Showing ${n(want.matching)} of ${n(want.total)} markets. Clear the filters`);
    // The summary names the flag hidden, and no row of the table carries it.
    await expect(page.getByRole("form", { name: "Filter the markets" }).locator("summary")).toContainText("metadata-unreachable");
    await expect(page.getByRole("region", { name: "Markets" }).locator("tbody").getByText("metadata-unreachable", { exact: true })).toHaveCount(0);
  });

  test("reopen from a filtered feed's address exactly as they were, with the right counts, and clear with the link", async ({ page }) => {
    const address = "/?liquidity=0.1&volume=0.01&created=7d&hide=metadata-unreachable%2Cmint-authority";
    await page.goto(address);
    const bar = page.getByRole("form", { name: "Filter the markets" });
    await expect(bar.getByLabel("Liquidity")).toHaveValue("0.1");
    await expect(bar.getByLabel("Volume, 24 hours")).toHaveValue("0.01");
    await expect(bar.getByLabel("Created")).toHaveValue("168");
    await expect(bar.getByText("2 flags", { exact: true })).toBeVisible();
    const want = await counted("min_sol_liquidity=100000000&min_sol_volume_24h=10000000&created_within=604800&hide=metadata-unreachable,mint-authority");
    await expect(line(page)).toContainText(`Showing ${n(want.matching)} of ${n(want.total)} markets.`);
    const rows = page.getByRole("region", { name: "Markets" }).locator("tbody tr");
    if (want.matching === 0) await expect(page.getByText("No market matches these filters. Loosen one, or clear them all.")).toBeVisible();
    else await expect(rows).toHaveCount(Math.min(want.matching, 50));

    await page.reload();
    await expect(bar.getByLabel("Liquidity")).toHaveValue("0.1");
    await page.getByRole("link", { name: "Clear the filters" }).click();
    await expect(page).toHaveURL("/");
    await expect(line(page)).toHaveText(/^All [\d,]+ markets are listed\. Nothing is curated or hidden\.$/);
  });

  test("that leave nothing say so", async ({ page }) => {
    // Every devnet strategy is upgradeable, so hiding that flag leaves no market.
    await page.goto("/?hide=upgradeable");
    await expect(page.getByText("No market matches these filters. Loosen one, or clear them all.")).toBeVisible();
    await expect(line(page)).toHaveText(/^Showing 0 of [\d,]+ markets\. Clear the filters$/);
  });
});

// Strategy names and trust flags (docs/spec/pipescope.md, "Listing"): a strategy with valid metadata
// is named in the author's style beside its short address, one without is listed under its address.
test.describe("strategy names", () => {
  test("come from valid metadata in the author's style, or are the short address with \"Metadata unavailable\"", async ({ page }) => {
    const { strategies } = StrategiesList.parse(await (await fetch(`${API}/v1/strategies`)).json());
    const named = strategies.find((s) => s.name)!;
    const unnamed = strategies.find((s) => s.metadata.status === "unreachable")!;
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/?tab=strategies");
    const table = page.getByRole("region", { name: "Strategies" });
    const name = table.getByText(named.name!, { exact: true }).first();
    expect(await name.evaluate((el) => [getComputedStyle(el).color, getComputedStyle(el).fontStyle])).toEqual([AUTHOR.light, "italic"]);
    const row = table.locator("tr", { has: page.locator(`[title="${unnamed.program}"]`) });
    await expect(row.getByText("Metadata unavailable", { exact: true })).toBeVisible();
  });

  test("of our own three strategies are their metadata's, fetched from GitHub, where documents are text/plain (PIPESCOPE-36)", async ({ page }) => {
    const ours = { J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t: "Aviary Tax AMM", BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6: "Aviary Buy Wall AMM", Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG: "Aviary Lending AMM" };
    const { strategies } = StrategiesList.parse(await (await fetch(`${API}/v1/strategies`)).json());
    for (const [program, name] of Object.entries(ours)) expect(strategies.find((s) => s.program === program), program).toMatchObject({ name, metadata: { status: "valid" }, flags: ["upgradeable"] });
    await page.goto("/?tab=strategies");
    for (const name of Object.values(ours)) await expect(page.getByRole("region", { name: "Strategies" }).getByText(name, { exact: true })).toBeVisible();
  });
});
