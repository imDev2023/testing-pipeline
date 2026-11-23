// Copied from Top-pad b833a7b, packages/indexer/src/index.ts (`indexTransactions`, `reindexTransactions`); owned here since.
// Aviary's indexer (docs/spec/pipescope-architecture.md, Indexer): every source hands its
// transactions to `indexTransactions`, which writes them through the router's handler.
import { and, asc, eq, gt, lt } from "drizzle-orm";
import { indexedTransactions, type Db } from "terminal-db";
import { DECODER_VERSION, type RawTransaction } from "./decode";
import type { IndexResult, TransactionHandler } from "./handler";
import { addResult } from "./result";

export * from "./accounts";
export * from "./candles";
export * from "./decode";
export * from "./handler";
export * from "./history";
export * from "./registry";
export * from "./result";
export * from "./rpc";

/** A batch in which some transactions could not be indexed; the rest were, so a retry only needs to bring these back. */
export class IndexBatchError extends Error {
  constructor(
    readonly result: IndexResult,
    readonly failed: { signature: string; error: string }[],
  ) {
    super(`${failed.length} of the transactions could not be indexed: ${failed.map((f) => `${f.signature} (${f.error})`).join("; ")}`);
  }
}

/**
 * The one ingestion entry point. One transaction that cannot be indexed never stops the others: the
 * batch goes on, and `IndexBatchError` names what failed at the end.
 */
export async function indexTransactions(db: Db, handle: TransactionHandler, txs: RawTransaction[]): Promise<IndexResult> {
  const result: IndexResult = { counts: {}, markets: [] };
  const failed: { signature: string; error: string }[] = [];
  for (const tx of txs) {
    try {
      addResult(result, await handle(db, tx));
    } catch (e) {
      const signature = tx?.transaction?.signatures?.[0] ?? "unknown";
      console.error(`indexing ${signature} failed`, e);
      failed.push({ signature, error: e instanceof Error ? e.message : String(e) });
    }
  }
  if (failed.length) throw new IndexBatchError(result, failed);
  return result;
}

/**
 * Indexes again transactions indexed before by code that did not know some of their events: each is
 * forgotten, then indexed as new, in one database transaction, so one that fails keeps its earlier
 * record and raw JSON. Every row is written once, so what the first pass wrote stays as it was.
 */
export async function reindexTransactions(db: Db, handle: TransactionHandler, txs: RawTransaction[]): Promise<IndexResult> {
  return indexTransactions(db, (db, raw) =>
    db.transaction(async (tx) => {
      await tx.delete(indexedTransactions).where(eq(indexedTransactions.signature, raw.transaction.signatures[0]!));
      return handle(tx as unknown as Db, raw);
    }), txs);
}

/** How many kept transactions `reindexUnknown` reads at once. */
const REINDEX_BATCH = 100;

/**
 * Reads again, from the raw JSON kept with them, every transaction that a decoder older than
 * `decoderVersion` could not fully decode, oldest first.
 */
export async function reindexUnknown(db: Db, handle: TransactionHandler, decoderVersion = DECODER_VERSION): Promise<IndexResult> {
  const result: IndexResult = { counts: {}, markets: [] };
  for (;;) {
    const kept = await db
      .select({ raw: indexedTransactions.raw })
      .from(indexedTransactions)
      .where(and(gt(indexedTransactions.unknownEvents, 0), lt(indexedTransactions.decoderVersion, decoderVersion)))
      .orderBy(asc(indexedTransactions.slot), asc(indexedTransactions.blockIndex))
      .limit(REINDEX_BATCH);
    if (!kept.length) return result;
    addResult(result, await reindexTransactions(db, handle, kept.map((k) => k.raw as RawTransaction)));
  }
}
