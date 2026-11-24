// The registry snapshot (docs/spec/pipescope-architecture.md, Indexer): `getProgramAccounts` on the
// router for `Strategy` and `Market` accounts; any not yet indexed is a missed event, indexed from
// its account.
import { readFileSync } from "node:fs";
import { encodeAccount, getMarketCodec, getStrategyCodec, PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { address } from "@solana/kit";
import { createDb, marketMints, markets, strategies, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { indexRegistry, indexTransactions, pipelineHandler, readRegistry, type RawTransaction } from "../src/index";
import { fakeRpc, type FakeRpc } from "./fakeRpc";

const registered = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/registered.json`, "utf8")) as RawTransaction;
const KNOWN_STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const MISSED_STRATEGY = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const MISSED_MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const DEFAULT = "11111111111111111111111111111111";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
let rpc: FakeRpc;
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
  rpc = await fakeRpc();
  const strategy = (program: string, registeredAt: bigint) =>
    encodeAccount("Strategy", getStrategyCodec(), { programId: address(program), metadataUri: `https://example.org/${program}.json`, interfaceVersion: 1, registeredAt, marketCount: 1n, bump: 255 });
  rpc.accounts.set("StrategyPdaOfKnown1111111111111111111111111", { owner: PIPELINE_PROGRAM_ADDRESS, data: strategy(KNOWN_STRATEGY, 1_795_000_000n) });
  rpc.accounts.set("StrategyPdaOfMissed111111111111111111111111", { owner: PIPELINE_PROGRAM_ADDRESS, data: strategy(MISSED_STRATEGY, 1_795_100_000n) });
  rpc.accounts.set(MISSED_MARKET, {
    owner: PIPELINE_PROGRAM_ADDRESS,
    data: encodeAccount("Market", getMarketCodec(), {
      strategyProgram: address(MISSED_STRATEGY),
      marketState: address("EE3ifuzvJGAtcY6xTxxr26ezaXG1cethHvA52R3r6x1U"),
      mintCount: 2,
      mints: [address(TOKEN), address(WSOL), address(DEFAULT), address(DEFAULT)],
      vaults: [address("2yLyoJtMyVYu7G1uMCr8mJKzVZj53fFHrJ8Fzb5iT6st"), address("8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2"), address(DEFAULT), address(DEFAULT)],
      supportsExactOut: true,
      createdBy: address("9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt"),
      createdAt: 1_795_200_000n,
      bump: 255,
      feeAuthorityBump: 254,
      feeMintIndex: 255,
    }),
  });
  await indexTransactions(client.db, pipelineHandler({ candleSeconds: [] }), [registered]);
});
afterAll(async () => {
  await rpc?.close();
  await client?.close();
  await database?.drop();
});

it("reads every registered strategy and market from the router's accounts", async () => {
  const registry = await readRegistry(rpc.url);
  expect(registry.strategies.map((s) => s.program).sort()).toEqual([KNOWN_STRATEGY, MISSED_STRATEGY].sort());
  expect(registry.markets.map((m) => m.address)).toEqual([MISSED_MARKET]);
});

it("indexes a strategy or market whose event was missed from its account, and leaves the indexed ones as they are", async () => {
  const registry = await readRegistry(rpc.url);
  const added = await indexRegistry(client.db, registry);
  expect(added).toEqual({ strategies: [MISSED_STRATEGY], markets: [MISSED_MARKET] });
  const rows = await client.db.select().from(strategies).orderBy(strategies.program);
  expect(rows).toEqual([
    expect.objectContaining({ program: MISSED_STRATEGY, feePaid: null, registeredAt: new Date(1_795_100_000_000), metadataUri: `https://example.org/${MISSED_STRATEGY}.json`, registeredSignature: null }),
    expect.objectContaining({ program: KNOWN_STRATEGY, feePaid: "10000000", registeredSignature: registered.transaction.signatures[0] }),
  ]);
  const [market] = await client.db.select().from(markets);
  expect(market).toMatchObject({ address: MISSED_MARKET, strategyProgram: MISSED_STRATEGY, createdAt: new Date(1_795_200_000_000), supportsExactOut: true, feeMint: null, createdSignature: null });
  const held = await client.db.select().from(marketMints).orderBy(marketMints.position);
  expect(held.map((h) => [h.mint, h.vault])).toEqual([
    [TOKEN, "2yLyoJtMyVYu7G1uMCr8mJKzVZj53fFHrJ8Fzb5iT6st"],
    [WSOL, "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2"],
  ]);
  expect(await indexRegistry(client.db, registry)).toEqual({ strategies: [], markets: [] });
});
