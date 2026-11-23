// What starts Canary's runs (docs/spec/pipescope-canary.md, When Canary runs, the one place that
// states them; CANARY-22, CANARY-23; #124). Each run is one strategy version's `CanaryRun`.
//
// - The indexer's outbox, read from Canary's own cursor: a new market runs on its strategy's
//   current version at once and each of CANARY.marketCreatedDelaysMs after its creation, so the
//   markets the first backfill finds run once and those still young again later (CANARY-48); a
//   new strategy version runs every market of the strategy; a router upgrade runs every market of
//   every strategy's current version. The indexer drains it after each of its jobs that touched
//   Postgres, so the database is never woken just to look (./indexer; PIPESCOPE-118).
// - The sweep, every JOB_INTERVAL_MINUTES.canarySweep, runs every market, after draining the outbox.
//
// An event is acknowledged only once its runs were handed to their objects, so a failure reads it
// again. A new market whose strategy has no recorded version yet (the ProgramData watch records it
// within a minute) stops the drain until it has one, or until CANARY.versionWaitMs has passed.
import { ackOutbox, markets, programVersions, readOutbox, type Db, type OutboxEvent } from "terminal-db";
import { desc, eq, inArray } from "drizzle-orm";
import type { CanaryRunRequest, CanaryRunVersion } from "./canaryRunCore";
import { CANARY } from "./config";

/** Canary's cursor in `outbox_cursors`. */
export const CANARY_CONSUMER = "canary";

/** Hands a request to a version's `CanaryRun`. */
export type CanaryStarts = (version: CanaryRunVersion, request: CanaryRunRequest) => Promise<void>;

/** The version in force of each strategy that has markets, with those markets. */
async function strategiesWithMarkets(db: Db, only?: string): Promise<{ version: CanaryRunVersion; markets: string[] }[]> {
  const rows = await db
    .select({ address: markets.address, strategy: markets.strategyProgram })
    .from(markets)
    .where(only ? eq(markets.strategyProgram, only) : undefined);
  const byStrategy = new Map<string, string[]>();
  for (const row of rows) byStrategy.set(row.strategy, [...(byStrategy.get(row.strategy) ?? []), row.address]);
  if (!byStrategy.size) return [];
  const versions = await db
    .selectDistinctOn([programVersions.program], { program: programVersions.program, deploySlot: programVersions.deploySlot })
    .from(programVersions)
    .where(inArray(programVersions.program, [...byStrategy.keys()]))
    .orderBy(programVersions.program, desc(programVersions.deploySlot));
  return versions.map((v) => ({ version: { program: v.program, deploySlot: String(v.deploySlot) }, markets: byStrategy.get(v.program)! }));
}

async function currentVersion(db: Db, program: string): Promise<CanaryRunVersion | null> {
  const [row] = await db.select({ deploySlot: programVersions.deploySlot }).from(programVersions).where(eq(programVersions.program, program)).orderBy(desc(programVersions.deploySlot)).limit(1);
  return row ? { program, deploySlot: String(row.deploySlot) } : null;
}

/** Starts the runs one event asks for; false when it must wait for its strategy's version. */
async function act(db: Db, event: OutboxEvent, start: CanaryStarts, now: number): Promise<boolean> {
  switch (event.kind) {
    case "market_created": {
      const version = await currentVersion(db, event.payload.strategy);
      if (!version) {
        if (now - event.createdAt.getTime() < CANARY.versionWaitMs) return false;
        console.warn(`canary: no version of ${event.payload.strategy} was recorded for market ${event.subject}; its first runs are passed by, and the sweep runs it`);
        return true;
      }
      // Its later runs count from its creation: a market found long after it was made runs once now.
      const [row] = await db.select({ createdAt: markets.createdAt }).from(markets).where(eq(markets.address, event.subject));
      const since = (row?.createdAt ?? event.createdAt).getTime();
      await start(version, { trigger: "market_created", markets: [event.subject], delaysMs: CANARY.marketCreatedDelaysMs, since });
      return true;
    }
    case "strategy_version": {
      for (const { markets: list } of await strategiesWithMarkets(db, event.subject)) {
        await start({ program: event.subject, deploySlot: event.payload.deploySlot }, { trigger: "strategy_version", markets: list });
      }
      return true;
    }
    case "router_upgraded": {
      for (const { version, markets: list } of await strategiesWithMarkets(db)) await start(version, { trigger: "router_upgraded", markets: list });
      return true;
    }
    default:
      // A new strategy has no market yet; Canary's own events are for the Telegram bot.
      return true;
  }
}

/** Reads the outbox on from Canary's cursor and starts the runs it asks for; returns how many events it acted on. */
export async function drainCanaryOutbox(db: Db, start: CanaryStarts, now: number): Promise<number> {
  let acted = 0;
  for (;;) {
    const events = await readOutbox(db, CANARY_CONSUMER);
    if (!events.length) return acted;
    for (const event of events) {
      if (!(await act(db, event, start, now))) return acted;
      await ackOutbox(db, CANARY_CONSUMER, event.id);
      acted++;
    }
  }
}

/** The scheduled sweep: every market of every strategy, on its current version (CANARY-23). */
export async function sweepCanary(db: Db, start: CanaryStarts): Promise<void> {
  for (const { version, markets: list } of await strategiesWithMarkets(db)) await start(version, { trigger: "sweep", markets: list });
}
