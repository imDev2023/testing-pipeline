import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/index.ts";
import { readKeeperRecords, recordKeeperPass, type KeeperPassRecord } from "../src/keeper.ts";
import { createTestDatabase } from "../src/testing.ts";

// What the keeper runner records (docs/spec/keeper-runner.md, "What it records") and what the keeper
// page reads back: a row per pass and a row per job it sent, held or parked.
const WALLET = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";
const OTHER_WALLET = "11111111111111111111111111111111";
const MARKET = "FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB";
const WALL_MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const NOW = new Date("2026-11-22T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const CAPS = { maxTxCost: 3_000_000n, marketDailyCap: 10_000_000n, dailyCap: 100_000_000n, minBalance: 100_000_000n, lowBalance: 500_000_000n };

function pass(overrides: Partial<KeeperPassRecord> & Pick<KeeperPassRecord, "pass" | "at">): KeeperPassRecord {
  return {
    wallet: WALLET,
    balance: 1_999_000_000n,
    day: overrides.at.toISOString().slice(0, 10),
    spentTotal: 0n,
    spentByMarket: {},
    caps: CAPS,
    settings: { SWEEP_INTERVAL: "10m" },
    warnings: [],
    counts: { markets: 2, sent: 0, held: 0, parked: 0, skipped: 0, failed: 0 },
    jobs: [],
    ...overrides,
  };
}

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  database = await createTestDatabase();
  ({ db, close } = createDb(database.url));
  // Yesterday: a distribute sent, and a parked payout that a later pass sent.
  await recordKeeperPass(
    db,
    pass({
      pass: "daily",
      at: new Date("2026-11-21T00:00:05Z"),
      spentTotal: 15_000n,
      spentByMarket: { [MARKET]: 15_000n },
      jobs: [
        { at: new Date("2026-11-21T00:00:03Z"), market: MARKET, product: "tax-amm", job: "distribute", slot: 0, outcome: "sent", signature: "sigOld", cost: 5_000n, estimate: 5_000n, cap: null, error: null, attempt: null },
        { at: new Date("2026-11-21T00:00:04Z"), market: WALL_MARKET, product: "buy-wall-amm", job: "pay_rewards", slot: null, outcome: "parked", signature: null, cost: null, estimate: null, cap: null, error: "custom program error: 0x1771", attempt: 4 },
      ],
    }),
  );
  await recordKeeperPass(
    db,
    pass({
      pass: "sweep",
      at: minutesAgo(300),
      jobs: [{ at: minutesAgo(300), market: WALL_MARKET, product: "buy-wall-amm", job: "pay_rewards", slot: null, outcome: "sent", signature: "sigUnpark", cost: 5_000n, estimate: 5_000n, cap: null, error: null, attempt: null }],
      spentTotal: 5_000n,
      spentByMarket: { [WALL_MARKET]: 5_000n },
    }),
  );
  // Today: a wall placed, then a distribute held by the market's cap, then a parked settle.
  await recordKeeperPass(
    db,
    pass({
      pass: "transaction",
      at: minutesAgo(30),
      spentTotal: 10_000n,
      spentByMarket: { [WALL_MARKET]: 10_000n },
      counts: { markets: 1, sent: 1, held: 0, parked: 0, skipped: 0, failed: 0 },
      jobs: [{ at: minutesAgo(30), market: WALL_MARKET, product: "buy-wall-amm", job: "place_wall", slot: null, outcome: "sent", signature: "sigWall", cost: 5_000n, estimate: 5_000n, cap: null, error: null, attempt: null }],
    }),
  );
  await recordKeeperPass(
    db,
    pass({
      pass: "sweep",
      at: minutesAgo(20),
      spentTotal: 10_000n,
      spentByMarket: { [WALL_MARKET]: 10_000n },
      warnings: ["low balance: the keeper wallet holds less than LOW_BALANCE; top it up with devnet-airdrop"],
      counts: { markets: 2, sent: 0, held: 1, parked: 1, skipped: 0, failed: 0 },
      jobs: [
        { at: minutesAgo(21), market: MARKET, product: "tax-amm", job: "distribute", slot: 2, outcome: "held", signature: null, cost: null, estimate: 2_044_280n, cap: "MARKET_DAILY_CAP", error: null, attempt: null },
        { at: minutesAgo(20), market: WALL_MARKET, product: "buy-wall-amm", job: "settle", slot: null, outcome: "parked", signature: null, cost: null, estimate: null, cap: null, error: "custom program error: 0x1772", attempt: 4 },
      ],
    }),
  );
  // Another runner's pass, with its own wallet: never shown as ours.
  await recordKeeperPass(db, pass({ wallet: OTHER_WALLET, pass: "sweep", at: minutesAgo(1), jobs: [{ at: minutesAgo(1), market: MARKET, product: "tax-amm", job: "distribute", slot: 1, outcome: "sent", signature: "sigOther", cost: 5_000n, estimate: 5_000n, cap: null, error: null, attempt: null }] }));
});
afterAll(async () => {
  await close?.();
  await database?.drop();
});

describe("the keeper runner's records", () => {
  it("give today's spend from the day's latest pass, and the caps and warnings of the latest pass", async () => {
    const records = await readKeeperRecords(db, { wallet: WALLET, now: NOW, recentJobs: 10, since: null });
    expect(records.latest).toMatchObject({ pass: "sweep", at: minutesAgo(20), caps: CAPS, warnings: [expect.stringMatching(/^low balance/)] });
    expect(records.today).toEqual({ day: "2026-11-22", spentTotal: 10_000n, spentByMarket: { [WALL_MARKET]: 10_000n }, highestCost: 5_000n });
  });

  it("give the last recorded pass of each kind", async () => {
    const records = await readKeeperRecords(db, { wallet: WALLET, now: NOW, recentJobs: 10, since: null });
    expect(records.lastOfEachKind.map(({ pass, at, counts }) => ({ pass, at, sent: counts.sent }))).toEqual([
      { pass: "sweep", at: minutesAgo(20), sent: 0 },
      { pass: "transaction", at: minutesAgo(30), sent: 1 },
      { pass: "daily", at: new Date("2026-11-21T00:00:05Z"), sent: 0 },
    ]);
  });

  it("give the latest jobs first, with their signatures and costs, and only this wallet's", async () => {
    const records = await readKeeperRecords(db, { wallet: WALLET, now: NOW, recentJobs: 3, since: null });
    expect(records.recent.map((job) => [job.job, job.outcome, job.signature, job.cost])).toEqual([
      ["settle", "parked", null, null],
      ["distribute", "held", null, null],
      ["place_wall", "sent", "sigWall", 5_000n],
    ]);
  });

  it("give the jobs still held today or parked: a later row for the same job ends either", async () => {
    const records = await readKeeperRecords(db, { wallet: WALLET, now: NOW, recentJobs: 10, since: null });
    expect(records.waiting.map((job) => [job.market, job.job, job.slot, job.outcome, job.cap ?? job.error])).toEqual([
      [WALL_MARKET, "settle", null, "parked", "custom program error: 0x1772"],
      [MARKET, "distribute", 2, "held", "MARKET_DAILY_CAP"],
    ]);
  });

  it("leave out parks older than `since`, the runner's last start, which forgot them", async () => {
    const records = await readKeeperRecords(db, { wallet: WALLET, now: NOW, recentJobs: 10, since: minutesAgo(10) });
    expect(records.waiting.map((job) => job.job)).toEqual(["distribute"]);
  });

  it("count the jobs each pass recorded", async () => {
    const records = await readKeeperRecords(db, { wallet: WALLET, now: NOW, recentJobs: 10, since: null });
    expect(records.lastOfEachKind.map(({ pass, recordedJobs }) => [pass, recordedJobs])).toEqual([
      ["sweep", 2],
      ["transaction", 1],
      ["daily", 2],
    ]);
  });

  it("never take today's spend from a pass that could not rebuild it, which records it as unknown", async () => {
    const unknownSpend = "4unknownSpendWallet1111111111111111111111";
    await recordKeeperPass(db, pass({ wallet: unknownSpend, pass: "sweep", at: minutesAgo(40), spentTotal: 7_000n, spentByMarket: { [MARKET]: 7_000n } }));
    await recordKeeperPass(db, pass({ wallet: unknownSpend, pass: "transaction", at: minutesAgo(10), spentTotal: null, spentByMarket: null, warnings: ["today's spend could not be rebuilt"] }));
    const records = await readKeeperRecords(db, { wallet: unknownSpend, now: NOW, recentJobs: 10, since: null });
    expect(records.latest).toMatchObject({ pass: "transaction", spentTotal: null, spentByMarket: null });
    expect(records.today).toEqual({ day: "2026-11-22", spentTotal: 7_000n, spentByMarket: { [MARKET]: 7_000n }, highestCost: null });
  });

  it("are empty for a wallet that recorded nothing", async () => {
    const records = await readKeeperRecords(db, { wallet: "So11111111111111111111111111111111111111112", now: NOW, recentJobs: 10, since: null });
    expect(records).toEqual({ latest: null, today: null, lastOfEachKind: [], recent: [], waiting: [] });
  });

  it("write a pass and its jobs together or not at all", async () => {
    const bad = pass({ pass: "sweep", at: minutesAgo(5), jobs: [{ at: minutesAgo(5), market: MARKET, product: "tax-amm", job: "distribute", slot: 0, outcome: "sent", signature: "x".repeat(10), cost: -1n as bigint, estimate: null, cap: null, error: null, attempt: null }] });
    // A job row the table refuses (here a job with no name) fails the whole pass.
    bad.jobs[0]!.job = null as unknown as string;
    await expect(recordKeeperPass(db, bad)).rejects.toThrow();
    const records = await readKeeperRecords(db, { wallet: WALLET, now: NOW, recentJobs: 10, since: null });
    expect(records.latest?.at).toEqual(minutesAgo(20));
  });
});
