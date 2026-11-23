// Adapted from Top-pad b833a7b, apps/api/src/indexer.ts (`reconcile`, asking the chain first);
// owned here since. The indexer's work, kept apart from the `Indexer` Durable Object (./indexer) so
// it runs and is tested in Node: the router's reconciliation from its cursor, the backfill of its
// whole history on the first run, and the registry snapshot (docs/spec/pipescope-architecture.md,
// Indexer). The live socket comes with the live rooms (#118), the strategy programs and the
// ProgramData watch with strategy versions (#117).
//
// Neon's free plan has 100 compute-hours a month, so the database must sleep while devnet is quiet
// (Data): each run asks the chain first and opens Postgres only when there is something new. What
// that takes (the router's cursor, and the strategies and markets already indexed) is read from
// Postgres once per instance and kept here.
import { PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import type { Db } from "terminal-db";
import {
  blockPositions,
  historySource,
  IndexBatchError,
  indexTransactions,
  indexRegistry,
  pipelineHandler,
  pruneCandles,
  readCursor,
  readRegistry,
  reconcileAccount,
  refreshMarkets,
  reindexUnknown,
  servedTransaction,
  addResult,
  emptyResult,
  type Cursor,
  type HistorySource,
  type IndexResult,
  type TransactionHandler,
} from "terminal-indexer";
import { indexedTransactions, markets, strategies, trades } from "terminal-db";
import { inArray, isNull } from "drizzle-orm";
import { CANDLES, LIVE_ROOM_TRADES_MAX, RPC_WAITS } from "./config";
import type { LiveEvent } from "./contract";
import { marketViews, tradeViews } from "./views";

export const ROUTER = PIPELINE_PROGRAM_ADDRESS;

/** How many values one `in (...)` list holds, well inside Postgres's 65,535 parameters a query. */
const IN_LIST_MAX = 1_000;

/** Reads the rows for `values` a list at a time, so a long backlog never passes Postgres's parameter limit. */
async function chunked<T>(values: string[], read: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let i = 0; i < values.length; i += IN_LIST_MAX) rows.push(...(await read(values.slice(i, i + IN_LIST_MAX))));
  return rows;
}

/** A short-lived database client: opened for one run and closed after it. */
export type OpenDb = () => { db: Db; close: () => Promise<void> };

export type ReconcileOutcome = {
  /** True when the chain had nothing past the cursor, so Postgres was not touched. */
  quiet: boolean;
  indexed: IndexResult;
  cursor: Cursor | null;
};

export class IndexerCore {
  private readonly source: HistorySource;
  private readonly handle: TransactionHandler;
  /** A transaction's place in its block, its blocks kept for the live path. */
  private readonly blockIndexOf: (slot: number, signature: string) => Promise<number>;
  /** The router's cursor, once read; undefined until the first run of this instance reads it. */
  private cursor: Cursor | null | undefined = undefined;
  /** Whether this instance has made its first run, which also reads every unread market and re-indexes what older code could not decode. */
  private started = false;
  /** The strategies and markets already indexed, read once per instance for the registry snapshot. */
  private known: { strategies: Set<string>; markets: Set<string> } | null = null;
  private running: Promise<ReconcileOutcome> | null = null;
  /**
   * Markets whose accounts are still to be read because the read after their event failed: the
   * cursor has already moved past the event, so nothing else would name them again.
   */
  private unread = new Set<string>();

  constructor(private readonly deps: { rpcUrl: string; openDb: OpenDb; source?: HistorySource; handler?: TransactionHandler }) {
    this.source = deps.source ?? historySource(deps.rpcUrl, RPC_WAITS.block);
    this.handle = deps.handler ?? pipelineHandler({ candleSeconds: CANDLES.map((c) => c.seconds) });
    this.blockIndexOf = blockPositions(deps.rpcUrl, RPC_WAITS.block);
  }

  /** Where reconciliation of the router stands, once this instance knows. */
  position(): Cursor | null {
    return this.cursor ?? null;
  }

  /** Reconciles the router; a call while one runs waits for it rather than starting a second. */
  reconcile(): Promise<ReconcileOutcome> {
    this.running ??= this.reconcileOnce().finally(() => (this.running = null));
    return this.running;
  }

  private async reconcileOnce(): Promise<ReconcileOutcome> {
    if (this.cursor && this.started && this.unread.size === 0 && !(await this.source.hasAfter(ROUTER, this.cursor))) {
      return { quiet: true, indexed: emptyResult(), cursor: this.cursor };
    }
    return this.withDb(async (db) => {
      try {
        const indexed = emptyResult();
        if (!this.started) {
          // Once per instance, so after each deploy or restart: every market Postgres holds as never
          // read is read with this run's, and what older code could not decode is read again. A
          // transaction that still cannot be read keeps its record and is tried by the next
          // instance; it never holds up the router's history.
          for (const { address } of await db.select({ address: markets.address }).from(markets).where(isNull(markets.readSlot))) this.unread.add(address);
          this.started = true;
          try {
            addResult(indexed, await reindexUnknown(db, this.handle));
          } catch (e) {
            console.error("reading again what older code could not decode failed; the next instance tries again", e);
          }
        }
        // The first run backfills the router's whole history, page after page, before it returns.
        const { result, cursor } = await reconcileAccount(db, this.source, this.handle, ROUTER, { cursor: this.cursor ?? (await readCursor(db, ROUTER)) });
        addResult(indexed, result);
        this.cursor = cursor;
        await this.refresh(db, indexed.markets);
        this.learn(indexed);
        return { quiet: false, indexed, cursor };
      } catch (e) {
        // Where it stopped is in Postgres; the next run reads it from there.
        this.cursor = undefined;
        throw e;
      }
    });
  }

  /**
   * The registry snapshot: the router's `Strategy` and `Market` accounts, read from the chain; any
   * not indexed yet is indexed from its account, and a new market's accounts and mints are read.
   */
  async snapshot(): Promise<{ strategies: string[]; markets: string[] }> {
    const registry = await readRegistry(this.deps.rpcUrl);
    if (this.known && registry.strategies.every((s) => this.known!.strategies.has(s.program)) && registry.markets.every((m) => this.known!.markets.has(m.address))) {
      return { strategies: [], markets: [] };
    }
    return this.withDb(async (db) => {
      const added = await indexRegistry(db, registry);
      await this.refresh(db, added.markets);
      this.known = {
        strategies: new Set((await db.select({ program: strategies.program }).from(strategies)).map((s) => s.program)),
        markets: new Set((await db.select({ address: markets.address }).from(markets)).map((m) => m.address)),
      };
      return added;
    });
  }

  /**
   * The live path: transactions the socket reported, each fetched once the RPC serves it, with its
   * place in its block, and indexed; one already indexed is not asked for again. A transaction not
   * served in time is left to reconciliation, which never passes it by.
   */
  async indexSignatures(signatures: string[]): Promise<IndexResult> {
    const wanted = [...new Set(signatures)];
    if (!wanted.length) return emptyResult();
    return this.withDb(async (db) => {
      const known = new Set(
        (await chunked(wanted, (part) => db.select({ signature: indexedTransactions.signature }).from(indexedTransactions).where(inArray(indexedTransactions.signature, part)))).map((r) => r.signature),
      );
      const indexed = emptyResult();
      // Each on its own: one that cannot be served or indexed never loses the others, which are
      // committed already and which reconciliation would not report again.
      for (const signature of wanted) {
        if (known.has(signature)) continue;
        try {
          const raw = await servedTransaction(this.deps.rpcUrl, signature, { ...RPC_WAITS.transaction, blockIndexOf: this.blockIndexOf });
          if (!raw) {
            console.warn(`transaction ${signature} was not served in time; reconciliation will index it`);
            continue;
          }
          addResult(indexed, await indexTransactions(db, this.handle, [raw]));
        } catch (e) {
          if (e instanceof IndexBatchError) addResult(indexed, e.result);
          console.error(`indexing ${signature} from the live socket failed; reconciliation will index it`, e);
        }
      }
      try {
        await this.refresh(db, indexed.markets);
      } catch (e) {
        // They stay unread for the next run; what was indexed is still handed on.
        console.error("reading the markets the live socket touched failed; the next run reads them", e);
      }
      this.learn(indexed);
      return indexed;
    });
  }

  /**
   * What an indexing run means to the live rooms that have a viewer (`rooms`, by name): each new swap
   * for its market's room, and each market it touched, new or changed, for the feed's room and its
   * own. The database is read only when such a room exists.
   */
  async events(indexed: IndexResult, rooms: readonly string[]): Promise<Map<string, LiveEvent[]>> {
    const watched = new Set(rooms);
    const feed = watched.has("feed");
    const touched = indexed.markets.filter((m) => feed || watched.has(`market:${m}`));
    const events = new Map<string, LiveEvent[]>();
    if (!touched.length) return events;
    const add = (room: string, event: LiveEvent) => events.set(room, [...(events.get(room) ?? []), event]);
    return this.withDb(async (db) => {
      const keys = new Set(indexed.trades.map((t) => `${t.signature}:${t.eventIndex}`));
      const signatures = [...new Set(indexed.trades.map((t) => t.signature))];
      const tradeRows = (await chunked(signatures, (part) => db.select().from(trades).where(inArray(trades.signature, part)))).filter(
        (t) => keys.has(`${t.signature}:${t.eventIndex}`) && watched.has(`market:${t.market}`),
      );
      tradeRows.sort((x, y) => Number(x.slot - y.slot) || (x.blockIndex ?? -1) - (y.blockIndex ?? -1) || x.eventIndex - y.eventIndex);
      // A room is sent its new swaps, or told to resync when there are more than it is sent at once.
      const byMarket = new Map<string, typeof tradeRows>();
      for (const t of tradeRows) byMarket.set(t.market, [...(byMarket.get(t.market) ?? []), t]);
      for (const [market, rows] of byMarket) {
        if (rows.length > LIVE_ROOM_TRADES_MAX) add(`market:${market}`, { type: "resync" });
        else for (const trade of await tradeViews(db, rows)) add(`market:${market}`, { type: "trade", trade });
      }
      const marketRows = await chunked(touched, (part) => db.select().from(markets).where(inArray(markets.address, part)));
      for (const market of await marketViews(db, marketRows)) {
        if (watched.has(`market:${market.address}`)) add(`market:${market.address}`, { type: "market", market });
        if (feed) add("feed", { type: "market", market });
      }
      return events;
    });
  }

  /** Drops candles past their length's retention (`CANDLES`, PIPESCOPE-30); returns how many went. */
  prune(now?: number): Promise<number> {
    return this.withDb((db) => pruneCandles(db, CANDLES, now));
  }

  /**
   * Reads the accounts of the markets named and of every market still unread; if the read fails,
   * they all stay unread for the next run.
   */
  private async refresh(db: Db, named: string[]) {
    for (const market of named) this.unread.add(market);
    const due = [...this.unread];
    await refreshMarkets(db, this.deps.rpcUrl, due);
    for (const market of due) this.unread.delete(market);
  }

  /** Adds what a reconciliation indexed to what the snapshot knows, so a market just indexed never wakes the database again. */
  private learn(indexed: IndexResult) {
    for (const market of indexed.markets) this.known?.markets.add(market);
    if (indexed.counts.strategies) this.known = null;
  }

  private async withDb<T>(work: (db: Db) => Promise<T>): Promise<T> {
    const { db, close } = this.deps.openDb();
    try {
      return await work(db);
    } finally {
      await close();
    }
  }
}
