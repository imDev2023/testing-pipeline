// A router event the decoder does not know (a router upgrade's, say) is kept with its transaction,
// and indexed once newer code knows it (docs/spec/pipescope-architecture.md, Indexer, "Unknown or
// failed decodes"): here a decoder that has not learnt swaps stands for the older code.
import { readFileSync } from "node:fs";
import { decodeEvent } from "@pipeline-sol/sdk";
import { eq } from "drizzle-orm";
import { createDb, indexedTransactions, trades, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DECODER_VERSION, indexTransactions, pipelineHandler, reindexUnknown, type EventDecoder, type RawTransaction } from "../src/index";

const swap = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/swap.json`, "utf8")) as RawTransaction;
const signature = swap.transaction.signatures[0]!;

/** The decoder before it learnt swaps. */
const withoutSwaps: EventDecoder = (data) => {
  const event = decodeEvent(data);
  return event?.type === "Swap" ? null : event;
};

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

it("keeps a transaction whose event the decoder does not know, and indexes it with reindexTransactions once the decoder learns it", async () => {
  const older = pipelineHandler({ decode: withoutSwaps, decoderVersion: DECODER_VERSION - 1 });
  expect((await indexTransactions(client.db, older, [swap])).counts).toEqual({ unknownEvents: 1 });
  expect(await client.db.select().from(trades)).toEqual([]);
  const [kept] = await client.db.select().from(indexedTransactions).where(eq(indexedTransactions.signature, signature));
  expect(kept).toMatchObject({ decoderVersion: DECODER_VERSION - 1, unknownEvents: 1 });
  expect(kept!.raw).toEqual(swap);

  // Code that knows swaps reads again what older code could not, and nothing else.
  const result = await reindexUnknown(client.db, pipelineHandler());
  expect(result.counts).toEqual({ trades: 1 });
  expect(await client.db.select({ signature: trades.signature, eventIndex: trades.eventIndex, received: trades.received }).from(trades)).toEqual([
    { signature, eventIndex: 0, received: "25056506296415" },
  ]);
  const [now] = await client.db.select().from(indexedTransactions).where(eq(indexedTransactions.signature, signature));
  expect(now).toMatchObject({ decoderVersion: DECODER_VERSION, unknownEvents: 0, raw: null });

  // Once known, there is nothing left to read again.
  expect((await reindexUnknown(client.db, pipelineHandler())).counts).toEqual({});
});

it("keeps a transaction's record when reading it again fails", async () => {
  const older = pipelineHandler({ decode: withoutSwaps, decoderVersion: DECODER_VERSION - 1 });
  await client.db.delete(trades);
  await client.db.delete(indexedTransactions);
  await indexTransactions(client.db, older, [swap]);
  const failing: typeof older = async () => {
    throw new Error("the handler failed");
  };
  await expect(reindexUnknown(client.db, failing)).rejects.toThrow("the handler failed");
  const [kept] = await client.db.select().from(indexedTransactions).where(eq(indexedTransactions.signature, signature));
  expect(kept).toMatchObject({ decoderVersion: DECODER_VERSION - 1, unknownEvents: 1, raw: swap });
});
