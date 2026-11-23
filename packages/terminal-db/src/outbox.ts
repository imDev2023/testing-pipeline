// The outbox (docs/spec/pipescope-architecture.md, Indexer, "Events for what follows"; #117): what
// the indexer saw happen, written once in the order seen, for whoever acts on it. Canary's runs
// (#124) start from `strategy_registered`, `market_created`, `strategy_version` and `router_upgraded`
// (CANARY-22), and the Telegram bot's queue (#133, #134) alerts on them. Each reader keeps its own
// cursor: it reads with `readOutbox`, acts, and then calls `ackOutbox` with the last id it is done
// with, so an event it failed to act on is read again.
//
// The indexer's jobs can overlap (a long backfill and the next minute's watch), and Postgres hands
// out an identity id at insert, not at commit, so two writers could commit their events out of id
// order and a reader could ack past one still to commit. So every transaction that writes the outbox
// first takes one transaction-scoped advisory lock (`lockOutbox`), before any other write, so lock
// order can never deadlock; an event's id is then handed out only once every earlier one committed.
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "./index.ts";
import { outboxCursors, outboxEvents } from "./schema.ts";

/** What each kind of event carries; slots and amounts are strings, as JSON keeps them whole. */
export type OutboxPayloads = {
  /** A strategy registered with the router, from its event or the registry snapshot. */
  strategy_registered: { metadataUri: string };
  /** A market created through the router, from its event or the registry snapshot. */
  market_created: { strategy: string };
  /** A strategy upgraded: its new version, and the version it replaced. */
  strategy_version: { deploySlot: string; executableSha256: string | null; previousSlot: string | null };
  /** The router upgraded: its new version, and the version it replaced. */
  router_upgraded: { deploySlot: string; executableSha256: string | null; previousSlot: string | null };
};

export type OutboxKind = keyof OutboxPayloads;

export type NewOutboxEvent = { [K in OutboxKind]: { kind: K; subject: string; slot: bigint | null; payload: OutboxPayloads[K] } }[OutboxKind];

export type OutboxEvent = NewOutboxEvent & { id: bigint; createdAt: Date };

/** What makes an event one event: a strategy or market appears once, a version once per deploy slot. */
function keyOf(event: NewOutboxEvent): string {
  switch (event.kind) {
    case "strategy_registered":
    case "market_created":
      return `${event.kind}:${event.subject}`;
    case "strategy_version":
    case "router_upgraded":
      return `${event.kind}:${event.subject}:${event.payload.deploySlot}`;
  }
}

/** The advisory lock every outbox writer holds until it commits ("outbox" in ASCII). */
const OUTBOX_LOCK = 0x6f7574626f78;

/**
 * Takes the outbox's lock for the rest of the transaction `db` is in. A transaction that may append
 * calls it before its first write; `appendOutbox` takes it again, which is free for the holder.
 */
export async function lockOutbox(db: Db): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(${OUTBOX_LOCK})`);
}

/** Writes an event unless it was written before; says whether it was new. */
export async function appendOutbox(db: Db, event: NewOutboxEvent): Promise<boolean> {
  await lockOutbox(db);
  const [row] = await db
    .insert(outboxEvents)
    .values({ key: keyOf(event), kind: event.kind, subject: event.subject, slot: event.slot, payload: event.payload })
    .onConflictDoNothing()
    .returning({ id: outboxEvents.id });
  return Boolean(row);
}

/** The events after the reader's cursor, oldest first, at most `limit`. */
export async function readOutbox(db: Db, consumer: string, { limit = 100 }: { limit?: number } = {}): Promise<OutboxEvent[]> {
  const rows = await db
    .select({ id: outboxEvents.id, kind: outboxEvents.kind, subject: outboxEvents.subject, slot: outboxEvents.slot, payload: outboxEvents.payload, createdAt: outboxEvents.createdAt })
    .from(outboxEvents)
    .leftJoin(outboxCursors, eq(outboxCursors.consumer, consumer))
    .where(and(gt(outboxEvents.id, sql`coalesce(${outboxCursors.lastId}, 0)`)))
    .orderBy(asc(outboxEvents.id))
    .limit(limit);
  return rows as OutboxEvent[];
}

/** Moves the reader's cursor to `lastId`, the last event it is done with; never back. */
export async function ackOutbox(db: Db, consumer: string, lastId: bigint): Promise<void> {
  await db
    .insert(outboxCursors)
    .values({ consumer, lastId })
    .onConflictDoUpdate({ target: outboxCursors.consumer, set: { lastId: sql`greatest(${outboxCursors.lastId}, excluded.last_id)`, updatedAt: sql`now()` } });
}
