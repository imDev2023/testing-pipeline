// What the pages show of Canary, as the API serves it (docs/spec/pipescope-screens.md, Canary
// outcomes, What a row says about Canary, Trade box, Markets that cannot trade and Strategy page;
// docs/spec/pipescope.md, Facts and Canary results and When a strategy is upgraded; #125). The
// records are real: every latest result of six devnet markets from Canary's sweep of 2026-11-23
// (test/fixtures/canary-records.json), stored as the `CanaryRun` objects store them.
import { readFileSync } from "node:fs";
import { createDb, marketMints, markets, programVersions, startCanaryRun, storeCanaryMarket, strategies, type CanaryRecord } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CanaryResults, CanaryRollup, MarketsPage, StrategiesList } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const RECORDS = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/canary-records.json`, "utf8")) as Record<string, CanaryRecord[]>;
const market = (label: string) => RECORDS[label]![0]!.market;
const WSOL = "So11111111111111111111111111111111111111112";
const CREATOR = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";
// A strategy upgraded after Canary ran its first version, and one never upgraded and not run yet.
const UPGRADED = "Upgraded1111111111111111111111111111111111";
const UPGRADED_MARKET = "UpgradedMarket11111111111111111111111111111";
const FRESH = "Fresh11111111111111111111111111111111111111";
const FRESH_MARKET = "FreshMarket1111111111111111111111111111111";
const UPGRADED_AT = new Date("2026-11-24T10:00:00Z");

let database: Awaited<ReturnType<typeof createTestDatabase>>;

beforeAll(async () => {
  database = await createTestDatabase();
  const { db, close } = createDb(database.url);
  try {
    const all = Object.values(RECORDS);
    const programs = new Set(all.map((r) => r[0]!.strategy!));
    await db.insert(strategies).values([...programs].map((program) => ({ program, metadataUri: `https://example.org/${program}.json`, registeredAt: new Date("2026-11-01T00:00:00Z") })));
    const versions = new Map(all.map((r) => [`${r[0]!.strategy}:${r[0]!.strategy_version.deploy_slot}`, { program: r[0]!.strategy!, deploySlot: BigInt(r[0]!.strategy_version.deploy_slot!) }]));
    await db.insert(programVersions).values([...versions.values()].map((v) => ({ ...v, role: "strategy", executableSha256: "ab".repeat(32), blockTime: new Date("2026-11-20T00:00:00Z") })));
    for (const records of all) {
      const first = records[0]!;
      const address = first.market;
      await db.insert(markets).values({ address, strategyProgram: first.strategy!, marketState: address, createdBy: CREATOR, createdAt: new Date("2026-11-10T00:00:00Z") });
      // Two mints, the money side wrapped SOL, as on every one of these six markets.
      const token = `Tok${address.slice(3)}`;
      await db.insert(marketMints).values([
        { market: address, position: 0, mint: token, vault: null, vaultAmount: "1000" },
        { market: address, position: 1, mint: WSOL, vault: null, vaultAmount: "2000" },
      ]);
      const version = { program: first.strategy!, deploySlot: BigInt(first.strategy_version.deploy_slot!) };
      const runId = await startCanaryRun(db, { version, trigger: "sweep", delayMs: 0, markets: [address] });
      await storeCanaryMarket(db, { runId, version, market: address, records, notes: [], rounds: 1, rpcRequests: 7, containerMs: 1000 });
    }
    await db.insert(strategies).values([UPGRADED, FRESH].map((program) => ({ program, metadataUri: `https://example.org/${program}.json`, registeredAt: new Date("2026-11-01T00:00:00Z") })));
    await db.insert(programVersions).values([
      { program: UPGRADED, deploySlot: 100n, role: "strategy", executableSha256: "01".repeat(32), blockTime: new Date("2026-11-02T00:00:00Z") },
      { program: UPGRADED, deploySlot: 200n, role: "strategy", executableSha256: "02".repeat(32), blockTime: UPGRADED_AT },
      { program: FRESH, deploySlot: 300n, role: "strategy", executableSha256: "03".repeat(32), blockTime: new Date("2026-11-03T00:00:00Z") },
    ]);
    for (const [address, program] of [[UPGRADED_MARKET, UPGRADED], [FRESH_MARKET, FRESH]] as const) {
      await db.insert(markets).values({ address, strategyProgram: program, marketState: address, createdBy: CREATOR, createdAt: new Date("2026-11-10T00:00:00Z") });
      await db.insert(marketMints).values([
        { market: address, position: 0, mint: `Tok${address.slice(3)}`, vault: null, vaultAmount: "1000" },
        { market: address, position: 1, mint: WSOL, vault: null, vaultAmount: "2000" },
      ]);
    }
    // The first version's results, which the pages no longer show as the strategy's.
    const old = { program: UPGRADED, deploySlot: 100n };
    const oldRun = await startCanaryRun(db, { version: old, trigger: "sweep", delayMs: 0, markets: [UPGRADED_MARKET] });
    const records = RECORDS.tax_demo!.map((r) => ({ ...r, id: `${r.check}:${UPGRADED_MARKET}:100:1`, market: UPGRADED_MARKET, strategy: UPGRADED, strategy_version: { deploy_slot: 100, executable_sha256: "01".repeat(32) } }));
    await storeCanaryMarket(db, { runId: oldRun, version: old, market: UPGRADED_MARKET, records, notes: [], rounds: 1, rpcRequests: 7, containerMs: 1000 });
  } finally {
    await close();
  }
});
afterAll(async () => {
  await database?.drop();
});

async function get(path: string) {
  const { ctx, settle } = executionContext();
  const response = await app.request(path, {}, bindings({ databaseUrl: database.url, rpcUrl: "http://127.0.0.1:9/never" }), ctx);
  await settle();
  return { status: response.status, body: (await response.json()) as unknown };
}

const canaryOf = async (label: string) => CanaryResults.parse((await get(`/v1/markets/${market(label)}/canary`)).body);

describe("a market's Canary summary", () => {
  it("gives the ordinary trade's return and, for the outside builder's AMM, the cost fail as the one result a row shows", async () => {
    const { summary } = await canaryOf("outside_builder");
    expect(summary).toEqual(
      expect.objectContaining({
        ordinary: { return_ppm: 486_449, amount_words: "0.01 SOL", stand_in: false },
        lead: { check: "cost", outcome: "fail", phrase: "a 0.01 SOL round trip returned 48.6%" },
        stranded: null,
        refuses: null,
      }),
    );
  });

  it("names a bonding curve's refused sale as the result its row shows, and lists each size with what came back", async () => {
    const canary = await canaryOf("open_curve");
    expect(canary.summary?.lead).toEqual({ check: "exit_sizes", outcome: "warn", phrase: "buys of 1 SOL or more could not sell back" });
    const sizes = canary.results.find((r) => r.check === "exit_sizes")!;
    expect(sizes.name).toBe("Buy, then sell straight back");
    expect(sizes.steps).toEqual([
      {
        pair: 0,
        steps: [
          { label: "0.00001 SOL", state: "back", return_ppm: 982_543 },
          { label: "0.001 SOL", state: "back", return_ppm: 982_664 },
          { label: "0.01 SOL", state: "back", return_ppm: 982_933 },
          { label: "0.1 SOL", state: "back", return_ppm: 984_066 },
          { label: "1 SOL", state: "stuck", return_ppm: null },
          { label: "10 SOL", state: "stuck", return_ppm: null },
        ],
      },
    ]);
    expect(sizes.refusals).toEqual([
      {
        by: "the strategy",
        program: "ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb",
        name: "WrongStatus",
        number: 6004,
        message: "Not allowed in the curve's current status",
        stage: "the swap",
        origin: "thrown in bonding-curve/src/lib.rs:1298",
        raw: "InstructionError(1, Custom(6004))",
      },
    ]);
  });

  it("words the trade box's notice from the record, with the day Canary saw it", async () => {
    const canary = await canaryOf("open_curve");
    expect(canary.could_not_sell_back).toEqual([
      {
        check: "exit_sizes",
        sentence: "In Canary's test on 23 Nov 2026, a wallet that bought 1 SOL or more could not sell back (strategy refused (WrongStatus: Not allowed in the curve's current status)); buys of 0.1 SOL and less sold back.",
      },
    ]);
    expect((await canaryOf("outside_builder")).could_not_sell_back).toEqual([]);
  });

  it("says a stranded market's strategy cannot read it, with the refusal, as a fail", async () => {
    const { summary } = await canaryOf("stranded");
    expect(summary?.lead).toEqual({ check: "readable", outcome: "fail", phrase: "the strategy's current version cannot read this market" });
    expect(summary?.stranded).toEqual(expect.objectContaining({ name: "AccountDiscriminatorMismatch", number: 3002, stage: "reading the market's info" }));
    expect(summary?.refuses).toBeNull();
    expect(summary?.ordinary).toBeNull();
  });

  it("says a market that refuses every trade by its own rules does, with the strategy's error, as not run", async () => {
    const { summary } = await canaryOf("refusing");
    expect(summary?.lead).toEqual({ check: "readable", outcome: "not run", phrase: "the market refuses every trade (WrongStatus)" });
    expect(summary?.refuses).toEqual(expect.objectContaining({ by: "the strategy", name: "WrongStatus", number: 6004, message: "Not allowed in the curve's current status" }));
    expect(summary?.stranded).toBeNull();
  });

  it("serves a market's results in the checks' fixed order", async () => {
    const { results } = await canaryOf("tax_demo");
    expect(results.map((r) => r.check)).toEqual([
      "readable",
      "exit_sizes",
      "cost",
      "exit_hold",
      "exit_wallets",
      "exit_transferred",
      "exit_queue",
      "exit_late",
      "exit_launch_clock",
      "token_authorities",
      "outside_supply",
      "quote_matches_swap",
      "direct_call",
      "transaction_accounts",
      "contained_mint",
      "conformance",
      "custom_instructions",
    ]);
  });
});

describe("after an upgrade", () => {
  it("says the strategy was upgraded and its tests are pending, until the new version has results of its own", async () => {
    const canary = CanaryResults.parse((await get(`/v1/markets/${UPGRADED_MARKET}/canary`)).body);
    expect(canary.version).toEqual(expect.objectContaining({ deploy_slot: 200, current: true }));
    expect(canary.results).toEqual([]);
    expect(canary.summary).toBeNull();
    expect(canary.upgrade).toEqual({ deploy_slot: 200, upgraded_at: UPGRADED_AT.toISOString() });
    const rollup = CanaryRollup.parse((await get(`/v1/strategies/${UPGRADED}/versions/200/canary`)).body);
    expect(rollup.upgrade).toEqual({ deploy_slot: 200, upgraded_at: UPGRADED_AT.toISOString() });
    expect(rollup.summary).toBeNull();
  });

  it("announces nothing for a strategy never upgraded, nor for one whose new version has results", async () => {
    expect(CanaryResults.parse((await get(`/v1/markets/${FRESH_MARKET}/canary`)).body).upgrade).toBeNull();
    expect(CanaryResults.parse((await get(`/v1/markets/${market("open_curve")}/canary`)).body).upgrade).toBeNull();
    expect(CanaryRollup.parse((await get(`/v1/strategies/${FRESH}/versions/300/canary`)).body).upgrade).toBeNull();
  });

  it("keeps the first version's results to themselves: a row shows nothing of them", async () => {
    const { markets: rows } = MarketsPage.parse((await get(`/v1/markets?limit=50`)).body);
    expect(rows.find((m) => m.address === UPGRADED_MARKET)?.canary).toBeNull();
    const { strategies: list } = StrategiesList.parse((await get("/v1/strategies")).body);
    expect(list.find((s) => s.program === UPGRADED)?.canary).toBeNull();
  });
});

describe("the feed's rows", () => {
  it("carry each market's ordinary return and the one result chosen for it", async () => {
    const { markets: rows } = MarketsPage.parse((await get(`/v1/markets?limit=50`)).body);
    const row = (label: string) => rows.find((m) => m.address === market(label))!.canary;
    expect(row("outside_builder")).toEqual(expect.objectContaining({ ordinary: expect.objectContaining({ return_ppm: 486_449 }), lead: expect.objectContaining({ check: "cost", outcome: "fail" }) }));
    expect(row("stranded")?.lead?.phrase).toBe("the strategy's current version cannot read this market");
    expect(row("tax_demo")?.lead).toEqual(expect.objectContaining({ outcome: expect.stringMatching(/warn|fail/) }));
    expect(rows.find((m) => m.address === FRESH_MARKET)?.canary).toBeNull();
  });

  it("carry each strategy's range of ordinary returns over its markets that trade, and how many its version cannot read", async () => {
    const { strategies: list } = StrategiesList.parse((await get("/v1/strategies")).body);
    const curve = list.find((s) => s.program === "ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb")!.canary;
    expect(curve).toEqual({ run_at: expect.any(String), markets: 3, stranded: 1, ordinary: { min_ppm: 982_933, max_ppm: 982_933, amount_words: "0.01 SOL" } });
  });
});

describe("a strategy version's roll-up", () => {
  it("names each check plainly, in the fixed order, with the markets that warn or fail and each one's sentence", async () => {
    const rollup = CanaryRollup.parse((await get(`/v1/strategies/ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb/versions/525565903/canary`)).body);
    const lines = Object.entries(rollup.checks).sort(([, a], [, b]) => a.rank - b.rank);
    expect(lines[0]![0]).toBe("readable");
    expect(lines[0]![1]).toEqual(
      expect.objectContaining({
        name: "Reading the market",
        outcomes: { fail: 1, pass: 2 },
        held: [{ market: market("stranded"), outcome: "fail", reason: expect.stringMatching(/^The strategy's current version cannot read this market's state/) }],
      }),
    );
    expect(rollup.checks.exit_sizes!.held).toEqual([{ market: market("open_curve"), outcome: "warn", reason: expect.stringMatching(/^A wallet that bought 1 SOL or more could not sell back/) }]);
    expect(rollup.summary).toEqual({ run_at: expect.any(String), markets: 3, stranded: 1, ordinary: { min_ppm: 982_933, max_ppm: 982_933, amount_words: "0.01 SOL" } });
  });
});
