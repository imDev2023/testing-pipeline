// `terminal-api`'s config module (PIPESCOPE-89): every policy value of the API, the indexer and
// the jobs that is not a per-environment var, as a named constant, so changing one is a change to
// one line (docs/spec/pipescope-architecture.md, "One place for every value"). Per-environment
// values (the rate limits, the integrator fee's settings, the Telegram handles) are vars and
// bindings in `wrangler.jsonc`. The pages and the Telegram bot read what they show from the API
// and never repeat a value written here.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How often each job runs, in whole minutes (PIPESCOPE-28, PIPESCOPE-36): the every-minute cron
 * runs a job when the minute it fires on is a multiple of the job's interval (./dispatcher), so no
 * interval is written in `wrangler.jsonc`.
 */
export const JOB_INTERVAL_MINUTES = {
  /** Reconciliation of the router's history from its cursor. */
  reconcileRouter: 1,
  /** Reconciliation of every watched strategy program's history. */
  reconcileStrategies: 5,
  /** `getProgramAccounts` on the router for `Strategy` and `Market` accounts not yet indexed. */
  registrySnapshot: 10,
  /** Each strategy's and the router's last-deploy slot, read in one `getMultipleAccounts` per 100 programs. */
  programDataWatch: 1,
  /** Polling running verified builds. */
  verifiedBuilds: 1,
  /** Re-fetching every strategy's metadata, since the document behind an unchanged URI can change. */
  metadataRefetch: 60,
  /** Dropping candles past their length's retention (`CANDLES`), once a day, so the database wakes for it rarely (PIPESCOPE-109). */
  pruneCandles: 24 * 60,
  /** Canary's scheduled sweep of every market (CANARY-23; docs/spec/pipescope-canary.md, When Canary runs). */
  canarySweep: 6 * 60,
} as const;

export type JobName = keyof typeof JOB_INTERVAL_MINUTES;

/**
 * How many ProgramData watches look again for a strategy version's deploy transaction the RPC had
 * not served when the version was recorded, before leaving it without one (PIPESCOPE-113).
 */
export const VERSION_TRANSACTION_LOOKS = 30;

/** The indexer's live socket (PIPESCOPE-27, PIPESCOPE-28): reopened by this alarm while open, closed this long after the last viewer leaves. */
export const SOCKET_REOPEN_ALARM_MS = 15 * SECOND;
export const SOCKET_CLOSE_AFTER_LAST_VIEWER_MS = 3 * MINUTE;

/**
 * How long the indexer waits for what the RPC has not served yet (Top-pad's measured waits): a
 * transaction the live socket reported, asked for every `everyMs` for up to `waitMs` before it is
 * left to reconciliation (Helius serves a confirmed one 1.5 to 2 s after its block); and a block,
 * for a transaction's place in it, asked for again after waits doubling from `firstRetryMs` to
 * `maxRetryMs`, for up to `waitMs`.
 */
export const RPC_WAITS = {
  transaction: { waitMs: 8 * SECOND, everyMs: 300 },
  block: { waitMs: 8 * SECOND, firstRetryMs: 500, maxRetryMs: 2 * SECOND },
} as const;

/**
 * The most new swaps a live room is sent in one publish (PIPESCOPE-110): past it, as after a long
 * backlog, the room is told to resync through the API instead, which pages what it missed.
 */
export const LIVE_ROOM_TRADES_MAX = 100;

/**
 * Candle lengths, each with the name the API's `interval` takes, and how long each is kept, in days;
 * `null` keeps it forever (PIPESCOPE-30). Trades are kept forever.
 */
export const CANDLES: readonly { interval: string; seconds: number; keepDays: number | null }[] = [
  { interval: "1s", seconds: 1, keepDays: 7 },
  { interval: "15s", seconds: 15, keepDays: 30 },
  { interval: "1m", seconds: 60, keepDays: null },
  { interval: "5m", seconds: 5 * 60, keepDays: null },
  { interval: "15m", seconds: 15 * 60, keepDays: null },
  { interval: "1h", seconds: 60 * 60, keepDays: null },
  { interval: "4h", seconds: 4 * 60 * 60, keepDays: null },
  { interval: "1d", seconds: 24 * 60 * 60, keepDays: null },
];

/**
 * How many significant digits the API writes a price to (PIPESCOPE-107): candles keep each price
 * exactly, so this is only how finely it is written out, well past what any page shows and past the
 * precision Pipeline's hosted API writes (about 19 significant digits), so a parity check rounds ours
 * to each of its values and compares them exactly.
 */
export const PRICE_SIGNIFICANT_DIGITS = 36;

/** How long a live room gathers events before it sends them (PIPESCOPE-31). */
export const LIVE_ROOM_BATCH_MS = 100;

/**
 * A live room that could not tell the indexer a viewer arrived (the indexer resetting for a deploy,
 * say) tries again after this wait, and after twice it, before leaving it to the next viewer.
 */
export const ROOM_ANNOUNCE_RETRY_MS = SECOND;

/** How often the trade fast path asks whether a signature has confirmed (PIPESCOPE-33). */
export const FAST_PATH_CONFIRMATION_POLL_MS = 300;

/** The metadata fetcher's limits (PIPESCOPE-36). */
export const METADATA_FETCH = {
  maxBytes: 64 * 1024,
  timeoutMs: 5 * SECOND,
  maxRedirects: 3,
} as const;

/** The token images `terminal-api` keeps (PIPESCOPE-82): told by their first bytes, at most this size. */
export const TOKEN_IMAGE = {
  types: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 1024 * 1024,
} as const;

/** Wrapped SOL, and the cluster's USDC: Circle's devnet mint (docs/spec/pipescope.md, The integrator fee). */
export const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
export const CLUSTER_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/**
 * The quote mint order (PIPESCOPE-74): wrapped SOL, then the cluster's USDC, then the later mint of
 * the pair in the market's own order (./pairs).
 */
export const QUOTE_MINT_ORDER = [WRAPPED_SOL, CLUSTER_USDC] as const;

/**
 * The names Aviary itself gives mints, set plainly as its own words; every other name is its
 * author's and comes with token names (#120).
 */
export const AVIARY_MINT_NAMES: Readonly<Record<string, string>> = { [WRAPPED_SOL]: "SOL", [CLUSTER_USDC]: "USDC" };

/** How far back a market's volume and trade count reach (docs/spec/pipescope-screens.md, Feed). */
export const VOLUME_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * Paging of the read endpoints: how many rows a page holds when the caller names no limit, and the
 * most it may ask for. The pages ask for what the screens' config says (50 feed rows, 40 trades).
 */
export const PAGE_LIMITS = {
  markets: { default: 50, max: 200 },
  trades: { default: 40, max: 1000 },
  /** The newest candles of one length a chart is given, and the most asked for at once (PIPESCOPE-107). */
  candles: { default: 1000, max: 5000 },
} as const;

/** The most signers an instruction lists in `GET /v1/strategies/{program}/instructions`, most calls first; the answer counts them all. */
export const INSTRUCTION_SIGNERS_SHOWN = 100;

/** How stale a public cache may be (PIPESCOPE-32). */
export const PUBLIC_CACHE_MAX_AGE_SECONDS = 60;

/**
 * The period of every rate-limiting binding in `wrangler.jsonc`, where the limits themselves live
 * (PIPESCOPE-90): a refused request is told to wait this long. A test checks it equals each
 * binding's `simple.period`, so the two never disagree.
 */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/** How long `/health` waits for the RPC and for the database before calling them unreachable. */
export const HEALTH_TIMEOUT_MS = 5 * SECOND;

/**
 * The keeper page (PIPESCOPE-104; docs/spec/keeper-runner.md, "How Aviary shows it"): the runner
 * looks stopped once its last heartbeat is older than its own SWEEP_INTERVAL, which the heartbeat
 * carries, and this much more; the page lists this many of the latest recorded jobs.
 */
export const KEEPER_STOPPED_GRACE_MS = 5 * MINUTE;
export const KEEPER_RECENT_JOBS = 20;

/**
 * The keeper runner's heartbeats (SUITE-57): one is kept only if its time is within this much of
 * the Worker's clock, so an old one cannot be replayed, and at most one of each kind of pass is
 * written to KV this often, however often the runner posts.
 */
export const KEEPER_HEARTBEAT_MAX_SKEW_MS = 2 * MINUTE;
export const KEEPER_HEARTBEAT_MIN_GAP_MS = 30 * SECOND;

/**
 * Canary's runs (docs/spec/pipescope-architecture.md, "Canary runner"; docs/spec/pipescope-canary.md,
 * When Canary runs, the one place the schedule is stated; CANARY-22, CANARY-23). The checks' own
 * policy values are in `crates/canary/src/config.rs` (CANARY-28), the snapshot rounds among them
 * (CANARY-25), which the binary counts.
 */
export const CANARY = {
  /** A market created or registered is run at once, and again this long after it was found (CANARY-22). */
  marketCreatedDelaysMs: [0, 10 * MINUTE, HOUR, DAY],
  /**
   * The one container: asleep this long after its last run, answering on this port, each run given
   * this long; after a start, its binary is asked for `/health` this often, this many times, before a run is posted.
   */
  container: { sleepAfter: "2m", port: 8080, answerTimeoutMs: 5 * MINUTE, readyEveryMs: 250, readyAttempts: 40 },
  /**
   * A market whose snapshot or run failed (the RPC, or the container restarting) is tried again on
   * the run's alarm, after waits doubling from the first to the longest, up to this many attempts in
   * all; then Aviary records that it could not run it and the run goes on.
   */
  retry: { attempts: 6, firstDelayMs: 30 * SECOND, maxDelayMs: 10 * MINUTE },
  /**
   * How many times a run waits for the ProgramData watch to record a newer version, when the chain's
   * strategy executable is no longer the version's, before giving up on the market, 1 minute apart.
   */
  versionWaits: { attempts: 5, delayMs: MINUTE },
  /**
   * The most snapshot rounds a market may take before Aviary calls the binary broken: the binary
   * answers with results by CANARY-25's last round (4), so this only guards against a broken one.
   */
  roundsGuard: 8,
  /** How long a new market's runs wait for the watch to record its strategy's version before Canary passes them by. */
  versionWaitMs: 30 * MINUTE,
  /** An operator's re-run (`pnpm canary:rerun`) is taken only if its time is within this much of the Worker's clock, so an old one cannot be replayed. */
  rerunMaxSkewMs: 2 * MINUTE,
} as const;
