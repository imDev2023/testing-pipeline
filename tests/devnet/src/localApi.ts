// `terminal-api` as the local run runs it (docs/toolchain.md, "Aviary's local run"): `wrangler dev`
// against devnet, here on a throwaway database and Durable Object state of its own, on ports of its
// own so it never meets a local run already up. The RPC's URL reaches wrangler through the
// environment, never on a command line.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Candles, MarketsPage, StrategiesList, TradesPage, type Market, type Strategy, type Trade } from "terminal-api/contract";
import { createTestDatabase } from "terminal-db/testing";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/terminal-api");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Polls `check` until it gives something, or fails after `ms`. */
export async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1_000);
  }
}

type IndexerStatus = { reconciledAt: string | null; lastError: string | null; cursor: { slot: number } | null };

export class LocalApi {
  readonly url: string;
  private process: ChildProcess | null = null;
  private readonly state = mkdtempSync(join(tmpdir(), "terminal-api-"));
  private readonly log = join(this.state, "wrangler.log");
  private database: Awaited<ReturnType<typeof createTestDatabase>> | null = null;

  constructor(private readonly port: number) {
    this.url = `http://localhost:${port}`;
  }

  /** Starts `wrangler dev`, on a fresh database the first time and the same one after. */
  async start(): Promise<void> {
    if (!process.env.RPC_URL) throw new Error("RPC_URL is not set: run with the project's .env loaded.");
    // Another session's API on this port would answer in this one's place, with other code and another database.
    if (await fetch(`${this.url}/health`).then(() => true, () => false)) throw new Error(`port ${this.port} is already in use: another process answers there, so this test would not be reading its own API`);
    this.database ??= await createTestDatabase();
    const log = openSync(this.log, "a");
    this.process = spawn(
      join(apiDir, "node_modules/.bin/wrangler"),
      ["dev", "--port", String(this.port), "--inspector-port", String(this.port + 1000), "--persist-to", this.state, "--test-scheduled"],
      { cwd: apiDir, env: { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: this.database.url }, stdio: ["ignore", log, log], detached: true },
    );
    try {
      await until("the API to answer", async () => (await fetch(`${this.url}/v1/indexer`)).ok, 120_000);
    } catch (e) {
      throw new Error(`${(e as Error).message}; wrangler said:\n${readFileSync(this.log, "utf8").slice(-3_000)}`, { cause: e });
    }
  }

  /** Stops `wrangler dev` and its workerd, so nothing of the indexer runs. */
  async stop(): Promise<void> {
    const running = this.process;
    if (!running) return;
    this.process = null;
    const exited = new Promise((done) => running.once("exit", done));
    process.kill(-running.pid!, "SIGTERM");
    await exited;
    await until("the API to stop", async () => !(await fetch(`${this.url}/v1/indexer`).then(() => true).catch(() => false)), 30_000);
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.database?.drop();
    rmSync(this.state, { recursive: true, force: true });
  }

  /** Fires the every-minute cron, as Cloudflare would, and waits until the indexer has reconciled since. */
  async reconcile(): Promise<IndexerStatus> {
    const before = Date.now();
    const fired = await fetch(`${this.url}/__scheduled?cron=${encodeURIComponent("* * * * *")}`);
    if (!fired.ok) throw new Error(`the cron was refused: ${fired.status}`);
    return until(
      "the indexer to reconcile",
      async () => {
        const status = (await (await fetch(`${this.url}/v1/indexer`)).json()) as IndexerStatus;
        if (status.lastError && Date.parse(status.lastError.slice(0, 24)) >= before) throw new Error(status.lastError);
        return status.reconciledAt && Date.parse(status.reconciledAt) >= before ? status : null;
      },
      240_000,
    );
  }

  private async get(path: string): Promise<unknown> {
    const response = await fetch(`${this.url}${path}`);
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
    return response.json();
  }

  async markets(): Promise<Market[]> {
    const all: Market[] = [];
    let before: string | null = null;
    do {
      const page = MarketsPage.parse(await this.get(`/v1/markets?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`));
      all.push(...page.markets);
      before = page.next;
    } while (before);
    return all;
  }

  /** The throwaway database this API writes, once started. */
  get databaseUrl(): string {
    if (!this.database) throw new Error("the API has not started");
    return this.database.url;
  }

  /** A market's candles of one length, for its own pair or the one named, every one the API keeps. */
  async candles(market: string, interval: string, pair?: { base: string; quote: string }): Promise<Candles> {
    return Candles.parse(await this.get(`/v1/markets/${market}/candles?interval=${interval}&limit=5000${pair ? `&base=${pair.base}&quote=${pair.quote}` : ""}`));
  }

  async strategies(): Promise<Strategy[]> {
    return StrategiesList.parse(await this.get("/v1/strategies")).strategies;
  }

  /** Every trade of a market, or of a trader, newest first. */
  async trades(of: { market: string } | { trader: string }): Promise<Trade[]> {
    const base = "market" in of ? `/v1/markets/${of.market}/trades` : `/v1/traders/${of.trader}/trades`;
    const all: Trade[] = [];
    let before: string | null = null;
    do {
      const page = TradesPage.parse(await this.get(`${base}?limit=1000${before ? `&before=${encodeURIComponent(before)}` : ""}`));
      all.push(...page.trades);
      before = page.next;
    } while (before);
    return all;
  }
}
