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
  /**
   * Pipeline's trust flags for the mint (Pipeline's SDK's `decodeMint`, at `readEpoch` for a
   * transfer fee in force), in the SDK's order; `mint-unreadable` for an account that is no mint.
   * Null for a mint read before the flags were kept, which the next read of mints fills in.
   */
  flags: text("flags").array(),
  /** The epoch the mint was read in, which picks the transfer fee in force. */
  readEpoch: bigint("read_epoch", { mode: "bigint" }),
  /**
   * The token's own name (PIPESCOPE-22), from its Token-2022 token metadata extension or else its
   * Metaplex metadata account: its symbol and name as the author-text normaliser leaves them (author
   * text, never Aviary's words), and the URI it names, where its image is looked for. Null when the
   * mint names none.
   */
  symbol: text("symbol"),
  name: text("name"),
  tokenUri: text("token_uri"),
});

/**
 * What fetching each token metadata URI found (docs/spec/pipescope-architecture.md, Data; PIPESCOPE-82,
 * PIPESCOPE-88): fetched once per URI, and again only when a mint names another, so mints that share a
 * URI share its row. A kept image's bytes are in `TERMINAL_CACHE` under their SHA-256, which a page
 * is given with the mint; KV holds only bytes a re-fetch could replace, so this stays the record.
 */
export const tokenImages = pgTable("token_images", {
  /** The token metadata URI a mint names. */
  uri: text("uri").primaryKey(),
  /** `kept`, `missing` (the document names no image), `unreachable` or `refused` (its type or size). */
  status: text("status").notNull(),
  /** Why it was unreachable or refused, in the fetcher's terms (`http-status`, `type`, `too-large`...). */
  reason: text("reason"),
  /** The image's URL: the URI itself when it serves an image, or the `image` its document names. */
  imageUrl: text("image_url"),
  /** The SHA-256 of a kept image's bytes, in hex: its key in KV and its address, `/images/<hash>`. */
  sha256: text("sha256"),
  /** The type its first bytes say: `image/png`, `image/jpeg` or `image/webp`. */
  contentType: text("content_type"),
  size: integer("size"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

/**
 * Each watched program's facts as Pipeline's SDK words them (`inspectProgram`): who can upgrade it,
 * and its program flags (`upgradeable`, `frozen` or `program-missing`), read by the ProgramData
 * watch from the loader's header every minute and written when they change.
 */
export const programFacts = pgTable("program_facts", {
  program: text("program").primaryKey(),
  /** The upgrade authority, or null for a frozen or missing program. */
  upgradeAuthority: text("upgrade_authority"),
  flags: text("flags").array().notNull(),
  readSlot: bigint("read_slot", { mode: "bigint" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Each strategy's metadata as fetched (docs/spec/pipescope-architecture.md, Metadata fetcher;
 * PIPESCOPE-36): one row per outcome, a new row only when the URI, the status or the document's hash
 * changed, and `checked_at` moved on each fetch that found the same. The newest row is the
 * strategy's metadata now; a changed hash is a metadata change, which makes a new explanation key.
 */
export const metadataSnapshots = pgTable(
  "metadata_snapshots",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    program: text("program").notNull(),
    /** The URI the strategy's account names, as fetched. */
    uri: text("uri").notNull(),
    /** Pipeline's SDK's metadata status: `missing`, `unreachable`, `invalid` or `valid`. */
    status: text("status").notNull(),
    /** Why it was unreachable or invalid, in the fetcher's terms (`http-status`, `content-type`...). */
    reason: text("reason"),
    /** What the fetch or Pipeline's validator said, as they said it: untrusted, since an error can quote the document. */
    errors: text("errors").array().notNull(),
    warnings: text("warnings").array().notNull(),
    /** The URL the document was finally read from, after redirects. */
    url: text("url"),
    /** The SHA-256 of the bytes fetched, in hex; null when no body was read. */
    sha256: text("sha256"),
    /** The document as Pipeline's validator accepted it, for the forms; null unless valid. */
    document: jsonb("document"),
    /** Its author text as the explainer's normaliser left it, for the pages and the explainer; null unless valid. */
    normalised: jsonb("normalised"),
    /** What the normaliser removed. */
    removed: jsonb("removed"),
    /** When this outcome was first fetched, and when last fetched unchanged. */
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("metadata_snapshots_program").on(t.program, t.id)],
);

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
 * Every event a strategy program logged in a successful transaction (Indexer, "Strategy-program
 * events"; #88): the data of each `Program data:` line the program wrote itself, in the order the
 * logs give, kept whole so a product's panel decodes its own events (a market's history) without
 * going back to the chain. `subject` is the 32 bytes after an Anchor event's discriminator read as
 * an address, which for our strategies' events is the market state they are about, so a market's
 * events are found without decoding every one; for another program it is whatever comes first.
 */
export const strategyEvents = pgTable(
  "strategy_events",
  {
    signature: text("signature").notNull(),
    /** Its place among the transaction's events from strategy programs, from 0, in log order. */
    position: smallint("position").notNull(),
    program: text("program").notNull(),
    /** The event's first eight bytes in hex, which for an Anchor event name it; null when it has fewer. */
    discriminator: text("discriminator"),
    /** Bytes 8 to 40 as an address, or null when it has fewer. */
    subject: text("subject"),
    /** The event's bytes, base64. */
    data: text("data").notNull(),
    slot: bigint("slot", { mode: "bigint" }).notNull(),
    blockIndex: integer("block_index"),
    blockTime: timestamp("block_time", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.signature, t.position] }), index("strategy_events_subject").on(t.program, t.subject, t.slot.desc())],
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
 * Candles (docs/spec/pipescope-architecture.md, Candles; PIPESCOPE-30), one per market, mint pair,
 * length and start, folded from trades as they are indexed. A pair's mints are kept in address order
 * (`mint_a` < `mint_b`), whichever of them a page quotes in. A price is an amount of `mint_a` for an
 * amount of `mint_b` in their smallest units, kept exactly as a reduced fraction of the swap that set
 * it, so a candle reads exactly either way round and at any decimals; the open and close are the
 * candle's first and last swaps by trade order (`open_key`, `close_key`).
 */
export const candles = pgTable(
  "candles",
  {
    market: text("market").notNull(),
    mintA: text("mint_a").notNull(),
    mintB: text("mint_b").notNull(),
    /** The candle's length in seconds. */
    seconds: integer("seconds").notNull(),
    /** Its start, in Unix seconds: a multiple of its length. */
    start: bigint("start", { mode: "bigint" }).notNull(),
    openA: amount("open_a").notNull(),
    openB: amount("open_b").notNull(),
    highA: amount("high_a").notNull(),
    highB: amount("high_b").notNull(),
    lowA: amount("low_a").notNull(),
    lowB: amount("low_b").notNull(),
    closeA: amount("close_a").notNull(),
    closeB: amount("close_b").notNull(),
    /** The trade order (slot, place in the block, event index) of the first and last swaps folded in. */
    openKey: text("open_key").notNull(),
    closeKey: text("close_key").notNull(),
    /** What the candle's swaps moved of each mint, in its smallest units; a sum of u64s can pass 20 digits. */
    volumeA: numeric("volume_a", { precision: 40, scale: 0 }).notNull(),
    volumeB: numeric("volume_b", { precision: 40, scale: 0 }).notNull(),
    trades: integer("trades").notNull(),
  },
  (t) => [primaryKey({ columns: [t.market, t.mintA, t.mintB, t.seconds, t.start] }), index("candles_retention").on(t.seconds, t.start)],
);

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

/**
 * Canary's runs (docs/spec/pipescope-architecture.md, "Canary runner"; #124): each run of one
 * strategy version on some or all of its markets, started by one trigger (CANARY-22, CANARY-23):
 * `market_created` (with its delay: at once, then 10 minutes, 1 hour and 1 day on),
 * `strategy_version`, `router_upgraded`, `sweep` or `rerun`. The `CanaryRun` Durable Object of the
 * version writes it when the run starts and when its last market is done.
 */
export const canaryRuns = pgTable(
  "canary_runs",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    program: text("program").notNull(),
    deploySlot: bigint("deploy_slot", { mode: "bigint" }).notNull(),
    trigger: text("trigger").notNull(),
    /** How long after its trigger the run was due, in milliseconds: a new market's later runs. */
    delayMs: bigint("delay_ms", { mode: "number" }).notNull().default(0),
    /** The markets it covers. */
    markets: integer("markets").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("canary_runs_version").on(t.program, t.deploySlot, t.startedAt.desc())],
);

/**
 * Each market of a run, once it is done: how many snapshot rounds it took, the RPC requests its
 * snapshot cost, the time it spent in the container and the notes the binary wrote; or, for a
 * market Aviary could not run (an RPC or the container failing past the retries), the error.
 */
export const canaryRunMarkets = pgTable(
  "canary_run_markets",
  {
    runId: bigint("run_id", { mode: "bigint" })
      .notNull()
      .references(() => canaryRuns.id, { onDelete: "cascade" }),
    market: text("market").notNull(),
    /** done or failed. */
    status: text("status").notNull(),
    rounds: smallint("rounds"),
    rpcRequests: integer("rpc_requests"),
    containerMs: integer("container_ms"),
    notes: jsonb("notes").$type<string[]>(),
    error: text("error"),
    finishedAt: timestamp("finished_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.market] })],
);

/**
 * Canary results (docs/spec/pipescope-canary.md, "Records"; CANARY-20): one per check, market,
 * strategy version and run slot, as the binary wrote it (`record`). Only the latest of each check
 * per market and version (`latest`) and every earlier one whose outcome differed from the one after
 * it are kept. The version is the indexer's (`program_versions`), keyed by its deploy slot.
 */
export const canaryResults = pgTable(
  "canary_results",
  {
    /** The binary's stable id: the check, the market, the version's deploy slot and the run's slot. */
    id: text("id").primaryKey(),
    runId: bigint("run_id", { mode: "bigint" })
      .notNull()
      .references(() => canaryRuns.id),
    program: text("program").notNull(),
    deploySlot: bigint("deploy_slot", { mode: "bigint" }).notNull(),
    market: text("market").notNull(),
    check: text("check").notNull(),
    /** pass, warn, fail, not run or noted. */
    outcome: text("outcome").notNull(),
    harness: text("harness").notNull(),
    slot: bigint("slot", { mode: "bigint" }).notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    record: jsonb("record").notNull(),
    latest: boolean("latest").notNull(),
  },
  (t) => [
    index("canary_results_market").on(t.market, t.program, t.deploySlot, t.check, t.slot.desc()),
    index("canary_results_latest_version").on(t.program, t.deploySlot).where(sql`latest`),
  ],
);

/**
 * Explainer keys (docs/spec/pipescope-explainer.md, "When an explanation is made"; docs/spec/pipescope-architecture.md,
 * "Explainer jobs"; EXPLAINER-04, EXPLAINER-05; #126): one row per key, made by `terminal-api` with
 * the evidence the model is to read and its estimated cost, pending until the owner's approve
 * command (`pnpm explainer:approve`) writes the explanation or the failure. A pending key a newer key
 * of the same strategy has replaced is `superseded` and leaves the queue (EXPLAINER-23).
 */
export const explainerKeys = pgTable(
  "explainer_keys",
  {
    /** The SHA-256 of the key's parts, in hex (terminal-explainer's `explainerKey`). */
    key: text("key").primaryKey(),
    program: text("program").notNull(),
    deploySlot: bigint("deploy_slot", { mode: "bigint" }).notNull(),
    authorTextSha256: text("author_text_sha256").notNull(),
    canaryOutcomesSha256: text("canary_outcomes_sha256").notNull(),
    promptVersion: text("prompt_version").notNull(),
    model: text("model").notNull(),
    /** pending, done, failed or superseded. */
    status: text("status").notNull(),
    /** The evidence items the model reads, each with where Aviary read it (`source`), which is never sent. */
    evidence: jsonb("evidence").notNull(),
    /** The market the version's market-level facts come from (EXPLAINER-03), or null when it has none. */
    representativeMarket: text("representative_market"),
    /** Whether Aviary's own detector found author text addressed to AI tools (EXPLAINER-14). */
    authorTextAddressesAi: boolean("author_text_addresses_ai").notNull(),
    estimatedInputTokens: integer("estimated_input_tokens").notNull(),
    /** The estimated cost in US dollars, a first try and its retry. */
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 12, scale: 6 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    /** The explanation as the model returned it and the validator passed it; null unless done. */
    explanation: jsonb("explanation"),
    /** The last attempt's checks, as the validator ran them. */
    validation: jsonb("validation"),
    /** Calls made, 1 or 2, and what they read and wrote and cost, as the API reported. */
    attempts: smallint("attempts"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    /** Why a failed key failed: the validator twice, a refusal, a cut-off answer or an error. */
    failure: text("failure"),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("explainer_keys_program").on(t.program, t.createdAt.desc()), index("explainer_keys_pending").on(t.createdAt).where(sql`status = 'pending'`)],
);

/** "This is wrong" reports (docs/spec/pipescope-explainer.md, Presentation): each against the key it refers to, for `pnpm explainer:reports`. */
export const explainerReports = pgTable(
  "explainer_reports",
  {
    id: bigint("id", { mode: "bigint" }).primaryKey().generatedAlwaysAsIdentity(),
    key: text("key")
      .notNull()
      .references(() => explainerKeys.key),
    /** What the reader wrote, if anything: untrusted, shown to the owner as plain text. */
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("explainer_reports_newest").on(t.createdAt.desc())],
);
