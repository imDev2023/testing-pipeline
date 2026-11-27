// Live updates (docs/spec/pipescope-architecture.md, Indexer "Live source" and Live rooms;
// docs/spec/pipescope-screens.md, "What the prototype did not show"): with the market page open, a
// swap sent by a script appears in Trades, in the forming candle and on the feed's row within seconds;
// a page that reconnects after missing trades shows them all, once; and the indexer's socket is open
// only while someone watches. src/live.ts says how a swap lands under each E2E_RPC.
import { expect, test, type Page } from "@playwright/test";
import { CANDLES, VOLUME_WINDOW_SECONDS } from "terminal-api/config";
import { Candles, LiveMessage, Market, TradesPage } from "terminal-api/contract";
import { createDb, trades as tradesTable } from "terminal-db";
import { rebuildCandles, writtenCandles } from "terminal-indexer";
import { landSwap, LIVE_MARKET } from "./live";
import { API } from "./target";

type Live = { open: boolean; rooms: string[]; closesAt: string | null; changedAt: string | null; reason: string | null };
const live = async (): Promise<Live> => ((await (await fetch(`${API}/v1/indexer`)).json()) as { live: Live }).live;
const api = async <T>(path: string, parse: (body: unknown) => T): Promise<T> => parse(await (await fetch(`${API}${path}`)).json());

/** A row of Trades, by its transaction. */
const tradeRows = (page: Page, signature: string) => page.getByRole("region", { name: "Trades" }).getByRole("row").filter({ has: page.locator(`a[title="${signature}"]`) });
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A time as the pages write it: "23 Nov 2026, 12:15 UTC". */
const utc = (iso: string) => {
  const d = new Date(iso);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
};
const swapCount = (page: Page) => page.getByText(/^Built from Pipeline's swap events on this market: [\d,]+ swaps? so far\./);

/**
 * The page's WebSockets, counted, and a switch that sends every new one to an address with no room,
 * so a test can take the page off its room while trades land.
 */
async function controlLiveRooms(page: Page) {
  await page.addInitScript(() => {
    const Native = window.WebSocket;
    const opened: WebSocket[] = [];
    const control = { blocked: false, opened, drop: () => opened.forEach((s) => s.close()) };
    (window as unknown as { __live: typeof control }).__live = control;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(control.blocked ? String(url).replace("/v1/live/", "/v1/no-live-room/") : url, protocols);
        opened.push(this);
      }
    };
  });
}

test.describe.configure({ mode: "serial" });

test("a swap sent by a script appears in Trades, in the forming candle and on the feed's row within seconds", async ({ page, context }) => {
  const feed = await context.newPage();
  // Every update of this market the feed's room sends the feed page.
  const feedUpdates: number[] = [];
  feed.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      const message = LiveMessage.safeParse(JSON.parse(String(payload)));
      if (message.success && message.data.events.some((e) => e.type === "market" && e.market.address === LIVE_MARKET)) feedUpdates.push(Date.now());
    }),
  );
  await feed.goto("/");
  const feedRow = feed.getByRole("region", { name: "Markets" }).getByRole("row").filter({ has: feed.locator(`a[href="/markets/${LIVE_MARKET}"]`) });
  await expect(feedRow).toBeVisible();

  await page.goto(`/markets/${LIVE_MARKET}`);
  await expect(page.getByRole("region", { name: "Trades" }).getByRole("table")).toBeVisible();
  await expect(swapCount(page)).toBeVisible();
  const before = await api(`/v1/markets/${LIVE_MARKET}`, (b) => Market.parse(b));
  const swapsBefore = (await api(`/v1/markets/${LIVE_MARKET}/candles?interval=15m`, (b) => Candles.parse(b))).trade_count;
  await expect(swapCount(page)).toContainText(`${swapsBefore.toLocaleString("en-US")} swap`);

  // Both pages have joined their rooms, so the indexer holds its socket.
  await expect.poll(live).toMatchObject({ open: true, rooms: expect.arrayContaining(["feed", `market:${LIVE_MARKET}`]) });

  const updatesBefore = feedUpdates.length;
  const { signature } = await landSwap("live");

  // Trades: at the top, within seconds.
  await expect(tradeRows(page, signature)).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByRole("region", { name: "Trades" }).getByRole("row").nth(1)).toContainText("Buy");
  await expect(page.getByRole("region", { name: "Trades" }).getByRole("row").nth(1).locator(`a[title="${signature}"]`)).toBeVisible();

  // The forming candle: the chart's latest candle is the API's, the swap in it.
  await expect(swapCount(page)).toContainText(`${(swapsBefore + 1).toLocaleString("en-US")} swap`, { timeout: 10_000 });
  const forming = (await api(`/v1/markets/${LIVE_MARKET}/candles?interval=15m`, (b) => Candles.parse(b))).candles.at(-1)!;
  const legend = page.locator("p").filter({ hasText: "Open" }).filter({ hasText: "Close" }).locator("span");
  await expect(legend.first()).toHaveText(utc(forming.start));
  await expect(legend.last()).toHaveText(`${forming.trades} ${forming.trades === 1 ? "trade" : "trades"}`);

  // The feed's row: its room sent the market again, and the row counts the swap in its last 24
  // hours if it landed within them. The API counts from its own clock, so a recorded swap (CI's
  // fixtures) leaves the window a day after its recording and is then rightly not counted.
  await expect.poll(() => feedUpdates.length, { timeout: 10_000 }).toBeGreaterThan(updatesBefore);
  const { trades: [landed] } = await api(`/v1/markets/${LIVE_MARKET}/trades?limit=1`, (b) => TradesPage.parse(b));
  expect(landed?.signature).toBe(signature);
  const inWindow = Date.parse(landed!.block_time!) >= Date.now() - VOLUME_WINDOW_SECONDS * 1000;
  const after = await api(`/v1/markets/${LIVE_MARKET}`, (b) => Market.parse(b));
  expect(after.stats_24h.trades).toBe(before.stats_24h.trades + (inWindow ? 1 : 0));
  const trades = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "trade" : "trades"}`;
  await expect(feedRow).toContainText(after.stats_24h.trades === 0 ? "none" : trades(after.stats_24h.trades), { timeout: 10_000 });
});

test("a page that reconnects after missing trades shows them all, once", async ({ page }) => {
  await controlLiveRooms(page);
  await page.goto(`/markets/${LIVE_MARKET}`);
  await expect(page.getByRole("region", { name: "Trades" }).getByRole("table")).toBeVisible();
  await expect.poll(live).toMatchObject({ rooms: expect.arrayContaining([`market:${LIVE_MARKET}`]) });

  // Off its room, the page misses a swap, which the indexer still takes.
  await page.evaluate(() => {
    const control = (window as unknown as { __live: { blocked: boolean; drop: () => void } }).__live;
    control.blocked = true;
    control.drop();
  });
  const { signature } = await landSwap("missed");
  await expect.poll(async () => (await api(`/v1/markets/${LIVE_MARKET}/trades?limit=5`, (b) => TradesPage.parse(b))).trades.some((t) => t.signature === signature), { timeout: 20_000 }).toBe(true);
  await expect(tradeRows(page, signature)).toHaveCount(0);

  // Back on its room, it resyncs from the last trade it saw.
  await page.evaluate(() => void ((window as unknown as { __live: { blocked: boolean } }).__live.blocked = false));
  await expect(tradeRows(page, signature)).toHaveCount(1, { timeout: 30_000 });
  // Each trade once: every transaction link in the table names a different signature.
  const signatures = await page.getByRole("region", { name: "Trades" }).locator('a[href*="/tx/"]').evaluateAll((links) => links.map((a) => a.getAttribute("title")));
  expect(signatures).toContain(signature);
  expect(new Set(signatures).size).toBe(signatures.length);
});

test("the indexer's socket stays open while a page watches and starts its 3-minute close when the last one leaves", async ({ page }) => {
  await page.goto(`/markets/${LIVE_MARKET}`);
  await expect.poll(live).toMatchObject({ open: true, rooms: expect.arrayContaining([`market:${LIVE_MARKET}`]), closesAt: null });
  await page.goto("/devnet");
  const left = Date.now();
  await expect.poll(async () => (await live()).rooms, { timeout: 30_000 }).toEqual([]);
  const { open, closesAt } = await live();
  expect(open).toBe(true);
  expect(Date.parse(closesAt!) - left).toBeGreaterThan(170_000);
  expect(Date.parse(closesAt!) - left).toBeLessThan(190_000);
});

test("a rebuild of every candle from trades equals the candles folded live", async () => {
  const { db, close } = createDb(process.env.DATABASE_URL!);
  try {
    const pairs = await db.selectDistinct({ market: tradesTable.market, input: tradesTable.inputMint, output: tradesTable.outputMint }).from(tradesTable);
    const seen = new Set<string>();
    for (const { market, input, output } of pairs) {
      const key = [market, ...[input, output].sort()].join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      for (const { seconds, keepDays } of CANDLES) {
        // Candles past their retention may have been dropped by the daily job; the rest are kept forever.
        const kept = (c: { start: number }) => keepDays === null || c.start >= Date.now() / 1000 - keepDays * 86_400 + 3_600;
        const written = (await writtenCandles(db, market, [input, output], seconds)).filter(kept);
        expect((await rebuildCandles(db, market, [input, output], seconds)).filter(kept), `${key} ${seconds}s`).toEqual(written);
      }
    }
    expect(seen.has([LIVE_MARKET, ...["So11111111111111111111111111111111111111112", (await api(`/v1/markets/${LIVE_MARKET}`, (b) => Market.parse(b))).base_mint].sort()].join(":"))).toBe(true);
  } finally {
    await close();
  }
});
