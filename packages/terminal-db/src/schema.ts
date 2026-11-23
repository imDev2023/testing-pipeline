// Adapted from Top-pad b833a7b, packages/db/src/schema.ts; owned here since.
// Aviary's tables (docs/spec/pipescope-architecture.md, Data). Each ticket adds the tables it
// needs, with a migration from `pnpm --filter terminal-db generate`.
//
// Token amounts are u64 on chain, so they are kept as numeric(20, 0) and read back as strings of
// integers, never as JavaScript numbers.
import { sql } from "drizzle-orm";
import { bigint, boolean, date, index, integer, jsonb, numeric, pgTable, primaryKey, smallint, text, timestamp } from "drizzle-orm/pg-core";

/** A u64 token amount. */
const amount = (name: string) => numeric(name, { precision: 20, scale: 0 });

/**
 * Where reconciliation stands for each watched address: the newest transaction it has indexed, by
 * signature and by its place in the chain (slot, then position in the block), which is where the
 * history source goes on from.
 */
export const indexerCursors = pgTable("indexer_cursors", {
  account: text("account").primaryKey(),
  signature: text("signature"),
  slot: bigint("slot", { mode: "bigint" }),
  blockIndex: integer("block_index"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Every transaction the indexer has indexed, once. `decoderVersion` is the version of the decoder
 * that read it; a transaction with events that decoder did not know (`unknownEvents`) keeps its raw
 * JSON in `raw`, so newer code can index it again without asking the chain (`reindexUnknown`).
 */
export const indexedTransactions = pgTable(
  "indexed_transactions",
  {
    signature: text("signature").primaryKey(),
    slot: bigint("slot", { mode: "bigint" }).notNull(),
    blockIndex: integer("block_index"),
    blockTime: timestamp("block_time", { withTimezone: true }),
    decoderVersion: integer("decoder_version").notNull(),
    unknownEvents: integer("unknown_events").notNull().default(0),
    raw: jsonb("raw"),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("indexed_transactions_unknown").on(t.decoderVersion).where(sql`unknown_events > 0`)],
);

/** Every strategy registered with the router, from its `StrategyRegistered` event or, if that was missed, its account. */
export const strategies = pgTable("strategies", {
  program: text("program").primaryKey(),
  metadataUri: text("metadata_uri").notNull(),
  /** The listing fee paid, in lamports; unknown when the strategy was found by its account alone. */
  feePaid: amount("fee_paid"),
  registeredAt: timestamp("registered_at", { withTimezone: true }).notNull(),
  registeredSlot: bigint("registered_slot", { mode: "bigint" }),
  registeredSignature: text("registered_signature"),
  /** The slot of the newest `MetadataUpdated` applied, so an older one indexed later never overwrites it. */
  metadataSlot: bigint("metadata_slot", { mode: "bigint" }),
});

/**
 * Every market created through the router. The market state is the strategy's own account, kept as
 * its raw bytes and the slot they were read at; the router's `Market` account gives the vaults.
 */
export const markets = pgTable(
  "markets",
  {
    address: text("address").primaryKey(),
    strategyProgram: text("strategy_program").notNull(),
    marketState: text("market_state").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    createdSlot: bigint("created_slot", { mode: "bigint" }),
    createdSignature: text("created_signature"),
    supportsExactOut: boolean("supports_exact_out"),
    /** The mint Pipeline takes its fee in when it is one side of a trade, or null for none. */
    feeMint: text("fee_mint"),
    /** The market state's bytes, base64, as last read, and the slot they were read at. */
    stateData: text("state_data"),
    readSlot: bigint("read_slot", { mode: "bigint" }),
  },
  (t) => [index("markets_newest").on(t.createdAt, t.address), index("markets_strategy").on(t.strategyProgram)],
);

/** A market's mints in the market's own order, each with its vault and what the vault held when last read. */
export const marketMints = pgTable(
  "market_mints",
  {
    market: text("market").notNull(),
    position: smallint("position").notNull(),
    mint: text("mint").notNull(),
    vault: text("vault"),
    vaultAmount: amount("vault_amount"),
  },
  (t) => [primaryKey({ columns: [t.market, t.position] }), index("market_mints_mint").on(t.mint)],
);

/**
 * Every mint a market trades, read once when first seen: its mint account and its Metaplex
 * metadata account, as raw bytes for the facts and token names that later read them. A mint whose
 * account is missing or not a mint is kept with `readable` false.
 */
export const mints = pgTable("mints", {
  address: text("address").primaryKey(),
  readable: boolean("readable").notNull(),
  tokenProgram: text("token_program"),
  decimals: smallint("decimals"),
  supply: amount("supply"),
  mintAuthority: text("mint_authority"),
  freezeAuthority: text("freeze_authority"),
  /** The mint account's bytes, base64, Token-2022 extensions and all. */
  data: text("data"),
  /** The Metaplex metadata account's bytes, base64, or null when the mint has none. */
  metadataData: text("metadata_data"),
  readSlot: bigint("read_slot", { mode: "bigint" }),
});

/** Every swap through the router, from its `Swap` event, keyed by its transaction and its place among the transaction's events. */
export const trades = pgTable(
  "trades",
  {
    signature: text("signature").notNull(),
    eventIndex: smallint("event_index").notNull(),
    slot: bigint("slot", { mode: "bigint" }).notNull(),
    blockIndex: integer("block_index"),
    blockTime: timestamp("block_time", { withTimezone: true }),
    market: text("market").notNull(),
    strategy: text("strategy").notNull(),
    trader: text("trader").notNull(),
    inputMint: text("input_mint").notNull(),
    outputMint: text("output_mint").notNull(),
    /** 0 exact-in, 1 exact-out. */
    mode: smallint("mode").notNull(),
    netSent: amount("net_sent").notNull(),
    received: amount("received").notNull(),
    pipelineFee: amount("pipeline_fee").notNull(),
    feeMint: text("fee_mint").notNull(),
    integrator: text("integrator"),
    integratorFee: amount("integrator_fee").notNull(),
    /** The event's own clock, in Unix seconds. */
    unixTimestamp: bigint("unix_timestamp", { mode: "bigint" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.signature, t.eventIndex] }),
    index("trades_market_order").on(t.market, t.slot, t.blockIndex, t.eventIndex),
    index("trades_trader_order").on(t.trader, t.slot, t.blockIndex, t.eventIndex),
    index("trades_time").on(t.unixTimestamp),
  ],
);

/**
 * Each version of each program the indexer watches (docs/spec/pipescope-architecture.md, Indexer,
 * "ProgramData watch"): a strategy's versions, which Canary checks attach to, and the router's. A
 * version is the program as of one deploy, keyed by the slot its ProgramData account was last
 * written in. The version seen by the watch has its executable's hash (`executable_sha256`, as
 * Pipeline's SDK and solana-verify compute it) and its instruction list; one found only in the
 * ProgramData account's history (`backfilled`), whose bytes are gone, has neither.
 */
export const programVersions = pgTable(
  "program_versions",
  {
    program: text("program").notNull(),
    deploySlot: bigint("deploy_slot", { mode: "bigint" }).notNull(),
    /** `strategy` or `router`. */
    role: text("role").notNull(),
    executableSha256: text("executable_sha256"),
    /** The deploy or upgrade transaction, once found in the ProgramData account's history. */
    signature: text("signature"),
    blockTime: timestamp("block_time", { withTimezone: true }),
    seenAt: timestamp("seen_at", { withTimezone: true }).defaultNow().notNull(),
    backfilled: boolean("backfilled").notNull().default(false),
    /** A router upgrade the watch saw happen: Canary re-runs every market, and the event decoder may need newer code. */
    flagged: boolean("flagged").notNull().default(false),
    /** Whether its bytes name instructions as Anchor compiles them; null until its bytes are read. */
    anchor: boolean("anchor"),
    /**
     * The ProgramData slot the watch last saw while this version was in force: past `deploySlot`
     * once an extension moved it, so a new instance of the indexer knows that slot is no new version.
     */
    programDataSlot: bigint("program_data_slot", { mode: "bigint" }),
  },
  (t) => [primaryKey({ columns: [t.program, t.deploySlot] })],
);

/** A strategy version's instruction list (PIPESCOPE-92): every instruction found in its bytes, Pipeline's six included. */
export const strategyInstructions = pgTable(
  "strategy_instructions",
  {
    program: text("program").notNull(),
    deploySlot: bigint("deploy_slot", { mode: "bigint" }).notNull(),
    /** Where its name appears among the others in the bytes, so the list keeps the program's order. */
    position: smallint("position").notNull(),
    name: text("name").notNull(),
    /** Anchor's discriminator, sha256("global:<name>")[..8], in hex. */
    discriminator: text("discriminator").notNull(),
    /** One of Pipeline's six, which Canary leaves out by name. */
    pipeline: boolean("pipeline").notNull(),
  },
  (t) => [primaryKey({ columns: [t.program, t.deploySlot, t.name] })],
);

/**
 * Every instruction the indexer sees on a strategy program (Indexer, "Strategy-program calls"),
 * from a successful transaction, at the top level or inside another program's: custom actions,
 * bypass swaps and the router's own calls. `signers` are the transaction's signers among its
 * accounts, which is who called it; `invokedBy` the program that called it, or null at the top.
 */
export const strategyCalls = pgTable(
  "strategy_calls",
  {
    signature: text("signature").notNull(),
    /** The top-level instruction it is, or is inside. */
    instructionIndex: smallint("instruction_index").notNull(),
    /** Its place among that instruction's inner instructions, or -1 for the top-level one itself. */
    innerIndex: smallint("inner_index").notNull(),
    program: text("program").notNull(),
    /** Its first eight bytes in hex, or null when it has fewer. */
    discriminator: text("discriminator"),
    signers: text("signers").array().notNull(),
    invokedBy: text("invoked_by"),
    slot: bigint("slot", { mode: "bigint" }).notNull(),
    blockIndex: integer("block_index"),
    blockTime: timestamp("block_time", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.signature, t.instructionIndex, t.innerIndex] }), index("strategy_calls_program").on(t.program, t.discriminator)],
);

/**
 * What the indexer saw happen, for whoever acts on it (Indexer, "Events for what follows"): a new
 * strategy, a new market, a new strategy version and a router upgrade, each written once, in the
 * order seen. Canary's runs and the Telegram bot's queue each read on from their own cursor in
 * `outbox_cursors` (`readOutbox`, `ackOutbox`).
 */
export const outboxEvents = pgTable("outbox_events", {
  id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
  /** What makes the event one event, so the same thing seen twice (by an event and a snapshot, say) is written once. */
  key: text("key").notNull().unique(),
  /** `strategy_registered`, `market_created`, `strategy_version` or `router_upgraded`. */
  kind: text("kind").notNull(),
  /** The strategy program, the market, or the router. */
  subject: text("subject").notNull(),
  slot: bigint("slot", { mode: "bigint" }),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** How far each reader of the outbox has acted: the id of the last event it is done with. */
export const outboxCursors = pgTable("outbox_cursors", {
  consumer: text("consumer").primaryKey(),
  lastId: bigint("last_id", { mode: "bigint" }).notNull(),
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
