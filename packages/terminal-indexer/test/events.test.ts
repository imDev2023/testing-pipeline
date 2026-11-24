// Strategy-program events (docs/spec/pipescope-architecture.md, Indexer, "Strategy-program events";
// #88): every `Program data:` line a strategy program wrote itself in a successful transaction is
// stored whole, in log order, with the address after its discriminator as its subject; lines written
// by any other program (the router's, klend's under a strategy) are not the strategy's.
import { asc } from "drizzle-orm";
import { createDb, strategyEvents, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { getAddressEncoder, type Address } from "@solana/kit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eventsInLogs, indexTransactions, strategyEventsHandler, type RawTransaction } from "../src/index";

const STRATEGY = "Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG";
const ROUTER = "PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34";
const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const MARKET_STATE = "AMJ4eVWMgqc9hZMmKDipbvwU6EQkmAvhUf4F42dNSDuu" as Address;
const LP = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";

/** An Anchor event: its 8-byte discriminator, the market state, then `rest`. */
const event = (discriminator: number, rest: number[] = []) => Buffer.from([discriminator, 1, 2, 3, 4, 5, 6, 7, ...getAddressEncoder().encode(MARKET_STATE), ...rest]).toString("base64");

function transaction(signature: string, logMessages: string[], err: unknown = null): RawTransaction {
  return {
    slot: 525_400_000,
    blockTime: 1_795_600_000,
    transactionIndex: 7,
    transaction: { signatures: [signature], message: { accountKeys: [LP, STRATEGY], header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 }, instructions: [] } },
    meta: { err, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, logMessages },
  };
}

const isStrategy = (program: string) => program === STRATEGY;

describe("eventsInLogs", () => {
  it("gives each data line to the program at the top of the call stack when it was written", () => {
    const logs = [
      `Program ${ROUTER} invoke [1]`,
      "Program log: Instruction: Swap",
      `Program ${STRATEGY} invoke [2]`,
      `Program ${KLEND} invoke [3]`,
      `Program data: ${Buffer.from([9, 9, 9]).toString("base64")}`,
      `Program ${KLEND} success`,
      `Program data: ${event(1, [42])}`,
      `Program ${STRATEGY} consumed 30000 of 200000 compute units`,
      `Program ${STRATEGY} success`,
      `Program data: ${Buffer.from([7]).toString("base64")}`,
      `Program ${ROUTER} success`,
      `Program ${STRATEGY} invoke [1]`,
      `Program data: ${event(2)}`,
      `Program return: ${STRATEGY} AQID`,
      `Program ${STRATEGY} success`,
    ];
    expect(eventsInLogs(logs, isStrategy).map((e) => ({ program: e.program, first: e.data[0], length: e.data.length }))).toEqual([
      { program: STRATEGY, first: 1, length: 41 },
      { program: STRATEGY, first: 2, length: 40 },
    ]);
  });

  it("joins a line's slices, and stops at truncated logs", () => {
    const logs = [`Program ${STRATEGY} invoke [1]`, `Program data: ${Buffer.from([1, 2]).toString("base64")} ${Buffer.from([3]).toString("base64")}`, "Log truncated", `Program data: ${event(3)}`];
    expect(eventsInLogs(logs, isStrategy).map((e) => [...e.data])).toEqual([[1, 2, 3]]);
  });
});

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
});
beforeEach(async () => {
  await client.db.delete(strategyEvents);
});
afterAll(async () => {
  await client?.close();
  await database?.drop();
});

const rows = () => client.db.select().from(strategyEvents).orderBy(asc(strategyEvents.signature), asc(strategyEvents.position));

describe("strategyEventsHandler", () => {
  it("stores a successful transaction's strategy events once, with their subject, discriminator and place", async () => {
    const logs = [`Program ${STRATEGY} invoke [1]`, `Program data: ${event(5, [1, 0])}`, `Program data: ${Buffer.from([1, 2, 3]).toString("base64")}`, `Program ${STRATEGY} success`];
    const handle = strategyEventsHandler(isStrategy);
    const first = await indexTransactions(client.db, handle, [transaction("events-1", logs)]);
    expect(first.counts).toEqual({ strategyEvents: 2 });
    await indexTransactions(client.db, handle, [transaction("events-1", logs)]);
    expect(await rows()).toEqual([
      { signature: "events-1", position: 0, program: STRATEGY, discriminator: "0501020304050607", subject: MARKET_STATE, data: event(5, [1, 0]), slot: 525_400_000n, blockIndex: 7, blockTime: new Date(1_795_600_000_000) },
      { signature: "events-1", position: 1, program: STRATEGY, discriminator: null, subject: null, data: "AQID", slot: 525_400_000n, blockIndex: 7, blockTime: new Date(1_795_600_000_000) },
    ]);
  });

  it("stores nothing of a failed transaction, which changed nothing", async () => {
    const logs = [`Program ${STRATEGY} invoke [1]`, `Program data: ${event(5)}`, `Program ${STRATEGY} failed: custom program error: 0x1770`];
    expect((await indexTransactions(client.db, strategyEventsHandler(isStrategy), [transaction("failed-1", logs, { InstructionError: [0, { Custom: 6000 }] })])).counts).toEqual({});
    expect(await rows()).toEqual([]);
  });
});
