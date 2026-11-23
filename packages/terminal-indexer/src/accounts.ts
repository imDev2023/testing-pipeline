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
import { AUTHOR_TEXT_CAPS, authorText } from "terminal-explainer";
import { rpcCall } from "./rpc";

/** Metaplex's Token Metadata program, whose PDA per mint holds most classic tokens' names. */
export const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
/** The most accounts one `getMultipleAccounts` reads. */
const ACCOUNTS_PER_CALL = 100;
/** The most mints one statement writes: 16 columns each, well inside Postgres's 65,535 parameters. */
const MINTS_PER_WRITE = 500;

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

/** A Borsh string (a little-endian u32 length, then UTF-8) at `offset`, with where the next field starts; null past the end. */
function borshStringAt(data: Uint8Array, offset: number): { value: string; next: number } | null {
  if (offset + 4 > data.length) return null;
  const length = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);
  const end = offset + 4 + length;
  if (end > data.length) return null;
  return { value: new TextDecoder().decode(data.subarray(offset + 4, end)), next: end };
}

/** A Metaplex metadata account's name, symbol and URI: after its key, update authority and mint, each a Borsh string Metaplex pads with NULs. */
function metaplexName(data: Uint8Array): { name: string; symbol: string; uri: string } | null {
  const name = borshStringAt(data, 65);
  const symbol = name && borshStringAt(data, name.next);
  const uri = symbol && borshStringAt(data, symbol.next);
  return uri ? { name: name.value, symbol: symbol.value, uri: uri.value } : null;
}

/**
 * A token's own name, as Aviary keeps it: from its Token-2022 token metadata extension, or else its
 * Metaplex metadata account; the symbol and name as the author-text normaliser leaves them, since
 * they are an author's claim (EXPLAINER-08, PIPESCOPE-122), and the URI without the NULs and spaces
 * around it. Each is null when empty.
 */
export function tokenName(fromMint: { name: string; symbol: string; uri: string } | undefined, metaplex: Uint8Array | null): { symbol: string | null; name: string | null; tokenUri: string | null } {
  const found = fromMint ?? (metaplex ? metaplexName(metaplex) : null);
  if (!found) return { symbol: null, name: null, tokenUri: null };
  const clean = (value: string) => value.replaceAll("\0", "");
  const symbol = authorText(clean(found.symbol), AUTHOR_TEXT_CAPS.symbol).text;
  const name = authorText(clean(found.name), AUTHOR_TEXT_CAPS.name).text;
  const uri = clean(found.uri).trim();
  return { symbol: symbol || null, name: name || null, tokenUri: uri || null };
}

/**
 * Reads again the state and vaults of each market named, after events touched them; the first time,
 * the router's `Market` account too, for the vaults, the fee mint and exact-out support. Then reads
 * every mint of those markets not read before. Returns how many mints it read.
 */
export async function refreshMarkets(db: Db, rpcUrl: string, marketAddresses: string[]): Promise<{ mintsRead: number }> {
  if (!marketAddresses.length) return { mintsRead: 0 };
  const known = await db.select({ address: markets.address, marketState: markets.marketState }).from(markets).where(inArray(markets.address, marketAddresses));
  if (!known.length) return { mintsRead: 0 };
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

  return { mintsRead: await readNewMints(db, rpcUrl, [...new Set(held.map((h) => h.mint))]) };
}

/**
 * Reads each mint not read before, with its Metaplex metadata account, and any read before its
 * trust flags were kept; the hourly `refreshMints` reads them all again. Returns how many it read.
 */
export async function readNewMints(db: Db, rpcUrl: string, mintAddresses: string[]): Promise<number> {
  if (!mintAddresses.length) return 0;
  const seen = new Set((await db.select({ address: mints.address }).from(mints).where(and(inArray(mints.address, mintAddresses), isNotNull(mints.flags)))).map((r) => r.address));
  const due = [...new Set(mintAddresses.filter((m) => !seen.has(m)))];
  await readMints(db, rpcUrl, due);
  return due.length;
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
 * a transfer fee in force), and with its token's own name; an account that is no mint is kept
 * unreadable, with `mint-unreadable`.
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
    const metadataBytes = metadataInfo && metadataInfo.owner === METADATA_PROGRAM ? bytesOf(metadataInfo) : null;
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
      ...(readable ? tokenName(decoded?.extensions.tokenMetadata, metadataBytes) : { symbol: null, name: null, tokenUri: null }),
    };
  });
  const set = Object.fromEntries(
    (["readable", "tokenProgram", "decimals", "supply", "mintAuthority", "freezeAuthority", "data", "metadataData", "readSlot", "flags", "readEpoch", "symbol", "name", "tokenUri"] as const).map((k) => [k, sql.raw(`excluded.${mints[k].name}`)]),
  );
  // In parts, so a refresh of every mint never makes one statement too large to build or to send.
  for (let i = 0; i < rows.length; i += MINTS_PER_WRITE) {
    await db.insert(mints).values(rows.slice(i, i + MINTS_PER_WRITE)).onConflictDoUpdate({ target: mints.address, set });
  }
}
