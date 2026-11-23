// Token names (docs/spec/pipescope.md, "Tokens and prices"; PIPESCOPE-22): each mint's symbol, name
// and metadata URI are read with the mint, from its Token-2022 token metadata extension or else its
// Metaplex metadata account, and kept as the author-text normaliser leaves them, since they are an
// author's claim like a strategy's name.
import { readFileSync } from "node:fs";
import { address, getAddressEncoder } from "@solana/kit";
import { eq } from "drizzle-orm";
import { createDb, mints, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { metadataAddress, METADATA_PROGRAM, readNewMints, refreshMints } from "../src/index";
import { fakeRpc, type FakeRpc } from "./fakeRpc";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const AUTHORITY = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";

// A devnet mint that names itself through Token-2022's token metadata, as devnet served it.
const dream = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/mintPipeDream.json`, "utf8")) as { address: string; owner: string; data: string };
const CLASSIC = "Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe";
const HOSTILE = "2SCfx1zDwpiWh9DUSjp4nXtbMrVTzqK1tNKhP5ktQipk";
const NAMELESS = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";

const addressBytes = (a: string) => getAddressEncoder().encode(address(a));
const u32 = (n: number) => Uint8Array.from([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]);
const borshString = (s: string, padTo = 0) => {
  const bytes = new TextEncoder().encode(s);
  const padded = new Uint8Array(Math.max(bytes.length, padTo));
  padded.set(bytes);
  return [...u32(padded.length), ...padded];
};

/** A mint's first 82 bytes: no authorities, a supply, its decimals, initialised. */
function baseMint(): Uint8Array {
  const data = new Uint8Array(82);
  new DataView(data.buffer).setBigUint64(36, 1_000n, true);
  data[44] = 6;
  data[45] = 1;
  return data;
}

/** A Token-2022 mint whose token metadata extension (type 19) holds the name, symbol and URI given. */
function token2022Mint(mint: string, { name, symbol, uri }: { name: string; symbol: string; uri: string }): Uint8Array {
  const value = Uint8Array.from([...addressBytes(AUTHORITY), ...addressBytes(mint), ...borshString(name), ...borshString(symbol), ...borshString(uri), ...u32(0)]);
  const data = new Uint8Array(166 + 4 + value.length);
  data.set(baseMint());
  data[165] = 1; // the account type: a mint
  data.set([19, 0, value.length & 255, value.length >> 8], 166);
  data.set(value, 170);
  return data;
}

/** A Metaplex metadata account: its key, update authority and mint, then name, symbol and URI padded with NULs as Metaplex writes them. */
function metaplexMetadata(mint: string, { name, symbol, uri }: { name: string; symbol: string; uri: string }): Uint8Array {
  return Uint8Array.from([4, ...addressBytes(AUTHORITY), ...addressBytes(mint), ...borshString(name, 32), ...borshString(symbol, 10), ...borshString(uri, 200), 0, 0]);
}

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
let rpc: FakeRpc;
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
  rpc = await fakeRpc();
  rpc.accounts.set(dream.address, { owner: dream.owner, data: Uint8Array.from(Buffer.from(dream.data, "base64")) });
  rpc.accounts.set(CLASSIC, { owner: TOKEN_PROGRAM, data: baseMint() });
  rpc.accounts.set(await metadataAddress(CLASSIC), { owner: METADATA_PROGRAM, data: metaplexMetadata(CLASSIC, { name: "Classic Coin", symbol: "CLSC", uri: "https://example.com/classic.json" }) });
  rpc.accounts.set(HOSTILE, { owner: TOKEN_2022, data: token2022Mint(HOSTILE, { name: "Real‮SOL​\u0007 Coin  ", symbol: "  SO‍L\tUSDC-and-then-some-more  ", uri: " https://example.com/h.json\u0000 " }) });
  rpc.accounts.set(NAMELESS, { owner: TOKEN_2022, data: baseMint() });
});
afterAll(async () => {
  await rpc?.close();
  await client?.close();
  await database?.drop();
});

const read = async (mint: string) => (await client.db.select({ symbol: mints.symbol, name: mints.name, tokenUri: mints.tokenUri }).from(mints).where(eq(mints.address, mint)))[0];

it("reads a devnet mint's symbol, name and URI from its Token-2022 token metadata", async () => {
  await readNewMints(client.db, rpc.url, [dream.address]);
  expect(await read(dream.address)).toEqual({ symbol: "DREAM", name: "Pipe Dream", tokenUri: "https://ipfs.io/ipfs/QmdznmJXTyhKAJdzMUrchXaHxtuRs97n9YzF4geW8EeMZW" });
});

it("reads a classic mint's name from its Metaplex metadata account, without the NULs that pad it", async () => {
  await readNewMints(client.db, rpc.url, [CLASSIC]);
  expect(await read(CLASSIC)).toEqual({ symbol: "CLSC", name: "Classic Coin", tokenUri: "https://example.com/classic.json" });
});

it("keeps an author's name as the normaliser leaves it: no control, direction or zero-width characters, and capped", async () => {
  await readNewMints(client.db, rpc.url, [HOSTILE]);
  expect(await read(HOSTILE)).toEqual({ symbol: "SOL USDC-and-the", name: "RealSOL Coin", tokenUri: "https://example.com/h.json" });
});

it("keeps no name for a mint with no metadata", async () => {
  await readNewMints(client.db, rpc.url, [NAMELESS]);
  expect(await read(NAMELESS)).toEqual({ symbol: null, name: null, tokenUri: null });
});

it("reads a changed name on the hourly refresh", async () => {
  rpc.accounts.set(NAMELESS, { owner: TOKEN_2022, data: token2022Mint(NAMELESS, { name: "Late Name", symbol: "LATE", uri: "" }) });
  await refreshMints(client.db, rpc.url);
  expect(await read(NAMELESS)).toEqual({ symbol: "LATE", name: "Late Name", tokenUri: null });
});
