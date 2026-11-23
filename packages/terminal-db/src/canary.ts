// Canary's runs and results in Postgres (docs/spec/pipescope-architecture.md, "Canary runner";
// docs/spec/pipescope-canary.md, "Records"; CANARY-20; #124). The `CanaryRun` Durable Object of a
// strategy version writes a run when it starts, each market's records as the container answers,
// and the run's end; the API reads a market's latest results and a version's roll-up.
//
// Kept: the latest record of each check per market and version, and every earlier one whose
// outcome differed from the one after it. So storing a record removes the one it replaces when
// both have the same outcome, and otherwise keeps it as history.
//
// What changed is written to the outbox for the Telegram bot (#133, #134): a market's first
// results, each changed outcome, and the end of each run. A store takes the outbox's lock first,
// as every outbox writer does (./outbox).
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./index.ts";
import { appendOutbox, lockOutbox } from "./outbox.ts";
import { canaryResults, canaryRunMarkets, canaryRuns } from "./schema.ts";

/** One of the five outcomes (docs/spec/pipescope-canary.md, Outcomes). */
export type CanaryOutcome = "pass" | "warn" | "fail" | "not run" | "noted";

/** A program as of one deploy, as the binary records it. */
export type CanaryRecordVersion = { deploy_slot: number | null; executable_sha256: string | null };

/** One Canary result, as the binary writes it (crates/canary/src/record.rs, `Record`). */
export type CanaryRecord = {
  id: string;
  check: string;
  harness: string;
  cluster: string | null;
  slot: number;
  /** Unix seconds. */
  run_at: number;
  strategy: string | null;
  strategy_version: CanaryRecordVersion;
  router_version: CanaryRecordVersion;
  market: string;
  inputs: unknown;
  outcome: CanaryOutcome;
  reason: string;
  numbers: unknown;
};

/** A strategy version, as the indexer keys it (`program_versions`). */
export type CanaryVersion = { program: string; deploySlot: bigint };

/** What starts a run (CANARY-22, CANARY-23). */
export type CanaryTrigger = "market_created" | "strategy_version" | "router_upgraded" | "sweep" | "rerun";

/** A stored result. */
export type StoredCanaryResult = {
  id: string;
  runId: bigint;
  market: string;
  check: string;
  outcome: CanaryOutcome;
  slot: number;
  runAt: Date;
  latest: boolean;
  record: CanaryRecord;
};

/** Writes a run as it starts; returns its id. */
export async function startCanaryRun(db: Db, run: { version: CanaryVersion; trigger: CanaryTrigger; delayMs: number; markets: string[] }): Promise<bigint> {
  const [row] = await db
    .insert(canaryRuns)
    .values({ program: run.version.program, deploySlot: run.version.deploySlot, trigger: run.trigger, delayMs: run.delayMs, markets: run.markets.length })
    .returning({ id: canaryRuns.id });
  return row!.id;
}

/**
 * Stores one market's records from one run, keeping what CANARY-20 keeps, and writes the outbox
 * events they make: the market's first results, and each check whose outcome differs from its
 * previous latest record for the same version. Says how many outcomes changed and whether these
 * were the market's first results.
 */
export async function storeCanaryMarket(
  db: Db,
  done: { runId: bigint; version: CanaryVersion; market: string; records: CanaryRecord[]; notes: string[]; rounds: number; rpcRequests: number; containerMs: number },
): Promise<{ changed: number; first: boolean }> {
  const { runId, version, market } = done;
  const deploySlot = String(version.deploySlot);
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    await lockOutbox(tx);
    const [before] = await tx.select({ id: canaryResults.id }).from(canaryResults).where(eq(canaryResults.market, market)).limit(1);
    let changed = 0;
    for (const record of done.records) {
      const [already] = await tx.select({ id: canaryResults.id }).from(canaryResults).where(eq(canaryResults.id, record.id));
      if (already) continue;
      const [previous] = await tx
        .select({ id: canaryResults.id, outcome: canaryResults.outcome })
        .from(canaryResults)
        .where(and(eq(canaryResults.market, market), eq(canaryResults.program, version.program), eq(canaryResults.deploySlot, version.deploySlot), eq(canaryResults.check, record.check), eq(canaryResults.latest, true)))
        .for("update");
      if (previous) {
        if (previous.outcome === record.outcome) await tx.delete(canaryResults).where(eq(canaryResults.id, previous.id));
        else {
          await tx.update(canaryResults).set({ latest: false }).where(eq(canaryResults.id, previous.id));
          changed++;
          await appendOutbox(tx, {
            kind: "canary_outcome_changed",
            subject: market,
            slot: BigInt(record.slot),
            payload: { program: version.program, deploySlot, check: record.check, from: previous.outcome, to: record.outcome, reason: record.reason, record: record.id },
          });
        }
      }
      await tx.insert(canaryResults).values({
        id: record.id,
        runId,
        program: version.program,
        deploySlot: version.deploySlot,
        market,
        check: record.check,
        outcome: record.outcome,
        harness: record.harness,
        slot: BigInt(record.slot),
        runAt: new Date(record.run_at * 1000),
        record,
        latest: true,
      });
    }
    const first = !before && done.records.length > 0;
    if (first) await appendOutbox(tx, { kind: "canary_first_results", subject: market, slot: BigInt(done.records[0]!.slot), payload: { program: version.program, deploySlot } });
    await tx
      .insert(canaryRunMarkets)
      .values({ runId, market, status: "done", rounds: done.rounds, rpcRequests: done.rpcRequests, containerMs: done.containerMs, notes: done.notes })
      .onConflictDoNothing();
    return { changed, first };
  });
}

/** Records a market Aviary could not run (the RPC or the container failing past the retries); its earlier results stand. */
export async function failCanaryMarket(db: Db, failed: { runId: bigint; market: string; error: string; rpcRequests?: number }): Promise<void> {
  await db
    .insert(canaryRunMarkets)
    .values({ runId: failed.runId, market: failed.market, status: "failed", error: failed.error, rpcRequests: failed.rpcRequests ?? null })
    .onConflictDoNothing();
}

/** Ends a run and tells the bot, with how many of its markets Aviary could not run. */
export async function finishCanaryRun(db: Db, runId: bigint): Promise<void> {
  await db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    await lockOutbox(tx);
    const [run] = await tx.update(canaryRuns).set({ finishedAt: sql`now()` }).where(eq(canaryRuns.id, runId)).returning();
    if (!run) throw new Error(`there is no Canary run ${runId}`);
    const [counts] = await tx
      .select({ failed: sql<number>`count(*) filter (where ${canaryRunMarkets.status} = 'failed')::int` })
      .from(canaryRunMarkets)
      .where(eq(canaryRunMarkets.runId, runId));
    await appendOutbox(tx, {
      kind: "canary_run_finished",
      subject: run.program,
      slot: null,
      payload: { deploySlot: String(run.deploySlot), runId: String(run.id), trigger: run.trigger, delayMs: run.delayMs, markets: run.markets, failed: counts?.failed ?? 0 },
    });
  });
}

const stored = (row: typeof canaryResults.$inferSelect): StoredCanaryResult => ({
  id: row.id,
  runId: row.runId,
  market: row.market,
  check: row.check,
  outcome: row.outcome as CanaryOutcome,
  slot: Number(row.slot),
  runAt: row.runAt,
  latest: row.latest,
  record: row.record as CanaryRecord,
});

const ofMarketVersion = (market: string, version: CanaryVersion) =>
  and(eq(canaryResults.market, market), eq(canaryResults.program, version.program), eq(canaryResults.deploySlot, version.deploySlot));

/** A market's latest result of each check under one version, by check. */
export async function readCanaryLatest(db: Db, { market, version }: { market: string; version: CanaryVersion }): Promise<StoredCanaryResult[]> {
  const rows = await db
    .select()
    .from(canaryResults)
    .where(and(ofMarketVersion(market, version), eq(canaryResults.latest, true)))
    .orderBy(asc(canaryResults.check));
  return rows.map(stored);
}

/** Every kept result of a market under one version: by check, newest first. */
export async function readCanaryHistory(db: Db, { market, version }: { market: string; version: CanaryVersion }): Promise<StoredCanaryResult[]> {
  const rows = await db
    .select()
    .from(canaryResults)
    .where(ofMarketVersion(market, version))
    .orderBy(asc(canaryResults.check), desc(canaryResults.slot));
  return rows.map(stored);
}

/** One check's outcomes across a version's markets (crates/canary/src/record.rs, `CheckRollup`). */
export type CanaryCheckRollup = { outcomes: Partial<Record<CanaryOutcome, number>>; warn: string[]; fail: string[] };

/** A version's roll-up from its markets' latest results (docs/spec/pipescope-canary.md, Records). */
export type CanaryRollup = { program: string; deploySlot: bigint; markets: number; checks: Record<string, CanaryCheckRollup> };

export async function readCanaryRollup(db: Db, version: CanaryVersion): Promise<CanaryRollup> {
  const rows = await db
    .select({ market: canaryResults.market, check: canaryResults.check, outcome: canaryResults.outcome })
    .from(canaryResults)
    .where(and(eq(canaryResults.program, version.program), eq(canaryResults.deploySlot, version.deploySlot), eq(canaryResults.latest, true)))
    .orderBy(asc(canaryResults.check), asc(canaryResults.market));
  const checks: Record<string, CanaryCheckRollup> = {};
  const markets = new Set<string>();
  for (const row of rows) {
    markets.add(row.market);
    const check = (checks[row.check] ??= { outcomes: {}, warn: [], fail: [] });
    const outcome = row.outcome as CanaryOutcome;
    check.outcomes[outcome] = (check.outcomes[outcome] ?? 0) + 1;
    if (outcome === "warn") check.warn.push(row.market);
    if (outcome === "fail") check.fail.push(row.market);
  }
  return { program: version.program, deploySlot: version.deploySlot, markets: markets.size, checks };
}
