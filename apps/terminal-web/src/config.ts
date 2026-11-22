// The screens' config module (PIPESCOPE-85, docs/spec/pipescope-screens.md, "One place for every
// value"): every number and list a page uses. Colours, typefaces and the widths at which pages change
// shape are in ./theme.css; the name and fee label in ./brand.ts; fee rates, fee mints, the quote mint
// rule and the Telegram handles are read from the API and never written here.

/** Aviary's API. Baked in at build time, so each environment is built against its own (the local run's by default). */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8811";

/** The cluster Aviary reads: devnet only until Pipeline's router is on mainnet. */
export const CLUSTER = "devnet";

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

/** The chart: the candle lengths offered, in seconds, and the one it opens at. */
export const CHART_CANDLE_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60, 4 * 60 * 60, 24 * 60 * 60];
export const CHART_OPENS_AT_SECONDS = 15 * 60;

/** Paging. */
export const TRADES_SHOWN = 40;
export const FEED_ROWS_PER_LOAD = 50;

/** The feed's filters: each offers these thresholds, measured on a market's SOL side. */
export const FEED_FILTERS = {
  liquiditySol: [0.1, 1, 10],
  volume24hSol: [0.01, 0.1, 1],
  createdWithinHours: [1, 24, 7 * 24],
};

/** Search. */
export const SEARCH_PAUSE_MS = 220;
export const SEARCH_RESULTS_PER_GROUP = 20;
