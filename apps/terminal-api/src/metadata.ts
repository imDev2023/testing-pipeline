// Strategy metadata in Postgres (docs/spec/pipescope-architecture.md, Metadata fetcher; PIPESCOPE-36):
// the indexer fetches a strategy's document when its `StrategyRegistered` or `MetadataUpdated` event
// is indexed, when the registry snapshot finds it, and every hour (./config, JOB_INTERVAL_MINUTES),
// since the document behind an unchanged URI can change with no event. Each outcome is stored with
// its hash, the document as Pipeline's validator accepted it (for the forms) and its author text as
// the explainer's normaliser leaves it (for the pages and the explainer). A fetch that finds what
// the newest row holds only moves its `checked_at`; anything else adds a row, so a changed hash is
// seen as a metadata change.
import { desc, eq, inArray } from "drizzle-orm";
import { metadataSnapshots, strategies, type Db } from "terminal-db";
import { normaliseMetadata } from "terminal-explainer";
import { METADATA_FETCH } from "./config";
import { fetchMetadata, type FetchLike, type MetadataOutcome } from "./metadataFetch";

type Snapshot = typeof metadataSnapshots.$inferInsert;

/** The row an outcome makes, without its times. */
function rowOf(program: string, uri: string, outcome: MetadataOutcome): Omit<Snapshot, "fetchedAt" | "checkedAt"> {
  const base = { program, uri, status: outcome.status, errors: "errors" in outcome ? outcome.errors : [], warnings: [] as string[], url: outcome.url, sha256: null as string | null, reason: null as string | null };
  switch (outcome.status) {
    case "missing":
      return base;
    case "unreachable":
      return { ...base, reason: outcome.reason };
    case "invalid":
      return { ...base, reason: outcome.reason, sha256: outcome.sha256 };
    case "valid": {
      const { document, removed } = normaliseMetadata(outcome.value);
      return { ...base, errors: [], warnings: outcome.warnings, sha256: outcome.sha256, document: outcome.value, normalised: document, removed };
    }
  }
}

/** A JSON value written with its keys sorted, so two that hold the same compare equal however Postgres ordered them. */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/**
 * Whether a fetch found what the newest row holds: the same URI, status, document and reasons, and
 * the same author text normalised, so a change of the normaliser reaches a document unchanged.
 */
const same = (row: typeof metadataSnapshots.$inferSelect, next: ReturnType<typeof rowOf>) =>
  row.uri === next.uri &&
  row.status === next.status &&
  row.sha256 === next.sha256 &&
  row.reason === next.reason &&
  row.url === next.url &&
  row.errors.join("\n") === next.errors.join("\n") &&
  canonical(row.normalised) === canonical(next.normalised) &&
  canonical(row.removed) === canonical(next.removed);

/** Runs `work` over `items`, at most `limit` at a time. */
async function inTurns<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  }));
}

/**
 * Fetches the metadata of each strategy named, from the URI its account names now, and stores what
 * was found. Returns how many it fetched and which changed. `fetch` is the Worker's (or a recorded
 * one in the end-to-end tests), `now` the time to record.
 */
export async function fetchStrategiesMetadata(db: Db, programs: string[], { fetch, now }: { fetch?: FetchLike; now?: Date } = {}): Promise<{ fetched: number; changed: string[] }> {
  const wanted = [...new Set(programs)];
  if (!wanted.length) return { fetched: 0, changed: [] };
  const rows = await db.select({ program: strategies.program, uri: strategies.metadataUri }).from(strategies).where(inArray(strategies.program, wanted));
  const changed: string[] = [];
  await inTurns(rows, METADATA_FETCH.concurrency, async ({ program, uri }) => {
    const next = rowOf(program, uri, await fetchMetadata(uri, { fetch }));
    const at = now ?? new Date();
    const [newest] = await db.select().from(metadataSnapshots).where(eq(metadataSnapshots.program, program)).orderBy(desc(metadataSnapshots.id)).limit(1);
    if (newest && same(newest, next)) {
      await db.update(metadataSnapshots).set({ checkedAt: at }).where(eq(metadataSnapshots.id, newest.id));
      return;
    }
    await db.insert(metadataSnapshots).values({ ...next, fetchedAt: at, checkedAt: at });
    changed.push(program);
  });
  return { fetched: rows.length, changed: changed.sort() };
}
