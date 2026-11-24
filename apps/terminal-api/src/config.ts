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
  /** Reading every mint again, since its authorities, supply and extensions can change after it is made. */
  mintRefresh: 60,
  /** Dropping candles past their length's retention (`CANDLES`), once a day, so the database wakes for it rarely (PIPESCOPE-109). */
  pruneCandles: 24 * 60,
  /** Canary's scheduled sweep of every market (CANARY-23; docs/spec/pipescope-canary.md, When Canary runs). */
  canarySweep: 6 * 60,
  /**
   * Making each strategy's explainer key (EXPLAINER-23): a new version, a metadata change, changed
   * Canary outcomes or a new prompt or model each make a key within this interval; no model is called.
   */
  explainerKeys: 5,
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
 * The longest wait before the socket is tried again while it keeps failing to open (an RPC that
 * refuses `logsSubscribe`, say): each failed try waits twice the last, from SOCKET_REOPEN_ALARM_MS,
 * so a refusing RPC is not asked, and reconciled with, every 15 seconds while anyone watches (#214).
 * Meanwhile the every-minute reconciliation still brings each trade to the pages.
 */
export const SOCKET_REOPEN_BACKOFF_MAX_MS = 5 * MINUTE;

/**
 * How long the indexer waits for what the RPC has not served yet (Top-pad's measured waits): the
 * transactions the live socket reported, each asked for every `everyMs`, `atOnce` of them at a time
 * so a burst never floods the RPC, for up to `waitMs` from when its batch arrived, before each still
 * unserved is left to reconciliation (Helius serves a confirmed one 1.5 to 2 s after its block; a rate
 * limit is waited out, any other refusal is not asked again, #214); and a block,
 * for a transaction's place in it, asked for again after waits doubling from `firstRetryMs` to
 * `maxRetryMs`, for up to `waitMs`.
 */
export const RPC_WAITS = {
  transaction: { waitMs: 8 * SECOND, everyMs: 300, atOnce: 2 },
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
 * say) tries again ROOM_ANNOUNCE_RETRIES times, after ROOM_ANNOUNCE_RETRY_MS and then twice the last
 * wait each time, before leaving it to the next viewer.
 */
export const ROOM_ANNOUNCE_RETRY_MS = SECOND;
export const ROOM_ANNOUNCE_RETRIES = 2;

/** How often the trade fast path asks whether a signature has confirmed (PIPESCOPE-33). */
export const FAST_PATH_CONFIRMATION_POLL_MS = 300;
/**
 * How long the fast path waits for a signature to confirm before it answers that it has not yet: a
 * transaction's blockhash lasts about a minute, after which it can no longer land.
 */
export const FAST_PATH_WAIT_MS = 60 * SECOND;

/**
 * The metadata fetcher's limits (PIPESCOPE-36): `https:` only, a body of at most `maxBytes`, an
 * answer within `timeoutMs` (redirects and body included), at most `maxRedirects` redirects, each to
 * `https:`, and a JSON content type: one of `contentTypes`, or any type ending in `+json`. `text/plain`
 * is there because GitHub serves raw files and gists, where most devnet metadata lives, as it.
 */
export const METADATA_FETCH = {
  maxBytes: 64 * 1024,
  timeoutMs: 5 * SECOND,
  maxRedirects: 3,
  contentTypes: ["application/json", "text/plain"],
  /** How many documents are fetched at once, as after a backfill names every strategy. */
  concurrency: 4,
} as const;

/** The token images `terminal-api` keeps (PIPESCOPE-82): told by their first bytes, at most this size. */
export const TOKEN_IMAGE = {
  types: ["image/png", "image/jpeg", "image/webp"],
  maxBytes: 1024 * 1024,
} as const;

/** Solana's base fee for each signature a transaction carries, in lamports, which the Fees page states. */
export const LAMPORTS_PER_SIGNATURE = 5_000;

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
  /** Search results a group holds, the screens' 20 by default (PIPESCOPE-124). */
  search: { default: 20, max: 100 },
} as const;

/** The longest search the API takes, in characters: past any address or name it keeps (PIPESCOPE-124). */
export const SEARCH_QUERY_MAX = 100;

/** The longest note a "This is wrong" report may carry, in characters (PIPESCOPE-154). */
export const REPORT_NOTE_MAX = 600;

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
   * The one container: asleep this long after its last run, answering on this port; a run waits at
   * most `queueWaitMs` for its turn and is given `answerTimeoutMs`; after a start, the binary is
   * asked for `/health` every `readyEveryMs`, `readyAttempts` times, before a run is posted.
   */
  container: { sleepAfter: "2m", port: 8080, queueWaitMs: 3 * MINUTE, answerTimeoutMs: 4 * MINUTE, readyEveryMs: 250, readyAttempts: 40 },
  /**
   * No snapshot round of a market starts once its rounds have taken this long, so the worst round
   * (a wait for the container's turn and its answer, 7 minutes) still ends within a Durable Object
   * alarm's 15 minutes; the market is tried again on a later alarm.
   */
  marketBudgetMs: 6 * MINUTE,
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

/**
 * A market's state read with named outside accounts at one slot, for the products' panels in Aviary
 * (PIPESCOPE-146; docs/spec/README.md, Our products live inside Aviary): the most accounts a read may
 * name besides the market's state, and the most bytes of one account's data it returns (a larger
 * account comes back with its size and no data), so the public read is no general RPC on Aviary's key.
 */
export const MARKET_READ = { maxAccounts: 8, maxAccountBytes: 64 * 1024 } as const;

/**
 * The most SOL, in lamports, a strategy's setup may take from the creator of a new market made in
 * Aviary's create form, which `create_market` carries as its `max_creator_lamports` (PIPESCOPE-144):
 * 0.1 SOL, the cap our own demos create markets with; what the setup takes is shown by the simulation.
 */
export const CREATE_MARKET_MAX_CREATOR_LAMPORTS = 100_000_000n;
