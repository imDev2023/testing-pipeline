// The screens' config module (PIPESCOPE-85, docs/spec/pipescope-screens.md, "One place for every
// value"): every number and list a page uses. Colours, typefaces and the widths at which pages change
// shape are in ./theme.css; the name and fee label in ./brand.ts; fee rates, fee mints, the quote mint
// rule and the Telegram handles are read from the API and never written here.

/** Aviary's API. Baked in at build time, so each environment is built against its own (the local run's by default). */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8811";

/** The cluster Aviary reads: devnet only until Pipeline's router is on mainnet. */
export const CLUSTER = "devnet";
/** The Wallet Standard chain a wallet signs for: Aviary's cluster. */
export const CHAIN = `solana:${CLUSTER}` as const;

/** The block explorer an address or a transaction links to, on the cluster above, whatever the address holds. */
export const EXPLORER = {
  address: (address: string) => `https://explorer.solana.com/address/${encodeURIComponent(address)}?cluster=${CLUSTER}`,
  transaction: (signature: string) => `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${CLUSTER}`,
};

/** Trading (docs/spec/pipescope.md, Trading). */
export const DEFAULT_SLIPPAGE_PERCENT = 1;
export const SLIPPAGE_CHOICES_PERCENT = [0.5, 1, 3];
export const MAX_SLIPPAGE_PERCENT = 50;
export const QUOTE_PAUSE_MS = 350;
/** SOL kept back for network fees and rent when the trader uses their whole balance. */
export const SOL_KEPT_BACK = 0.01;
/**
 * How old a prepared swap may be when the trader asks to sign it: its blockhash lasts about a minute,
 * so an older one is built and simulated again before the wallet is asked.
 */
export const PREPARED_SWAP_MAX_AGE_MS = 45_000;
/**
 * After a market is created in the create form (docs/spec/pipescope-screens.md, Create market): how
 * long the page waits for the API to have read the new market before it links its page anyway, and how
 * often it asks.
 */
export const NEW_MARKET_WAIT_MS = 60_000;
export const NEW_MARKET_ASK_EVERY_MS = 1_000;
/** How many of the program's last log lines a failed simulation shows behind its disclosure. */
export const FAILED_SIMULATION_LOG_LINES = 12;

/**
 * The chart (PIPESCOPE-75): the candle lengths offered, by the API's names for them, and the one it
 * opens at. The API also keeps 1 s and 15 s candles ("1s", "15s"), which this list can add.
 */
export const CHART_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export const CHART_OPENS_AT = "15m";
/** The room a chart gives each candle, in pixels, whatever its width, so a lone candle is drawn at a readable size (PIPESCOPE-112). */
export const CHART_CANDLE_SPACING_PX = 16;

/**
 * Live updates (docs/spec/pipescope-architecture.md, Live rooms; PIPESCOPE-111): the longest wait before a dropped
 * live room is joined again (each try waits twice the last, from a second), and the shortest gap
 * between two reads of the forming candle while trades land.
 */
export const LIVE_RECONNECT_MAX_MS = 15_000;
export const LIVE_CANDLE_REFRESH_MS = 1_000;

/** Paging. */
export const TRADES_SHOWN = 40;
export const FEED_ROWS_PER_LOAD = 50;

/**
 * The feed's filters (PIPESCOPE-72): each offers these steps, liquidity and volume measured on a
 * market's SOL side, in SOL; every filter starts off (PIPESCOPE-05).
 */
export const FEED_FILTERS = {
  liquiditySol: [0.1, 1, 10],
  volume24hSol: [0.01, 0.1, 1],
  createdWithinHours: [1, 24, 7 * 24],
};

/** Search (PIPESCOPE-81): the pause after the last keystroke before a search runs, and the results shown a group. */
export const SEARCH_PAUSE_MS = 220;
export const SEARCH_RESULTS_PER_GROUP = 20;

/**
 * The three examples shown when nothing is typed, each one that finds something on devnet (the
 * end-to-end tests check they still do), with what it shows can be searched for.
 */
export const SEARCH_EXAMPLES = [
  { query: "Sniper", what: "part of a strategy's name" },
  { query: "7BctW", what: "the start of a market's address" },
  { query: "dream", what: "part of a token's name, in any case" },
] as const;
