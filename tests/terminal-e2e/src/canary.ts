// Canary's results in the end-to-end tests (#125). The suite's API runs without Canary's container
// (playwright.config.ts), so the pages' Canary parts are drawn from real records: every latest result
// of six devnet markets from Canary's sweep of 2026-11-23 (apps/terminal-api/test/fixtures/
// canary-records.json, which the API's own tests use too), stored as the `CanaryRun` objects store
// them, each only under the strategy version it was run on.
//
// On the recorded fixtures every one of those versions is the market's strategy's current version, so
// a market whose version differs means the recording moved on: take the records again from a sweep of
// the new recording's moment. On live devnet a strategy upgraded since is skipped, and says so, and a
// market that already has results of its own, as on a local run with Canary's container, keeps them.
import { readFileSync } from "node:fs";
import { createDb, finishCanaryRun, programVersions, readCanaryLatest, startCanaryRun, storeCanaryMarket, type CanaryRecord } from "terminal-db";
import { desc, eq } from "drizzle-orm";
import { RPC_MODE } from "./target";

const RECORDS = JSON.parse(readFileSync(`${import.meta.dirname}/../../../apps/terminal-api/test/fixtures/canary-records.json`, "utf8")) as Record<string, CanaryRecord[]>;

/** The six markets, by what each shows. */
export const CANARY_MARKETS = Object.fromEntries(Object.entries(RECORDS).map(([label, records]) => [label, records[0]!.market])) as Record<
  "open_curve" | "outside_builder" | "stranded" | "refusing" | "tax_demo" | "sniper",
  string
>;
/** The bonding curve's strategy, two of whose markets above are stranded and refusing. */
export const CANARY_CURVE_STRATEGY = RECORDS.open_curve![0]!.strategy!;

/** Stores the records of each market whose strategy's current version is the one they were run on. */
export async function seedCanaryResults(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { db, close } = createDb(url);
  try {
    for (const [label, records] of Object.entries(RECORDS)) {
      const first = records[0]!;
      const [current] = await db.select({ deploySlot: programVersions.deploySlot }).from(programVersions).where(eq(programVersions.program, first.strategy!)).orderBy(desc(programVersions.deploySlot)).limit(1);
      if (current?.deploySlot !== BigInt(first.strategy_version.deploy_slot!)) {
        const why = `Canary's ${label} records (${first.market}) were run on version ${first.strategy_version.deploy_slot} of ${first.strategy}, and its current version here is ${current?.deploySlot ?? "not recorded"}`;
        if (RPC_MODE === "fixtures") throw new Error(`${why}: take the records again from a sweep at the recording's moment.`);
        console.warn(`${why}: not seeded.`);
        continue;
      }
      const version = { program: first.strategy!, deploySlot: current.deploySlot };
      // A market Canary has already run under this version (a live run with the container) keeps its own results.
      if ((await readCanaryLatest(db, { market: first.market, version })).length) continue;
      const runId = await startCanaryRun(db, { version, trigger: "sweep", delayMs: 0, markets: [first.market] });
      // A record already stored (a database reused from an earlier run) is skipped by its id.
      await storeCanaryMarket(db, { runId, version, market: first.market, records, notes: ["seeded by the end-to-end tests"], rounds: 1, rpcRequests: 0, containerMs: 0 });
      await finishCanaryRun(db, runId);
    }
  } finally {
    await close();
  }
}
