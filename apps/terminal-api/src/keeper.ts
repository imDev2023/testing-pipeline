// The keeper page's API (docs/spec/keeper-runner.md, "How Aviary shows it"; PIPESCOPE-97,
// PIPESCOPE-104, SUITE-57):
//
// - `POST /keeper/heartbeat`: the keeper runner, after each pass, posts a heartbeat signed with the
//   keeper wallet's key. Only KEEPER_WALLET's signature is accepted, so no secret is shared and no
//   one else can make a stopped runner look alive. The newest of each kind of pass is kept in KV,
//   which never wakes Postgres, since the runner records in Postgres only the passes that did
//   something.
// - `GET /keeper`: the wallet and its balance through RPC, whether the runner looks stopped (its
//   last heartbeat older than its SWEEP_INTERVAL plus KEEPER_STOPPED_GRACE_MS), the last pass of
//   each kind, and from Postgres today's spend, the latest jobs and the held and parked ones. A
//   database or an RPC that does not answer leaves the rest standing.
// - `GET /v1/markets/{market}/keeper`: the runner's latest record of each job and slot on one market,
//   which the market's panel shows beside its due jobs (PIPESCOPE-166).
import { address, createSolanaRpc } from "@solana/kit";
import type { Hono } from "hono";
import { createDb, readKeeperRecords, readMarketKeeperJobs, type KeeperJobRead, type KeeperRecords } from "terminal-db";
import { HEALTH_TIMEOUT_MS, KEEPER_HEARTBEAT_MAX_SKEW_MS, KEEPER_HEARTBEAT_MIN_GAP_MS, KEEPER_RECENT_JOBS, KEEPER_STOPPED_GRACE_MS } from "./config";
import {
  Keeper,
  KeeperHeartbeat,
  KeeperHeartbeatPayload,
  KeeperPassKind,
  keeperHeartbeatMessage,
  MarketKeeper,
  type ApiError,
  type KeeperCaps,
  type KeeperJob,
} from "./contract";
import type { AppEnv } from "./index";
import { countAsRead } from "./rateLimits";
import { signedBy } from "./signed";
import { addressOf } from "./trading/routes";

/**
 * What KV holds for the keeper wallet: when each kind of pass last sent a heartbeat, the newest
 * heartbeat, and the newest of the runner's own (a one-off `once` run aside), whose SWEEP_INTERVAL
 * the threshold counts from.
 */
type StoredHeartbeats = { passes: Partial<Record<KeeperPassKind, string>>; latest: KeeperHeartbeatPayload; runner?: KeeperHeartbeatPayload };

const newer = (a: KeeperHeartbeatPayload | undefined, b: KeeperHeartbeatPayload) => (a && Date.parse(a.at) > Date.parse(b.at) ? a : b);

const heartbeatKey = (wallet: string) => `keeper-heartbeat:${wallet}`;

export function keeperRoutes(app: Hono<AppEnv>) {
  marketKeeperRoute(app);
  app.post("/keeper/heartbeat", countAsRead, async (c) => {
    const refuse = (status: 400 | 401 | 403 | 409, error: string) => c.json<ApiError>({ error }, status);
    const body = KeeperHeartbeat.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return refuse(400, "This is not a keeper heartbeat.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.data.payload);
    } catch {
      return refuse(400, "This is not a keeper heartbeat.");
    }
    const payload = KeeperHeartbeatPayload.safeParse(parsed);
    if (!payload.success) return refuse(400, "This is not a keeper heartbeat.");
    const heartbeat = payload.data;
    if (!(await signedBy(heartbeat.wallet, keeperHeartbeatMessage(body.data.payload), body.data.signature))) return refuse(401, "The heartbeat's signature does not match its wallet.");
    if (heartbeat.wallet !== c.env.KEEPER_WALLET) return refuse(403, "Only the keeper wallet's heartbeats are kept.");
    const at = Date.parse(heartbeat.at);
    if (Math.abs(at - Date.now()) > KEEPER_HEARTBEAT_MAX_SKEW_MS) return refuse(409, "The heartbeat's time is too far from now.");

    const key = heartbeatKey(heartbeat.wallet);
    const stored = await c.env.TERMINAL_CACHE.get<StoredHeartbeats>(key, "json");
    const last = stored?.passes[heartbeat.pass];
    if (last !== undefined && at - Date.parse(last) < KEEPER_HEARTBEAT_MIN_GAP_MS) return c.json({ stored: false }, 202);
    const next: StoredHeartbeats = {
      passes: { ...stored?.passes, [heartbeat.pass]: heartbeat.at },
      latest: newer(stored?.latest, heartbeat),
      ...(heartbeat.pass === "once" ? (stored?.runner ? { runner: stored.runner } : {}) : { runner: newer(stored?.runner, heartbeat) }),
    };
    await c.env.TERMINAL_CACHE.put(key, JSON.stringify(next));
    return c.json({ stored: true }, 202);
  });

  app.get("/keeper", async (c) => {
    const wallet = c.env.KEEPER_WALLET;
    const now = new Date();
    const [stored, balance] = await Promise.all([c.env.TERMINAL_CACHE.get<StoredHeartbeats>(heartbeatKey(wallet), "json"), readBalance(c.env.RPC_URL, wallet)]);
    // Parks live only in the runner's memory: those recorded before this run started are over.
    const since = stored?.runner ? new Date(stored.runner.startedAt) : null;
    const records = await readRecords(c.env.HYPERDRIVE.connectionString, { wallet, now, since }, (p) => c.executionCtx.waitUntil(p));

    // The runner's own passes: a `once` is a one-off run beside it, not a sign that it is running.
    const running = Object.entries(stored?.passes ?? {})
      .filter(([pass]) => pass !== "once")
      .sort(([, a], [, b]) => Date.parse(b) - Date.parse(a))[0] as [KeeperPassKind, string] | undefined;
    const stoppedAfterMs = stored?.runner ? stored.runner.sweepIntervalMs + KEEPER_STOPPED_GRACE_MS : null;
    const state = !running || stoppedAfterMs === null ? "no-heartbeat" : now.getTime() - Date.parse(running[1]) > stoppedAfterMs ? "looks-stopped" : "running";

    const data = records.ok ? records.data : null;
    const recorded = new Map((data?.lastOfEachKind ?? []).map((pass) => [pass.pass, pass]));
    const latestRecord = data?.latest ?? null;
    const heartbeatIsNewer = stored !== null && (!latestRecord || Date.parse(stored.latest.at) >= latestRecord.at.getTime());

    const body: Keeper = {
      wallet,
      balance,
      liveness: { state, lastPass: running ? { pass: running[0], at: running[1] } : null, stoppedAfterMs, sweepIntervalMs: stored?.runner?.sweepIntervalMs ?? null },
      passes: KeeperPassKind.options.map((pass) => {
        const record = recorded.get(pass);
        return {
          pass,
          lastRanAt: stored?.passes[pass] ?? null,
          lastRecorded: record
            ? { at: record.at.toISOString(), sent: record.counts.sent, held: record.counts.held, parked: record.counts.parked, failed: record.counts.failed, jobs: record.recordedJobs }
            : null,
        };
      }),
      caps: stored ? stored.latest.caps : latestRecord ? numbers(latestRecord.caps) : null,
      today: {
        day: now.toISOString().slice(0, 10),
        spentTotal: Number(data?.today?.spentTotal ?? 0n),
        highestCost: data?.today?.highestCost == null ? null : Number(data.today.highestCost),
        markets: Object.entries(data?.today?.spentByMarket ?? {})
          .map(([market, spent]) => ({ market, spent: Number(spent) }))
          .sort((a, b) => b.spent - a.spent),
      },
      warnings: heartbeatIsNewer ? { at: stored.latest.at, list: stored.latest.warnings } : latestRecord ? { at: latestRecord.at.toISOString(), list: latestRecord.warnings } : null,
      waiting: (data?.waiting ?? []).map(job),
      recent: (data?.recent ?? []).map(job),
      records: records.ok ? { ok: true, error: null } : { ok: false, error: records.error },
    };
    return c.json(Keeper.parse(body));
  });
}

/** `GET /v1/markets/{market}/keeper`: the runner's latest record of each job and slot on one market (PIPESCOPE-166). */
function marketKeeperRoute(app: Hono<AppEnv>) {
  app.get("/v1/markets/:market/keeper", async (c) => {
    const market = addressOf(c.req.param("market"), "market");
    const wallet = c.env.KEEPER_WALLET;
    let client: ReturnType<typeof createDb> | undefined;
    try {
      client = createDb(c.env.HYPERDRIVE.connectionString);
      const jobs = await readMarketKeeperJobs(client.db, { wallet, market });
      return c.json(MarketKeeper.parse({ market, wallet, jobs: jobs.map(job) }));
    } catch (e) {
      // The error can quote the connection string: log only what kind of failure it was.
      console.error("keeper: the database query failed", e instanceof Error ? e.name : typeof e);
      return c.json({ error: "The keeper runner's records could not be read: the database did not answer." }, 503);
    } finally {
      if (client) c.executionCtx.waitUntil(client.close());
    }
  });
}

async function readBalance(rpcUrl: string, wallet: string): Promise<Keeper["balance"]> {
  try {
    const { value } = await createSolanaRpc(rpcUrl)
      .getBalance(address(wallet), { commitment: "confirmed" })
      .send({ abortSignal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return { lamports: Number(value), error: null };
  } catch (e) {
    // The error can quote the URL, which carries the key: log only what kind of failure it was.
    console.error("keeper: the RPC did not answer", e instanceof Error ? e.name : typeof e);
    return { lamports: null, error: "the RPC did not answer" };
  }
}

async function readRecords(
  connectionString: string,
  options: { wallet: string; now: Date; since: Date | null },
  waitUntil: (p: Promise<unknown>) => void,
): Promise<{ ok: true; data: KeeperRecords } | { ok: false; error: string }> {
  let client: ReturnType<typeof createDb> | undefined;
  try {
    client = createDb(connectionString);
    return { ok: true, data: await readKeeperRecords(client.db, { ...options, recentJobs: KEEPER_RECENT_JOBS }) };
  } catch (e) {
    console.error("keeper: the database query failed", e instanceof Error ? e.name : typeof e);
    return { ok: false, error: "the database did not answer" };
  } finally {
    if (client) waitUntil(client.close());
  }
}

const numbers = (caps: Record<keyof KeeperCaps, bigint>): KeeperCaps => ({
  maxTxCost: Number(caps.maxTxCost),
  marketDailyCap: Number(caps.marketDailyCap),
  dailyCap: Number(caps.dailyCap),
  minBalance: Number(caps.minBalance),
  lowBalance: Number(caps.lowBalance),
});

const job = (row: KeeperJobRead): KeeperJob => ({
  at: row.at.toISOString(),
  pass: row.pass,
  market: row.market,
  product: row.product,
  job: row.job,
  slot: row.slot,
  outcome: row.outcome,
  signature: row.signature,
  cost: row.cost === null ? null : Number(row.cost),
  cap: row.cap,
  error: row.error,
});
