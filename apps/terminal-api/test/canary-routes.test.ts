// Canary's results from the API (docs/spec/pipescope-architecture.md, API; docs/spec/pipescope-canary.md,
// Records and What counts as "a buyer could not sell back"; docs/spec/pipescope-screens.md, Canary
// outcomes; CANARY-20, CANARY-21; #124): a market's latest results with the sentences code writes
// for them, its "could not sell back" notice, a version's roll-up, and the owner's re-run.
import { generateKeyPairSigner, getBase58Decoder, signBytes, type KeyPairSigner } from "@solana/kit";
import { createDb, markets, programVersions, startCanaryRun, storeCanaryMarket, strategies, type CanaryRecord } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanaryRunRequest, CanaryRunVersion } from "../src/canaryRunCore";
import { CanaryResults, CanaryRollup, CanarySchedule, canaryRerunMessage, type ApiError } from "../src/contract";
import { app } from "../src/index";
import type { Bindings } from "../src/env";
import { bindings, executionContext } from "./fakes";

const CURVE = "ETrmUeKxFsH3KxSHPuzCMvNgv7AGGmhsUHGWBaJDKrnb";
const OPEN = "3dpKiLEDnLxCDBybnc5N9iVSLDWpvVBhE4971w59JETL";
const CLOSED = "5CpbSAsLfRnhDBX6bJk6YzeNun3c9pQnAz9RVbH19jkC";
const CREATOR = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";
const STUCK = "A wallet that bought 1 SOL or more could not sell back (the strategy refused: 6001 SlippageExceeded); buys of 0.1 SOL and less sold back.";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let operator: KeyPairSigner;
let stranger: KeyPairSigner;
const started: { version: CanaryRunVersion; request: CanaryRunRequest }[] = [];

function record(check: string, market: string, deploySlot: number, slot: number, outcome: CanaryRecord["outcome"], reason: string, numbers: unknown): CanaryRecord {
  return {
    id: `${check}:${market}:${deploySlot}:${slot}`,
    check,
    harness: "canary/0.3.1",
    cluster: "devnet",
    slot,
    run_at: Date.UTC(2026, 10, 10, 4, 54) / 1000,
    strategy: CURVE,
    strategy_version: { deploy_slot: deploySlot, executable_sha256: "bb".repeat(32) },
    router_version: { deploy_slot: 100, executable_sha256: "cd".repeat(32) },
    market,
    inputs: {},
    outcome,
    reason,
    numbers,
  };
}

beforeAll(async () => {
  database = await createTestDatabase();
  operator = await generateKeyPairSigner();
  stranger = await generateKeyPairSigner();
  const { db, close } = createDb(database.url);
  try {
    await db.insert(strategies).values({ program: CURVE, metadataUri: "https://example.org/curve.json", registeredAt: new Date() });
    await db.insert(programVersions).values([
      { program: CURVE, deploySlot: 520_000_000n, role: "strategy", executableSha256: "aa".repeat(32) },
      { program: CURVE, deploySlot: 520_151_724n, role: "strategy", executableSha256: "bb".repeat(32) },
    ]);
    await db.insert(markets).values([OPEN, CLOSED].map((address) => ({ address, strategyProgram: CURVE, marketState: address, createdBy: CREATOR, createdAt: new Date() })));
    const old = { program: CURVE, deploySlot: 520_000_000n };
    const current = { program: CURVE, deploySlot: 520_151_724n };
    const oldRun = await startCanaryRun(db, { version: old, trigger: "sweep", delayMs: 0, markets: [OPEN] });
    await storeCanaryMarket(db, { runId: oldRun, version: old, market: OPEN, records: [record("exit_sizes", OPEN, 520_000_000, 520_100_000, "pass", "Every size that could be bought sold back in the same slot (6 of 6).", { could_not_sell_back: false })], notes: [], rounds: 1, rpcRequests: 7, containerMs: 900 });
    const run = await startCanaryRun(db, { version: current, trigger: "strategy_version", delayMs: 0, markets: [OPEN, CLOSED] });
    await storeCanaryMarket(db, {
      runId: run,
      version: current,
      market: OPEN,
      records: [
        record("exit_sizes", OPEN, 520_151_724, 520_629_097, "warn", STUCK, { could_not_sell_back: true }),
        record("exit_late", OPEN, 520_151_724, 520_629_097, "warn", "A round trip of 0.01 SOL a day later could not sell back.", { could_not_sell_back: false }),
        record("cost", OPEN, 520_151_724, 520_629_097, "pass", "Every size that round-tripped returns 95.0% or more.", {}),
      ],
      notes: [],
      rounds: 2,
      rpcRequests: 8,
      containerMs: 2100,
    });
    await storeCanaryMarket(db, {
      runId: run,
      version: current,
      market: CLOSED,
      records: [record("exit_sizes", CLOSED, 520_151_724, 520_629_101, "not run", "Not run: the market refuses every trade (WrongStatus).", null)],
      notes: [],
      rounds: 1,
      rpcRequests: 7,
      containerMs: 800,
    });
  } finally {
    await close();
  }
});
afterAll(async () => {
  await database?.drop();
});

function env() {
  return bindings({
    databaseUrl: database.url,
    rpcUrl: "http://127.0.0.1:9/never",
    CANARY_OPERATOR: operator.address,
    // The runs' namespace: each version's object, by name, takes the request.
    CANARY_RUNS: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        schedule: async (version: CanaryRunVersion, request: CanaryRunRequest) => void started.push({ version, request }),
        status: async () => ({
          version: { program: name.split(":")[0], deploySlot: name.split(":")[1] },
          runs: [{ trigger: "market_created", delayMs: 3_600_000, dueAt: Date.UTC(2026, 10, 23, 19), markets: 1, done: 0, started: false }],
        }),
      }),
    } as unknown as Bindings["CANARY_RUNS"],
  });
}

async function get(path: string) {
  const { ctx, settle } = executionContext();
  const response = await app.request(path, {}, env(), ctx);
  await settle();
  return { status: response.status, body: (await response.json()) as unknown };
}

describe("GET /v1/markets/{market}/canary", () => {
  it("serves the market's latest result of each check for its strategy's current version, each with the sentences code wrote for it", async () => {
    const { status, body } = await get(`/v1/markets/${OPEN}/canary`);
    expect(status).toBe(200);
    const results = CanaryResults.parse(body);
    expect(results.version).toEqual({ program: CURVE, deploy_slot: 520_151_724, executable_sha256: "bb".repeat(32), deployed_at: null, current: true });
    expect(results.results.map((r) => [r.check, r.outcome])).toEqual([
      ["exit_sizes", "warn"],
      ["cost", "pass"],
      ["exit_late", "warn"],
    ]);
    const sizes = results.results.find((r) => r.check === "exit_sizes")!;
    expect(sizes.reason).toBe(STUCK);
    expect(sizes.about).toBe("Check `exit_sizes`: buys each size and sells everything bought in the same slot.");
    expect(sizes.ran).toBe("Run on 10 Nov 2026, 04:54 UTC at slot 520,629,097, on the strategy version deployed in slot 520,151,724.");
    expect(sizes.numbers).toEqual({ could_not_sell_back: true });
  });

  it("derives the market's \"could not sell back\" notice from its latest exit results, and none from another time or a low return", async () => {
    const { body } = await get(`/v1/markets/${OPEN}/canary`);
    expect(CanaryResults.parse(body).could_not_sell_back).toEqual([{ check: "exit_sizes", sentence: `In Canary's test on 10 Nov 2026, a${STUCK.slice(1)}` }]);
    const closed = CanaryResults.parse((await get(`/v1/markets/${CLOSED}/canary`)).body);
    expect(closed.could_not_sell_back).toEqual([]);
  });

  it("keeps an older version's results attached to it, served only when that version is asked for, with no notice", async () => {
    const results = CanaryResults.parse((await get(`/v1/markets/${OPEN}/canary?version=520000000`)).body);
    expect(results.version?.current).toBe(false);
    expect(results.results.map((r) => [r.check, r.outcome, r.slot])).toEqual([["exit_sizes", "pass", 520_100_000]]);
    expect(results.could_not_sell_back).toEqual([]);
  });

  it("answers a market Aviary does not know with a 404 in words", async () => {
    const { status, body } = await get("/v1/markets/Unknown111111111111111111111111111111111111/canary");
    expect(status).toBe(404);
    expect((body as ApiError).error).toMatch(/market/);
  });
});

describe("GET /v1/strategies/{program}/versions/{slot}/canary", () => {
  it("rolls the version up per check across its markets, naming the markets that warn or fail", async () => {
    const { status, body } = await get(`/v1/strategies/${CURVE}/versions/520151724/canary`);
    expect(status).toBe(200);
    const rollup = CanaryRollup.parse(body);
    expect(rollup.markets).toBe(2);
    expect(rollup.current).toBe(true);
    expect(rollup.checks.exit_sizes).toEqual({
      name: "Buy, then sell straight back",
      rank: 1,
      about: "Check `exit_sizes`: buys each size and sells everything bought in the same slot.",
      outcomes: { warn: 1, "not run": 1 },
      warn: [OPEN],
      fail: [],
      held: [{ market: OPEN, outcome: "warn", reason: STUCK }],
    });
    expect(rollup.last_run).toEqual(expect.objectContaining({ trigger: "strategy_version", markets: 2 }));
  });
});

describe("GET /v1/strategies/{program}/versions/{slot}/canary/schedule", () => {
  it("lists the runs the version's CanaryRun still holds, each with its trigger, delay and when it is due", async () => {
    const { status, body } = await get(`/v1/strategies/${CURVE}/versions/520151724/canary/schedule`);
    expect(status).toBe(200);
    expect(CanarySchedule.parse(body)).toEqual({
      program: CURVE,
      deploy_slot: 520_151_724,
      runs: [{ trigger: "market_created", delay_ms: 3_600_000, due_at: "2026-11-23T19:00:00.000Z", markets: 1, done: 0, started: false }],
    });
  });

  it("reads the version's object by its slot written plainly, and refuses what is no address or slot", async () => {
    expect(CanarySchedule.parse((await get(`/v1/strategies/${CURVE}/versions/0520151724/canary/schedule`)).body).deploy_slot).toBe(520_151_724);
    expect((await get("/v1/strategies/notanaddress/versions/1/canary/schedule")).status).toBe(400);
    expect((await get(`/v1/strategies/${CURVE}/versions/1e9/canary/schedule`)).status).toBe(400);
  });
});

describe("POST /v1/canary/reruns", () => {
  async function post(body: unknown) {
    const { ctx, settle } = executionContext();
    const response = await app.request("/v1/canary/reruns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env(), ctx);
    await settle();
    return { status: response.status, body: (await response.json()) as unknown };
  }
  async function signed(what: { market?: string; strategy?: string }, signer = operator, at = new Date()) {
    const payload = JSON.stringify({ ...what, wallet: signer.address, at: at.toISOString() });
    return { payload, signature: getBase58Decoder().decode(await signBytes(signer.keyPair.privateKey, canaryRerunMessage(payload))) };
  }

  it("re-runs a market, or every market of a strategy, on its current version when the operator wallet signed the request", async () => {
    started.length = 0;
    expect((await post(await signed({ market: OPEN }))).status).toBe(202);
    expect((await post(await signed({ strategy: CURVE }))).status).toBe(202);
    expect(started).toEqual([
      { version: { program: CURVE, deploySlot: "520151724" }, request: { trigger: "rerun", markets: [OPEN] } },
      { version: { program: CURVE, deploySlot: "520151724" }, request: { trigger: "rerun", markets: [OPEN, CLOSED].sort() } },
    ]);
  });

  it("refuses a request another wallet signed, an old one, and one naming nothing Aviary knows", async () => {
    started.length = 0;
    expect((await post(await signed({ market: OPEN }, stranger))).status).toBe(403);
    expect((await post(await signed({ market: OPEN }, operator, new Date(Date.now() - 10 * 60_000)))).status).toBe(409);
    const forged = await signed({ market: OPEN });
    expect((await post({ ...forged, payload: forged.payload.replace(OPEN, CLOSED) })).status).toBe(401);
    expect((await post(await signed({ market: "Unknown111111111111111111111111111111111111" }))).status).toBe(404);
    expect(started).toEqual([]);
  });
});
