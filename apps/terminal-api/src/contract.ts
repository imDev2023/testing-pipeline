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
