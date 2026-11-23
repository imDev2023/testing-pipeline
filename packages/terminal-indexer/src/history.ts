// Adapted from Top-pad b833a7b, packages/indexer/src/index.ts (`reconcileAccount`, the history
// source) and packages/indexer/src/live.ts (`blockPositions`); owned here since.
//
// Where the indexer reads an account's history (docs/spec/pipescope-architecture.md, Indexer,
// "Reconciliation"): through Helius's `getTransactionsForAddress` while the key gets it, which
// serves whole transactions oldest first with their place in the block, else through the standard
// `getSignaturesForAddress` and `getTransaction`, with the place in the block from `getBlock`. Both
// sit behind one interface, and reconciliation reads from a cursor through it.
import { eq, sql } from "drizzle-orm";
import { indexerCursors, type Db } from "terminal-db";
import type { RawTransaction } from "./decode";
import { addResult } from "./result";
import type { IndexResult, TransactionHandler } from "./handler";
import { RpcError, rpcCall } from "./rpc";

/** Where reconciliation stands on an account: the newest transaction it indexed, and its place in the chain. */
export type Cursor = { signature: string; slot: number; blockIndex: number | null };

export type HistorySource = {
  /**
   * Up to `limit` of the account's transactions after `cursor` (or from its first, with none),
   * oldest first, whole and with their place in the block, failed ones included. When a transaction
   * is listed but not served yet, the page ends before it, so nothing after it is handed over first.
   */
  after(account: string, cursor: Cursor | null, limit: number): Promise<{ transactions: RawTransaction[]; more: boolean }>;
  /** Whether the account has any transaction after `cursor`: one small request, so a quiet account costs almost nothing. */
  hasAfter(account: string, cursor: Cursor): Promise<boolean>;
};

const COMMITMENT = "confirmed";
/** The most whole transactions `getTransactionsForAddress` serves in one page. */
const HELIUS_FULL_PAGE = 100;

const signatureOf = (t: RawTransaction) => t.transaction.signatures[0]!;

/** Helius's `getTransactionsForAddress` (docs/spec/pipescope-architecture.md, Indexer): whole transactions, oldest first, each with its `transactionIndex`. */
export function heliusSource(rpcUrl: string): HistorySource {
  const token = (cursor: Cursor | null) => (cursor && cursor.blockIndex !== null ? { paginationToken: `${cursor.slot}:${cursor.blockIndex}` } : {});
  return {
    async after(account, cursor, limit) {
      if (cursor && cursor.blockIndex === null) throw new Error(`the cursor on ${account} has no place in its block, which getTransactionsForAddress needs`);
      const size = Math.min(limit, HELIUS_FULL_PAGE);
      const page = await rpcCall<{ data: RawTransaction[]; paginationToken: string | null }>(rpcUrl, "getTransactionsForAddress", [
        account,
        { transactionDetails: "full", sortOrder: "asc", limit: size, encoding: "json", maxSupportedTransactionVersion: 0, commitment: COMMITMENT, ...token(cursor) },
      ]);
      return { transactions: page.data, more: page.data.length === size && page.paginationToken !== null };
    },
    async hasAfter(account, cursor) {
      const page = await rpcCall<{ data: unknown[] }>(rpcUrl, "getTransactionsForAddress", [
        account,
        { transactionDetails: "signatures", sortOrder: "asc", limit: 1, commitment: COMMITMENT, ...token(cursor) },
      ]);
      return page.data.length > 0;
    },
  };
}

/** How many signatures one `getSignaturesForAddress` page lists. */
const SIGNATURE_PAGE = 1000;
/** How many transactions the standard source fetches at once. */
const FETCH_BATCH = 8;

/** The standard RPC methods, for an RPC without Helius's: signatures listed newest first, then each transaction fetched, its place in the block from `getBlock`. */
export function rpcSource(rpcUrl: string, blockIndexOf = blockPositions(rpcUrl)): HistorySource {
  const listAfter = async (account: string, cursor: Cursor | null) => {
    const listed: { signature: string; slot: number }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await rpcCall<{ signature: string; slot: number }[]>(rpcUrl, "getSignaturesForAddress", [
        account,
        { limit: SIGNATURE_PAGE, commitment: COMMITMENT, ...(cursor ? { until: cursor.signature } : {}), ...(before ? { before } : {}) },
      ]);
      listed.push(...page);
      if (page.length < SIGNATURE_PAGE) return listed.reverse();
      before = page.at(-1)!.signature;
    }
  };
  return {
    async after(account, cursor, limit) {
      const listed = await listAfter(account, cursor);
      const wanted = listed.slice(0, limit);
      const transactions: RawTransaction[] = [];
      for (let i = 0; i < wanted.length; i += FETCH_BATCH) {
        const batch = wanted.slice(i, i + FETCH_BATCH);
        const raws = await Promise.all(
          batch.map((s) =>
            rpcCall<RawTransaction | null>(rpcUrl, "getTransaction", [s.signature, { encoding: "json", commitment: COMMITMENT, maxSupportedTransactionVersion: 0 }]),
          ),
        );
        for (const [j, raw] of raws.entries()) {
          if (!raw) return { transactions, more: true };
          transactions.push({ ...raw, transactionIndex: await blockIndexOf(raw.slot, batch[j]!.signature) });
        }
      }
      return { transactions, more: listed.length > wanted.length };
    },
    async hasAfter(account, cursor) {
      const page = await rpcCall<unknown[]>(rpcUrl, "getSignaturesForAddress", [account, { limit: 1, commitment: COMMITMENT, until: cursor.signature }]);
      return page.length > 0;
    },
  };
}

/**
 * Helius's source while the key gets `getTransactionsForAddress`, and the standard one from the
 * first time the RPC says it has no such method.
 */
export function historySource(rpcUrl: string): HistorySource {
  const helius = heliusSource(rpcUrl);
  let standard: HistorySource | null = null;
  const pick = async <T>(call: (s: HistorySource) => Promise<T>): Promise<T> => {
    if (standard) return call(standard);
    try {
      return await call(helius);
    } catch (e) {
      if (!(e instanceof RpcError) || !e.methodMissing) throw e;
      console.warn("the RPC does not serve getTransactionsForAddress; reading history with getSignaturesForAddress and getTransaction");
      standard = rpcSource(rpcUrl);
      return call(standard);
    }
  };
  return { after: (...a) => pick((s) => s.after(...a)), hasAfter: (...a) => pick((s) => s.hasAfter(...a)) };
}

/**
 * A transaction's place in its block, read with `getBlock` (signatures only) and the blocks kept
 * for a while, since a busy minute puts several of the router's transactions in one block.
 */
export function blockPositions(rpcUrl: string, { cacheSlots = 64 } = {}) {
  const blocks = new Map<number, Promise<string[]>>();
  return async function blockIndexOf(slot: number, signature: string): Promise<number> {
    let block = blocks.get(slot);
    if (!block) {
      block = rpcCall<{ signatures: string[] } | null>(rpcUrl, "getBlock", [
        slot,
        { transactionDetails: "signatures", rewards: false, commitment: COMMITMENT, maxSupportedTransactionVersion: 0 },
      ]).then((b) => {
        if (!b) throw new Error(`block ${slot} was not served`);
        return b.signatures;
      });
      blocks.set(slot, block);
      block.catch(() => blocks.delete(slot));
      while (blocks.size > cacheSlots) blocks.delete(blocks.keys().next().value!);
    }
    const index = (await block).indexOf(signature);
    if (index < 0) throw new Error(`transaction ${signature} is not in block ${slot}`);
    return index;
  };
}

/** The account's cursor as Postgres holds it, or null before its first reconciliation. */
export async function readCursor(db: Db, account: string): Promise<Cursor | null> {
  const [row] = await db.select().from(indexerCursors).where(eq(indexerCursors.account, account)).limit(1);
  return row?.signature && row.slot !== null ? { signature: row.signature, slot: Number(row.slot), blockIndex: row.blockIndex } : null;
}

/** How many transactions one reconciliation page hands to the handler. */
const RECONCILE_PAGE = 100;

/**
 * Reconciliation: indexes the account's transactions after its cursor, oldest first, and moves the
 * cursor past each page once the page is indexed. A failed transaction changed nothing and is
 * passed over; one that cannot be indexed stops it there (the batch error is thrown), so the cursor
 * never moves past a transaction that was not indexed. `cursor` is where the caller knows it stands
 * (read from Postgres when not given); `limit` stops it after that many transactions, for a caller
 * that comes back, and `complete` says whether it reached the newest.
 */
export async function reconcileAccount(
  db: Db,
  source: HistorySource,
  handle: TransactionHandler,
  account: string,
  { cursor: known, limit = Infinity }: { cursor?: Cursor | null; limit?: number } = {},
): Promise<{ result: IndexResult; cursor: Cursor | null; complete: boolean }> {
  let cursor = known === undefined ? await readCursor(db, account) : known;
  const result: IndexResult = { counts: {}, markets: [] };
  let seen = 0;
  for (;;) {
    const { transactions, more } = await source.after(account, cursor, Math.min(RECONCILE_PAGE, limit - seen));
    for (const raw of transactions) {
      addResult(result, await handle(db, raw));
      cursor = { signature: signatureOf(raw), slot: raw.slot, blockIndex: raw.transactionIndex ?? null };
    }
    if (transactions.length) {
      const { signature, slot, blockIndex } = cursor!;
      await db
        .insert(indexerCursors)
        .values({ account, signature, slot: BigInt(slot), blockIndex })
        .onConflictDoUpdate({ target: indexerCursors.account, set: { signature, slot: BigInt(slot), blockIndex, updatedAt: sql`now()` } });
    }
    seen += transactions.length;
    if (!more) return { result, cursor, complete: true };
    if (seen >= limit || transactions.length === 0) return { result, cursor, complete: false };
  }
}
