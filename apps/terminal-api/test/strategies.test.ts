// The indexer's strategy programs and their versions (docs/spec/pipescope-architecture.md, Indexer;
// #117): the ProgramData watch reads the router's and every strategy's deploy slot in one request per
// 100 programs and touches Postgres only when one changed; a changed slot is a new version, recorded
// with its event, and a strategy's markets are read again; strategy programs are reconciled from
// their own cursors, storing every call on them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PIPELINE_PROGRAM_ADDRESS, programDataPda } from "@pipeline-sol/sdk";
import { address, getBase58Decoder } from "@solana/kit";
import { asc, eq } from "drizzle-orm";
import { createDb, markets, programFacts, programVersions, readOutbox, strategyCalls, strategyInstructions } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import type { RawTransaction } from "terminal-indexer";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { programDataAccount, UPGRADE_AUTHORITY, upgradeTransaction } from "terminal-indexer/testing/programs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexerCore } from "../src/indexerCore";
import { memoryImages, metadataWeb } from "./fakes";

const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/../../../packages/terminal-indexer/test/fixtures/${name}.json`, "utf8")) as RawTransaction;
const [registered, created, swap] = ["registered", "marketCreated", "swap"].map(fixture) as [RawTransaction, RawTransaction, RawTransaction];

const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const disc = (snake: string) => createHash("sha256").update(`global:${snake}`).digest().subarray(0, 8);
const code = (...names: [string, string][]) => Buffer.concat([Buffer.alloc(16, 0x5a), ...names.flatMap(([camel, snake]) => [Buffer.from(`Instruction: ${camel}`), Buffer.alloc(8, 0x5a), disc(snake)]), Buffer.alloc(8, 0x5a)]);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let rpc: FakeRpc;
let reader: ReturnType<typeof createDb>;
let strategyData: string;
let routerData: string;
beforeEach(async () => {
  database = await createTestDatabase();
  reader = createDb(database.url);
  strategyData = await programDataPda(address(STRATEGY));
  routerData = await programDataPda(address(PIPELINE_PROGRAM_ADDRESS));
  rpc = await fakeRpc([
    upgradeTransaction({ kind: "deploy", program: STRATEGY, programData: strategyData, slot: 525_100_000, signature: "strategy-deploy" }),
    upgradeTransaction({ kind: "deploy", program: PIPELINE_PROGRAM_ADDRESS, programData: routerData, slot: 525_000_000, signature: "router-deploy" }),
    registered,
    created,
  ]);
  rpc.accounts.set(strategyData, programDataAccount(525_100_000n, code(["Distribute", "distribute"], ["PipelineSwap", "pipeline_swap"])));
  rpc.accounts.set(routerData, programDataAccount(525_000_000n, Uint8Array.of(0x7f, 0x45, 0x4c, 0x46)));
});
afterEach(async () => {
  await rpc.close();
  await reader.close();
  await database.drop();
});

function core() {
  const openDb = vi.fn(() => createDb(database.url));
  return { indexer: new IndexerCore({ rpcUrl: rpc.url, openDb, webFetch: metadataWeb().fetch, images: memoryImages() }), openDb };
}

const versionsOf = (program: string) => reader.db.select().from(programVersions).where(eq(programVersions.program, program)).orderBy(asc(programVersions.deploySlot));

/** The strategy upgraded in `slot` with `bytes`, as the loader leaves it. */
function upgradeStrategy(slot: number, bytes: Uint8Array, signature: string) {
  rpc.accounts.set(strategyData, programDataAccount(BigInt(slot), bytes));
  rpc.history.push(upgradeTransaction({ kind: "upgrade", program: STRATEGY, programData: strategyData, slot, signature }));
}

describe("the ProgramData watch", () => {
  it("records the version in force of the router and of every strategy on first sight, reading their slots in one request", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    rpc.requests.length = 0;
    expect(await indexer.watchPrograms()).toEqual({ quiet: false, recorded: [PIPELINE_PROGRAM_ADDRESS, STRATEGY].sort(), upgraded: [] });
    expect(rpc.requests.filter((r) => r.method === "getMultipleAccounts" && JSON.stringify(r.params).includes("dataSlice"))).toHaveLength(1);
    expect((await versionsOf(STRATEGY)).map((v) => [v.deploySlot, v.role, v.signature, v.backfilled, v.anchor])).toEqual([[525_100_000n, "strategy", "strategy-deploy", false, true]]);
    expect((await versionsOf(PIPELINE_PROGRAM_ADDRESS)).map((v) => [v.deploySlot, v.role, v.flagged])).toEqual([[525_000_000n, "router", false]]);
    expect((await reader.db.select().from(strategyInstructions)).map((i) => i.name)).toEqual(["Distribute", "PipelineSwap"]);
    // First sight is no upgrade: only the strategy and its market, from the router's events.
    expect((await readOutbox(reader.db, "test")).map((e) => e.kind)).toEqual(["strategy_registered", "market_created"]);
  });

  it("is one request and opens no database while no program changed", async () => {
    const { indexer, openDb } = core();
    await indexer.reconcile();
    await indexer.watchPrograms();
    openDb.mockClear();
    rpc.requests.length = 0;
    expect(await indexer.watchPrograms()).toEqual({ quiet: true, recorded: [], upgraded: [] });
    expect(rpc.requests.map((r) => r.method)).toEqual(["getMultipleAccounts"]);
    expect(openDb).not.toHaveBeenCalled();
  });

  it("records a strategy's upgrade on the next watch, with its event, and reads the strategy's markets again", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    await indexer.watchPrograms();
    upgradeStrategy(525_400_000, code(["Distribute", "distribute"], ["Withdraw", "withdraw"]), "strategy-upgrade");
    rpc.slot = 525_400_005;

    expect(await indexer.watchPrograms()).toEqual({ quiet: false, recorded: [STRATEGY], upgraded: [STRATEGY] });
    expect((await versionsOf(STRATEGY)).map((v) => [v.deploySlot, v.signature])).toEqual([
      [525_100_000n, "strategy-deploy"],
      [525_400_000n, "strategy-upgrade"],
    ]);
    expect((await readOutbox(reader.db, "test")).at(-1)).toMatchObject({ kind: "strategy_version", subject: STRATEGY, payload: { deploySlot: "525400000", previousSlot: "525100000" } });
    expect((await reader.db.select({ readSlot: markets.readSlot }).from(markets).where(eq(markets.address, MARKET)))[0]?.readSlot).toBe(525_400_005n);
  });

  it("looks again on later watches for an upgrade's transaction the RPC did not serve yet", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    await indexer.watchPrograms();
    rpc.accounts.set(strategyData, programDataAccount(525_500_000n, code(["Distribute", "distribute"])));
    await indexer.watchPrograms();
    expect((await versionsOf(STRATEGY)).at(-1)?.signature).toBeNull();
    rpc.history.push(upgradeTransaction({ kind: "upgrade", program: STRATEGY, programData: strategyData, slot: 525_500_000, signature: "served-late" }));
    await indexer.watchPrograms();
    expect((await versionsOf(STRATEGY)).at(-1)?.signature).toBe("served-late");
  });

  it("records no version for an extension and reads the program's bytes once for it, not on every watch", async () => {
    const { indexer, openDb } = core();
    await indexer.reconcile();
    await indexer.watchPrograms();
    rpc.accounts.set(strategyData, programDataAccount(525_450_000n, code(["Distribute", "distribute"], ["PipelineSwap", "pipeline_swap"])));
    rpc.history.push(upgradeTransaction({ kind: "extend", program: STRATEGY, programData: strategyData, slot: 525_450_000, signature: "extend" }));
    expect(await indexer.watchPrograms()).toEqual({ quiet: true, recorded: [], upgraded: [] });
    openDb.mockClear();
    rpc.requests.length = 0;
    expect(await indexer.watchPrograms()).toEqual({ quiet: true, recorded: [], upgraded: [] });
    expect(rpc.requests.map((r) => r.method)).toEqual(["getMultipleAccounts"]);
    expect(openDb).not.toHaveBeenCalled();
    expect((await versionsOf(STRATEGY)).map((v) => v.deploySlot)).toEqual([525_100_000n]);
  });

  it("looks again for a first version's transaction the RPC did not serve yet", async () => {
    rpc.history.splice(rpc.history.findIndex((t) => t.transaction.signatures[0] === "strategy-deploy"), 1);
    const { indexer } = core();
    await indexer.reconcile();
    await indexer.watchPrograms();
    expect((await versionsOf(STRATEGY))[0]?.signature).toBeNull();
    rpc.history.push(upgradeTransaction({ kind: "deploy", program: STRATEGY, programData: strategyData, slot: 525_100_000, signature: "strategy-deploy" }));
    await indexer.watchPrograms();
    expect((await versionsOf(STRATEGY))[0]?.signature).toBe("strategy-deploy");
  });

  it("remembers an extension's slot in Postgres, so a new instance does not read the program's bytes again for it", async () => {
    await core().indexer.reconcile();
    await core().indexer.watchPrograms();
    rpc.accounts.set(strategyData, programDataAccount(525_450_000n, code(["Distribute", "distribute"], ["PipelineSwap", "pipeline_swap"])));
    rpc.history.push(upgradeTransaction({ kind: "extend", program: STRATEGY, programData: strategyData, slot: 525_450_000, signature: "extend" }));
    await core().indexer.watchPrograms();
    const { indexer, openDb } = core();
    rpc.requests.length = 0;
    expect(await indexer.watchPrograms()).toEqual({ quiet: true, recorded: [], upgraded: [] });
    expect(rpc.requests.map((r) => r.method)).toEqual(["getMultipleAccounts"]);
    expect(openDb).toHaveBeenCalledTimes(1);
  });

  it("records a router upgrade flagged, with its router_upgraded event", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    await indexer.watchPrograms();
    rpc.accounts.set(routerData, programDataAccount(525_600_000n, Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 2)));
    rpc.history.push(upgradeTransaction({ kind: "upgrade", program: PIPELINE_PROGRAM_ADDRESS, programData: routerData, slot: 525_600_000, signature: "router-upgrade" }));

    expect(await indexer.watchPrograms()).toEqual({ quiet: false, recorded: [PIPELINE_PROGRAM_ADDRESS], upgraded: [PIPELINE_PROGRAM_ADDRESS] });
    expect((await versionsOf(PIPELINE_PROGRAM_ADDRESS)).map((v) => [v.deploySlot, v.flagged, v.signature])).toEqual([
      [525_000_000n, false, "router-deploy"],
      [525_600_000n, true, "router-upgrade"],
    ]);
    expect((await readOutbox(reader.db, "test")).at(-1)).toMatchObject({ kind: "router_upgraded", subject: PIPELINE_PROGRAM_ADDRESS });
  });

  it("keeps who can upgrade each program, and writes it again only when it changes, as when an authority is given up", async () => {
    const { indexer, openDb } = core();
    await indexer.reconcile();
    await indexer.watchPrograms();
    const facts = async () => (await reader.db.select().from(programFacts).orderBy(asc(programFacts.program))).map((f) => [f.program, f.upgradeAuthority, f.flags]);
    expect(await facts()).toEqual([
      [STRATEGY, UPGRADE_AUTHORITY, ["upgradeable"]],
      [PIPELINE_PROGRAM_ADDRESS, UPGRADE_AUTHORITY, ["upgradeable"]],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

    openDb.mockClear();
    await indexer.watchPrograms();
    expect(openDb).not.toHaveBeenCalled();

    // `solana program set-upgrade-authority --final` rewrites the header and leaves the slot as it was.
    rpc.accounts.set(strategyData, programDataAccount(525_100_000n, code(["Distribute", "distribute"], ["PipelineSwap", "pipeline_swap"]), null));
    expect(await indexer.watchPrograms()).toMatchObject({ recorded: [], upgraded: [] });
    expect((await facts()).find(([p]) => p === STRATEGY)).toEqual([STRATEGY, null, ["frozen"]]);
    expect(await versionsOf(STRATEGY)).toHaveLength(1);
  });

  it("still records versions when asking about a program with no ProgramData account fails", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    // A strategy whose program is gone: its facts are asked of the RPC with getAccountInfo, which refuses.
    rpc.accounts.delete(strategyData);
    rpc.failing.add(STRATEGY);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await indexer.watchPrograms()).toEqual({ quiet: false, recorded: [PIPELINE_PROGRAM_ADDRESS], upgraded: [] });
    log.mockRestore();
    expect((await reader.db.select().from(programFacts)).map((f) => f.program)).toEqual([PIPELINE_PROGRAM_ADDRESS]);
  });

  it("is carried on by a new instance from what Postgres holds, as after a deploy, without recording the same version again", async () => {
    await core().indexer.reconcile();
    await core().indexer.watchPrograms();
    const { indexer, openDb } = core();
    expect(await indexer.watchPrograms()).toEqual({ quiet: true, recorded: [], upgraded: [] });
    // Nor does it write the programs' facts again: it read them from Postgres with the slots.
    expect(openDb).toHaveBeenCalledTimes(1);
  });
});

/** A custom action called straight on the strategy by `caller`. */
function customAction(signature: string, slot: number, caller: string): RawTransaction {
  return {
    slot,
    blockTime: 1_795_500_000,
    transactionIndex: 0,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [caller, STRATEGY],
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        instructions: [{ programIdIndex: 1, accounts: [0], data: getBase58Decoder().decode(disc("distribute")) }],
      },
    },
    meta: { err: null, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] } },
  };
}

describe("reconciliation of strategy programs", () => {
  it("backfills each strategy's whole history on its first run, storing every call on it", async () => {
    const { indexer } = core();
    await indexer.reconcile();
    rpc.history.push(swap, customAction("custom-1", 525_300_000, "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt"));
    const outcome = await indexer.reconcileStrategies();
    expect(outcome.quiet).toBe(false);
    expect(outcome.indexed.counts.strategyCalls).toBe(4);
    expect((await reader.db.select({ signature: strategyCalls.signature }).from(strategyCalls).orderBy(asc(strategyCalls.slot))).map((c) => c.signature)).toEqual([
      created.transaction.signatures[0],
      created.transaction.signatures[0],
      swap.transaction.signatures[0],
      "custom-1",
    ]);
  });

  it("asks the chain first and opens no database while no strategy has anything new, then picks up a new call", async () => {
    const { indexer, openDb } = core();
    await indexer.reconcile();
    await indexer.reconcileStrategies();
    openDb.mockClear();
    expect((await indexer.reconcileStrategies()).quiet).toBe(true);
    expect(openDb).not.toHaveBeenCalled();

    rpc.history.push(customAction("custom-2", 525_700_000, "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2"));
    expect((await indexer.reconcileStrategies()).indexed.counts).toEqual({ strategyCalls: 1 });
    expect(openDb).toHaveBeenCalledTimes(1);
  });

  it("watches a strategy from the moment the router's reconciliation indexes its registration", async () => {
    const { indexer } = core();
    expect((await indexer.reconcileStrategies()).indexed.counts).toEqual({});
    await indexer.reconcile();
    expect((await indexer.reconcileStrategies()).indexed.counts.strategyCalls).toBe(2);
  });
});
