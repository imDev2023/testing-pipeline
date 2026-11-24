// CanaryRun, one per strategy version (docs/spec/pipescope-architecture.md, "Canary runner";
// docs/spec/pipescope-canary.md, When Canary runs; CANARY-22, CANARY-25; #124): it builds each
// market's snapshot through the RPC, posts it to the one container, posts again with what the
// binary names as missing, stores the results, and goes on from its alarm after a failure.
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { canaryRunMarkets, canaryRuns, createDb, markets, programVersions, readCanaryLatest, readOutbox, strategies, strategyCalls, strategyInstructions, type CanaryRecord } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CanaryRunCore, type CanaryContainerAnswer, type CanaryRunStorage } from "../src/canaryRunCore";
import { CANARY } from "../src/config";
import { putMarket, type CanaryChain } from "./canaryChain";

const MINUTE = 60_000;
const SIGNER = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let rpc: FakeRpc;
let client: ReturnType<typeof createDb>;
beforeEach(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
  rpc = await fakeRpc();
});
afterEach(async () => {
  await rpc.close();
  await client.close();
  await database.drop();
});

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The indexer's view of a chain market: its strategy, the version in force with its instruction list and calls, and the market. */
async function index(chain: CanaryChain) {
  const { db } = client;
  await db.insert(strategies).values({ program: chain.strategy, metadataUri: "https://example.org/s.json", registeredAt: new Date() }).onConflictDoNothing();
  await db.insert(programVersions).values({ program: chain.strategy, deploySlot: chain.deploySlot, role: "strategy", executableSha256: sha256(chain.executable), anchor: true });
  await db.insert(strategyInstructions).values([
    { program: chain.strategy, deploySlot: chain.deploySlot, position: 0, name: "PipelineSwap", discriminator: "aa".repeat(8), pipeline: true },
    { program: chain.strategy, deploySlot: chain.deploySlot, position: 1, name: "Deposit", discriminator: "bb".repeat(8), pipeline: false },
  ]);
  await db.insert(strategyCalls).values({ signature: `deposit-${chain.market}`, instructionIndex: 0, innerIndex: -1, program: chain.strategy, discriminator: "bb".repeat(8), signers: [SIGNER], slot: 1n }).onConflictDoNothing();
  await db.insert(markets).values({ address: chain.market, strategyProgram: chain.strategy, marketState: chain.market, createdBy: SIGNER, createdAt: new Date() });
}

/** The binary's records for a market: two checks, as `crates/canary` writes them. */
function records(chain: CanaryChain, slot: number, exitSizes: CanaryRecord["outcome"] = "pass"): CanaryRecord[] {
  return ["exit_sizes", "cost"].map((check) => ({
    id: `${check}:${chain.market}:${chain.deploySlot}:${slot}`,
    check,
    harness: "canary/0.3.1",
    cluster: "devnet",
    slot,
    run_at: 1_763_900_000,
    strategy: chain.strategy,
    strategy_version: { deploy_slot: Number(chain.deploySlot), executable_sha256: sha256(chain.executable) },
    router_version: { deploy_slot: 100, executable_sha256: "cd".repeat(32) },
    market: chain.market,
    inputs: {},
    outcome: check === "exit_sizes" ? exitSizes : "pass",
    reason: "Every size that could be bought sold back in the same slot (6 of 6).",
    numbers: { could_not_sell_back: false },
  }));
}

type Posted = { market: string; round: number; seed?: string; accounts: Record<string, unknown>; instructions?: unknown };

/**
 * The container as the binary answers: for each market, `missing` once (the strategy's resolution
 * names an account the first round lacks), then its records. `down` makes it refuse as a container
 * restarting does.
 */
function container(chains: CanaryChain[], { exitSizes = "pass" as CanaryRecord["outcome"] } = {}) {
  const posted: Posted[] = [];
  const state = { down: false, exitSizes, beforeAnswer: null as (() => Promise<void>) | null };
  return {
    posted,
    state,
    run: async (body: string): Promise<CanaryContainerAnswer> => {
      if (state.down) return { status: "failed", error: "the container is not listening on port 8080" };
      const snapshot = JSON.parse(body) as Posted & { cluster: { slot: number } };
      posted.push(snapshot);
      const before = state.beforeAnswer;
      state.beforeAnswer = null;
      await before?.();
      const chain = chains.find((c) => c.market === snapshot.market)!;
      if (!(chain.resolved in snapshot.accounts)) return { status: "missing", round: snapshot.round, addresses: [chain.resolved], seed: "5e".repeat(32) };
      return { status: "results", harness: "canary/0.3.1", records: records(chain, snapshot.cluster.slot, state.exitSizes), notes: [] };
    },
  };
}

function memoryStorage(): CanaryRunStorage & { alarm: number | null } {
  const values = new Map<string, unknown>();
  const storage = {
    alarm: null as number | null,
    get: async <T,>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => void values.set(key, structuredClone(value)),
    setAlarm: async (at: number) => void (storage.alarm = at),
    deleteAlarm: async () => void (storage.alarm = null),
  };
  return storage;
}

function runner(chains: CanaryChain[], options: { exitSizes?: CanaryRecord["outcome"]; openDb?: () => ReturnType<typeof createDb> } = {}) {
  const clock = { now: 1_763_900_000_000 };
  const storage = memoryStorage();
  const box = container(chains, options);
  const forwarded: { version: { program: string; deploySlot: string }; trigger: string; markets: string[]; delaysMs?: readonly number[]; since?: number }[] = [];
  const core = new CanaryRunCore({
    storage,
    now: () => clock.now,
    rpcUrl: rpc.url,
    openDb: options.openDb ?? (() => createDb(database.url)),
    container: { run: box.run },
    forward: async (version, request) => void forwarded.push({ version, ...request }),
    log: () => {},
  });
  /** Fires the alarm while it is due, as the runtime does. */
  const fireDue = async () => {
    for (let i = 0; storage.alarm !== null && storage.alarm <= clock.now; i++) {
      if (i > 100) throw new Error("the alarm never settles");
      await core.alarm();
    }
  };
  return { core, clock, storage, box, forwarded, fireDue };
}

const versionOf = (chain: CanaryChain) => ({ program: chain.strategy, deploySlot: String(chain.deploySlot) });

describe("a Canary run of a strategy version", () => {
  it("runs a new market at once and again 10 minutes, 1 hour and 1 day later, posting its snapshot with the version's instructions and the accounts the binary named", async () => {
    const chain = await putMarket(rpc);
    await index(chain);
    const { core, clock, storage, box, fireDue } = runner([chain]);

    await core.schedule(versionOf(chain), { trigger: "market_created", markets: [chain.market], delaysMs: CANARY.marketCreatedDelaysMs });
    expect(storage.alarm).toBe(clock.now);
    await fireDue();

    expect(box.posted.map((p) => [p.round, p.seed ?? null])).toEqual([
      [1, null],
      [2, "5e".repeat(32)],
    ]);
    expect(box.posted[0]!.instructions).toEqual({
      anchor: true,
      instructions: [
        { name: "PipelineSwap", calls: 0, signers: [] },
        { name: "Deposit", calls: 1, signers: [SIGNER] },
      ],
    });
    const version = { program: chain.strategy, deploySlot: chain.deploySlot };
    expect((await readCanaryLatest(client.db, { market: chain.market, version })).map((r) => [r.check, r.outcome])).toEqual([
      ["cost", "pass"],
      ["exit_sizes", "pass"],
    ]);
    const [run] = await client.db.select().from(canaryRuns);
    expect([run!.trigger, run!.delayMs, run!.markets, run!.finishedAt !== null]).toEqual(["market_created", 0, 1, true]);
    const [done] = await client.db.select().from(canaryRunMarkets);
    expect([done!.status, done!.rounds, done!.rpcRequests! <= 9]).toEqual(["done", 2, true]);

    // The second run is scheduled 10 minutes on, and the others after it.
    expect(storage.alarm).toBe(clock.now + 10 * MINUTE);
    expect((await core.status()).runs.map((r) => [r.trigger, r.delayMs, r.dueAt - clock.now])).toEqual([
      ["market_created", 10 * MINUTE, 10 * MINUTE],
      ["market_created", 60 * MINUTE, 60 * MINUTE],
      ["market_created", 24 * 60 * MINUTE, 24 * 60 * MINUTE],
    ]);
    clock.now += 10 * MINUTE;
    rpc.slot += 1500;
    await fireDue();
    expect(await client.db.select().from(canaryRuns)).toHaveLength(2);
    expect(storage.alarm).toBe(clock.now + 50 * MINUTE);
  });

  it("runs every market of the version, and tells the bot when the run ends", async () => {
    const chains = [await putMarket(rpc, { seed: 1 }), await putMarket(rpc, { seed: 2, strategySeed: 1 })];
    await index(chains[0]!);
    const { core, fireDue } = runner(chains);
    await core.schedule(versionOf(chains[0]!), { trigger: "strategy_version", markets: chains.map((c) => c.market) });
    await fireDue();
    const done = await client.db.select().from(canaryRunMarkets);
    expect(done.map((d) => d.market).sort()).toEqual(chains.map((c) => c.market).sort());
    const finished = (await readOutbox(client.db, "test")).filter((e) => e.kind === "canary_run_finished");
    expect(finished.map((e) => e.payload)).toEqual([expect.objectContaining({ trigger: "strategy_version", markets: 2, failed: 0 })]);
  });

  it("goes on from its alarm when the container stops mid-run, redoing the market it was on and none before it", async () => {
    const chains = [await putMarket(rpc, { seed: 1 }), await putMarket(rpc, { seed: 2, strategySeed: 1 })];
    await index(chains[0]!);
    const { core, clock, storage, box, fireDue } = runner(chains);
    await core.schedule(versionOf(chains[0]!), { trigger: "sweep", markets: chains.map((c) => c.market) });

    await core.alarm(); // the first market
    box.state.down = true;
    await core.alarm(); // the second: the container is gone
    expect(storage.alarm).toBe(clock.now + CANARY.retry.firstDelayMs);
    expect((await client.db.select().from(canaryRunMarkets)).map((d) => d.market)).toEqual([chains[0]!.market]);

    box.state.down = false;
    clock.now += CANARY.retry.firstDelayMs;
    const before = box.posted.length;
    await fireDue();
    expect(box.posted.slice(before).map((p) => p.market)).toEqual([chains[1]!.market, chains[1]!.market]);
    expect((await client.db.select().from(canaryRunMarkets)).map((d) => [d.market, d.status])).toEqual([
      [chains[0]!.market, "done"],
      [chains[1]!.market, "done"],
    ]);
    expect(storage.alarm).toBeNull();
  });

  it("writes a new run when the one it remembers is gone from Postgres, as when the database was replaced, rather than retrying forever", async () => {
    const chains = [await putMarket(rpc, { seed: 1 }), await putMarket(rpc, { seed: 2, strategySeed: 1 })];
    await index(chains[0]!);
    const { core, storage, fireDue } = runner(chains);
    await core.schedule(versionOf(chains[0]!), { trigger: "sweep", markets: chains.map((c) => c.market) });
    await core.alarm(); // the first market, under the run's first row
    const [first] = await client.db.select().from(canaryRuns);
    await client.db.execute(sql`truncate canary_results, canary_run_markets, canary_runs`);

    await fireDue();
    const runs = await client.db.select().from(canaryRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).not.toBe(first!.id);
    expect(runs[0]!.finishedAt).not.toBeNull();
    expect((await client.db.select().from(canaryRunMarkets)).map((d) => [d.market, d.status])).toEqual([[chains[1]!.market, "done"]]);
    expect(await readCanaryLatest(client.db, { market: chains[1]!.market, version: { program: chains[1]!.strategy, deploySlot: chains[1]!.deploySlot } })).toHaveLength(2);
    expect(storage.alarm).toBeNull();
  });

  it("records a market it could not run after its last attempt, keeps its earlier results, and goes on", async () => {
    const chain = await putMarket(rpc);
    await index(chain);
    const { core, clock, box, fireDue } = runner([chain]);
    await core.schedule(versionOf(chain), { trigger: "sweep", markets: [chain.market] });
    await fireDue();
    box.state.down = true;
    await core.schedule(versionOf(chain), { trigger: "rerun", markets: [chain.market] });
    for (let i = 0; i < CANARY.retry.attempts; i++) {
      await fireDue();
      clock.now += CANARY.retry.maxDelayMs;
    }
    const rows = await client.db.select().from(canaryRunMarkets);
    expect(rows.map((r) => [r.status, r.error])).toEqual([
      ["done", null],
      ["failed", "the container is not listening on port 8080"],
    ]);
    expect(await readCanaryLatest(client.db, { market: chain.market, version: { program: chain.strategy, deploySlot: chain.deploySlot } })).toHaveLength(2);
    expect((await core.status()).runs).toEqual([]);
  });

  it("hands its markets to the strategy's newer version once the chain runs other code, and stores nothing for itself", async () => {
    const chain = await putMarket(rpc);
    await index(chain);
    const { core, clock, box, forwarded, fireDue } = runner([chain]);
    // The strategy is upgraded before the run reaches the market, and the watch has recorded it.
    const { strategyProgramData } = chain;
    const upgraded = new Uint8Array(64).fill(8);
    const { programDataAccount } = await import("terminal-indexer/testing/programs");
    rpc.accounts.set(strategyProgramData, programDataAccount(900n, upgraded));
    await client.db.insert(programVersions).values({ program: chain.strategy, deploySlot: 900n, role: "strategy", executableSha256: sha256(upgraded), anchor: true });

    await core.schedule(versionOf(chain), { trigger: "market_created", markets: [chain.market], delaysMs: CANARY.marketCreatedDelaysMs });
    await fireDue();
    expect(box.posted).toEqual([]);
    // Each of the new market's runs goes with it, still due when it was.
    const to = { program: chain.strategy, deploySlot: "900" };
    expect(forwarded).toEqual(CANARY.marketCreatedDelaysMs.map((delay) => ({ version: to, trigger: "market_created", markets: [chain.market], delaysMs: [delay], since: clock.now })));
    expect(await client.db.select().from(canaryRunMarkets).where(eq(canaryRunMarkets.status, "done"))).toEqual([]);
    expect((await core.status()).runs).toEqual([]);
  });

  it("counts a market's later runs from when it was created, so runs already past are one run now", async () => {
    const chain = await putMarket(rpc);
    await index(chain);
    const { core, clock, box, fireDue } = runner([chain]);
    const created = clock.now - 2 * 60 * MINUTE;
    await core.schedule(versionOf(chain), { trigger: "market_created", markets: [chain.market], delaysMs: CANARY.marketCreatedDelaysMs, since: created });
    expect((await core.status()).runs.map((r) => [r.delayMs, r.dueAt])).toEqual([
      [0, created],
      [24 * 60 * MINUTE, created + 24 * 60 * MINUTE],
    ]);
    await fireDue();
    expect(box.posted.filter((p) => p.round === 1)).toHaveLength(1);
  });

  it("keeps a request that arrives while its alarm is running a market", async () => {
    const chains = [await putMarket(rpc, { seed: 1 }), await putMarket(rpc, { seed: 2, strategySeed: 1 })];
    await index(chains[0]!);
    const { core, box, fireDue } = runner(chains);
    await core.schedule(versionOf(chains[0]!), { trigger: "market_created", markets: [chains[0]!.market] });
    // The second market's request lands while the container is answering for the first.
    box.state.beforeAnswer = () => core.schedule(versionOf(chains[0]!), { trigger: "market_created", markets: [chains[1]!.market] });
    await fireDue();
    expect((await client.db.select().from(canaryRunMarkets)).map((d) => d.market).sort()).toEqual(chains.map((c) => c.market).sort());
  });

  it("keeps its runs and tries again later when its alarm fails outside a market, as when Postgres cannot be reached", async () => {
    const chain = await putMarket(rpc);
    await index(chain);
    let refuse = true;
    const { core, clock, storage, box, fireDue } = runner([chain], {
      openDb: () => {
        if (refuse) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
        return createDb(database.url);
      },
    });
    await core.schedule(versionOf(chain), { trigger: "sweep", markets: [chain.market] });
    await core.alarm();
    expect(storage.alarm).toBe(clock.now + CANARY.retry.firstDelayMs);
    expect((await core.status()).runs).toHaveLength(1);
    refuse = false;
    clock.now += CANARY.retry.firstDelayMs;
    await fireDue();
    expect(box.posted.filter((p) => p.round === 1)).toHaveLength(1);
    expect(await client.db.select().from(canaryRuns)).toHaveLength(1);
  });

  it("stores a run's row once, however often its first market is tried", async () => {
    const chain = await putMarket(rpc);
    await index(chain);
    const { core, clock, box, fireDue } = runner([chain]);
    await core.schedule(versionOf(chain), { trigger: "sweep", markets: [chain.market] });
    box.state.down = true;
    await fireDue();
    clock.now += CANARY.retry.firstDelayMs;
    box.state.down = false;
    await fireDue();
    const runs = await client.db.select().from(canaryRuns);
    expect(runs.map((r) => r.finishedAt !== null)).toEqual([true]);
  });

  it("never runs a version whose code it cannot tell, as one found only in the program's history", async () => {
    const chain = await putMarket(rpc);
    await index(chain);
    await client.db.update(programVersions).set({ executableSha256: null, backfilled: true }).where(eq(programVersions.program, chain.strategy));
    const { core, box, fireDue } = runner([chain]);
    await core.schedule(versionOf(chain), { trigger: "rerun", markets: [chain.market] });
    await fireDue();
    expect(box.posted).toEqual([]);
    expect((await client.db.select().from(canaryRunMarkets)).map((r) => [r.status, r.error])).toEqual([["failed", "Aviary does not know this version's code, so it cannot tell whether the chain still runs it"]]);
  });

  it("puts a market's run off to a later alarm when its rounds take too long for one", async () => {
    const chain = await putMarket(rpc);
    await index(chain);
    const { core, clock, storage, box, fireDue } = runner([chain]);
    await core.schedule(versionOf(chain), { trigger: "sweep", markets: [chain.market] });
    // The first round's answer comes back after the market's whole budget.
    box.state.beforeAnswer = async () => void (clock.now += CANARY.marketBudgetMs + 1);
    await core.alarm();
    expect(box.posted).toHaveLength(1);
    expect(await client.db.select().from(canaryRunMarkets)).toEqual([]);
    expect(storage.alarm).toBe(clock.now + CANARY.retry.firstDelayMs);
    clock.now += CANARY.retry.firstDelayMs;
    await fireDue();
    expect((await client.db.select().from(canaryRunMarkets)).map((r) => r.status)).toEqual(["done"]);
  });

  it("takes the same request twice as once, and leaves a market out of a new run while a started run still holds it", async () => {
    const chain = await putMarket(rpc);
    await index(chain);
    const { core, clock, box, fireDue } = runner([chain]);
    const created = clock.now;
    const request = { trigger: "market_created" as const, markets: [chain.market], delaysMs: CANARY.marketCreatedDelaysMs, since: created };
    await core.schedule(versionOf(chain), request);
    await core.schedule(versionOf(chain), request);
    expect((await core.status()).runs).toHaveLength(4);
    // The first run starts, and its market's try fails, putting the run 30 s on; a sweep then names it.
    box.state.down = true;
    await fireDue();
    await core.schedule(versionOf(chain), { trigger: "sweep", markets: [chain.market] });
    expect((await core.status()).runs.map((r) => r.trigger)).not.toContain("sweep");
  });

  it("does not run a market twice when a second trigger names it while it waits", async () => {
    const chain = await putMarket(rpc);
    await index(chain);
    const { core, box, fireDue } = runner([chain]);
    await core.schedule(versionOf(chain), { trigger: "strategy_version", markets: [chain.market] });
    await core.schedule(versionOf(chain), { trigger: "sweep", markets: [chain.market] });
    await fireDue();
    expect(box.posted.filter((p) => p.round === 1)).toHaveLength(1);
    expect((await client.db.select().from(canaryRuns)).map((r) => r.trigger)).toEqual(["strategy_version"]);
  });
});
