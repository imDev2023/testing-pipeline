// Adapted from Top-pad b833a7b, apps/api/src/env.ts; owned here since.
// The bindings `wrangler.jsonc` gives `terminal-api`. Per-environment values (the cluster, the rate
// limits) live there; policy values the code uses live in ./config.
import type { CanaryContainer } from "./canaryContainer";
import type { CanaryRun } from "./canaryRun";
import type { Indexer } from "./indexer";
import type { LiveRoom } from "./liveRoom";

/** The Workers rate-limiting binding: one call per request, counted per key over the binding's period. */
export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type Bindings = {
  /** The cluster this deployment reads; Aviary runs on devnet only until Pipeline's router is on mainnet. */
  CLUSTER: string;
  /** Postgres: Hyperdrive in front of Neon when deployed, the Docker Postgres in the local run. */
  HYPERDRIVE: Hyperdrive;
  /** The Solana RPC, a Helius devnet URL that carries its key: a secret, never shown or logged. */
  RPC_URL: string;
  /** The version of the code this Worker runs, which the indexer later checks against its own (Top-pad's `wake`). */
  CF_VERSION_METADATA: WorkerVersionMetadata;
  /** Per-IP limits (PIPESCOPE-90): reads; quotes, prepares and trade signatures; "This is wrong" reports. */
  READS: RateLimiter;
  TRADES: RateLimiter;
  REPORTS: RateLimiter;
  /** Public caches up to 60 s stale, and the copies of token images (PIPESCOPE-88). */
  TERMINAL_CACHE: KVNamespace;
  /** The indexer, one instance (docs/spec/pipescope-architecture.md, Indexer). */
  INDEXER: DurableObjectNamespace<Indexer>;
  /** The live rooms, one per market and one for the feed, by name (docs/spec/pipescope-architecture.md, Live rooms). */
  LIVE_ROOMS: DurableObjectNamespace<LiveRoom>;
  /**
   * Aviary's own address lookup table (PIPESCOPE-160): a frozen table of addresses every market shares,
   * which shortens a transaction that would not fit otherwise, such as a tax market's launch. Empty
   * for none; `apps/terminal-api/scripts/lookup-table.ts` makes one on a cluster.
   */
  AVIARY_LOOKUP_TABLE: string;
  /** The keeper runner's wallet (docs/spec/keeper-runner.md, "The keeper wallet"): the keeper page shows it, and only its signed heartbeats are kept. */
  KEEPER_WALLET: string;
  /**
   * The integrator fee (PIPESCOPE-10 to PIPESCOPE-13): its rate in basis points, the fee wallet Aviary
   * knows only by address, and that wallet's token account for each fee mint, whose keys are the fee
   * mints. A var per environment, so it changes by a configuration deploy (./trading/fees reads it).
   */
  INTEGRATOR_FEE: IntegratorFeeVar;
  /**
   * Only in the end-to-end tests (tests/terminal-e2e): the fixture server's address, through which
   * the metadata fetcher reads recorded documents instead of the web, as the API reads recorded RPC
   * answers there (PIPESCOPE-102). Never set in a deployment.
   */
  TEST_METADATA_FIXTURES?: string;
  /** Canary's runs, one per strategy version, by `<program>:<deploy slot>` (docs/spec/pipescope-architecture.md, "Canary runner"). */
  CANARY_RUNS: DurableObjectNamespace<CanaryRun>;
  /** Canary's one container, by the name `canary`. */
  CANARY_CONTAINER: DurableObjectNamespace<CanaryContainer>;
  /** The operator wallet, whose signed requests alone re-run Canary (`pnpm canary:rerun`). */
  CANARY_OPERATOR: string;
};

export type IntegratorFeeVar = { bps: number; wallet: string; accounts: Record<string, string> };
