// Canary in its container on devnet (#124; docs/spec/pipescope-architecture.md, "Canary runner";
// docs/spec/pipescope-canary.md, When Canary runs): `terminal-api` under `wrangler dev` with
// Canary's container, on a throwaway database, reading devnet.
//
// - The indexer's first run backfills the router and starts a run of every market it finds; then a
//   full sweep re-runs every market of every strategy, and its duration, the container's awake time,
//   the GiB-hours a month that four sweeps a day would take and the RPC requests are printed, for the
//   PR to set against the spec's budget.
// - Each market's `conformance` outcome is compared with Pipeline's hosted API's own
//   `pipeline-check` run for the same strategy code hash (PIPESCOPE-93); every disagreement is printed.
// - A market created here with the project's devnet wallet gets its first results within minutes and
//   its second run 10 minutes after its creation, with the runs 1 hour and 1 day on scheduled.
//
//   direnv exec "<main checkout>" pnpm --filter terminal-devnet devnet src/canary.test.ts
//
// Needs Docker, and spends a little devnet SOL from the project's wallet on the new market.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createKeyPairSignerFromBytes, createSolanaRpc, getBase58Decoder, signBytes, type KeyPairSigner } from "@solana/kit";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { CanaryResults, CanarySchedule, canaryRerunMessage } from "terminal-api/contract";
import { canaryRunMarkets, canaryRuns, createDb, programVersions } from "terminal-db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCpMarket, DEVNET_CP } from "./cpMarket";
import { rpcUrl, WALLET_FILE } from "./devnet";
import { everyTenMinuteJob, LocalApi, until } from "./localApi";

const HOSTED = "https://pipeline-devnet.up.railway.app";
const ready = Boolean(process.env.RPC_URL && process.env.TEST_DATABASE_URL);
/** The container's image, as `wrangler dev` names it. */
const IMAGE = "cloudflare-dev/canarycontainer";
const MINUTE = 60_000;

const api = new LocalApi(8834, { containers: true });
let db: ReturnType<typeof createDb>;
let wallet: KeyPairSigner;
let stopCron = () => {};

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const getJson = async (path: string) => {
  const response = await fetch(`${api.url}${path}`);
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return response.json();
};

/** Whether Canary's container is running, as Docker sees it. */
const containerRunning = () => execFileSync("docker", ["ps", "--format", "{{.Image}}"], { encoding: "utf8" }).split("\n").some((image) => image.startsWith(IMAGE));

/** Watches the container every 2 seconds, adding up the time it is running. */
function awakeMeter() {
  let awakeMs = 0;
  let last = Date.now();
  let wasRunning = containerRunning();
  const timer = setInterval(() => {
    const now = Date.now();
    const running = containerRunning();
    if (wasRunning) awakeMs += now - last;
    wasRunning = running;
    last = now;
  }, 2_000);
  return { awakeMs: () => awakeMs, running: () => wasRunning, stop: () => clearInterval(timer) };
}

/** Fires the every-minute cron at the start of each minute, as Cloudflare would. */
function cronTicker(): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    timer = setTimeout(() => {
      void fetch(`${api.url}/__scheduled?cron=${encodeURIComponent("* * * * *")}`).catch(() => {});
      tick();
    }, MINUTE - (Date.now() % MINUTE) + 500);
  };
  tick();
  return () => clearTimeout(timer);
}

async function rerun(what: { market?: string; strategy?: string }) {
  const payload = JSON.stringify({ ...what, wallet: wallet.address, at: new Date().toISOString() });
  const signature = getBase58Decoder().decode(await signBytes(wallet.keyPair.privateKey, canaryRerunMessage(payload)));
  const response = await fetch(`${api.url}/v1/canary/reruns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload, signature }) });
  if (response.status !== 202) throw new Error(`the re-run was refused: ${response.status} ${await response.text()}`);
  return (await response.json()) as { markets: string[] };
}

/** What a pass of runs took, from Postgres: its markets, failures, rounds, RPC requests and container time. */
async function passFigures(runIds: bigint[]) {
  const rows = await db.db.select().from(canaryRunMarkets).where(inArray(canaryRunMarkets.runId, runIds));
  const [span] = await db.db
    .select({ first: sql<Date>`min(${canaryRuns.startedAt})`, last: sql<Date>`max(${canaryRuns.finishedAt})` })
    .from(canaryRuns)
    .where(inArray(canaryRuns.id, runIds));
  const rounds: Record<number, number> = {};
  for (const r of rows) if (r.rounds !== null) rounds[r.rounds] = (rounds[r.rounds] ?? 0) + 1;
  return {
    markets: rows.length,
    failed: rows.filter((r) => r.status === "failed").map((r) => `${r.market}: ${r.error}`),
    moved: rows.filter((r) => r.status === "moved").length,
    rounds,
    rpcRequests: rows.reduce((n, r) => n + (r.rpcRequests ?? 0), 0),
    containerSeconds: rows.reduce((n, r) => n + (r.containerMs ?? 0), 0) / 1000,
    wallSeconds: span?.first && span.last ? (new Date(span.last).getTime() - new Date(span.first).getTime()) / 1000 : null,
  };
}

beforeAll(async () => {
  if (!ready) return;
  wallet = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(WALLET_FILE, "utf8")) as number[]));
  await api.start();
  db = createDb(api.databaseUrl);
  // The first run backfills the router's history and records every strategy's version; the
  // outbox's new markets then start Canary's first runs.
  await api.runJobs({ minute: everyTenMinuteJob, wait: ["reconciledAt", "snapshotAt", "strategiesReconciledAt", "watchedAt"] });
  stopCron = cronTicker();
}, 15 * MINUTE);

afterAll(async () => {
  stopCron();
  await db?.close();
  await api.dispose();
});

describe.skipIf(!ready)("Canary on devnet, in its container", () => {
  it("runs every devnet market after the first backfill, then sweeps them all, measuring the sweep", async () => {
    const markets = await api.markets();
    log(`${markets.length} markets indexed`);
    await until(
      "a first run of every market",
      async () => {
        const [row] = await db.db.select({ n: sql<number>`count(distinct ${canaryRunMarkets.market})::int` }).from(canaryRunMarkets);
        log(`first runs: ${row!.n} of ${markets.length} markets`);
        return row!.n >= markets.length;
      },
      60 * MINUTE,
    );
    const firstRuns = (await db.db.select({ id: canaryRuns.id }).from(canaryRuns)).map((r) => r.id);
    log(`first pass: ${JSON.stringify(await passFigures(firstRuns))}`);

    // The container goes to sleep, then a sweep starts it again: every market of every strategy.
    await until("the container to sleep", async () => !containerRunning(), 10 * MINUTE);
    const meter = awakeMeter();
    const sweepStart = new Date();
    const strategies = [...new Set(markets.map((m) => m.strategy))];
    for (const strategy of strategies) await rerun({ strategy });
    const sweepRuns = await until(
      "the sweep's runs to end",
      async () => {
        const rows = await db.db.select().from(canaryRuns).where(and(eq(canaryRuns.trigger, "rerun"), sql`${canaryRuns.startedAt} >= ${sweepStart}`));
        return rows.length === strategies.length && rows.every((r) => r.finishedAt) && rows;
      },
      60 * MINUTE,
    );
    const runsEnded = Date.now();
    await until("the container to sleep after the sweep", async () => !meter.running(), 10 * MINUTE);
    meter.stop();
    const figures = await passFigures(sweepRuns.map((r) => r.id));
    const awakeHours = meter.awakeMs() / 3_600_000;
    const sleepHours = (Date.now() - runsEnded) / 3_600_000;
    const report = {
      ...figures,
      containerAwakeSeconds: Math.round(meter.awakeMs() / 1000),
      gibHoursPerMonthFourSweepsBasic: +(awakeHours * 1 * 4 * 30).toFixed(1),
      gibHoursPerMonthFourSweepsLite: +(awakeHours * 0.25 * 4 * 30).toFixed(1),
      ofWhichTheSleepAfter: +(sleepHours * 4 * 30).toFixed(1),
    };
    log(`sweep: ${JSON.stringify(report)}`);
    expect(figures.markets).toBe(markets.length);
    expect(figures.failed).toEqual([]);
  }, 90 * MINUTE);

  it("agrees with Pipeline's hosted pipeline-check run on each market's conformance, for the same strategy code", async () => {
    const markets = await api.markets();
    const rows: { market: string; ours: string; theirs: string; reason: string; failed: string[] }[] = [];
    let skipped = 0;
    for (const m of markets) {
      const ours = CanaryResults.parse(await getJson(`/v1/markets/${m.address}/canary`));
      const conformance = ours.results.find((r) => r.check === "conformance");
      const hosted = (await (await fetch(`${HOSTED}/v1/markets/${m.address}/checks`)).json().catch(() => null)) as {
        checks?: { result: string | null; status: string; strategy_executable_sha256: string | null; failed_checks: string[] } | null;
      } | null;
      const checks = hosted?.checks;
      if (!conformance || !checks?.result || checks.strategy_executable_sha256 !== ours.version.executable_sha256) {
        skipped++;
        continue;
      }
      rows.push({ market: m.address, ours: conformance.outcome, theirs: checks.result, reason: conformance.reason, failed: checks.failed_checks });
    }
    const disagree = rows.filter((r) => r.ours !== r.theirs);
    log(`conformance compared on ${rows.length} markets (${skipped} without a hosted run for the same code); ${rows.length - disagree.length} agree`);
    for (const d of disagree) log(`disagree ${d.market}: ours ${d.ours} (${d.reason}); hosted ${d.theirs} (${d.failed.join(", ")})`);
    expect(rows.length).toBeGreaterThan(0);
  }, 20 * MINUTE);

  it("runs the container with no network and no RPC key: a request from inside it fails", async () => {
    const [market] = await api.markets();
    await rerun({ market: market!.address });
    const id = await until("the container to run", async () => execFileSync("docker", ["ps", "--format", "{{.ID}} {{.Image}}"], { encoding: "utf8" }).split("\n").find((l) => l.split(" ")[1]?.startsWith(IMAGE))?.split(" ")[0], 5 * MINUTE);
    const attempt = (url: string) => {
      try {
        const out = execFileSync("docker", ["exec", id, "/usr/local/bin/canary", "snapshot", "--url", url, "--market", market!.address], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3 * MINUTE });
        return { reached: true, said: out.slice(0, 200) };
      } catch (e) {
        return { reached: false, said: String((e as { stderr?: string }).stderr ?? e).trim().split("\n").at(-1) };
      }
    };
    for (const url of ["https://api.devnet.solana.com", "http://1.1.1.1"]) {
      const result = attempt(url);
      log(`from inside the container, ${url}: ${result.reached ? "reached" : "refused"}: ${result.said}`);
      expect(result.reached).toBe(false);
    }
    const env = JSON.parse(execFileSync("docker", ["inspect", "--format", "{{json .Config.Env}}", id], { encoding: "utf8" })) as string[];
    log(`the container's environment: ${JSON.stringify(env)}`);
    expect(env.filter((v) => /rpc|helius|api[-_]?key|secret|token/i.test(v))).toEqual([]);
  }, 15 * MINUTE);

  it("runs a market created with the project's devnet keys within minutes, again 10 minutes after its creation, with its 1-hour and 1-day runs scheduled", async () => {
    const devnet = createSolanaRpc(rpcUrl());
    const { market, signatures } = await createCpMarket(devnet, wallet, DEVNET_CP);
    const created = Date.now();
    log(`market ${market} created on devnet: ${signatures.join(", ")}`);
    const first = await until(`${market}'s first results`, async () => {
      const results = CanaryResults.parse(await getJson(`/v1/markets/${market}/canary`).catch(() => ({ market, version: { program: DEVNET_CP, deploy_slot: 0, executable_sha256: null, current: true }, results: [], could_not_sell_back: [] })));
      return results.results.length > 0 && results;
    }, 10 * MINUTE);
    log(`first results ${((Date.now() - created) / 1000).toFixed(0)} s after the market was created, at slot ${first.results[0]!.slot}`);

    const [version] = await db.db.select({ deploySlot: programVersions.deploySlot }).from(programVersions).where(eq(programVersions.program, DEVNET_CP)).orderBy(sql`${programVersions.deploySlot} desc`).limit(1);
    const schedule = CanarySchedule.parse(await getJson(`/v1/strategies/${DEVNET_CP}/versions/${version!.deploySlot}/canary/schedule`));
    const own = schedule.runs.filter((r) => r.trigger === "market_created" && r.markets === 1).map((r) => r.delay_ms);
    log(`scheduled: ${JSON.stringify(schedule.runs)}`);
    expect(own).toEqual(expect.arrayContaining([10 * MINUTE, 60 * MINUTE, 24 * 60 * MINUTE]));

    const second = await until(
      "the run 10 minutes on",
      async () => {
        const [row] = await db.db
          .select()
          .from(canaryRuns)
          .innerJoin(canaryRunMarkets, eq(canaryRunMarkets.runId, canaryRuns.id))
          .where(and(eq(canaryRunMarkets.market, market), eq(canaryRuns.delayMs, 10 * MINUTE), isNotNull(canaryRuns.finishedAt)));
        return row;
      },
      20 * MINUTE,
    );
    log(`second run ${((second.canary_runs.startedAt.getTime() - created) / 1000).toFixed(0)} s after the market was created, done in ${second.canary_run_markets.rounds} round(s)`);
    const latest = CanaryResults.parse(await getJson(`/v1/markets/${market}/canary`));
    expect(Math.max(...latest.results.map((r) => r.slot))).toBeGreaterThan(first.results[0]!.slot);
  }, 40 * MINUTE);
});
