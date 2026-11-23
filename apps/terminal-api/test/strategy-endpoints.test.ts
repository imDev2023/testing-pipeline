// A strategy's versions and instructions, its markets, and the router's versions, in the zod
// contract (docs/spec/pipescope-architecture.md, API; #117): the database is filled by the indexer's
// own handlers and version recording from real devnet transactions and loader accounts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PIPELINE_PROGRAM_ADDRESS, programDataPda } from "@pipeline-sol/sdk";
import { address, getBase58Decoder } from "@solana/kit";
import { createDb } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { combineHandlers, indexTransactions, pipelineHandler, recordVersion, strategyCallsHandler, type RawTransaction } from "terminal-indexer";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { programDataAccount, programReader, upgradeTransaction } from "terminal-indexer/testing/programs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarketsPage, RouterVersions, StrategyInstructions, StrategyVersions, type ApiError } from "../src/contract";
import { app } from "../src/index";
import { readStrategyInstructions } from "../src/strategies";
import { bindings, executionContext } from "./fakes";

const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/../../../packages/terminal-indexer/test/fixtures/${name}.json`, "utf8")) as RawTransaction;
const [registered, created, swap] = ["registered", "marketCreated", "swap"].map(fixture) as [RawTransaction, RawTransaction, RawTransaction];

const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const CALLER_A = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";
const CALLER_B = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";
const UNKNOWN = "6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp";
const disc = (snake: string) => createHash("sha256").update(`global:${snake}`).digest().subarray(0, 8);
const code = (...names: [string, string][]) => Buffer.concat([Buffer.alloc(16, 0x5a), ...names.flatMap(([camel, snake]) => [Buffer.from(`Instruction: ${camel}`), Buffer.alloc(8, 0x5a), disc(snake)]), Buffer.alloc(8, 0x5a)]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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

const v1 = code(["Distribute", "distribute"], ["PipelineSwap", "pipeline_swap"]);
const v2 = code(["Distribute", "distribute"], ["Withdraw", "withdraw"], ["PipelineSwap", "pipeline_swap"]);
const routerBytes = Uint8Array.of(0x7f, 0x45, 0x4c, 0x46, 1);

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let rpc: FakeRpc;
let env: ReturnType<typeof bindings>;
beforeAll(async () => {
  database = await createTestDatabase();
  env = bindings({ databaseUrl: database.url, rpcUrl: "http://127.0.0.1:9/never-called" });
  rpc = await fakeRpc();
  const { db, close } = createDb(database.url);
  try {
    const handler = combineHandlers(pipelineHandler(), strategyCallsHandler((p) => p === STRATEGY));
    await indexTransactions(db, handler, [registered, created, swap, customAction("custom-a1", 525_300_000, CALLER_A), customAction("custom-a2", 525_300_001, CALLER_A), customAction("custom-b1", 525_300_002, CALLER_B)]);
    const strategyData = await programDataPda(address(STRATEGY));
    rpc.history.push(upgradeTransaction({ kind: "deploy", program: STRATEGY, programData: strategyData, slot: 525_100_000, signature: "strategy-deploy" }));
    rpc.accounts.set(strategyData, programDataAccount(525_100_000n, v1));
    await recordVersion(db, programReader(rpc.url), { program: STRATEGY, role: "strategy", programData: strategyData, previousSlot: null });
    rpc.history.push(upgradeTransaction({ kind: "upgrade", program: STRATEGY, programData: strategyData, slot: 525_400_000, signature: "strategy-upgrade" }));
    rpc.accounts.set(strategyData, programDataAccount(525_400_000n, v2));
    await recordVersion(db, programReader(rpc.url), { program: STRATEGY, role: "strategy", programData: strategyData, previousSlot: 525_100_000n });
    const routerData = await programDataPda(address(PIPELINE_PROGRAM_ADDRESS));
    rpc.accounts.set(routerData, programDataAccount(525_000_000n, routerBytes));
    await recordVersion(db, programReader(rpc.url), { program: PIPELINE_PROGRAM_ADDRESS, role: "router", programData: routerData, previousSlot: null });
    rpc.history.push(upgradeTransaction({ kind: "upgrade", program: PIPELINE_PROGRAM_ADDRESS, programData: routerData, slot: 525_600_000, signature: "router-upgrade" }));
    rpc.accounts.set(routerData, programDataAccount(525_600_000n, routerBytes));
    await recordVersion(db, programReader(rpc.url), { program: PIPELINE_PROGRAM_ADDRESS, role: "router", programData: routerData, previousSlot: 525_000_000n });
  } finally {
    await close();
  }
});
afterAll(async () => {
  await rpc?.close();
  await database?.drop();
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const { ctx, settle } = executionContext();
  const response = await app.request(path, {}, env, ctx);
  await settle();
  return { status: response.status, body: await response.json() };
}

describe("GET /v1/strategies/{program}/versions", () => {
  it("lists the strategy's versions newest first, the newest marked current", async () => {
    const { status, body } = await get(`/v1/strategies/${STRATEGY}/versions`);
    expect(status).toBe(200);
    expect(StrategyVersions.parse(body)).toEqual({
      program: STRATEGY,
      versions: [
        { deploy_slot: 525_400_000, executable_sha256: sha(v2), signature: "strategy-upgrade", deployed_at: new Date(525_400_000_000).toISOString(), seen_at: expect.any(String), backfilled: false, current: true },
        { deploy_slot: 525_100_000, executable_sha256: sha(v1), signature: "strategy-deploy", deployed_at: new Date(525_100_000_000).toISOString(), seen_at: expect.any(String), backfilled: false, current: false },
      ],
    });
  });

  it("answers 404 for an address that is no strategy", async () => {
    const { status, body } = await get(`/v1/strategies/${UNKNOWN}/versions`);
    expect(status).toBe(404);
    expect((body as ApiError).error).toBe("Aviary knows no strategy registered with Pipeline at this address.");
  });
});

describe("GET /v1/strategies/{program}/instructions", () => {
  it("lists the current version's instructions, each with how often it was called and by whom", async () => {
    const { status, body } = await get(`/v1/strategies/${STRATEGY}/instructions`);
    expect(status).toBe(200);
    const trader = swap.transaction.message.accountKeys[0]!;
    expect(StrategyInstructions.parse(body)).toEqual({
      program: STRATEGY,
      deploy_slot: 525_400_000,
      anchor: true,
      instructions: [
        { name: "Distribute", discriminator: disc("distribute").toString("hex"), pipeline: false, calls: 3, signers: [{ address: CALLER_A, calls: 2 }, { address: CALLER_B, calls: 1 }], signers_total: 2 },
        { name: "Withdraw", discriminator: disc("withdraw").toString("hex"), pipeline: false, calls: 0, signers: [], signers_total: 0 },
        { name: "PipelineSwap", discriminator: disc("pipeline_swap").toString("hex"), pipeline: true, calls: 1, signers: [{ address: trader, calls: 1 }], signers_total: 1 },
      ],
    });
  });

  it("lists at most the signers asked for, most calls first, and counts them all", async () => {
    const { db, close } = createDb(database.url);
    try {
      const [distribute] = (await readStrategyInstructions(db, STRATEGY, { signersShown: 1 })).instructions;
      expect(distribute).toMatchObject({ name: "Distribute", calls: 3, signers: [{ address: CALLER_A, calls: 2 }], signers_total: 2 });
    } finally {
      await close();
    }
  });

  it("says no version is recorded yet for a strategy the watch has not read", async () => {
    const { db, close } = createDb(database.url);
    const { strategies } = await import("terminal-db");
    await db.insert(strategies).values({ program: UNKNOWN, metadataUri: "https://example.org/u.json", registeredAt: new Date(1_795_000_000_000) });
    await close();
    expect(StrategyInstructions.parse((await get(`/v1/strategies/${UNKNOWN}/instructions`)).body)).toEqual({ program: UNKNOWN, deploy_slot: null, anchor: null, instructions: [] });
    expect(StrategyVersions.parse((await get(`/v1/strategies/${UNKNOWN}/versions`)).body)).toEqual({ program: UNKNOWN, versions: [] });
  });
});

describe("GET /v1/markets?strategy=", () => {
  it("lists only that strategy's markets, with their count", async () => {
    const page = MarketsPage.parse((await get(`/v1/markets?strategy=${STRATEGY}`)).body);
    expect(page.markets.map((m) => m.address)).toEqual([MARKET]);
    expect(page.total).toBe(1);
    expect(MarketsPage.parse((await get(`/v1/markets?strategy=${UNKNOWN}`)).body)).toEqual({ markets: [], total: 0, matching: 0, no_sol_side: 0, flags_present: [], next: null });
  });
});

describe("GET /v1/router", () => {
  it("lists the router's versions newest first, an upgrade the watch saw flagged", async () => {
    const { status, body } = await get("/v1/router");
    expect(status).toBe(200);
    expect(RouterVersions.parse(body)).toEqual({
      program: PIPELINE_PROGRAM_ADDRESS,
      versions: [
        { deploy_slot: 525_600_000, executable_sha256: sha(routerBytes), signature: "router-upgrade", deployed_at: new Date(525_600_000_000).toISOString(), seen_at: expect.any(String), backfilled: false, flagged: true, current: true },
        { deploy_slot: 525_000_000, executable_sha256: sha(routerBytes), signature: null, deployed_at: null, seen_at: expect.any(String), backfilled: false, flagged: false, current: false },
      ],
    });
  });
});
