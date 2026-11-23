// `terminal-api`'s config module (PIPESCOPE-89): every policy value of the API, the indexer and
// the jobs that is not a per-environment var, as a named constant, so changing one is a change to
// one line (docs/spec/pipescope-architecture.md, "One place for every value"). Per-environment
// values (the rate limits, the integrator fee's settings, the Telegram handles) are vars and
// bindings in `wrangler.jsonc`. The pages and the Telegram bot read what they show from the API
// and never repeat a value written here.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/**
 * How often each job runs, in whole minutes (PIPESCOPE-28, PIPESCOPE-36): the every-minute cron
 * runs a job when the minute it fires on is a multiple of the job's interval (./dispatcher), so no
 * interval is written in `wrangler.jsonc`. Canary's schedule (CANARY-22, CANARY-23) joins with
 * Canary in the Container (#124).
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
} as const;

export type JobName = keyof typeof JOB_INTERVAL_MINUTES;

/** The indexer's live socket (PIPESCOPE-27, PIPESCOPE-28): reopened by this alarm while open, closed this long after the last viewer leaves. */
export const SOCKET_REOPEN_ALARM_MS = 15 * SECOND;
export const SOCKET_CLOSE_AFTER_LAST_VIEWER_MS = 3 * MINUTE;

/** Candle lengths in seconds and how long each is kept, in days; `null` keeps it forever (PIPESCOPE-30). Trades are kept forever. */
export const CANDLES: readonly { seconds: number; keepDays: number | null }[] = [
  { seconds: 1, keepDays: 7 },
  { seconds: 15, keepDays: 30 },
  { seconds: 60, keepDays: null },
  { seconds: 5 * 60, keepDays: null },
  { seconds: 15 * 60, keepDays: null },
  { seconds: 60 * 60, keepDays: null },
  { seconds: 4 * 60 * 60, keepDays: null },
  { seconds: 24 * 60 * 60, keepDays: null },
];

/** How long a live room gathers events before it sends them (PIPESCOPE-31). */
export const LIVE_ROOM_BATCH_MS = 100;

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
} as const;

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
