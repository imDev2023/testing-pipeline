// Adapted from Top-pad b833a7b, apps/api/src/indexer.ts (the Indexer Durable Object and its `wake`);
// owned here since, without Heat's graduated pools, Bundle Radar and keeper starts.
//
// The indexer as one Durable Object (docs/spec/pipescope-architecture.md, Indexer). The every-minute
// cron's dispatcher calls it with the jobs ./config makes due; its work is ./indexerCore. It keeps
// nothing in its own storage yet: the live socket and its alarm come with the live rooms (#118).
import { DurableObject } from "cloudflare:workers";
import { createDb } from "terminal-db";
import { RpcError } from "terminal-indexer";
import type { Bindings } from "./env";
import { IndexerCore } from "./indexerCore";

/** `GET /v1/indexer`: how the indexer stands, with no secret in it. */
export type IndexerStatus = {
  /** The version of the Worker's code the indexer runs. */
  version: string | null;
  /** The newest router transaction indexed, once known. */
  cursor: { signature: string; slot: number } | null;
  reconciledAt: string | null;
  snapshotAt: string | null;
  /** What last failed, by job and kind of error; its detail stays in the logs, since it can name the database's host. */
  lastError: string | null;
};

export class Indexer extends DurableObject<Bindings> {
  private core: IndexerCore | null = null;
  private reconciledAt: string | null = null;
  private snapshotAt: string | null = null;
  private lastError: string | null = null;

  private indexer(): IndexerCore {
    this.core ??= new IndexerCore({ rpcUrl: this.env.RPC_URL, openDb: () => createDb(this.env.HYPERDRIVE.connectionString) });
    return this.core;
  }

  /**
   * An object kept busy can go on running the code from before a deploy (Top-pad's lesson of
   * 2026-10-29), so given the version of the Worker calling it, it resets itself when it runs
   * another, and the runtime starts it again on the Worker's version.
   */
  private checkVersion(version: string | undefined) {
    const own = this.env.CF_VERSION_METADATA?.id;
    if (version && own && version !== own) this.ctx.abort(`the indexer runs version ${own}, and the Worker calling it ${version}`);
  }

  /** Reconciles the router from its cursor; the first run backfills its whole history. */
  async reconcile(version?: string): Promise<IndexerStatus> {
    this.checkVersion(version);
    try {
      await this.indexer().reconcile();
      this.reconciledAt = new Date().toISOString();
    } catch (e) {
      this.failed("reconciling the router", e);
      throw e;
    }
    return this.status();
  }

  /** The registry snapshot. */
  async snapshot(version?: string): Promise<IndexerStatus> {
    this.checkVersion(version);
    try {
      await this.indexer().snapshot();
      this.snapshotAt = new Date().toISOString();
    } catch (e) {
      this.failed("taking the registry snapshot", e);
      throw e;
    }
    return this.status();
  }

  /** Drops candles past their retention, once a day. */
  async prune(version?: string): Promise<number> {
    this.checkVersion(version);
    try {
      return await this.indexer().prune();
    } catch (e) {
      this.failed("dropping candles past their retention", e);
      throw e;
    }
  }

  status(): IndexerStatus {
    const cursor = this.core?.position() ?? null;
    return {
      version: this.env.CF_VERSION_METADATA?.id ?? null,
      cursor: cursor && { signature: cursor.signature, slot: cursor.slot },
      reconciledAt: this.reconciledAt,
      snapshotAt: this.snapshotAt,
      lastError: this.lastError,
    };
  }

  private failed(what: string, e: unknown) {
    // RPC errors never quote the URL (terminal-indexer's rpc.ts); others are named by kind only.
    const detail = e instanceof RpcError ? e.message : e instanceof Error ? e.name : typeof e;
    this.lastError = `${new Date().toISOString()} ${what}: ${detail}`;
    console.error(`the indexer failed ${what}`, e);
  }
}
