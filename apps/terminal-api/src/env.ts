// Adapted from Top-pad b833a7b, apps/api/src/env.ts; owned here since.
// The bindings `wrangler.jsonc` gives `terminal-api`. Per-environment values (the cluster, the rate
// limits) live there; policy values the code uses live in ./config.

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
  /** The keeper runner's wallet (docs/spec/keeper-runner.md, "The keeper wallet"): the keeper page shows it, and only its signed heartbeats are kept. */
  KEEPER_WALLET: string;
};
