// The API's zod contract: what each endpoint answers, shared with the web app, which is a pure
// client of the API (docs/spec/pipescope-architecture.md, "terminal-web"). Every endpoint is
// labelled unstable until v1 ships (PIPESCOPE-32).
import { z } from "zod";

/** `GET /health`: healthy only when the database and the RPC both answer. */
export const Health = z.object({
  ok: z.boolean(),
  cluster: z.string(),
  database: z.object({
    ok: z.boolean(),
    latencyMs: z.number().int().nullable(),
    /** How many migrations the database has applied, so a deploy with one missing never looks ready. */
    migrations: z.number().int().nullable(),
    error: z.string().nullable(),
  }),
  rpc: z.object({
    ok: z.boolean(),
    latencyMs: z.number().int().nullable(),
    slot: z.number().int().nullable(),
    error: z.string().nullable(),
  }),
  version: z.object({ id: z.string(), tag: z.string(), timestamp: z.string() }),
});
export type Health = z.infer<typeof Health>;

/** Every refusal and failure: one sentence a page can show as it is. */
export const ApiError = z.object({ error: z.string(), retryAfterSeconds: z.number().int().optional() });
export type ApiError = z.infer<typeof ApiError>;

/** A u64 token amount, as a string of an integer in the mint's smallest units. */
const Amount = z.string().regex(/^\d+$/);
const Address = z.string().min(32).max(44);
const Time = z.iso.datetime({ offset: true });

/**
 * One of Pipeline's trust flags with its fixed description, as Pipeline's SDK words it
 * (`FLAG_DESCRIPTIONS`), so Aviary's wording is the SDK's and the hosted API's (PIPESCOPE-16).
 */
export const FlagFact = z.object({ flag: z.string(), description: z.string() });
export type FlagFact = z.infer<typeof FlagFact>;

/**
 * A strategy's metadata as the fetcher last found it (docs/spec/pipescope-architecture.md, Metadata
 * fetcher): Pipeline's SDK's status, or `not-fetched` before the first fetch. Errors and warnings are
 * the fetch's or Pipeline's validator's words, which can quote the document, so a page shows them as
 * plain text.
 */
export const MetadataStatus = z.object({
  status: z.enum(["not-fetched", "missing", "unreachable", "invalid", "valid"]),
  /** The URI the strategy's account names. */
  uri: z.string(),
  /** The URL the document was read from, after redirects. */
  url: z.string().nullable(),
  fetched_at: Time.nullable(),
  checked_at: Time.nullable(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  /** The SHA-256 of the document's bytes, in hex. */
  sha256: z.string().nullable(),
  /** What the explainer's normaliser removed from its author text (EXPLAINER-08). */
  removed: z.object({ characters: z.number().int(), truncated: z.array(z.string()), images: z.number().int(), links: z.number().int() }).nullable(),
});
export type MetadataStatus = z.infer<typeof MetadataStatus>;

/** A strategy registered with the router (`GET /v1/strategies`, `GET /v1/strategies/{program}`). */
export const Strategy = z.object({
  program: Address,
  metadata_uri: z.string(),
  /** The listing fee paid, in lamports; null when the strategy was found by its account, without its event. */
  fee_paid: Amount.nullable(),
  registered_at: Time,
  registered_signature: z.string().nullable(),
  market_count: z.number().int(),
  /** The name its valid metadata gives, as the normaliser left it: author text, shown as plain text in the author's style. Null without valid metadata. */
  name: z.string().nullable(),
  /** Its valid metadata's description, normalised and capped (EXPLAINER-08); author text too. */
  description: z.string().nullable(),
  metadata: MetadataStatus,
  /** Pipeline's trust flags for the strategy, in the SDK's order: its program's and its metadata's. */
  flags: z.array(z.string()),
  /** Who can upgrade its program, or null when it is frozen (or not read yet: then `flags` holds neither `upgradeable` nor `frozen`). */
  upgrade_authority: Address.nullable(),
  /** Its program's version in force, or null before the ProgramData watch has read it. */
  current_version: z.object({ deploy_slot: z.number().int(), executable_sha256: z.string().nullable(), deployed_at: Time.nullable() }).nullable(),
  /** A verified build of the current version: none until verified builds exist (#128). */
  verified_build: z.null(),
});
export type Strategy = z.infer<typeof Strategy>;

/** One strategy (`GET /v1/strategies/{program}`), with each of its flags' fixed description for its facts. */
export const StrategyDetail = Strategy.extend({ flag_facts: z.array(FlagFact) });
export type StrategyDetail = z.infer<typeof StrategyDetail>;

/** Every strategy, newest first, with each flag any of them has and its description. */
export const StrategiesList = z.object({ strategies: z.array(Strategy), flags_present: z.array(FlagFact) });
export type StrategiesList = z.infer<typeof StrategiesList>;

/** One version of a program: the program as of one deploy, keyed by the slot of that deploy (docs/spec/pipescope-architecture.md, Indexer, "ProgramData watch"). */
const ProgramVersionFields = {
  deploy_slot: z.number().int(),
  /** The executable's SHA-256 as Pipeline's SDK and `solana-verify get-program-hash` compute it; null for a version found only in the history, whose bytes are gone. */
  executable_sha256: z.string().nullable(),
  /** The deploy or upgrade transaction; null until found in the ProgramData account's history. */
  signature: z.string().nullable(),
  /** When that transaction landed. */
  deployed_at: Time.nullable(),
  /** When Aviary recorded the version. */
  seen_at: Time,
  /** Found in the ProgramData account's history rather than seen by the watch, so its bytes were never read. */
  backfilled: z.boolean(),
  /** The version in force now. */
  current: z.boolean(),
};

/** A strategy's versions, newest first (`GET /v1/strategies/{program}/versions`). Canary checks attach to versions, not to strategies. */
export const StrategyVersion = z.object(ProgramVersionFields);
export type StrategyVersion = z.infer<typeof StrategyVersion>;
export const StrategyVersions = z.object({ program: Address, versions: z.array(StrategyVersion) });
export type StrategyVersions = z.infer<typeof StrategyVersions>;

/** The router's versions, newest first (`GET /v1/router`); an upgrade the watch saw happen is flagged, since it can change event layouts. */
export const RouterVersion = z.object({ ...ProgramVersionFields, flagged: z.boolean() });
export type RouterVersion = z.infer<typeof RouterVersion>;
export const RouterVersions = z.object({ program: Address, versions: z.array(RouterVersion) });
export type RouterVersions = z.infer<typeof RouterVersions>;

/**
 * The instructions compiled into a strategy's current version (`GET /v1/strategies/{program}/instructions`;
 * PIPESCOPE-92, CANARY-18), Pipeline's six marked as Pipeline's, each with how often it has been
 * called and by which signers, from the indexer's history of the strategy program. `anchor` is false
 * when the program names no instruction as Anchor compiles them ("none found"), and null, with
 * `deploy_slot`, before any version is recorded.
 */
export const StrategyInstruction = z.object({
  name: z.string(),
  discriminator: z.string().regex(/^[0-9a-f]{16}$/),
  pipeline: z.boolean(),
  calls: z.number().int(),
  /** The signers that called it, most calls first, at most INSTRUCTION_SIGNERS_SHOWN. */
  signers: z.array(z.object({ address: Address, calls: z.number().int() })),
  signers_total: z.number().int(),
});
export type StrategyInstruction = z.infer<typeof StrategyInstruction>;
export const StrategyInstructions = z.object({ program: Address, deploy_slot: z.number().int().nullable(), anchor: z.boolean().nullable(), instructions: z.array(StrategyInstruction) });
export type StrategyInstructions = z.infer<typeof StrategyInstructions>;

/**
 * A token's own name and picture, from its mint's on-chain token metadata (PIPESCOPE-22, PIPESCOPE-82):
 * author text, never Aviary's words, so a page sets it in the author's style beside the mint's short
 * address. Its symbol and name as the author-text normaliser leaves them, at least one of them set,
 * and `image`, the SHA-256 of the image Aviary keeps of it, served at `/images/<image>`, or null.
 */
export const TokenName = z.object({
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  image: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
export type TokenName = z.infer<typeof TokenName>;

/** One of a market's mints, in the market's own order, with what its vault holds. */
export const MarketMint = z.object({
  mint: Address,
  /** Aviary's own name for the mint (SOL, USDC), set plainly; null for every other mint. */
  symbol: z.string().nullable(),
  /** The token's own name, the author's claim; null for a mint that names none, and for SOL and USDC, which Aviary names. */
  token: TokenName.nullable(),
  /** Null until the mint is read, or when its account is not a mint. */
  decimals: z.number().int().nullable(),
  vault: Address.nullable(),
  /** What the vault held when last read, in the mint's smallest units. */
  liquidity: Amount.nullable(),
  /** Pipeline's trust flags for the mint, in the SDK's order; null until the mint is read. */
  flags: z.array(z.string()).nullable(),
});
export type MarketMint = z.infer<typeof MarketMint>;

/** A market created through the router (`GET /v1/markets`, `GET /v1/markets/{market}`). */
export const Market = z.object({
  address: Address,
  strategy: Address,
  market_state: Address,
  created_at: Time,
  created_by: Address,
  created_signature: z.string().nullable(),
  fee_mint: Address.nullable(),
  supports_exact_out: z.boolean().nullable(),
  mints: z.array(MarketMint),
  /** The pair a price is shown for (PIPESCOPE-74): an amount of the quote mint for one of the base mint. */
  quote_mint: Address,
  base_mint: Address,
  /** The last 24 hours: every trade counted, and the volume of those in the quote mint, in its smallest units. */
  stats_24h: z.object({ trades: z.number().int(), volume_quote: Amount }),
  /** Its strategy's name from valid metadata (author text), or null when its metadata is unavailable. */
  strategy_name: z.string().nullable(),
  /** Its strategy's metadata status, for "Metadata unavailable". */
  strategy_metadata: MetadataStatus.shape.status,
  /** Pipeline's trust flags for the market: its strategy's and every mint's, in the SDK's order, as Pipeline's SDK and hosted API give them. */
  flags: z.array(z.string()),
});
export type Market = z.infer<typeof Market>;

/**
 * `GET /v1/markets?min_sol_liquidity=&min_sol_volume_24h=&created_within=&hide=`: markets newest
 * first, all of them or those the filters keep (PIPESCOPE-05, PIPESCOPE-72): at least that much SOL
 * in the market's SOL vault and of SOL traded in the last 24 hours (lamports), created within that
 * many seconds, and none of the trust flags in `hide` (a comma-separated list). Liquidity and volume
 * are measured on the SOL side, so either leaves out a market with no SOL side.
 * `total` counts every market (of the strategy asked for), `matching` those the filters keep, and
 * `no_sol_side` those with no SOL side; `flags_present` is every flag any of the markets has, with
 * its description. `next` is the `before` of the following page, or null after the last.
 */
export const MarketsPage = z.object({
  markets: z.array(Market),
  total: z.number().int(),
  matching: z.number().int(),
  no_sol_side: z.number().int(),
  flags_present: z.array(FlagFact),
  next: z.string().nullable(),
});
export type MarketsPage = z.infer<typeof MarketsPage>;

/** A Token-2022 extension of a mint, in words: its name, what it is set to, the address it names (a hook's program, a delegate), and who can change it. */
export const MintExtension = z.object({ name: z.string(), detail: z.string().nullable(), address: Address.nullable(), authority: Address.nullable() });
export type MintExtension = z.infer<typeof MintExtension>;

/** A mint as the facts panel shows it (docs/spec/pipescope-screens.md, Explanation, actions and facts: "Its mints"). */
export const MintFacts = z.object({
  mint: Address,
  /** Aviary's own name for it (SOL, USDC), or null: no other mint is named by Aviary. */
  symbol: z.string().nullable(),
  /** The token's own name, as on a market's mints. */
  token: TokenName.nullable(),
  readable: z.boolean(),
  /** "Token" or "Token-2022", or null for an unreadable mint. */
  token_program: z.enum(["Token", "Token-2022"]).nullable(),
  decimals: z.number().int().nullable(),
  supply: Amount.nullable(),
  mint_authority: Address.nullable(),
  freeze_authority: Address.nullable(),
  extensions: z.array(MintExtension),
  /** What this market's vault holds of it, and that as a share of the supply in percent (null with no supply). */
  vault_amount: Amount.nullable(),
  vault_share_percent: z.number().nullable(),
  flags: z.array(FlagFact),
  /** When it was last read. */
  read_slot: z.number().int().nullable(),
});
export type MintFacts = z.infer<typeof MintFacts>;

/**
 * `GET /v1/markets/{market}/facts`: the facts panel's three parts of Aviary's own (PIPESCOPE-16):
 * this market, its strategy, and its mints in the market's order. Canary's part joins with #125.
 */
export const MarketFacts = z.object({
  market: Market,
  strategy: StrategyDetail,
  mints: z.array(MintFacts),
});
export type MarketFacts = z.infer<typeof MarketFacts>;

/** A mint found by search: Aviary's name for it or its own, and every market it trades on. */
export const SearchMint = z.object({
  mint: Address,
  /** Aviary's own name for it (SOL, USDC), or null. */
  symbol: z.string().nullable(),
  token: TokenName.nullable(),
  /** Every market it trades on, newest first. */
  markets: z.array(Address),
});
export type SearchMint = z.infer<typeof SearchMint>;

/** One group of search results: how many match, and the first of them, at most the limit asked for. */
const SearchGroup = <T extends z.ZodType>(result: T) => z.object({ total: z.number().int(), results: z.array(result) });

/**
 * `GET /v1/search?q=&limit=` (docs/spec/pipescope-screens.md, Search; PIPESCOPE-81): what is
 * registered with Pipeline that matches `q`, grouped as strategies, markets and mints. Names match
 * anywhere and in any case (a strategy's name from valid metadata, a token's symbol and name, and
 * Aviary's own SOL and USDC); addresses match exactly as typed from their start or their end (a
 * strategy's program, a market, a market state or a mint). Each group is ordered with a whole address
 * typed first; then strategies by markets, markets newest first and mints by markets.
 */
export const SearchResults = z.object({
  /** What was searched for, trimmed. */
  query: z.string(),
  strategies: SearchGroup(Strategy),
  markets: SearchGroup(Market),
  mints: SearchGroup(SearchMint),
});
export type SearchResults = z.infer<typeof SearchResults>;

/** A swap through the router, from its `Swap` event. */
export const Trade = z.object({
  signature: z.string(),
  event_index: z.number().int(),
  slot: z.number().int(),
  block_index: z.number().int().nullable(),
  block_time: Time.nullable(),
  market: Address,
  trader: Address,
  input_mint: Address,
  output_mint: Address,
  mode: z.enum(["exact_in", "exact_out"]),
  net_sent: Amount,
  received: Amount,
  pipeline_fee: Amount,
  fee_mint: Address,
  integrator: Address.nullable(),
  integrator_fee: Amount,
  /** The trade's pair by the quote mint order, and whether it bought or sold the base mint. */
  quote_mint: Address,
  base_mint: Address,
  side: z.enum(["buy", "sell"]),
});
export type Trade = z.infer<typeof Trade>;

/**
 * Trades, newest first; `next` is the `before` of the following page, or null after the last. Asked
 * with `after` (a reconnecting page's resync), it holds only trades newer than that cursor, the
 * newest of them; `next` is then null when they all fit, or else the `before` of the older ones
 * still between the page and the cursor.
 */
export const TradesPage = z.object({ trades: z.array(Trade), next: z.string().nullable() });
export type TradesPage = z.infer<typeof TradesPage>;

/**
 * What a live room sends a browser (docs/spec/pipescope-architecture.md, Live rooms): a swap just
 * indexed, to a market's room; a market new or changed (its liquidity, its last 24 hours), to the
 * feed's room and the market's own. A page puts each in place by its key, so one that arrives twice,
 * or again in a resync through the API, is shown once.
 */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trade"), trade: Trade }),
  z.object({ type: z.literal("market"), market: Market }),
  /** More new swaps than a room is sent at once landed (LIVE_ROOM_TRADES_MAX): the page catches up through the API, as after a reconnection. */
  z.object({ type: z.literal("resync") }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

/** One message of a live room: the events gathered over its batching interval (PIPESCOPE-31). */
export const LiveMessage = z.object({ events: z.array(LiveEvent) });
export type LiveMessage = z.infer<typeof LiveMessage>;

/** A price: an amount of the quote mint for one of the base mint, after both mints' decimals, as a decimal string. */
const Price = z.string().regex(/^\d+(\.\d+)?$/);

/** One candle: its start, its first, highest, lowest and last price, what its swaps moved of each mint, and how many there were. */
export const Candle = z.object({
  start: Time,
  open: Price,
  high: Price,
  low: Price,
  close: Price,
  /** In the base and quote mints' smallest units. */
  volume_base: Amount,
  volume_quote: Amount,
  trades: z.number().int(),
});
export type Candle = z.infer<typeof Candle>;

/**
 * `GET /v1/markets/{market}/candles?interval=&base=&quote=&limit=&from=`: a market's candles of one
 * length for a pair, oldest first, only those with swaps. The pair is the one asked for by `base` and
 * `quote`, or the market's own by the quote mint order (PIPESCOPE-74).
 */
export const Candles = z.object({
  market: Address,
  interval: z.string(),
  seconds: z.number().int(),
  base_mint: Address,
  quote_mint: Address,
  /** Every swap of the pair on this market that the candles are built from, all time. */
  trade_count: z.number().int(),
  candles: z.array(Candle),
});
export type Candles = z.infer<typeof Candles>;
/**
 * The keeper runner's passes (docs/spec/keeper-runner.md, "Triggers"): `start` and `once` run every
 * job, the others their own; `retry` re-runs a failed job, or one refused for a later slot.
 */
export const KeeperPassKind = z.enum(["start", "once", "sweep", "hourly", "daily", "transaction", "retry"]);
export type KeeperPassKind = z.infer<typeof KeeperPassKind>;

/** The runner's caps and balance thresholds, in lamports. */
export const KeeperCaps = z.object({
  maxTxCost: z.number().int().nonnegative(),
  marketDailyCap: z.number().int().nonnegative(),
  dailyCap: z.number().int().nonnegative(),
  minBalance: z.number().int().nonnegative(),
  lowBalance: z.number().int().nonnegative(),
});
export type KeeperCaps = z.infer<typeof KeeperCaps>;

/**
 * The signed heartbeat the runner posts to `POST /keeper/heartbeat` after each pass (SUITE-57), so
 * the keeper page knows the runner is alive while Postgres sleeps: `payload` is the JSON of a
 * `KeeperHeartbeatPayload`, and `signature` the keeper wallet's Ed25519 signature, in base58, of
 * `keeperHeartbeatMessage(payload)`.
 */
export const KeeperHeartbeat = z.object({ payload: z.string().max(8192), signature: z.string().min(64).max(100) }).strict();
export type KeeperHeartbeat = z.infer<typeof KeeperHeartbeat>;

/** The most warnings a heartbeat carries, and the longest each may be; the runner cuts its own to fit. */
export const KEEPER_WARNINGS_MAX = 20;
export const KEEPER_WARNING_MAX_LENGTH = 1000;

export const KeeperHeartbeatPayload = z
  .object({
    /** The keeper wallet, which signed it. */
    wallet: z.string().min(32).max(44),
    pass: KeeperPassKind,
    /** When the pass ended. */
    at: z.iso.datetime(),
    /** When this run of the runner started: parks are kept only in its memory, so older ones are over. */
    startedAt: z.iso.datetime(),
    /** The runner's SWEEP_INTERVAL, which the page's "looks stopped" counts from. */
    sweepIntervalMs: z.number().int().positive(),
    caps: KeeperCaps,
    /** The pass's warnings (a low balance, a failed discovery). */
    warnings: z.array(z.string().max(KEEPER_WARNING_MAX_LENGTH)).max(KEEPER_WARNINGS_MAX),
  })
  .strict();
export type KeeperHeartbeatPayload = z.infer<typeof KeeperHeartbeatPayload>;

/** What a heartbeat's signature signs: a domain line no Solana transaction can begin with, then the payload. */
export const KEEPER_HEARTBEAT_DOMAIN = "keeper-heartbeat/v1";
export const keeperHeartbeatMessage = (payload: string): Uint8Array => new TextEncoder().encode(`${KEEPER_HEARTBEAT_DOMAIN}\n${payload}`);

/** One job the runner recorded: sent (with its signature), held by a cap, parked or unparked. */
export const KeeperJob = z.object({
  at: z.iso.datetime(),
  pass: z.string(),
  market: z.string().nullable(),
  product: z.string().nullable(),
  job: z.string(),
  slot: z.number().int().nullable(),
  outcome: z.string(),
  signature: z.string().nullable(),
  /** Lamports the landed transaction took from the keeper wallet. */
  cost: z.number().int().nullable(),
  cap: z.string().nullable(),
  error: z.string().nullable(),
});
export type KeeperJob = z.infer<typeof KeeperJob>;

/** `GET /keeper`: what the keeper runner did and spends, for the keeper page (PIPESCOPE-97, PIPESCOPE-104). */
export const Keeper = z.object({
  /** The keeper wallet Aviary shows. */
  wallet: z.string(),
  /** Its balance in lamports, read through RPC now. */
  balance: z.object({ lamports: z.number().int().nullable(), error: z.string().nullable() }),
  liveness: z.object({
    /** `running` within the threshold of the last heartbeat, `looks-stopped` after it, `no-heartbeat` when none was ever received. */
    state: z.enum(["running", "looks-stopped", "no-heartbeat"]),
    /** The runner's latest pass (one-off `once` passes aside), from its heartbeats. */
    lastPass: z.object({ pass: KeeperPassKind, at: z.iso.datetime() }).nullable(),
    /** How old the last pass may be before the runner looks stopped: its SWEEP_INTERVAL and a few minutes. */
    stoppedAfterMs: z.number().int().nullable(),
    /** The runner's SWEEP_INTERVAL, from its latest heartbeat. */
    sweepIntervalMs: z.number().int().nullable(),
  }),
  /** Each kind of pass: when it last ran, from heartbeats, and the last one that recorded something. */
  passes: z.array(
    z.object({
      pass: KeeperPassKind,
      lastRanAt: z.iso.datetime().nullable(),
      lastRecorded: z
        .object({ at: z.iso.datetime(), sent: z.number().int(), held: z.number().int(), parked: z.number().int(), failed: z.number().int(), jobs: z.number().int() })
        .nullable(),
    }),
  ),
  /** The caps the runner runs with, from its latest heartbeat or recorded pass; null before either exists. */
  caps: KeeperCaps.nullable(),
  /** Today's spend (UTC), in lamports. */
  today: z.object({
    day: z.string(),
    spentTotal: z.number().int(),
    /** The most one of today's transactions cost, against MAX_TX_COST. */
    highestCost: z.number().int().nullable(),
    markets: z.array(z.object({ market: z.string(), spent: z.number().int() })),
  }),
  /** The latest pass's warnings, and when that pass ran. */
  warnings: z.object({ at: z.iso.datetime(), list: z.array(z.string()) }).nullable(),
  /** Jobs held by a cap today or parked, newest first. */
  waiting: z.array(KeeperJob),
  /** The latest recorded jobs, newest first. */
  recent: z.array(KeeperJob),
  /** Whether the records could be read: a database that does not answer leaves the rest of the page standing. */
  records: z.object({ ok: z.boolean(), error: z.string().nullable() }),
});
export type Keeper = z.infer<typeof Keeper>;
