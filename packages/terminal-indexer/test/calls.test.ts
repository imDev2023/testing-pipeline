// Strategy-program calls (docs/spec/pipescope-architecture.md, Indexer): every instruction the
// indexer sees on a strategy program is stored with who signed it, at the top level (a custom action
// or a bypass swap) or inside another program (the router's calls), from real devnet transactions.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { getBase58Decoder } from "@solana/kit";
import { asc } from "drizzle-orm";
import { createDb, strategyCalls, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { combineHandlers, indexTransactions, pipelineHandler, strategyCallsHandler, type RawTransaction } from "../src/index";

const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/${name}.json`, "utf8")) as RawTransaction;
const [registered, created, swap, failed] = ["registered", "marketCreated", "swap", "failed"].map(fixture) as [RawTransaction, RawTransaction, RawTransaction, RawTransaction];

const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const MARKET_STATE = "EE3ifuzvJGAtcY6xTxxr26ezaXG1cethHvA52R3r6x1U";
const CREATOR = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";
const disc = (snake: string) => createHash("sha256").update(`global:${snake}`).digest().subarray(0, 8).toString("hex");

/** A custom action called straight on the strategy, outside the router: `distribute` on the market's state, signed by its caller. */
function customAction(signature: string, marketState: string): RawTransaction {
  const data = Uint8Array.from([...createHash("sha256").update("global:distribute").digest().subarray(0, 8), 1, 2, 3]);
  return {
    slot: 525_300_000,
    blockTime: 1_795_500_000,
    transactionIndex: 3,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [CREATOR, marketState, STRATEGY],
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
        instructions: [{ programIdIndex: 2, accounts: [0, 1], data: getBase58Decoder().decode(data) }],
      },
    },
    meta: { err: null, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] } },
  };
}

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
});
beforeEach(async () => {
  await client.db.delete(strategyCalls);
});
afterAll(async () => {
  await client?.close();
  await database?.drop();
});

const handler = () => combineHandlers(pipelineHandler(), strategyCallsHandler((program) => program === STRATEGY));
const calls = () => client.db.select().from(strategyCalls).orderBy(asc(strategyCalls.slot), asc(strategyCalls.instructionIndex), asc(strategyCalls.innerIndex));

describe("strategyCallsHandler", () => {
  it("stores the router's calls into the strategy with the signers among their accounts and the router as the caller", async () => {
    const result = await indexTransactions(client.db, handler(), [registered, created, swap]);
    expect(result.counts).toMatchObject({ strategies: 1, markets: 1, trades: 1, strategyCalls: 3 });
    const [creatorSigner] = created.transaction.message.accountKeys.slice(1, 2);
    const trader = swap.transaction.message.accountKeys[0]!;
    expect((await calls()).map((c) => ({ signature: c.signature, at: [c.instructionIndex, c.innerIndex], discriminator: c.discriminator, signers: c.signers, invokedBy: c.invokedBy, program: c.program }))).toEqual([
      { signature: created.transaction.signatures[0], at: [0, 2], discriminator: disc("pipeline_init_market"), signers: [creatorSigner], invokedBy: PIPELINE_PROGRAM_ADDRESS, program: STRATEGY },
      { signature: created.transaction.signatures[0], at: [0, 11], discriminator: disc("pipeline_market_info"), signers: [creatorSigner], invokedBy: PIPELINE_PROGRAM_ADDRESS, program: STRATEGY },
      { signature: swap.transaction.signatures[0], at: [0, 1], discriminator: disc("pipeline_swap"), signers: [trader], invokedBy: PIPELINE_PROGRAM_ADDRESS, program: STRATEGY },
    ]);
  });

  it("stores a custom action called straight on the strategy, and names the market whose state it touched to be read again", async () => {
    await indexTransactions(client.db, pipelineHandler(), [registered, created]);
    const result = await indexTransactions(client.db, handler(), [customAction("custom-1", MARKET_STATE)]);
    expect(result).toEqual({ counts: { strategyCalls: 1 }, markets: [MARKET] });
    expect(await calls()).toEqual([
      expect.objectContaining({ signature: "custom-1", instructionIndex: 0, innerIndex: -1, discriminator: disc("distribute"), signers: [CREATOR], invokedBy: null, slot: 525_300_000n, blockIndex: 3, blockTime: new Date(1_795_500_000_000) }),
    ]);
  });

  it("writes each call once, however often its transaction arrives, and nothing for a failed transaction", async () => {
    await indexTransactions(client.db, handler(), [customAction("custom-2", "Unknown1111111111111111111111111111111111111"), customAction("custom-2", "Unknown1111111111111111111111111111111111111")]);
    expect(await calls()).toHaveLength(1);
    const failedOnStrategy = { ...customAction("custom-failed", MARKET_STATE), meta: { ...failed.meta!, err: { InstructionError: [0, { Custom: 6000 }] } } } as RawTransaction;
    expect((await indexTransactions(client.db, handler(), [failedOnStrategy])).counts).toEqual({});
    expect(await calls()).toHaveLength(1);
  });
});
