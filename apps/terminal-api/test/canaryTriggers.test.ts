// What starts Canary's runs (docs/spec/pipescope-canary.md, When Canary runs; CANARY-22, CANARY-23;
// #124): the indexer's outbox (a new market, a new strategy version, a router upgrade), read from
// Canary's own cursor, and the sweep of every market.
import { eq } from "drizzle-orm";
import { appendOutbox, createDb, markets, programVersions, readOutbox, strategies } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANARY_CONSUMER, drainCanaryOutbox, sweepCanary, type CanaryStarts } from "../src/canaryTriggers";
import type { CanaryRunRequest, CanaryRunVersion } from "../src/canaryRunCore";
import { CANARY } from "../src/config";

const ROUTER = "PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34";
const CP = "yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx";
const CURVE = "ETrmUeKxFsH3KxSHPuzCMvNgv7AGGmhsUHGWBaJDKrnb";
const M1 = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const M2 = "AMJ4eVWMgqc9hZMmKDipbvwU6EQkmAvhUf4F42dNSDuu";
const M3 = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const CREATOR = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: ReturnType<typeof createDb>;
beforeEach(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
  const { db } = client;
  await db.insert(strategies).values([CP, CURVE].map((program) => ({ program, metadataUri: "https://example.org/s.json", registeredAt: new Date() })));
  await db.insert(programVersions).values([
    { program: CP, deploySlot: 100n, role: "strategy", backfilled: true },
    { program: CP, deploySlot: 200n, role: "strategy", executableSha256: "aa".repeat(32) },
    { program: CURVE, deploySlot: 300n, role: "strategy", executableSha256: "bb".repeat(32) },
    { program: ROUTER, deploySlot: 50n, role: "router", executableSha256: "cc".repeat(32) },
  ]);
  await db.insert(markets).values([
    { address: M1, strategyProgram: CP, marketState: M1, createdBy: CREATOR, createdAt: new Date() },
    { address: M2, strategyProgram: CP, marketState: M2, createdBy: CREATOR, createdAt: new Date() },
    { address: M3, strategyProgram: CURVE, marketState: M3, createdBy: CREATOR, createdAt: new Date() },
  ]);
});
afterEach(async () => {
  await client.close();
  await database.drop();
});

function starts() {
  const started: { version: CanaryRunVersion; request: CanaryRunRequest }[] = [];
  const start: CanaryStarts = async (version, request) => void started.push({ version, request: { ...request, markets: [...request.markets].sort() } });
  return { started, start };
}

describe("Canary's triggers", () => {
  it("runs a new market on its strategy's current version at once and 10 minutes, 1 hour and 1 day after it was created", async () => {
    const created = new Date("2026-11-23T08:00:00Z");
    await client.db.update(markets).set({ createdAt: created }).where(eq(markets.address, M3));
    await appendOutbox(client.db, { kind: "market_created", subject: M3, slot: 10n, payload: { strategy: CURVE } });
    const { started, start } = starts();
    await drainCanaryOutbox(client.db, start, Date.now());
    expect(started).toEqual([{ version: { program: CURVE, deploySlot: "300" }, request: { trigger: "market_created", markets: [M3], delaysMs: CANARY.marketCreatedDelaysMs, since: created.getTime() } }]);
    expect(await readOutbox(client.db, CANARY_CONSUMER)).toEqual([]);
  });

  it("runs a new strategy version on every market of the strategy, and a router upgrade on every market of every strategy's current version", async () => {
    await appendOutbox(client.db, { kind: "strategy_registered", subject: CURVE, slot: 1n, payload: { metadataUri: "https://example.org/s.json" } });
    await appendOutbox(client.db, { kind: "strategy_version", subject: CP, slot: 200n, payload: { deploySlot: "200", executableSha256: "aa".repeat(32), previousSlot: "100" } });
    await appendOutbox(client.db, { kind: "router_upgraded", subject: ROUTER, slot: 50n, payload: { deploySlot: "50", executableSha256: "cc".repeat(32), previousSlot: null } });
    await appendOutbox(client.db, { kind: "canary_first_results", subject: M1, slot: 9n, payload: { program: CP, deploySlot: "200" } });
    const { started, start } = starts();
    await drainCanaryOutbox(client.db, start, Date.now());
    expect(started).toEqual([
      { version: { program: CP, deploySlot: "200" }, request: { trigger: "strategy_version", markets: [M1, M2].sort() } },
      // Strategies in address order.
      { version: { program: CURVE, deploySlot: "300" }, request: { trigger: "router_upgraded", markets: [M3] } },
      { version: { program: CP, deploySlot: "200" }, request: { trigger: "router_upgraded", markets: [M1, M2].sort() } },
    ]);
    expect(await readOutbox(client.db, CANARY_CONSUMER)).toEqual([]);
  });

  it("waits for the watch to record a new market's strategy version, reading the event again, and passes it by once the wait is over", async () => {
    const LATE = "LateStrategy1111111111111111111111111111111";
    await appendOutbox(client.db, { kind: "market_created", subject: M1, slot: 10n, payload: { strategy: LATE } });
    await appendOutbox(client.db, { kind: "market_created", subject: M3, slot: 11n, payload: { strategy: CURVE } });
    const { started, start } = starts();
    await drainCanaryOutbox(client.db, start, Date.now());
    expect(started).toEqual([]);
    expect(await readOutbox(client.db, CANARY_CONSUMER)).toHaveLength(2);

    await drainCanaryOutbox(client.db, start, Date.now() + CANARY.versionWaitMs + 1);
    expect(started.map((s) => s.request.markets)).toEqual([[M3]]);
    // A market the indexer has not stored counts from when its event was written.
    expect(started[0]!.request.since).toEqual(expect.any(Number));
    expect(await readOutbox(client.db, CANARY_CONSUMER)).toEqual([]);
  });

  it("reads an event again when a run could not be started, so none is lost", async () => {
    await appendOutbox(client.db, { kind: "market_created", subject: M3, slot: 10n, payload: { strategy: CURVE } });
    await expect(drainCanaryOutbox(client.db, async () => Promise.reject(new Error("the object is resetting")), Date.now())).rejects.toThrow("resetting");
    expect(await readOutbox(client.db, CANARY_CONSUMER)).toHaveLength(1);
  });

  it("sweeps every market of every strategy on its current version", async () => {
    const { started, start } = starts();
    await sweepCanary(client.db, start);
    expect(started).toEqual([
      { version: { program: CURVE, deploySlot: "300" }, request: { trigger: "sweep", markets: [M3] } },
      { version: { program: CP, deploySlot: "200" }, request: { trigger: "sweep", markets: [M1, M2].sort() } },
    ]);
  });
});
