// Adapted from Top-pad b833a7b, packages/db/src/schema.ts; owned here since.
// Aviary's tables (docs/spec/pipescope-architecture.md, Data). Each ticket adds the tables it
// needs, with a migration from `pnpm --filter terminal-db generate`.
import { bigint, date, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Where reconciliation stands for each watched address: the newest signature it has indexed. */
export const indexerCursors = pgTable("indexer_cursors", {
  account: text("account").primaryKey(),
  signature: text("signature"),
  slot: bigint("slot", { mode: "bigint" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * The keeper runner's passes (docs/spec/keeper-runner.md, "What it records"; SUITE-37): one row per
 * pass that sent, held or parked something, written by the runner from the owner's Mac in one
 * transaction with its jobs. Amounts are in lamports.
 */
export const keeperRuns = pgTable(
  "keeper_runs",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    /** The keeper wallet that ran the pass, so another runner's records are never shown as ours. */
    wallet: text("wallet").notNull(),
    /** start, once, sweep, hourly, daily, transaction or retry. */
    pass: text("pass").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** The keeper wallet's balance at the end of the pass, or null when it could not be read. */
    balance: bigint("balance", { mode: "bigint" }),
    /** The UTC day today's spend is counted for. */
    day: date("day", { mode: "string" }).notNull(),
    /** Today's spend, or null when the chain could not be asked for it after a send whose landing was unknown. */
    spentTotal: bigint("spent_total", { mode: "bigint" }),
    /** Today's spend by market, lamports as decimal strings, or null with `spent_total`. */
    spentByMarket: jsonb("spent_by_market").$type<Record<string, string>>(),
    /** MAX_TX_COST, MARKET_DAILY_CAP, DAILY_CAP, MIN_BALANCE and LOW_BALANCE, lamports as decimal strings. */
    caps: jsonb("caps").$type<Record<KeeperCap, string>>().notNull(),
    /** Every setting the runner ran with, as it logs them (no key or password). */
    settings: jsonb("settings").$type<Record<string, string>>().notNull(),
    warnings: text("warnings").array().notNull(),
    markets: integer("markets").notNull(),
    sent: integer("sent").notNull(),
    held: integer("held").notNull(),
    parked: integer("parked").notNull(),
    skipped: integer("skipped").notNull(),
    failed: integer("failed").notNull(),
  },
  (table) => [index("keeper_runs_wallet_at").on(table.wallet, table.at.desc())],
);

export type KeeperCap = "maxTxCost" | "marketDailyCap" | "dailyCap" | "minBalance" | "lowBalance";

/**
 * Each job a recorded pass sent, held or parked: a job whose transaction landed (whatever it did),
 * one held by a cap, one parked after its last retry, or one unparked because its market changed.
 */
export const keeperRunJobs = pgTable(
  "keeper_run_jobs",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    runId: bigint("run_id", { mode: "bigint" })
      .notNull()
      .references(() => keeperRuns.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** The market, or null for the keeper wallet's own work (unwrapping its tips). */
    market: text("market"),
    product: text("product"),
    job: text("job").notNull(),
    /** The job's slot (a payout slot), or null for a job that has none. */
    slot: integer("slot"),
    /** sent, failed, later-slot, nothing-to-do (each with a signature), held, parked or unparked. */
    outcome: text("outcome").notNull(),
    signature: text("signature"),
    /** What the landed transaction took from the keeper wallet. */
    cost: bigint("cost", { mode: "bigint" }),
    /** What the simulation said it would take. */
    estimate: bigint("estimate", { mode: "bigint" }),
    /** The cap that held it. */
    cap: text("cap"),
    error: text("error"),
    /** Which attempt this was, for a failed or parked job. */
    attempt: integer("attempt"),
  },
  (table) => [index("keeper_run_jobs_run").on(table.runId), index("keeper_run_jobs_unit").on(table.market, table.job, table.slot, table.at.desc())],
);
