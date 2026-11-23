// The keeper runner's records (docs/spec/keeper-runner.md, "What it records" and "How Aviary shows
// it"; SUITE-37): the runner writes each pass that sent, held or parked something with
// `recordKeeperPass`, straight from the owner's Mac, and `terminal-api`'s keeper endpoint reads
// them back with `readKeeperRecords`. Amounts are in lamports.
import { and, desc, eq, gte, isNotNull, max, sql } from "drizzle-orm";
import type { Db } from "./index.ts";
import { keeperRunJobs, keeperRuns, type KeeperCap } from "./schema.ts";

export type KeeperCounts = { markets: number; sent: number; held: number; parked: number; skipped: number; failed: number };

export type KeeperJobRecord = {
  at: Date;
  market: string | null;
  product: string | null;
  job: string;
  slot: number | null;
  outcome: string;
  signature: string | null;
  cost: bigint | null;
  estimate: bigint | null;
  cap: string | null;
  error: string | null;
  attempt: number | null;
};

export type KeeperPassRecord = {
  wallet: string;
  pass: string;
  at: Date;
  balance: bigint | null;
  /** The UTC day today's spend is counted for, "2026-11-22". */
  day: string;
  /** Today's spend, or null when it could not be rebuilt from the chain for this pass. */
  spentTotal: bigint | null;
  spentByMarket: Record<string, bigint> | null;
  caps: Record<KeeperCap, bigint>;
  settings: Record<string, string>;
  warnings: string[];
  counts: KeeperCounts;
  jobs: KeeperJobRecord[];
};

/** Writes one pass and its jobs in one transaction, so a pass is never recorded without its jobs. */
export async function recordKeeperPass(db: Db, record: KeeperPassRecord): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(keeperRuns)
      .values({
        wallet: record.wallet,
        pass: record.pass,
        at: record.at,
        balance: record.balance,
        day: record.day,
        spentTotal: record.spentTotal,
        spentByMarket: record.spentByMarket && strings(record.spentByMarket),
        caps: strings(record.caps),
        settings: record.settings,
        warnings: record.warnings,
        ...record.counts,
      })
      .returning({ id: keeperRuns.id });
    if (!run) throw new Error("the pass was not recorded");
    if (record.jobs.length > 0) await tx.insert(keeperRunJobs).values(record.jobs.map((job) => ({ runId: run.id, ...job })));
  });
}

export type KeeperPassRead = Omit<KeeperPassRecord, "jobs" | "wallet"> & { /** How many jobs the pass recorded. */ recordedJobs: number };
export type KeeperJobRead = KeeperJobRecord & { pass: string };

export type KeeperRecords = {
  /** The latest recorded pass, with the caps and settings it ran with and its warnings. */
  latest: KeeperPassRead | null;
  /** Today's spend, from today's latest recorded pass that knew it; null when none did (when nothing was recorded today, nothing was spent). */
  today: { day: string; spentTotal: bigint; spentByMarket: Record<string, bigint>; highestCost: bigint | null } | null;
  /** The latest recorded pass of each kind, newest first. */
  lastOfEachKind: KeeperPassRead[];
  /** The latest jobs, newest first. */
  recent: KeeperJobRead[];
  /** Jobs still held by a cap today, or parked since `since`, newest first: a later row for the same job ends either. */
  waiting: KeeperJobRead[];
};

/**
 * What the keeper page shows of one keeper wallet's records. `since` is when the runner last
 * started, if known: a park is kept only in the runner's memory, so one recorded before it is over.
 */
export async function readKeeperRecords(db: Db, options: { wallet: string; now: Date; recentJobs: number; since: Date | null }): Promise<KeeperRecords> {
  const { wallet, now, recentJobs, since } = options;
  const today = now.toISOString().slice(0, 10);
  const passColumns = {
    pass: keeperRuns.pass,
    at: keeperRuns.at,
    balance: keeperRuns.balance,
    day: keeperRuns.day,
    spentTotal: keeperRuns.spentTotal,
    spentByMarket: keeperRuns.spentByMarket,
    caps: keeperRuns.caps,
    settings: keeperRuns.settings,
    warnings: keeperRuns.warnings,
    markets: keeperRuns.markets,
    sent: keeperRuns.sent,
    held: keeperRuns.held,
    parked: keeperRuns.parked,
    skipped: keeperRuns.skipped,
    failed: keeperRuns.failed,
    // Written out in full: inside a subquery Drizzle would leave the column names unqualified.
    recordedJobs: sql<number>`(select count(*)::int from "keeper_run_jobs" where "keeper_run_jobs"."run_id" = "keeper_runs"."id")`,
  };
  const jobColumns = {
    pass: keeperRuns.pass,
    at: keeperRunJobs.at,
    market: keeperRunJobs.market,
    product: keeperRunJobs.product,
    job: keeperRunJobs.job,
    slot: keeperRunJobs.slot,
    outcome: keeperRunJobs.outcome,
    signature: keeperRunJobs.signature,
    cost: keeperRunJobs.cost,
    estimate: keeperRunJobs.estimate,
    cap: keeperRunJobs.cap,
    error: keeperRunJobs.error,
    attempt: keeperRunJobs.attempt,
  };

  const dayStart = new Date(`${today}T00:00:00Z`);
  const [latestRows, spendRows, kindRows, recent, unitRows, highest] = await Promise.all([
    db.select(passColumns).from(keeperRuns).where(eq(keeperRuns.wallet, wallet)).orderBy(desc(keeperRuns.at), desc(keeperRuns.id)).limit(1),
    db
      .select({ day: keeperRuns.day, spentTotal: keeperRuns.spentTotal, spentByMarket: keeperRuns.spentByMarket })
      .from(keeperRuns)
      .where(and(eq(keeperRuns.wallet, wallet), eq(keeperRuns.day, today), isNotNull(keeperRuns.spentTotal)))
      .orderBy(desc(keeperRuns.at), desc(keeperRuns.id))
      .limit(1),
    db
      .selectDistinctOn([keeperRuns.pass], passColumns)
      .from(keeperRuns)
      .where(eq(keeperRuns.wallet, wallet))
      .orderBy(keeperRuns.pass, desc(keeperRuns.at), desc(keeperRuns.id)),
    db
      .select(jobColumns)
      .from(keeperRunJobs)
      .innerJoin(keeperRuns, eq(keeperRuns.id, keeperRunJobs.runId))
      .where(eq(keeperRuns.wallet, wallet))
      .orderBy(desc(keeperRunJobs.at), desc(keeperRunJobs.id))
      .limit(recentJobs),
    // The latest row of each job unit (market, job and slot), for those whose latest row is a hold or a park.
    db
      .selectDistinctOn([keeperRunJobs.market, keeperRunJobs.job, sql`coalesce(${keeperRunJobs.slot}, -1)`], jobColumns)
      .from(keeperRunJobs)
      .innerJoin(keeperRuns, eq(keeperRuns.id, keeperRunJobs.runId))
      .where(eq(keeperRuns.wallet, wallet))
      .orderBy(keeperRunJobs.market, keeperRunJobs.job, sql`coalesce(${keeperRunJobs.slot}, -1)`, desc(keeperRunJobs.at), desc(keeperRunJobs.id)),
    db
      .select({ cost: max(keeperRunJobs.cost) })
      .from(keeperRunJobs)
      .innerJoin(keeperRuns, eq(keeperRuns.id, keeperRunJobs.runId))
      .where(and(eq(keeperRuns.wallet, wallet), gte(keeperRunJobs.at, dayStart))),
  ]);

  const passOf = (row: (typeof latestRows)[number]): KeeperPassRead => ({
    pass: row.pass,
    at: row.at,
    balance: row.balance,
    day: row.day,
    spentTotal: row.spentTotal,
    spentByMarket: row.spentByMarket && bigints(row.spentByMarket),
    caps: bigints(row.caps) as Record<KeeperCap, bigint>,
    settings: row.settings,
    warnings: row.warnings,
    counts: { markets: row.markets, sent: row.sent, held: row.held, parked: row.parked, skipped: row.skipped, failed: row.failed },
    recordedJobs: Number(row.recordedJobs),
  });

  const latest = latestRows[0] ? passOf(latestRows[0]) : null;
  const todays = spendRows[0];
  const waiting = unitRows
    .filter((row) => (row.outcome === "held" && row.at >= dayStart) || (row.outcome === "parked" && (since === null || row.at >= since)))
    .sort((a, b) => b.at.getTime() - a.at.getTime());

  return {
    latest,
    today: todays?.spentTotal != null && todays.spentByMarket
      ? { day: todays.day, spentTotal: todays.spentTotal, spentByMarket: bigints(todays.spentByMarket), highestCost: highest[0]?.cost ?? null }
      : null,
    lastOfEachKind: kindRows.map(passOf).sort((a, b) => b.at.getTime() - a.at.getTime()),
    recent,
    waiting,
  };
}

const strings = <K extends string>(values: Record<K, bigint>) => Object.fromEntries(Object.entries<bigint>(values).map(([k, v]) => [k, v.toString()])) as Record<K, string>;
const bigints = <K extends string>(values: Record<K, string>) => Object.fromEntries(Object.entries<string>(values).map(([k, v]) => [k, BigInt(v)])) as Record<K, bigint>;
