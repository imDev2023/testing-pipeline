// Market accounts and mints (docs/spec/pipescope-architecture.md, Indexer): after an event touches a
// market its state and vaults are read again, and a mint is read once, when a market first brings it.
import { readFileSync } from "node:fs";
import { encodeAccount, getMarketCodec, PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { address, getAddressEncoder } from "@solana/kit";
import { eq, sql } from "drizzle-orm";
import { createDb, marketMints, markets, mints, type Db } from "terminal-db";
import { getTaxMarketEncoder, MarketStatus, type TaxMarketArgs } from "tax-amm-scripts/client/index.ts";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { indexTransactions, metadataAddress, pipelineHandler, refreshMarkets, refreshMints, type RawTransaction } from "../src/index";
import { fakeRpc, type FakeRpc } from "./fakeRpc";
import { programAddress } from "./programs";

const created = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/marketCreated.json`, "utf8")) as RawTransaction;
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const STATE = "EE3ifuzvJGAtcY6xTxxr26ezaXG1cethHvA52R3r6x1U";
const TOKEN = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";
const WSOL = "So11111111111111111111111111111111111111112";
const VAULTS = ["2yLyoJtMyVYu7G1uMCr8mJKzVZj53fFHrJ8Fzb5iT6st", "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2"];
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const AUTHORITY = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";
const DEFAULT = "11111111111111111111111111111111";

const addressBytes = (a: string) => getAddressEncoder().encode(address(a));

/** A tax market's state, seeded and open, with the reserves and owed amounts given. */
function taxMarket({ reserves, owed }: { reserves: bigint[]; owed: bigint[] }): TaxMarketArgs {
  const zero = address(DEFAULT);
  return {
    version: 1,
    status: MarketStatus.Open,
    taxSide: 1,
    virtualSide: 0,
    authorityBump: 255,
    taxAuthorityRenounced: false,
    mints: [address(TOKEN), address(WSOL)],
    vaults: [address(VAULTS[0]!), address(VAULTS[1]!)],
    marketSigner: address(MARKET),
    buyTaxBps: 300,
    sellTaxBps: 500,
    buyTaxMinBps: 0,
    buyTaxMaxBps: 1000,
    sellTaxMinBps: 0,
    sellTaxMaxBps: 1000,
    taxAuthority: address(AUTHORITY),
    seeder: address(AUTHORITY),
    recipients: [address(AUTHORITY), zero, zero, zero],
    shares: [10_000, 0, 0, 0],
    burnShareBps: 0,
    virtualReserve: 0n,
    reserves,
    owed,
    taxCollected: owed.reduce((a, b) => a + b, 0n),
    volume: [0n, 0n],
    swapCount: 3n,
    createdSlot: 525_100_000n,
    createdAt: 1_795_000_000n,
    pendingBuyTaxBps: 0,
    pendingSellTaxBps: 0,
    pendingFromSlot: 0n,
    reserved: new Uint8Array(52),
  };
}

/** A token account holding `amount`, as both token programs lay out its first 165 bytes. */
function tokenAccount(mint: string, amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  data.set(addressBytes(mint), 0);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return data;
}

/** A mint account: supply, decimals, and the two authorities as `COption`s. */
function mintAccount({ supply, decimals, mintAuthority, freezeAuthority }: { supply: bigint; decimals: number; mintAuthority: string | null; freezeAuthority: string | null }): Uint8Array {
  const data = new Uint8Array(82);
  const view = new DataView(data.buffer);
  if (mintAuthority) {
    view.setUint32(0, 1, true);
    data.set(addressBytes(mintAuthority), 4);
  }
  view.setBigUint64(36, supply, true);
  data[44] = decimals;
  data[45] = 1;
  if (freezeAuthority) {
    view.setUint32(46, 1, true);
    data.set(addressBytes(freezeAuthority), 50);
  }
  return data;
}

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
let rpc: FakeRpc;
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
  rpc = await fakeRpc();
  const market = encodeAccount("Market", getMarketCodec(), {
    strategyProgram: address(STRATEGY),
    marketState: address(STATE),
    mintCount: 2,
    mints: [address(TOKEN), address(WSOL), address(DEFAULT), address(DEFAULT)],
    vaults: [address(VAULTS[0]!), address(VAULTS[1]!), address(DEFAULT), address(DEFAULT)],
    supportsExactOut: false,
    createdBy: address(AUTHORITY),
    createdAt: BigInt(created.blockTime!),
    bump: 255,
    feeAuthorityBump: 254,
    feeMintIndex: 1,
  });
  rpc.accounts.set(MARKET, { owner: PIPELINE_PROGRAM_ADDRESS, data: market });
  rpc.accounts.set(STATE, { owner: STRATEGY, data: Uint8Array.from([1, 2, 3, 4]) });
  rpc.accounts.set(VAULTS[0]!, { owner: TOKEN_2022, data: tokenAccount(TOKEN, 774_943_493_703_585n) });
  rpc.accounts.set(VAULTS[1]!, { owner: TOKEN_PROGRAM, data: tokenAccount(WSOL, 30_000_000_000n) });
  rpc.accounts.set(TOKEN, { owner: TOKEN_2022, data: mintAccount({ supply: 10n ** 15n, decimals: 6, mintAuthority: AUTHORITY, freezeAuthority: null }) });
  rpc.accounts.set(WSOL, { owner: TOKEN_PROGRAM, data: mintAccount({ supply: 0n, decimals: 9, mintAuthority: null, freezeAuthority: null }) });
  rpc.accounts.set(await metadataAddress(TOKEN), { owner: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s", data: Uint8Array.from([4, 5, 6]) });
  await indexTransactions(client.db, pipelineHandler({ candleSeconds: [] }), [created]);
});
afterAll(async () => {
  await rpc?.close();
  await client?.close();
  await database?.drop();
});

it("reads a new market's vaults, its state and what each vault holds, and each of its mints", async () => {
  await refreshMarkets(client.db, rpc.url, [MARKET]);
  const [market] = await client.db.select().from(markets).where(eq(markets.address, MARKET));
  expect(market).toMatchObject({ supportsExactOut: false, feeMint: WSOL, stateData: Buffer.from([1, 2, 3, 4]).toString("base64"), readSlot: 525_200_000n });
  const held = await client.db.select().from(marketMints).where(eq(marketMints.market, MARKET)).orderBy(marketMints.position);
  expect(held.map(({ mint, vault, vaultAmount }) => ({ mint, vault, vaultAmount }))).toEqual([
    { mint: TOKEN, vault: VAULTS[0], vaultAmount: "774943493703585" },
    { mint: WSOL, vault: VAULTS[1], vaultAmount: "30000000000" },
  ]);
  const read = await client.db.select().from(mints).orderBy(mints.address);
  expect(read).toEqual([
    {
      address: TOKEN,
      readable: true,
      tokenProgram: TOKEN_2022,
      decimals: 6,
      supply: "1000000000000000",
      mintAuthority: AUTHORITY,
      freezeAuthority: null,
      data: Buffer.from(rpc.accounts.get(TOKEN)!.data).toString("base64"),
      metadataData: Buffer.from([4, 5, 6]).toString("base64"),
      readSlot: 525_200_000n,
      flags: ["token-2022", "mint-authority"],
      readEpoch: 812n,
      // Its Metaplex account is three bytes, no metadata, so it names no token.
      symbol: null,
      name: null,
      tokenUri: null,
    },
    expect.objectContaining({ address: WSOL, readable: true, tokenProgram: TOKEN_PROGRAM, decimals: 9, supply: "0", mintAuthority: null, metadataData: null, flags: [], readEpoch: 812n }),
  ]);
});

it("reads the state and vaults again after the next event, and never the mints or the market's account again", async () => {
  rpc.accounts.set(VAULTS[1]!, { owner: TOKEN_PROGRAM, data: tokenAccount(WSOL, 31_000_000_000n) });
  rpc.requests.length = 0;
  await refreshMarkets(client.db, rpc.url, [MARKET]);
  const [sol] = await client.db.select().from(marketMints).where(eq(marketMints.vault, VAULTS[1]!));
  expect(sol?.vaultAmount).toBe("31000000000");
  const asked = rpc.requests.flatMap((r) => (r.method === "getMultipleAccounts" ? (r.params[0] as string[]) : []));
  expect(asked).toEqual([STATE, ...VAULTS].sort());
});

it("keeps a tax market's real reserves beside what its vaults hold, since its tax-side vault also holds tax not yet paid out (PIPESCOPE-166)", async () => {
  const state = getTaxMarketEncoder().encode(taxMarket({ reserves: [770_000_000_000_000n, 29_000_000_000n], owed: [400_000_000n, 0n, 0n, 0n, 0n, 100_000_000n] }));
  rpc.accounts.set(STATE, { owner: STRATEGY, data: new Uint8Array(state) });
  await refreshMarkets(client.db, rpc.url, [MARKET]);
  const held = await client.db.select().from(marketMints).where(eq(marketMints.market, MARKET)).orderBy(marketMints.position);
  expect(held.map(({ mint, vaultAmount, reserve }) => ({ mint, vaultAmount, reserve }))).toEqual([
    { mint: TOKEN, vaultAmount: "774943493703585", reserve: "770000000000000" },
    { mint: WSOL, vaultAmount: "31000000000", reserve: "29000000000" },
  ]);

  // A state its strategy's reader cannot decode, or a strategy with none, keeps no reserve: what the vault holds is its liquidity.
  rpc.accounts.set(STATE, { owner: STRATEGY, data: Uint8Array.from([1, 2, 3, 4]) });
  await refreshMarkets(client.db, rpc.url, [MARKET]);
  const unread = await client.db.select({ reserve: marketMints.reserve }).from(marketMints).where(eq(marketMints.market, MARKET));
  expect(unread.map((r) => r.reserve)).toEqual([null, null]);
});

it("keeps a mint whose account is missing as unreadable", async () => {
  const missing = "Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe";
  await client.db.update(marketMints).set({ mint: missing }).where(eq(marketMints.mint, TOKEN));
  await refreshMarkets(client.db, rpc.url, [MARKET]);
  const [row] = await client.db.select().from(mints).where(eq(mints.address, missing));
  expect(row).toMatchObject({ readable: false, tokenProgram: null, decimals: null, flags: ["mint-unreadable"] });
});

it("reads again a mint read before its flags were kept", async () => {
  await client.db.update(mints).set({ flags: null }).where(eq(mints.address, WSOL));
  await refreshMarkets(client.db, rpc.url, [MARKET]);
  const [row] = await client.db.select().from(mints).where(eq(mints.address, WSOL));
  expect(row?.flags).toEqual([]);
});

it("reads every mint again on the hourly refresh, so an authority given up or a freeze authority set shows", async () => {
  rpc.accounts.set(WSOL, { owner: TOKEN_PROGRAM, data: mintAccount({ supply: 5n, decimals: 9, mintAuthority: null, freezeAuthority: AUTHORITY }) });
  rpc.epoch = 813;
  rpc.slot = 525_300_000;
  rpc.requests.length = 0;
  expect(await refreshMints(client.db, rpc.url)).toBe(3);
  const [row] = await client.db.select().from(mints).where(eq(mints.address, WSOL));
  expect(row).toMatchObject({ supply: "5", freezeAuthority: AUTHORITY, flags: ["freeze-authority"], readEpoch: 813n, readSlot: 525_300_000n });
  // One read of the mints and their metadata accounts, and one of the epoch.
  expect(rpc.requests.map((r) => r.method).sort()).toEqual(["getEpochInfo", "getMultipleAccounts"]);
});

it("reads more mints than one statement of Postgres can write, in parts", async () => {
  // 12,000 mints of 13 columns each are past what one statement can be built with, or sent as (65,535 parameters).
  const many = await Promise.all(Array.from({ length: 12_000 }, (_, i) => programAddress(10_000 + i)));
  for (let i = 0; i < many.length; i += 1_000) await client.db.insert(mints).values(many.slice(i, i + 1_000).map((address) => ({ address, readable: false })));
  expect(await refreshMints(client.db, rpc.url)).toBe(12_000 + 3);
  const [{ count }] = (await client.db.execute<{ count: number }>(sql`select count(*)::int as count from mints where flags = array['mint-unreadable']`)) as unknown as [{ count: number }];
  expect(count).toBeGreaterThanOrEqual(12_000);
}, 60_000);
