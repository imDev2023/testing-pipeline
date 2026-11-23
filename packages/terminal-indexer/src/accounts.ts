// Market accounts and mints (docs/spec/pipescope-architecture.md, Indexer, "Market accounts" and
// "Mints"). There are no account subscriptions: after each event that touches a market, its state
// and its vaults are read again; the router's `Market` account, which names the vaults, is read
// once; and each mint is read when a market first brings it, with its Metaplex metadata account, as
// raw bytes for the token names that later read them and with Pipeline's trust flags, then again
// every hour (`refreshMints`), since a mint's authorities, supply and extensions can change.
import { decodeMarket, decodeMint, marketFeeMint, type Flag } from "@pipeline-sol/sdk";
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, getUtf8Encoder } from "@solana/kit";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { marketMints, markets, mints, type Db } from "terminal-db";
import { rpcCall } from "./rpc";

/** Metaplex's Token Metadata program, whose PDA per mint holds most classic tokens' names. */
export const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
/** The most accounts one `getMultipleAccounts` reads. */
const ACCOUNTS_PER_CALL = 100;

type AccountInfo = { owner: string; data: [string, "base64"] } | null;

/** A mint's Metaplex metadata account: the PDA `["metadata", program, mint]`. */
export async function metadataAddress(mint: string): Promise<string> {
  const program = address(METADATA_PROGRAM);
  const [pda] = await getProgramDerivedAddress({
    programAddress: program,
    seeds: [getUtf8Encoder().encode("metadata"), getAddressEncoder().encode(program), getAddressEncoder().encode(address(mint))],
  });
  return pda;
}

/**
 * Reads accounts in as few `getMultipleAccounts` calls as it can, with the slot they were read at.
 * The addresses are asked for sorted, so the same accounts make the same requests whatever order
 * Postgres listed them in (CI replays recorded answers keyed by each request, PIPESCOPE-102).
 */
async function readAccounts(rpcUrl: string, wanted: string[]): Promise<{ slot: bigint; accounts: Map<string, AccountInfo> }> {
  const addresses = [...new Set(wanted)].sort();
  const accounts = new Map<string, AccountInfo>();
  let slot = 0n;
  for (let i = 0; i < addresses.length; i += ACCOUNTS_PER_CALL) {
    const chunk = addresses.slice(i, i + ACCOUNTS_PER_CALL);
    const answer = await rpcCall<{ context: { slot: number }; value: AccountInfo[] }>(rpcUrl, "getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
    slot = BigInt(answer.context.slot);
    chunk.forEach((a, j) => accounts.set(a, answer.value[j] ?? null));
  }
  return { slot, accounts };
}

const bytesOf = (info: AccountInfo) => (info ? Uint8Array.from(Buffer.from(info.data[0], "base64")) : null);
const u64At = (data: Uint8Array, offset: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true);
const addressDecoder = getAddressDecoder();
/** A `COption<Pubkey>`: a four-byte tag, then the address. */
const optionalAddressAt = (data: Uint8Array, offset: number) => (data[offset] === 1 ? addressDecoder.decode(data.subarray(offset + 4, offset + 36)) : null);

/**
 * Reads again the state and vaults of each market named, after events touched them; the first time,
 * the router's `Market` account too, for the vaults, the fee mint and exact-out support. Then reads
 * every mint of those markets not read before.
 */
export async function refreshMarkets(db: Db, rpcUrl: string, marketAddresses: string[]): Promise<void> {
  if (!marketAddresses.length) return;
  const known = await db.select({ address: markets.address, marketState: markets.marketState }).from(markets).where(inArray(markets.address, marketAddresses));
  if (!known.length) return;
  const addresses = known.map((m) => m.address);

  // The router's Market account, once per market: it names the vaults.
  const unread = [...new Set((await db.select({ market: marketMints.market }).from(marketMints).where(and(inArray(marketMints.market, addresses), isNull(marketMints.vault)))).map((r) => r.market))];
  if (unread.length) {
    const { accounts } = await readAccounts(rpcUrl, unread);
    for (const market of unread) {
      const data = bytesOf(accounts.get(market) ?? null);
      const decoded = data && decodeMarket(data);
      if (!decoded) continue;
      await db.transaction(async (tx) => {
        await tx.update(markets).set({ supportsExactOut: decoded.supportsExactOut, feeMint: marketFeeMint(decoded) }).where(eq(markets.address, market));
        for (let position = 0; position < decoded.mintCount; position++) {
          await tx
            .insert(marketMints)
            .values({ market, position, mint: decoded.mints[position]!, vault: decoded.vaults[position]! })
            .onConflictDoUpdate({ target: [marketMints.market, marketMints.position], set: { vault: decoded.vaults[position]! } });
        }
      });
    }
  }

  // Each market's state and vaults, in one read.
  const held = await db.select().from(marketMints).where(inArray(marketMints.market, addresses));
  const vaults = held.flatMap((h) => (h.vault ? [h.vault] : []));
  const { slot, accounts } = await readAccounts(rpcUrl, [...known.map((m) => m.marketState), ...vaults]);
  await db.transaction(async (tx) => {
    for (const m of known) {
      const info = accounts.get(m.marketState) ?? null;
      await tx.update(markets).set({ stateData: info ? info.data[0] : null, readSlot: slot }).where(eq(markets.address, m.address));
    }
    for (const h of held) {
      if (!h.vault) continue;
      const data = bytesOf(accounts.get(h.vault) ?? null);
      const amount = data && data.length >= 72 ? String(u64At(data, 64)) : null;
      await tx.update(marketMints).set({ vaultAmount: amount }).where(and(eq(marketMints.market, h.market), eq(marketMints.position, h.position)));
    }
  });

  await readNewMints(db, rpcUrl, [...new Set(held.map((h) => h.mint))]);
}

/**
 * Reads each mint not read before, with its Metaplex metadata account, and any read before its
 * trust flags were kept; the hourly `refreshMints` reads them all again.
 */
export async function readNewMints(db: Db, rpcUrl: string, mintAddresses: string[]): Promise<void> {
  if (!mintAddresses.length) return;
  const seen = new Set((await db.select({ address: mints.address }).from(mints).where(and(inArray(mints.address, mintAddresses), isNotNull(mints.flags)))).map((r) => r.address));
  await readMints(db, rpcUrl, mintAddresses.filter((m) => !seen.has(m)));
}

/**
 * Reads every mint again (the hourly job), so what can change after a mint is made shows on the
 * pages: an authority given up or handed on, a supply minted or burned, a transfer fee or a pause
 * set. Returns how many it read.
 */
export async function refreshMints(db: Db, rpcUrl: string): Promise<number> {
  const all = (await db.select({ address: mints.address }).from(mints)).map((r) => r.address);
  await readMints(db, rpcUrl, all);
  return all.length;
}

/**
 * Reads mints with their Metaplex metadata accounts in as few requests as it can, and keeps each
 * with Pipeline's trust flags, as its SDK's `decodeMint` gives them at the current epoch (which picks
 * a transfer fee in force); an account that is no mint is kept unreadable, with `mint-unreadable`.
 */
async function readMints(db: Db, rpcUrl: string, wanted: string[]): Promise<void> {
  const fresh = [...new Set(wanted)];
  if (!fresh.length) return;
  const metadata = await Promise.all(fresh.map(metadataAddress));
  const [{ slot, accounts }, { epoch }] = await Promise.all([readAccounts(rpcUrl, [...fresh, ...metadata]), rpcCall<{ epoch: number }>(rpcUrl, "getEpochInfo", [{ commitment: "confirmed" }])]);
  const rows = fresh.map((mint, i) => {
    const info = accounts.get(mint) ?? null;
    const data = bytesOf(info);
    const metadataInfo = accounts.get(metadata[i]!) ?? null;
    const readable = !!info && !!data && TOKEN_PROGRAMS.has(info.owner) && data.length >= 82 && data[45] === 1;
    const decoded = readable ? decodeMint(address(mint), address(info!.owner), data!, BigInt(epoch)) : null;
    return {
      address: mint,
      readable,
      tokenProgram: readable ? info!.owner : null,
      decimals: readable ? data![44]! : null,
      supply: readable ? String(u64At(data!, 36)) : null,
      mintAuthority: readable ? optionalAddressAt(data!, 0) : null,
      freezeAuthority: readable ? optionalAddressAt(data!, 46) : null,
      data: info ? info.data[0] : null,
      metadataData: metadataInfo && metadataInfo.owner === METADATA_PROGRAM ? metadataInfo.data[0] : null,
      readSlot: slot,
      flags: decoded ? decoded.flags : (["mint-unreadable"] satisfies Flag[]),
      readEpoch: BigInt(epoch),
    };
  });
  await db
    .insert(mints)
    .values(rows)
    .onConflictDoUpdate({
      target: mints.address,
      set: Object.fromEntries(
        (["readable", "tokenProgram", "decimals", "supply", "mintAuthority", "freezeAuthority", "data", "metadataData", "readSlot", "flags", "readEpoch"] as const).map((k) => [k, sql.raw(`excluded.${mints[k].name}`)]),
      ),
    });
}
