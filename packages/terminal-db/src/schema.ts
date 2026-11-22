// Adapted from Top-pad b833a7b, packages/db/src/schema.ts; owned here since.
// Aviary's tables (docs/spec/pipescope-architecture.md, Data). Each ticket adds the tables it
// needs, with a migration from `pnpm --filter terminal-db generate`.
import { bigint, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Where reconciliation stands for each watched address: the newest signature it has indexed. */
export const indexerCursors = pgTable("indexer_cursors", {
  account: text("account").primaryKey(),
  signature: text("signature"),
  slot: bigint("slot", { mode: "bigint" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
