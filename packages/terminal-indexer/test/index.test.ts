// Indexing Pipeline's router history: real devnet transactions (test/fixtures, read from devnet on
// 2026-11-22) indexed into a throwaway database, read back as the API reads them.
import { readFileSync } from "node:fs";
import { encodeEvent, PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { address, getBase58Decoder } from "@solana/kit";
import { eq } from "drizzle-orm";
import { createDb, indexedTransactions, marketMints, markets, strategies, trades, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountKeysOf, indexTransactions, pipelineHandler, type RawTransaction } from "../src/index";

const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/${name}.json`, "utf8")) as RawTransaction;

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

describe("indexing a swap", () => {
  it("writes its trade, keyed by signature and event index, with its slot and place in the block", async () => {
    const swap = fixture("swap");
    await indexTransactions(client.db, pipelineHandler(), [swap]);
    const rows = await client.db.select().from(trades);
    expect(rows).toEqual([
      {
        signature: "vcAWCGRS1TG4da1kKiPKnbxnJv2KsygWqCqRGYAffZxNVpySfQk3mqXDP3RetvugDs33nUTs8Yju3eiLoKycNHy",
        eventIndex: 0,
        slot: 525139941n,
        blockIndex: 4,
        blockTime: new Date(swap.blockTime! * 1000),
        market: "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz",
        strategy: "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t",
        trader: "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt",
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX",
        mode: 0,
        netSent: "1000000000",
        received: "25056506296415",
        pipelineFee: "2500000",
        feeMint: "So11111111111111111111111111111111111111112",
        integrator: null,
        integratorFee: "0",
        unixTimestamp: BigInt(swap.blockTime!),
      },
    ]);
  });
});

describe("indexing registrations and new markets", () => {
  it("writes the strategy from its StrategyRegistered event, with the listing fee paid", async () => {
    const registered = fixture("registered");
    const result = await indexTransactions(client.db, pipelineHandler(), [registered]);
    expect(result.counts).toEqual({ strategies: 1 });
    const [row] = await client.db.select().from(strategies).where(eq(strategies.program, "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t"));
    expect(row).toMatchObject({
      feePaid: "10000000",
      registeredAt: new Date(registered.blockTime! * 1000),
      registeredSlot: 524204494n,
      registeredSignature: registered.transaction.signatures[0],
    });
    expect(row!.metadataUri).toMatch(/^https:\/\//);
  });

  it("writes the market from its MarketCreated event, with its mints in the market's own order, and names it to be read", async () => {
    const created = fixture("marketCreated");
    const result = await indexTransactions(client.db, pipelineHandler(), [created]);
    expect(result).toEqual({ counts: { markets: 1 }, markets: ["7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz"], trades: [] });
    const [market] = await client.db.select().from(markets).where(eq(markets.address, "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz"));
    expect(market).toMatchObject({
      strategyProgram: "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t",
      marketState: "EE3ifuzvJGAtcY6xTxxr26ezaXG1cethHvA52R3r6x1U",
      createdBy: "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt",
      createdAt: new Date(created.blockTime! * 1000),
      createdSlot: 525139858n,
    });
    const mints = await client.db.select().from(marketMints).where(eq(marketMints.market, market!.address)).orderBy(marketMints.position);
    expect(mints.map((m) => m.mint)).toEqual(["5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX", "So11111111111111111111111111111111111111112"]);
  });

  it("numbers each event of a transaction by its place, so a market created and swapped at once keeps both", async () => {
    const multi = fixture("multiEvent");
    const result = await indexTransactions(client.db, pipelineHandler(), [multi]);
    expect(result.counts).toEqual({ markets: 1, trades: 1 });
    const rows = await client.db.select().from(trades).where(eq(trades.signature, multi.transaction.signatures[0]!));
    expect(rows.map((t) => t.eventIndex)).toEqual([1]);
  });
});

describe("indexing is idempotent", () => {
  it("writes a transaction once, however often it arrives", async () => {
    const swap = fixture("swap");
    const again = await indexTransactions(client.db, pipelineHandler(), [swap, swap]);
    expect(again.counts).toEqual({});
    expect(await client.db.select().from(trades).where(eq(trades.signature, swap.transaction.signatures[0]!))).toHaveLength(1);
  });

  it("writes nothing for a failed transaction, which changed nothing", async () => {
    const failed = fixture("failed");
    expect((await indexTransactions(client.db, pipelineHandler(), [failed])).counts).toEqual({});
    expect(await client.db.select().from(indexedTransactions).where(eq(indexedTransactions.signature, failed.transaction.signatures[0]!))).toEqual([]);
  });
});

describe("a strategy's metadata URI", () => {
  /** The real MetadataUpdated transaction, its event re-encoded for the strategy above with another URI and slot. */
  function metadataUpdate(uri: string, slot: number): RawTransaction {
    const raw = structuredClone(fixture("metadataUpdated"));
    const keys = accountKeysOf(raw);
    const data = getBase58Decoder().decode(encodeEvent({ type: "MetadataUpdated", data: { strategy: address("J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t"), metadataUri: uri } }));
    for (const group of raw.meta!.innerInstructions!) for (const ix of group.instructions) if (keys[ix.programIdIndex] === PIPELINE_PROGRAM_ADDRESS) ix.data = data;
    raw.slot = slot;
    raw.transaction.signatures[0] = `${raw.transaction.signatures[0]!.slice(0, 80)}${slot}`;
    return raw;
  }
  const uri = async () => (await client.db.select().from(strategies).where(eq(strategies.program, "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t")))[0]!.metadataUri;

  it("follows MetadataUpdated, and an older update indexed later never overwrites a newer one", async () => {
    await indexTransactions(client.db, pipelineHandler(), [metadataUpdate("https://example.org/newer.json", 525_000_002)]);
    expect(await uri()).toBe("https://example.org/newer.json");
    await indexTransactions(client.db, pipelineHandler(), [metadataUpdate("https://example.org/older.json", 525_000_001)]);
    expect(await uri()).toBe("https://example.org/newer.json");
  });
});
