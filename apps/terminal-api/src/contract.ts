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
// A refusal from a strategy or the chain also carries the failure decoded (Failure, below) as `failure`.
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

// ---- Trading (docs/spec/pipescope-architecture.md, Trading path) ----

/** A fee mint: the integrator fee is charged only on swaps paying in one, into the fee wallet's account for it. */
export const FeeMint = z.object({ mint: Address, symbol: z.string(), account: Address });
export type FeeMint = z.infer<typeof FeeMint>;

/**
 * `GET /v1/fees`: every rate a page shows (PIPESCOPE-10 to PIPESCOPE-13, PIPESCOPE-91): Pipeline's own,
 * the router's, and Aviary's integrator fee with the mints it is charged in and the wallet it goes to.
 */
export const Fees = z.object({
  pipeline_fee_bps: z.number().int(),
  integrator_fee_bps: z.number().int(),
  fee_wallet: Address,
  fee_mints: z.array(FeeMint),
  /** Solana's network fee for each signature, in lamports. */
  network_fee_per_signature: z.number().int(),
});
export type Fees = z.infer<typeof Fees>;

/**
 * A refused quote or a failed simulation, decoded (docs/spec/pipescope-screens.md, "On every page"):
 * its class, the sentence a page shows, the Anchor error's name, number and message when there is one,
 * the program that raised it, and the raw error to show beneath.
 */
export const Failure = z.object({
  class: z.enum(["too_little", "strategy_refused", "router_refused", "token_program_refused", "other_refused", "cannot_read_state", "crash", "out_of_compute", "unavailable"]),
  sentence: z.string(),
  name: z.string().nullable(),
  number: z.number().int().nullable(),
  message: z.string().nullable(),
  program: z.string().nullable(),
  raw: z.string(),
});
export type Failure = z.infer<typeof Failure>;

/** A refusal from a strategy or the chain: the sentence, the failure decoded with its raw error, and the program's log lines when a simulation gave them. */
export const Refusal = ApiError.extend({ failure: Failure, logs: z.array(z.string()).optional() });
export type Refusal = z.infer<typeof Refusal>;

/**
 * `GET /v1/quote?market=&input_mint=&output_mint=&amount=&trader=`: a quote for the amount typed, which
 * is everything that leaves the wallet for the swap (PIPESCOPE-76), from an RPC simulation of the
 * strategy's `pipeline_quote` (PIPESCOPE-34), with the rates it was worked out at (PIPESCOPE-91).
 */
export const Quote = z.object({
  market: Address,
  input_mint: Address,
  output_mint: Address,
  /** The amount typed: what leaves the wallet, fees included. */
  amount: Amount,
  /** Which side Pipeline's fee is taken on: the input, or the output on a trade into the market's fee mint. */
  fee_side: z.enum(["input", "output"]),
  pipeline_fee_bps: z.number().int(),
  /** The integrator fee's rate on this swap: 0 unless the trader pays in a fee mint. */
  integrator_fee_bps: z.number().int(),
  /** What goes into the market. */
  net_sent: Amount,
  /** Pipeline's fee, in `pipeline_fee_mint`: the input mint, or the output mint on a trade into the market's fee mint. */
  pipeline_fee: Amount,
  pipeline_fee_mint: Address,
  integrator_fee: Amount,
  /** Everything that leaves the wallet for the swap: at most the amount typed. */
  total_spend: Amount,
  /** What the strategy sends. */
  strategy_amount_out: Amount,
  /** What the trader is expected to receive: the strategy's output, less Pipeline's fee when it is taken there. */
  expected_out: Amount,
  compute_units: z.number().int().nullable(),
});
export type Quote = z.infer<typeof Quote>;

/** `POST /v1/swaps/prepare`: the swap to build, for the trader who will sign it. */
export const PrepareSwapRequest = z
  .object({
    market: Address,
    input_mint: Address,
    output_mint: Address,
    amount: Amount,
    /** The slippage accepted, in basis points, up to 50% (the screens' config module's highest). */
    slippage_bps: z.number().int().min(0).max(5_000),
    trader: Address,
  })
  .strict();
export type PrepareSwapRequest = z.infer<typeof PrepareSwapRequest>;

/** How one account the wallet owns changes: SOL when `mint` is null, else a token account. */
export const BalanceChange = z.object({ mint: Address.nullable(), account: Address, before: Amount, after: Amount });
export type BalanceChange = z.infer<typeof BalanceChange>;

/** The simulation of the exact transaction returned (docs/spec/pipescope-architecture.md, Simulation before every signature). */
export const Simulation = z.object({
  ok: z.boolean(),
  failure: Failure.nullable(),
  logs: z.array(z.string()),
  compute_units: z.number().int().nullable(),
  /** What signing would change in the wallet: its SOL and each token account the transaction touches. */
  changes: z.array(BalanceChange),
  /** The network fee, in lamports. */
  network_fee: Amount,
  /** Token accounts the transaction creates for the wallet and keeps, with the rent each holds. */
  new_accounts: z.array(z.object({ account: Address, mint: Address, rent: Amount })),
  /** What the swap takes from the wallet in the mint paid, and gives in the mint received, measured in the simulation; null when it failed. */
  paid: Amount.nullable(),
  received: Amount.nullable(),
});
export type Simulation = z.infer<typeof Simulation>;

/** The prepared swap: its quote, the minimum after slippage, and the unsigned transaction, only when its simulation passed. */
export const PreparedSwap = z.object({
  quote: Quote,
  slippage_bps: z.number().int(),
  min_amount_out: Amount,
  /** The unsigned transaction, base64, exactly as simulated; null when the simulation failed, so there is nothing to sign. */
  transaction: z.string().nullable(),
  simulation: Simulation,
});
export type PreparedSwap = z.infer<typeof PreparedSwap>;

/** `POST /v1/trades`: a trade's signature, from the page that sent it (the fast path, PIPESCOPE-33). */
export const TradeSignature = z
  .object({
    signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/),
    /** The market traded, so a swap that failed on chain is decoded with its strategy named. */
    market: Address.optional(),
  })
  .strict();
export type TradeSignature = z.infer<typeof TradeSignature>;

/**
 * The fast path's answer: the transaction's swaps, read back once it confirmed, each under a provisional
 * order key (no place in its block yet, `block_index` null) that the indexer replaces in place.
 */
export const TradeReport = z.object({ signature: z.string(), slot: z.number().int(), trades: z.array(Trade) });
export type TradeReport = z.infer<typeof TradeReport>;

/** `GET /v1/traders/{trader}/balances?mints=`: what the wallet holds in each mint asked; for wrapped SOL, its plain SOL, which a swap wraps. */
export const Balances = z.object({ trader: Address, balances: z.array(z.object({ mint: Address, amount: Amount })) });
export type Balances = z.infer<typeof Balances>;
