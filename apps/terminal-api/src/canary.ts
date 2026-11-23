// Canary's endpoints (docs/spec/pipescope-architecture.md, API and "Canary runner"; #124), from what
// the `CanaryRun` objects store in Postgres (terminal-db's canary.ts), each result served with the
// sentences ./canarySentences writes:
//
// - `GET /v1/markets/{market}/canary`: the market's latest results under its strategy's current
//   version (or `?version=<deploy slot>`), and its "could not sell back" notice (CANARY-21).
// - `GET /v1/strategies/{program}/versions/{slot}/canary`: the version's roll-up, and `.../schedule`,
//   the runs its `CanaryRun` still holds, read from the object, never from Postgres.
// - `POST /v1/canary/reruns`: the owner's re-run of a market or a strategy (`pnpm canary:rerun`),
//   signed by the operator wallet, `CANARY_OPERATOR`, so no secret is shared and no one else can
//   start runs.
import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { canaryRuns, markets, programVersions, readCanaryLatest, readCanaryRollup, type Db, type StoredCanaryResult } from "terminal-db";
import type { CanaryRunRequest, CanaryRunVersion } from "./canaryRunCore";
import { aboutCheck, couldNotSellBack, ranLine } from "./canarySentences";
import { CANARY } from "./config";
import { CanaryRerun, CanaryRerunPayload, CanaryResults, CanaryRollup, CanarySchedule, canaryRerunMessage, type ApiError, type CanaryResult } from "./contract";
import type { Bindings } from "./env";
import { notFound } from "./feed";
import { countAsRead } from "./rateLimits";
import { dbOf, requestDb, type DbEnv } from "./requestDb";
import { signedBy } from "./signed";

/** The name of a version's `CanaryRun`, one per program and deploy slot. */
export const canaryRunName = (version: CanaryRunVersion) => `${version.program}:${version.deploySlot}`;

/** Hands a request to the version's `CanaryRun`. */
export const startCanary = (env: Pick<Bindings, "CANARY_RUNS">) => async (version: CanaryRunVersion, request: CanaryRunRequest) => {
  await env.CANARY_RUNS.get(env.CANARY_RUNS.idFromName(canaryRunName(version))).schedule(version, request);
};

export const canaryRoutes = new Hono<DbEnv>();
canaryRoutes.use("/v1/markets/:market/canary", requestDb);
canaryRoutes.use("/v1/strategies/:program/versions/:slot/canary", requestDb);
canaryRoutes.use("/v1/canary/*", countAsRead, requestDb);

type VersionRow = { program: string; deploySlot: bigint; executableSha256: string | null };

async function versionsOf(db: Db, program: string): Promise<VersionRow[]> {
  return db
    .select({ program: programVersions.program, deploySlot: programVersions.deploySlot, executableSha256: programVersions.executableSha256 })
    .from(programVersions)
    .where(eq(programVersions.program, program))
    .orderBy(desc(programVersions.deploySlot));
}

const SLOT = /^\d{1,20}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const resultView = (r: StoredCanaryResult): CanaryResult => ({
  id: r.id,
  check: r.check,
  outcome: r.outcome,
  reason: r.record.reason,
  about: aboutCheck(r.check),
  ran: ranLine(r.record),
  harness: r.record.harness,
  slot: r.slot,
  run_at: r.runAt.toISOString(),
  strategy_version: r.record.strategy_version,
  router_version: r.record.router_version,
  inputs: r.record.inputs ?? null,
  numbers: r.record.numbers ?? null,
});

canaryRoutes.get("/v1/markets/:market/canary", async (c) => {
  const db = dbOf(c);
  const market = c.req.param("market");
  const [row] = await db.select({ strategy: markets.strategyProgram }).from(markets).where(eq(markets.address, market));
  if (!row) throw notFound("market");
  const versions = await versionsOf(db, row.strategy);
  const asked = c.req.query("version");
  if (asked !== undefined && !SLOT.test(asked)) return c.json<ApiError>({ error: "A version is the slot its strategy was deployed in, a whole number." }, 400);
  const version = asked === undefined ? versions[0] : versions.find((v) => v.deploySlot === BigInt(asked));
  if (!version) throw notFound(asked === undefined ? "recorded version of this market's strategy" : "version of this market's strategy deployed in that slot");
  const current = version === versions[0];
  const latest = await readCanaryLatest(db, { market, version: { program: version.program, deploySlot: version.deploySlot } });
  return c.json(
    CanaryResults.parse({
      market,
      version: { program: version.program, deploy_slot: Number(version.deploySlot), executable_sha256: version.executableSha256, current },
      results: latest.map(resultView),
      could_not_sell_back: current ? couldNotSellBack(latest) : [],
    }),
  );
});

canaryRoutes.get("/v1/strategies/:program/versions/:slot/canary", async (c) => {
  const db = dbOf(c);
  const program = c.req.param("program");
  const slot = c.req.param("slot");
  if (!SLOT.test(slot)) return c.json<ApiError>({ error: "A version is the slot its strategy was deployed in, a whole number." }, 400);
  const versions = await versionsOf(db, program);
  const version = versions.find((v) => v.deploySlot === BigInt(slot));
  if (!version) throw notFound("version of this strategy deployed in that slot");
  const rollup = await readCanaryRollup(db, { program, deploySlot: version.deploySlot });
  const [run] = await db
    .select()
    .from(canaryRuns)
    .where(and(eq(canaryRuns.program, program), eq(canaryRuns.deploySlot, version.deploySlot)))
    .orderBy(desc(canaryRuns.startedAt), desc(canaryRuns.id))
    .limit(1);
  return c.json(
    CanaryRollup.parse({
      program,
      deploy_slot: Number(version.deploySlot),
      current: version === versions[0],
      markets: rollup.markets,
      checks: Object.fromEntries(Object.entries(rollup.checks).map(([check, r]) => [check, { about: aboutCheck(check), ...r }])),
      last_run: run ? { trigger: run.trigger, delay_ms: run.delayMs, markets: run.markets, started_at: run.startedAt.toISOString(), finished_at: run.finishedAt?.toISOString() ?? null } : null,
    }),
  );
});

canaryRoutes.get("/v1/strategies/:program/versions/:slot/canary/schedule", async (c) => {
  const program = c.req.param("program");
  const slot = c.req.param("slot");
  if (!ADDRESS.test(program)) return c.json<ApiError>({ error: "This is not a strategy program's address." }, 400);
  if (!SLOT.test(slot)) return c.json<ApiError>({ error: "A version is the slot its strategy was deployed in, a whole number." }, 400);
  const version = { program, deploySlot: String(BigInt(slot)) };
  const status = await c.env.CANARY_RUNS.get(c.env.CANARY_RUNS.idFromName(canaryRunName(version))).status();
  return c.json(
    CanarySchedule.parse({
      program,
      deploy_slot: Number(version.deploySlot),
      runs: status.runs.map((r) => ({ trigger: r.trigger, delay_ms: r.delayMs, due_at: new Date(r.dueAt).toISOString(), markets: r.markets, done: r.done, started: r.started })),
    }),
  );
});

canaryRoutes.post("/v1/canary/reruns", async (c) => {
  const refuse = (status: 400 | 401 | 403 | 404 | 409, error: string) => c.json<ApiError>({ error }, status);
  const body = CanaryRerun.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return refuse(400, "This is not a Canary re-run.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.data.payload);
  } catch {
    return refuse(400, "This is not a Canary re-run.");
  }
  const payload = CanaryRerunPayload.safeParse(parsed);
  if (!payload.success) return refuse(400, "This is not a Canary re-run: it names a market or a strategy, the wallet and the time.");
  const rerun = payload.data;
  if (!(await signedBy(rerun.wallet, canaryRerunMessage(body.data.payload), body.data.signature))) return refuse(401, "The re-run's signature does not match its wallet.");
  if (rerun.wallet !== c.env.CANARY_OPERATOR) return refuse(403, "Only the operator wallet's re-runs are taken.");
  if (Math.abs(Date.parse(rerun.at) - Date.now()) > CANARY.rerunMaxSkewMs) return refuse(409, "The re-run's time is too far from now.");

  const db = dbOf(c);
  const strategy = rerun.strategy ?? (await db.select({ strategy: markets.strategyProgram }).from(markets).where(eq(markets.address, rerun.market!)))[0]?.strategy;
  if (!strategy) return refuse(404, "Aviary knows no market at this address.");
  const [version] = await versionsOf(db, strategy);
  if (!version) return refuse(404, "Aviary has recorded no version of this strategy.");
  const list = rerun.market ? [rerun.market] : (await db.select({ address: markets.address }).from(markets).where(eq(markets.strategyProgram, strategy))).map((m) => m.address).sort();
  if (!list.length) return refuse(404, "This strategy has no market to run.");
  const target = { program: strategy, deploySlot: String(version.deploySlot) };
  await startCanary(c.env)(target, { trigger: "rerun", markets: list });
  return c.json({ version: target, markets: list }, 202);
});
