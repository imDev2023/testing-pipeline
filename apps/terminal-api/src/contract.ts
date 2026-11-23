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

/** A strategy registered with the router (`GET /v1/strategies`, `GET /v1/strategies/{program}`). */
export const Strategy = z.object({
  program: Address,
  metadata_uri: z.string(),
  /** The listing fee paid, in lamports; null when the strategy was found by its account, without its event. */
  fee_paid: Amount.nullable(),
  registered_at: Time,
  registered_signature: z.string().nullable(),
  market_count: z.number().int(),
});
export type Strategy = z.infer<typeof Strategy>;

export const StrategiesList = z.object({ strategies: z.array(Strategy) });
export type StrategiesList = z.infer<typeof StrategiesList>;

/** One of a market's mints, in the market's own order, with what its vault holds. */
export const MarketMint = z.object({
  mint: Address,
  /** Aviary's own name for the mint (SOL, USDC); null for every other mint until token names land (#120). */
  symbol: z.string().nullable(),
  /** Null until the mint is read, or when its account is not a mint. */
  decimals: z.number().int().nullable(),
  vault: Address.nullable(),
  /** What the vault held when last read, in the mint's smallest units. */
  liquidity: Amount.nullable(),
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
});
export type Market = z.infer<typeof Market>;

/** Markets, newest first; `next` is the `before` of the following page, or null after the last. */
export const MarketsPage = z.object({ markets: z.array(Market), total: z.number().int(), next: z.string().nullable() });
export type MarketsPage = z.infer<typeof MarketsPage>;

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

/** Trades, newest first; `next` is the `before` of the following page, or null after the last. */
export const TradesPage = z.object({ trades: z.array(Trade), next: z.string().nullable() });
export type TradesPage = z.infer<typeof TradesPage>;
