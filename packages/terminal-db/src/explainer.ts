// The explainer's keys and reports in Postgres (docs/spec/pipescope-architecture.md, "Explainer jobs";
// EXPLAINER-04, EXPLAINER-05, EXPLAINER-23; #126). `terminal-api` records each new key with the
// evidence the model is to read and its estimated cost; the owner's approve command lists the
// pending keys, calls the model for those approved and writes each outcome; `pnpm explainer:reports`
// lists the "This is wrong" reports with their keys.
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { Db } from "./index.ts";
import { explainerKeys, explainerReports as reports } from "./schema.ts";

type Row = typeof explainerKeys.$inferSelect;

/** A key as `terminal-api` records it, before anything is generated. */
export type NewExplainerKey = Omit<typeof explainerKeys.$inferInsert, "status" | "createdAt" | "estimatedCostUsd" | "explanation" | "validation" | "attempts" | "inputTokens" | "outputTokens" | "costUsd" | "failure" | "finishedAt"> & {
  estimatedCostUsd: number;
};

/** A key as read back, with its amounts as numbers of dollars. */
export type StoredExplainerKey = Omit<Row, "estimatedCostUsd" | "costUsd"> & { estimatedCostUsd: number; costUsd: number | null };

const stored = (row: Row): StoredExplainerKey => ({ ...row, estimatedCostUsd: Number(row.estimatedCostUsd), costUsd: row.costUsd === null ? null : Number(row.costUsd) });

/**
 * Records a new key, pending; says whether it was new. A strategy's older pending keys leave the
 * queue as superseded in the same transaction, since only the newest key is ever shown.
 */
export async function recordExplainerKey(db: Db, key: NewExplainerKey): Promise<boolean> {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    const inserted = await tx
      .insert(explainerKeys)
      .values({ ...key, status: "pending", estimatedCostUsd: key.estimatedCostUsd.toFixed(6) })
      .onConflictDoNothing()
      .returning({ key: explainerKeys.key });
    if (!inserted.length) return false;
    await tx
      .update(explainerKeys)
      .set({ status: "superseded" })
      .where(and(eq(explainerKeys.program, key.program), eq(explainerKeys.status, "pending"), ne(explainerKeys.key, key.key)));
    return true;
  });
}

/** Whether a key has been recorded already, whatever its status. */
export async function hasExplainerKey(db: Db, key: string): Promise<boolean> {
  const [row] = await db.select({ key: explainerKeys.key }).from(explainerKeys).where(eq(explainerKeys.key, key));
  return row !== undefined;
}

export async function readExplainerKey(db: Db, key: string): Promise<StoredExplainerKey | null> {
  const [row] = await db.select().from(explainerKeys).where(eq(explainerKeys.key, key));
  return row ? stored(row) : null;
}

/** The approval queue: every pending key, oldest first. */
export async function pendingExplainerKeys(db: Db): Promise<StoredExplainerKey[]> {
  const rows = await db.select().from(explainerKeys).where(eq(explainerKeys.status, "pending")).orderBy(explainerKeys.createdAt, explainerKeys.key);
  return rows.map(stored);
}

/** What the approve command found for one key. */
export type ExplainerOutcome = {
  status: "done" | "failed";
  explanation: unknown;
  validation: unknown;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failure: string | null;
};

/** Writes a key's outcome; a key superseded while its calls ran keeps the outcome too, since it was paid for. */
export async function finishExplainerKey(db: Db, key: string, outcome: ExplainerOutcome): Promise<void> {
  const [row] = await db
    .update(explainerKeys)
    .set({ ...outcome, costUsd: outcome.costUsd.toFixed(6), finishedAt: sql`now()` })
    .where(and(eq(explainerKeys.key, key), sql`${explainerKeys.status} in ('pending', 'superseded')`))
    .returning({ key: explainerKeys.key });
  if (!row) throw new Error(`explainer key ${key} is not waiting for an outcome`);
}

/** Every "This is wrong" report, newest first, with the key it refers to. */
export async function readExplainerReports(db: Db): Promise<{ id: bigint; note: string | null; createdAt: Date; key: string; program: string; deploySlot: bigint; status: string }[]> {
  return db
    .select({ id: reports.id, note: reports.note, createdAt: reports.createdAt, key: explainerKeys.key, program: explainerKeys.program, deploySlot: explainerKeys.deploySlot, status: explainerKeys.status })
    .from(reports)
    .innerJoin(explainerKeys, eq(explainerKeys.key, reports.key))
    .orderBy(desc(reports.createdAt), desc(reports.id));
}
