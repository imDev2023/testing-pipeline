import { generateKeyPairSigner, getBase58Decoder, signBytes, type KeyPairSigner } from "@solana/kit";
import { createDb, recordKeeperPass, type KeeperPassRecord } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KEEPER_STOPPED_GRACE_MS } from "../src/config";
import { Keeper, keeperHeartbeatMessage, MarketKeeper, type KeeperHeartbeatPayload } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext, fakeRpc, memoryKv, rateLimiter } from "./fakes";

// The keeper page's API (docs/spec/keeper-runner.md, "How Aviary shows it"; SUITE-57): the runner's
// signed heartbeats in KV say whether it is alive while Postgres sleeps, its records in Postgres say
// what it did, and the keeper wallet's balance is read through RPC.

const NOW = new Date("2026-11-22T12:00:00Z");
const MARKET = "FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB";
const CAPS = { maxTxCost: 3_000_000, marketDailyCap: 10_000_000, dailyCap: 100_000_000, minBalance: 100_000_000, lowBalance: 500_000_000 };
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let keeper: KeyPairSigner;
let stranger: KeyPairSigner;
let rpc: Awaited<ReturnType<typeof fakeRpc>>;

beforeAll(async () => {
  database = await createTestDatabase();
  keeper = await generateKeyPairSigner();
  stranger = await generateKeyPairSigner();
  rpc = await fakeRpc({ slot: 525_000_000, balance: 1_987_650_000 });
  const { db, close } = createDb(database.url);
  const pass = (at: Date, kind: string, jobs: KeeperPassRecord["jobs"], extra: Partial<KeeperPassRecord> = {}): KeeperPassRecord => ({
    wallet: keeper.address,
    pass: kind,
    at,
    balance: 1_990_000_000n,
    day: at.toISOString().slice(0, 10),
    spentTotal: 10_000n,
    spentByMarket: { [MARKET]: 10_000n },
    caps: { maxTxCost: 3_000_000n, marketDailyCap: 10_000_000n, dailyCap: 100_000_000n, minBalance: 100_000_000n, lowBalance: 500_000_000n },
    settings: { SWEEP_INTERVAL: "10m" },
    warnings: [],
    counts: { markets: 1, sent: jobs.filter((j) => j.signature).length, held: jobs.filter((j) => j.outcome === "held").length, parked: 0, skipped: 0, failed: 0 },
    jobs,
    ...extra,
  });
  const job = (at: Date, slot: number, outcome: string, extra: Partial<KeeperPassRecord["jobs"][number]> = {}) => ({
    at,
    market: MARKET,
    product: "tax-amm",
    job: "distribute",
    slot,
    outcome,
    signature: null,
    cost: null,
    estimate: null,
    cap: null,
    error: null,
    attempt: null,
    ...extra,
  });
  try {
    await recordKeeperPass(db, pass(minutesAgo(60), "daily", [job(minutesAgo(60), 0, "sent", { signature: "5jobSignature", cost: 5_000n })], { spentTotal: 5_000n, spentByMarket: { [MARKET]: 5_000n } }));
    await recordKeeperPass(db, pass(minutesAgo(30), "sweep", [job(minutesAgo(30), 2, "sent", { signature: "5otherSignature", cost: 5_000n }), job(minutesAgo(30), 3, "held", { cap: "MARKET_DAILY_CAP", estimate: 2_044_280n })], { warnings: ["low balance"] }));
  } finally {
    await close();
  }
});
afterAll(async () => {
  await rpc?.close();
  await database?.drop();
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function env(overrides: Partial<ReturnType<typeof bindings>> = {}) {
  return bindings({ databaseUrl: database.url, rpcUrl: rpc.url, KEEPER_WALLET: keeper.address, TERMINAL_CACHE: memoryKv(), ...overrides });
}

function payload(overrides: Partial<KeeperHeartbeatPayload> = {}): KeeperHeartbeatPayload {
  return { wallet: keeper.address, pass: "sweep", at: new Date().toISOString(), startedAt: minutesAgo(45).toISOString(), sweepIntervalMs: 600_000, caps: CAPS, warnings: [], ...overrides };
}

async function signed(body: KeeperHeartbeatPayload, signer = keeper) {
  const text = JSON.stringify(body);
  const signature = await signBytes(signer.keyPair.privateKey, keeperHeartbeatMessage(text));
  return { payload: text, signature: getBase58Decoder().decode(signature) };
}

async function post(e: ReturnType<typeof env>, body: unknown) {
  const { ctx, settle } = executionContext();
  const response = await app.request("/keeper/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, e, ctx);
  await settle();
  return { status: response.status, body: (await response.json()) as unknown };
}

async function page(e: ReturnType<typeof env>) {
  const { ctx, settle } = executionContext();
  const response = await app.request("/keeper", {}, e, ctx);
  await settle();
  expect(response.status).toBe(200);
  return Keeper.parse(await response.json());
}

describe("POST /keeper/heartbeat", () => {
  it("keeps a heartbeat the keeper wallet signed, and the page shows the runner running", async () => {
    const e = env();
    expect(await post(e, await signed(payload({ pass: "start" })))).toEqual({ status: 202, body: { stored: true } });
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    expect((await post(e, await signed(payload({ pass: "sweep", warnings: ["low balance: top it up"] })))).status).toBe(202);
    const keeperPage = await page(e);
    expect(keeperPage.liveness).toEqual({ state: "running", lastPass: { pass: "sweep", at: "2026-11-22T12:05:00.000Z" }, stoppedAfterMs: 600_000 + KEEPER_STOPPED_GRACE_MS, sweepIntervalMs: 600_000 });
    expect(keeperPage.passes.find((p) => p.pass === "start")?.lastRanAt).toBe("2026-11-22T12:00:00.000Z");
    expect(keeperPage.warnings).toEqual({ at: "2026-11-22T12:05:00.000Z", list: ["low balance: top it up"] });
    expect(keeperPage.caps).toEqual(CAPS);
  });

  it("refuses a heartbeat signed by any other key, or naming another wallet", async () => {
    const e = env();
    expect((await post(e, await signed(payload(), stranger))).status).toBe(401);
    expect((await post(e, await signed(payload({ wallet: stranger.address }), stranger))).status).toBe(403);
    const forged = await signed(payload());
    expect((await post(e, { ...forged, payload: forged.payload.replace('"sweep"', '"daily"') })).status).toBe(401);
    expect((await page(e)).liveness.state).toBe("no-heartbeat");
  });

  it("refuses a heartbeat from the wrong time, so an old one cannot be replayed to look alive", async () => {
    const e = env();
    expect((await post(e, await signed(payload({ at: minutesAgo(10).toISOString() })))).status).toBe(409);
    expect((await post(e, await signed(payload({ at: new Date(NOW.getTime() + 10 * 60_000).toISOString() })))).status).toBe(409);
  });

  it("refuses what is not a heartbeat", async () => {
    const e = env();
    expect((await post(e, { hello: "world" })).status).toBe(400);
    expect((await post(e, { payload: "not json", signature: "1".repeat(88) })).status).toBe(400);
  });

  it("counts each heartbeat as a read against the sender's IP, so nobody can flood the signature check", async () => {
    const e = env({ READS: rateLimiter(1) });
    expect((await post(e, await signed(payload()))).status).toBe(202);
    expect((await post(e, await signed(payload()))).status).toBe(429);
  });

  it("keeps at most one heartbeat of each kind every half minute, and never an older one over a newer", async () => {
    const e = env();
    const kv = e.TERMINAL_CACHE as ReturnType<typeof memoryKv>;
    expect((await post(e, await signed(payload()))).body).toEqual({ stored: true });
    vi.setSystemTime(new Date(NOW.getTime() + 10_000));
    expect((await post(e, await signed(payload()))).body).toEqual({ stored: false });
    expect((await post(e, await signed(payload({ pass: "transaction" })))).body).toEqual({ stored: true });
    expect(kv.puts).toBe(2);
    expect((await post(e, await signed(payload({ at: NOW.toISOString(), pass: "transaction" })))).body).toEqual({ stored: false });
  });
});

describe("GET /keeper", () => {
  it("shows the wallet, its balance through RPC, today's spend against the caps, the jobs with their signatures and the held ones", async () => {
    const keeperPage = await page(env());
    expect(keeperPage.wallet).toBe(keeper.address);
    expect(keeperPage.balance).toEqual({ lamports: 1_987_650_000, error: null });
    expect(keeperPage.today).toEqual({ day: "2026-11-22", spentTotal: 10_000, highestCost: 5_000, markets: [{ market: MARKET, spent: 10_000 }] });
    expect(keeperPage.caps).toEqual(CAPS);
    expect(keeperPage.recent.map((j) => [j.slot, j.outcome, j.signature, j.cost])).toEqual([
      [3, "held", null, null],
      [2, "sent", "5otherSignature", 5_000],
      [0, "sent", "5jobSignature", 5_000],
    ]);
    expect(keeperPage.waiting.map((j) => [j.slot, j.outcome, j.cap])).toEqual([[3, "held", "MARKET_DAILY_CAP"]]);
    expect(keeperPage.warnings).toEqual({ at: minutesAgo(30).toISOString(), list: ["low balance"] });
    expect(keeperPage.passes.filter((p) => p.lastRecorded).map((p) => [p.pass, p.lastRecorded?.at, p.lastRecorded?.sent])).toEqual([
      ["sweep", minutesAgo(30).toISOString(), 1],
      ["daily", minutesAgo(60).toISOString(), 1],
    ]);
    expect(keeperPage.records).toEqual({ ok: true, error: null });
  });

  it("says the runner looks stopped once its last heartbeat is older than its SWEEP_INTERVAL and a few minutes", async () => {
    const e = env();
    await post(e, await signed(payload({ pass: "sweep" })));
    vi.setSystemTime(new Date(NOW.getTime() + 600_000 + KEEPER_STOPPED_GRACE_MS));
    expect((await page(e)).liveness.state).toBe("running");
    vi.setSystemTime(new Date(NOW.getTime() + 600_000 + KEEPER_STOPPED_GRACE_MS + 1_000));
    expect((await page(e)).liveness).toMatchObject({ state: "looks-stopped", lastPass: { pass: "sweep", at: NOW.toISOString() } });
  });

  it("takes the threshold from the runner's own heartbeats, never from a one-off run's", async () => {
    const e = env();
    await post(e, await signed(payload({ pass: "sweep", sweepIntervalMs: 60_000 })));
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    await post(e, await signed(payload({ pass: "once", sweepIntervalMs: 600_000 })));
    expect((await page(e)).liveness).toEqual({ state: "running", lastPass: { pass: "sweep", at: NOW.toISOString() }, stoppedAfterMs: 60_000 + KEEPER_STOPPED_GRACE_MS, sweepIntervalMs: 60_000 });
    vi.setSystemTime(new Date(NOW.getTime() + 60_000 + KEEPER_STOPPED_GRACE_MS + 1_000));
    expect((await page(e)).liveness.state).toBe("looks-stopped");
  });

  it("shows only parks recorded since the runner's current run started, which its heartbeats carry", async () => {
    const { db, close } = createDb(database.url);
    const parked = { at: minutesAgo(50), market: MARKET, product: "tax-amm", job: "distribute", slot: 4, outcome: "parked", signature: null, cost: null, estimate: null, cap: null, error: "custom program error: 0x1771", attempt: 4 };
    try {
      await recordKeeperPass(db, {
        wallet: keeper.address, pass: "retry", at: minutesAgo(50), balance: 1n, day: "2026-11-22", spentTotal: 10_000n, spentByMarket: { [MARKET]: 10_000n },
        caps: { maxTxCost: 1n, marketDailyCap: 1n, dailyCap: 1n, minBalance: 1n, lowBalance: 1n }, settings: {}, warnings: [],
        counts: { markets: 1, sent: 0, held: 0, parked: 1, skipped: 0, failed: 0 }, jobs: [parked],
      });
    } finally {
      await close();
    }
    const e = env();
    await post(e, await signed(payload({ startedAt: minutesAgo(55).toISOString() })));
    expect((await page(e)).waiting.map((j) => [j.slot, j.outcome])).toEqual([
      [3, "held"],
      [4, "parked"],
    ]);
    vi.setSystemTime(new Date(NOW.getTime() + 31_000));
    await post(e, await signed(payload({ startedAt: minutesAgo(45).toISOString() })));
    expect((await page(e)).waiting.map((j) => [j.slot, j.outcome])).toEqual([[3, "held"]]);
  });

  it("counts a one-off `once` pass as no sign that the runner itself is running", async () => {
    const e = env();
    await post(e, await signed(payload({ pass: "once" })));
    const keeperPage = await page(e);
    expect(keeperPage.liveness.state).toBe("no-heartbeat");
    expect(keeperPage.passes.find((p) => p.pass === "once")?.lastRanAt).toBe(NOW.toISOString());
  });

  it("stays up when the RPC or the database does not answer, saying which, and never shows their URLs", async () => {
    const down = await fakeRpc({ status: 503 });
    try {
      const keeperPage = await page(env({ RPC_URL: down.url, HYPERDRIVE: { connectionString: "postgres://terminal:hunter2@127.0.0.1:1/nowhere" } as Hyperdrive }));
      expect(keeperPage.balance).toEqual({ lamports: null, error: "the RPC did not answer" });
      expect(keeperPage.records).toEqual({ ok: false, error: "the database did not answer" });
      expect(keeperPage.recent).toEqual([]);
      expect(JSON.stringify(keeperPage)).not.toMatch(/hunter2|secret-in-the-url/);
    } finally {
      await down.close();
    }
    // Closing a client whose connections were refused takes the driver's 5 s end timeout, after the answer.
  }, 30_000);
});

describe("GET /v1/markets/{market}/keeper", () => {
  async function marketJobs(e: ReturnType<typeof env>, market: string) {
    const { ctx, settle } = executionContext();
    const response = await app.request(`/v1/markets/${market}/keeper`, {}, e, ctx);
    await settle();
    return { status: response.status, body: (await response.json()) as unknown };
  }

  it("answers the runner's latest record of each job and slot on the market, for its panel's due jobs (PIPESCOPE-162)", async () => {
    const { status, body } = await marketJobs(env(), MARKET);
    expect(status).toBe(200);
    const { market, wallet, jobs } = MarketKeeper.parse(body);
    expect([market, wallet]).toEqual([MARKET, keeper.address]);
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ job: "distribute", slot: 0, outcome: "sent", signature: "5jobSignature", at: minutesAgo(60).toISOString() }),
        expect.objectContaining({ job: "distribute", slot: 2, outcome: "sent", signature: "5otherSignature" }),
        expect.objectContaining({ job: "distribute", slot: 3, outcome: "held", cap: "MARKET_DAILY_CAP" }),
      ]),
    );
    // One record a job and slot: the latest.
    expect(new Set(jobs.map((j) => `${j.job}:${j.slot}`)).size).toBe(jobs.length);
  });

  it("answers no jobs for a market the runner never recorded, and refuses what is no address", async () => {
    expect(MarketKeeper.parse((await marketJobs(env(), "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz")).body).jobs).toEqual([]);
    expect((await marketJobs(env(), "nowhere")).status).toBe(400);
  });

  it("says when the database does not answer, without its URL", async () => {
    const { status, body } = await marketJobs(env({ HYPERDRIVE: { connectionString: "postgres://terminal:hunter2@127.0.0.1:1/nowhere" } as Hyperdrive }), MARKET);
    expect(status).toBe(503);
    expect(JSON.stringify(body)).not.toMatch(/hunter2/);
  }, 30_000);
});
