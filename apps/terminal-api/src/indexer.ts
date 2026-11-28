// Adapted from Top-pad b833a7b, apps/api/src/indexer.ts (the Indexer Durable Object and its `wake`);
// owned here since, without Heat's graduated pools, Bundle Radar and keeper starts.
//
// The indexer as one Durable Object (docs/spec/pipescope-architecture.md, Indexer). The every-minute
// cron's dispatcher calls it with the jobs ./config makes due; its work is ./indexerCore. Its live
// source, a `logsSubscribe` socket held only while a live room has a viewer, is ./liveSocket, whose
// state and alarm live in this object's storage, the only thing it keeps there (Data); what it
// indexes is published to the rooms with a viewer (./liveRoom).
import { DurableObject } from "cloudflare:workers";
import { createDb } from "terminal-db";
import { startCanary } from "./canary";
import { drainCanaryOutbox } from "./canaryTriggers";
import { makeExplainerKeys } from "./explainer";
import { logsSubscribeRequest, parseLogsMessage, RpcError, type IndexResult } from "terminal-indexer";
import type { Bindings } from "./env";
import { IndexerCore, ROUTER } from "./indexerCore";
import { kvImageStore } from "./tokenImages";
import { webFetchFor } from "./webFetch";
import { LiveSocket, type LiveSocketState, type LiveStatus } from "./liveSocket";

/** `GET /v1/indexer`: how the indexer stands, with no secret in it. */
export type IndexerStatus = {
  /** The version of the Worker's code the indexer runs. */
  version: string | null;
  /** The newest router transaction indexed, once known. */
  cursor: { signature: string; slot: number } | null;
  reconciledAt: string | null;
  snapshotAt: string | null;
  /** When every strategy program was last reconciled. */
  strategiesReconciledAt: string | null;
  /** When the ProgramData watch last ran. */
  watchedAt: string | null;
  /** What last failed, by job and kind of error; its detail stays in the logs, since it can name the database's host. */
  lastError: string | null;
  /** The live socket: whether it is open, the rooms with a viewer keeping it so, when it closes, when and why it last opened or closed, and how long it has been open this UTC day (PIPESCOPE-169). */
  live: { open: boolean; rooms: string[]; closesAt: string | null; changedAt: string | null; reason: string | null; openTodayMs: number };
};

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const LIVE_STATE = "live";

export class Indexer extends DurableObject<Bindings> {
  private core: IndexerCore | null = null;
  private reconciledAt: string | null = null;
  private snapshotAt: string | null = null;
  private strategiesReconciledAt: string | null = null;
  private watchedAt: string | null = null;
  private lastError: string | null = null;

  private canaryDrain: Promise<void> = Promise.resolve();

  /**
   * After a job that woke Postgres, Canary's triggers read the outbox on from their cursor
   * (./canaryTriggers), so the database is never woken only to look (PIPESCOPE-127). The drain runs
   * behind the job, which returns (and publishes its trades) without waiting for it.
   */
  private async afterJob<T>(work: () => Promise<T>): Promise<T> {
    const before = this.indexer().databaseUses();
    try {
      return await work();
    } finally {
      if (this.indexer().databaseUses() !== before) this.ctx.waitUntil(this.drainOutbox());
    }
  }

  /**
   * Reads Canary's triggers from the outbox: every drain goes through this one object, one at a
   * time, so no event is read by two drains at once (the sweep job asks for it here too).
   */
  async drainOutbox(): Promise<void> {
    this.canaryDrain = this.canaryDrain.then(() => this.drainCanary());
    await this.canaryDrain;
  }

  private async drainCanary(): Promise<void> {
    const { db, close } = createDb(this.env.HYPERDRIVE.connectionString);
    try {
      await drainCanaryOutbox(db, startCanary(this.env), Date.now());
    } catch (e) {
      this.failed("starting Canary's runs from the outbox", e);
    } finally {
      await close();
    }
  }

  private indexer(): IndexerCore {
    this.core ??= new IndexerCore({
      rpcUrl: this.env.RPC_URL,
      openDb: () => createDb(this.env.HYPERDRIVE.connectionString),
      webFetch: webFetchFor(this.env),
      images: kvImageStore(this.env.TERMINAL_CACHE),
    });
    return this.core;
  }

  private readonly live = new LiveSocket({
    now: () => Date.now(),
    load: () => this.ctx.storage.get<LiveSocketState>(LIVE_STATE),
    save: (state) => this.ctx.storage.put(LIVE_STATE, state),
    setAlarm: (at) => this.ctx.storage.setAlarm(at),
    clearAlarm: () => this.ctx.storage.deleteAlarm(),
    // The router; strategy programs join with strategy versions (#117).
    accounts: () => [ROUTER],
    connect: (accounts, on) => this.openSocket(accounts, on),
    reconcile: async () => void (await this.reconcile()),
    transactions: (signatures) => this.reported(signatures),
    viewersIn: (room) => this.env.LIVE_ROOMS.get(this.env.LIVE_ROOMS.idFromName(room)).viewers(),
    log: (line) => console.log(line),
  });

  /** A live room's first viewer arrived (./liveRoom): the socket opens. */
  async arrived(room: string): Promise<void> {
    await this.live.arrived(room);
  }

  /** A live room's last viewer left: once none has one, the socket closes after the grace. */
  async left(room: string): Promise<void> {
    await this.live.left(room);
  }

  /**
   * The trade fast path's hand-off (./trading/fastPath): a signature a page sent and the API read back,
   * indexed as the live socket's are, and sent to the rooms with a viewer, so the page's provisional
   * row is replaced by the trade with its place in its block.
   */
  async fastPath(signatures: string[]): Promise<void> {
    this.reported(signatures);
  }

  /** The socket's alarm (./liveSocket). */
  async alarm(): Promise<void> {
    await this.live.alarm();
  }

  /**
   * The RPC's WebSocket, a `logsSubscribe` on each account, reporting each successful transaction, and
   * saying once the RPC has confirmed every subscription, or refused one.
   */
  private async openSocket(
    accounts: string[],
    on: { transaction: (signature: string) => void; subscribed: () => void; refused: (error: string) => void; dropped: () => void },
  ): Promise<{ close: () => void }> {
    const response = await fetch(this.env.RPC_URL, { headers: { upgrade: "websocket" } });
    const socket = response.webSocket;
    // The RPC's URL carries its key, so only the status is named.
    if (!socket) throw new Error(`the RPC answered ${response.status} to a WebSocket upgrade`);
    socket.accept();
    const confirmed = new Set<number>();
    socket.addEventListener("message", (event) => {
      const message = parseLogsMessage(typeof event.data === "string" ? event.data : "");
      if (message.kind === "transaction" && !message.failed) on.transaction(message.signature);
      else if (message.kind === "subscribed") {
        confirmed.add(message.id);
        if (confirmed.size === accounts.length) on.subscribed();
      } else if (message.kind === "refused") {
        // A socket without its subscription reports nothing: closed, and tried again after a wait that grows while it is refused (./liveSocket).
        this.failed("subscribing on the live socket", new Error(message.error));
        socket.close(1011, "subscription refused");
        on.refused(message.error);
      }
    });
    socket.addEventListener("close", () => on.dropped());
    socket.addEventListener("error", () => on.dropped());
    accounts.forEach((account, i) => socket.send(logsSubscribeRequest(i + 1, account)));
    return { close: () => socket.close(1000, "no viewer") };
  }

  /**
   * Transactions the socket or the fast path reported, each indexed and published as soon as it is
   * served; a batch starts at once, never waiting on an earlier one the RPC is slow to serve (#214).
   */
  private reported(signatures: string[]) {
    void this.afterJob(() => this.indexer().indexSignatures(signatures, (one) => this.publish(one))).catch((e: unknown) =>
      this.failed("indexing what the live socket reported", e),
    );
  }

  /** Sends what was indexed to the rooms with a viewer; with none, nothing is read or sent. */
  private async publish(indexed: IndexResult) {
    const { rooms } = await this.live.status();
    if (!rooms.length) return;
    const events = await this.indexer().events(indexed, rooms);
    await Promise.all(
      [...events].map(([room, batch]) =>
        this.env.LIVE_ROOMS.get(this.env.LIVE_ROOMS.idFromName(room))
          .publish(batch)
          .catch((e: unknown) => console.error(`publishing to ${room} failed`, e)),
      ),
    );
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
      const { indexed } = await this.afterJob(() => this.indexer().reconcile());
      this.reconciledAt = new Date().toISOString();
      // What reconciliation found reaches the pages too: the socket's misses, and every trade while it is closed.
      await this.publish(indexed).catch((e: unknown) => this.failed("publishing what reconciliation indexed", e));
      // Then the metadata of every strategy a run noted, this one's or the live socket's since.
      await this.fetchMetadata();
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
      await this.afterJob(() => this.indexer().snapshot());
      this.snapshotAt = new Date().toISOString();
      await this.fetchMetadata();
    } catch (e) {
      this.failed("taking the registry snapshot", e);
      throw e;
    }
    return this.status();
  }

  /** Reconciles every strategy program from its own cursor, storing every call on it. */
  async reconcileStrategies(version?: string): Promise<IndexerStatus> {
    this.checkVersion(version);
    try {
      await this.afterJob(() => this.indexer().reconcileStrategies());
      this.strategiesReconciledAt = new Date().toISOString();
    } catch (e) {
      this.failed("reconciling the strategy programs", e);
      throw e;
    }
    return this.status();
  }

  /** The ProgramData watch: a new version of the router or of a strategy is recorded. */
  async watchPrograms(version?: string): Promise<IndexerStatus> {
    this.checkVersion(version);
    try {
      await this.afterJob(() => this.indexer().watchPrograms());
      this.watchedAt = new Date().toISOString();
    } catch (e) {
      this.failed("watching the programs' deploys", e);
      throw e;
    }
    return this.status();
  }

  /**
   * Fetches the metadata of the strategies indexing noted, then the images of the tokens it read; a
   * failure is reported, and what failed is looked for again on the next run.
   */
  private async fetchMetadata(): Promise<void> {
    await this.indexer()
      .fetchPendingMetadata()
      .catch((e: unknown) => this.failed("fetching strategies' metadata", e));
    await this.fetchImages();
  }

  /** Fetches the images of the tokens whose mints were read since the last look (./tokenImages). */
  private async fetchImages(): Promise<void> {
    await this.indexer()
      .fetchPendingImages()
      .catch((e: unknown) => this.failed("fetching tokens' images", e));
  }

  /** Fetches every strategy's metadata again, every hour. */
  async refetchMetadata(version?: string): Promise<void> {
    this.checkVersion(version);
    try {
      await this.indexer().refetchMetadata();
    } catch (e) {
      this.failed("fetching every strategy's metadata again", e);
      throw e;
    }
  }

  /** Reads every mint again, every hour. */
  async refreshMints(version?: string): Promise<void> {
    this.checkVersion(version);
    try {
      await this.indexer().refreshMints();
    } catch (e) {
      this.failed("reading every mint again", e);
      throw e;
    }
    await this.fetchImages();
  }

  /**
   * The explainer's keys (./explainer): each strategy's current version's key, recorded pending with
   * its evidence when new, made only when Postgres may hold something that changes one
   * (IndexerCore's `explainerKeys`), so a quiet devnet never wakes the database for them (#192).
   */
  async explainerKeys(version?: string): Promise<void> {
    this.checkVersion(version);
    try {
      // A strategy whose product's facts could not be read now is tried again on the next run.
      const outcome = await this.indexer().explainerKeys(
        (db) => makeExplainerKeys(db, { rpcUrl: this.env.RPC_URL }),
        (made) => made.unread.length > 0,
      );
      if (outcome && Object.values(outcome).some((programs) => programs.length)) console.log("explainer keys", outcome);
    } catch (e) {
      this.failed("making the explainer's keys", e);
      throw e;
    }
  }

  /** Canary recorded results (./canaryRun), which can change an explainer key: the next `explainerKeys` job makes them. */
  async canaryRecorded(): Promise<void> {
    this.indexer().canaryRecorded();
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

  async status(): Promise<IndexerStatus> {
    const cursor = this.core?.position() ?? null;
    const live: LiveStatus = await this.live.status();
    return {
      version: this.env.CF_VERSION_METADATA?.id ?? null,
      cursor: cursor && { signature: cursor.signature, slot: cursor.slot },
      reconciledAt: this.reconciledAt,
      snapshotAt: this.snapshotAt,
      strategiesReconciledAt: this.strategiesReconciledAt,
      watchedAt: this.watchedAt,
      lastError: this.lastError,
      live: { open: live.open, rooms: live.rooms, closesAt: iso(live.closesAt), changedAt: iso(live.changedAt), reason: live.reason, openTodayMs: live.openTodayMs },
    };
  }

  private failed(what: string, e: unknown) {
    // RPC errors never quote the URL (terminal-indexer's rpc.ts); others are named by kind only.
    const detail = e instanceof RpcError ? e.message : e instanceof AggregateError ? `${e.errors.length} programs failed (${e.errors.map((x) => (x instanceof RpcError ? x.message : x instanceof Error ? x.name : typeof x)).join("; ")})` : e instanceof Error ? e.name : typeof e;
    this.lastError = `${new Date().toISOString()} ${what}: ${detail}`;
    console.error(`the indexer failed ${what}`, e);
  }
}
