// Canary's records in Postgres (docs/spec/pipescope-canary.md, "Records"; CANARY-20; #124): one
// record per check, market and strategy version per run, keeping the latest of each and every
// earlier one whose outcome differed from the one after it, with the outbox events the Telegram
// bot reads.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/index.ts";
import { finishCanaryRun, readCanaryHistory, readCanaryLatest, readCanaryRollup, startCanaryRun, storeCanaryMarket, type CanaryRecord } from "../src/canary.ts";
import { readOutbox } from "../src/outbox.ts";
import { createTestDatabase } from "../src/testing.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
});
afterAll(async () => {
  await client?.close();
  await database?.drop();
});

const STRATEGY = "ETrmUeKxFsH3KxSHPuzCMvNgv7AGGmhsUHGWBaJDKrnb";
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const OTHER = "AMJ4eVWMgqc9hZMmKDipbvwU6EQkmAvhUf4F42dNSDuu";
const V1 = { program: STRATEGY, deploySlot: 500n };
const V2 = { program: STRATEGY, deploySlot: 900n };

/** A record as the binary writes it (crates/canary/src/record.rs). */
function record(check: string, market: string, deploySlot: bigint, slot: number, outcome: CanaryRecord["outcome"], numbers: unknown = {}): CanaryRecord {
  return {
    id: `${check}:${market}:${deploySlot}:${slot}`,
    check,
    harness: "0.3.1+test",
    cluster: "devnet",
    slot,
    run_at: 1_763_000_000 + slot,
    strategy: STRATEGY,
    strategy_version: { deploy_slot: Number(deploySlot), executable_sha256: "ab".repeat(32) },
    router_version: { deploy_slot: 100, executable_sha256: "cd".repeat(32) },
    market,
    inputs: {},
    outcome,
    reason: `${check} is ${outcome}.`,
    numbers,
  };
}

async function runOnce(version: typeof V1, market: string, slot: number, outcomes: Record<string, CanaryRecord["outcome"]>) {
  const { db } = client;
  const runId = await startCanaryRun(db, { version, trigger: "sweep", delayMs: 0, markets: [market] });
  const records = Object.entries(outcomes).map(([check, outcome]) => record(check, market, version.deploySlot, slot, outcome));
  const stored = await storeCanaryMarket(db, { runId, version, market, records, notes: [], rounds: 2, rpcRequests: 7, containerMs: 1234 });
  await finishCanaryRun(db, runId);
  return { runId, stored };
}

describe("Canary's records", () => {
  it("keeps the latest record of each check per market and version, and every earlier one whose outcome differed from the next", async () => {
    await runOnce(V1, MARKET, 1, { exit_sizes: "pass", cost: "pass" });
    await runOnce(V1, MARKET, 2, { exit_sizes: "pass", cost: "warn" }); // exit_sizes slot 1 goes: same outcome as slot 2
    await runOnce(V1, MARKET, 3, { exit_sizes: "warn", cost: "warn" }); // cost slot 2 goes; exit_sizes slot 2 stays
    await runOnce(V1, MARKET, 4, { exit_sizes: "warn", cost: "warn" }); // exit_sizes slot 3 and cost slot 3 go

    const latest = await readCanaryLatest(client.db, { market: MARKET, version: V1 });
    expect(latest.map((r) => [r.check, r.slot, r.outcome])).toEqual([
      ["cost", 4, "warn"],
      ["exit_sizes", 4, "warn"],
    ]);
    const history = await readCanaryHistory(client.db, { market: MARKET, version: V1 });
    expect(history.map((r) => [r.check, r.slot, r.outcome])).toEqual([
      ["cost", 4, "warn"],
      ["cost", 1, "pass"],
      ["exit_sizes", 4, "warn"],
      ["exit_sizes", 2, "pass"],
    ]);
  });

  it("keeps an older version's records attached to it when a new version runs", async () => {
    await runOnce(V2, MARKET, 10, { exit_sizes: "fail", cost: "pass" });
    expect((await readCanaryLatest(client.db, { market: MARKET, version: V1 })).map((r) => [r.check, r.outcome])).toEqual([
      ["cost", "warn"],
      ["exit_sizes", "warn"],
    ]);
    expect((await readCanaryLatest(client.db, { market: MARKET, version: V2 })).map((r) => [r.check, r.outcome, r.record.strategy_version.deploy_slot])).toEqual([
      ["cost", "pass", 900],
      ["exit_sizes", "fail", 900],
    ]);
  });

  it("rolls a version up per check from its markets' latest records, naming the markets that warn or fail", async () => {
    await runOnce(V2, OTHER, 11, { exit_sizes: "warn", cost: "pass" });
    expect(await readCanaryRollup(client.db, V2)).toEqual({
      program: STRATEGY,
      deploySlot: 900n,
      markets: 2,
      checks: {
        cost: { outcomes: { pass: 2 }, warn: [], fail: [] },
        exit_sizes: { outcomes: { fail: 1, warn: 1 }, warn: [OTHER], fail: [MARKET] },
      },
    });
  });

  it("tells the Telegram bot of a market's first results, each changed outcome and the end of each run", async () => {
    const events = (await readOutbox(client.db, "test-bot", { limit: 1000 })).map((e) => [e.kind, e.subject, e.payload]);
    const first = events.filter(([kind]) => kind === "canary_first_results");
    expect(first).toEqual([
      ["canary_first_results", MARKET, { program: STRATEGY, deploySlot: "500" }],
      ["canary_first_results", OTHER, { program: STRATEGY, deploySlot: "900" }],
    ]);
    const changed = events.filter(([kind]) => kind === "canary_outcome_changed");
    expect(changed).toEqual([
      ["canary_outcome_changed", MARKET, { program: STRATEGY, deploySlot: "500", check: "cost", from: "pass", to: "warn", reason: "cost is warn.", record: `cost:${MARKET}:500:2` }],
      ["canary_outcome_changed", MARKET, { program: STRATEGY, deploySlot: "500", check: "exit_sizes", from: "pass", to: "warn", reason: "exit_sizes is warn.", record: `exit_sizes:${MARKET}:500:3` }],
    ]);
    const finished = events.filter(([kind]) => kind === "canary_run_finished");
    expect(finished).toHaveLength(6);
    expect(finished[0]).toEqual(["canary_run_finished", STRATEGY, expect.objectContaining({ deploySlot: "500", trigger: "sweep", markets: 1, failed: 0 })]);
  });

  it("stores a record seen twice once", async () => {
    const { db } = client;
    const runId = await startCanaryRun(db, { version: V2, trigger: "rerun", delayMs: 0, markets: [OTHER] });
    const again = [record("exit_sizes", OTHER, 900n, 11, "warn")];
    await storeCanaryMarket(db, { runId, version: V2, market: OTHER, records: again, notes: [], rounds: 1, rpcRequests: 7, containerMs: 10 });
    expect((await readCanaryHistory(db, { market: OTHER, version: V2 })).filter((r) => r.check === "exit_sizes")).toHaveLength(1);
  });
});
