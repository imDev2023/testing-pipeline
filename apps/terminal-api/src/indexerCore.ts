// Adapted from Top-pad b833a7b, apps/api/src/indexer.ts (`reconcile`, asking the chain first);
// owned here since. The indexer's work, kept apart from the `Indexer` Durable Object (./indexer) so
// it runs and is tested in Node: the router's reconciliation from its cursor, the backfill of its
// whole history on the first run, the registry snapshot, the reconciliation of every strategy
// program, which stores every call on it, and the ProgramData watch, which records each version of
// the router and of every strategy (docs/spec/pipescope-architecture.md, Indexer). The live socket
// comes with the live rooms (#118).
//
// Neon's free plan has 100 compute-hours a month, so the database must sleep while devnet is quiet
// (Data): each run asks the chain first and opens Postgres only when there is something new. What
// that takes (the router's cursor, and the strategies and markets already indexed) is read from
// Postgres once per instance and kept here.
import { PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import type { Db } from "terminal-db";
import {
  combineHandlers,
  deployHistory,
  historySource,
  indexRegistry,
  readDeploySlots,
  recordVersion,
  signVersion,
  strategyCallsHandler,
  pipelineHandler,
  readCursor,
  readRegistry,
  reconcileAccount,
  refreshMarkets,
  reindexUnknown,
  addResult,
  type Cursor,
  type HistorySource,
  type IndexResult,
  type TransactionHandler,
} from "terminal-indexer";
import { markets, programVersions, strategies } from "terminal-db";
import { eq, isNull, max, sql } from "drizzle-orm";
import { VERSION_TRANSACTION_LOOKS } from "./config";

export const ROUTER = PIPELINE_PROGRAM_ADDRESS;

/** A short-lived database client: opened for one run and closed after it. */
export type OpenDb = () => { db: Db; close: () => Promise<void> };

export type ReconcileOutcome = {
  /** True when the chain had nothing past the cursor, so Postgres was not touched. */
  quiet: boolean;
  indexed: IndexResult;
  cursor: Cursor | null;
};

/** What a run of a job that may find nothing did: `quiet` when there was nothing new, so nothing was written. */
export type StrategiesOutcome = { quiet: boolean; indexed: IndexResult };

/** What a ProgramData watch did: the programs whose version it recorded, and those of them it saw upgraded. */
export type WatchOutcome = { quiet: boolean; recorded: string[]; upgraded: string[] };

export class IndexerCore {
  private readonly source: HistorySource;
  private readonly handle: TransactionHandler;
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
  /** The strategy programs watched, read from Postgres once and again whenever a strategy is indexed; null until then. */
  private watched: Set<string> | null = null;
  /** Each strategy program's reconciliation cursor, once this instance knows it (null: it has no history yet). */
  private strategyCursors = new Map<string, Cursor | null>();
  /**
   * Each watched program's ProgramData slot as last seen, which the watch compares, and the slot of
   * its version in force, which an extension of the program moves the first away from. Both are
   * read from Postgres once per instance: the ProgramData slot last seen, kept on the version.
   */
  private deploySlots: Map<string, bigint> | null = null;
  private versionSlots = new Map<string, bigint>();
  /** Versions recorded before the RPC served their transaction, looked for again on each watch. */
  private unsigned = new Map<string, { programData: string; deploySlot: bigint; looks: number }>();
  private runningStrategies: Promise<StrategiesOutcome> | null = null;
  private runningWatch: Promise<WatchOutcome> | null = null;

  constructor(private readonly deps: { rpcUrl: string; openDb: OpenDb; source?: HistorySource; handler?: TransactionHandler }) {
    this.source = deps.source ?? historySource(deps.rpcUrl);
    this.handle = deps.handler ?? pipelineHandler();
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
      return { quiet: true, indexed: { counts: {}, markets: [] }, cursor: this.cursor };
    }
    return this.withDb(async (db) => {
      try {
        const indexed: IndexResult = { counts: {}, markets: [] };
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
      if (added.strategies.length) this.watched = null;
      this.known = {
        strategies: new Set((await db.select({ program: strategies.program }).from(strategies)).map((s) => s.program)),
        markets: new Set((await db.select({ address: markets.address }).from(markets)).map((m) => m.address)),
      };
      return added;
    });
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
    if (indexed.counts.strategies) {
      this.known = null;
      this.watched = null;
    }
  }

  /** The strategy programs watched, read from Postgres when this instance does not know them. */
  private async watchedStrategies(db?: Db): Promise<Set<string>> {
    if (this.watched) return this.watched;
    const read = async (d: Db) => new Set((await d.select({ program: strategies.program }).from(strategies)).map((s) => s.program));
    this.watched = db ? await read(db) : await this.withDb(read);
    return this.watched;
  }

  /**
   * Reconciles every watched strategy program from its own cursor, so custom actions, bypass swaps
   * and every other call on it are stored (and any router event in them indexed); the first run of
   * each backfills its whole history. It asks the chain first, one small request a program, and
   * opens Postgres only when one has something new. One program that fails never stops the others.
   */
  reconcileStrategies(): Promise<StrategiesOutcome> {
    this.runningStrategies ??= this.reconcileStrategiesOnce().finally(() => (this.runningStrategies = null));
    return this.runningStrategies;
  }

  private async reconcileStrategiesOnce(): Promise<StrategiesOutcome> {
    const watched = new Set(await this.watchedStrategies());
    const due: string[] = [];
    for (const program of [...watched].sort()) {
      const cursor = this.strategyCursors.get(program);
      if (cursor === undefined || (await this.hasNew(program, cursor))) due.push(program);
    }
    const indexed: IndexResult = { counts: {}, markets: [] };
    if (!due.length) return { quiet: true, indexed };
    const handle = combineHandlers(this.handle, strategyCallsHandler((program) => watched.has(program)));
    return this.withDb(async (db) => {
      const failed: { program: string; error: unknown }[] = [];
      for (const program of due) {
        try {
          const known = this.strategyCursors.get(program);
          const { result, cursor } = await reconcileAccount(db, this.source, handle, program, { cursor: known ?? (await readCursor(db, program)) });
          this.strategyCursors.set(program, cursor);
          addResult(indexed, result);
        } catch (error) {
          // Where it stopped is in Postgres; the next run reads it from there.
          this.strategyCursors.delete(program);
          failed.push({ program, error });
        }
      }
      await this.refresh(db, indexed.markets);
      this.learn(indexed);
      if (failed.length) throw new AggregateError(failed.map((f) => f.error), `reconciling ${failed.map((f) => f.program).join(", ")} failed`);
      return { quiet: false, indexed };
    });
  }

  /** Whether the program has a transaction after its cursor; with none yet, whether it has any. */
  private async hasNew(program: string, cursor: Cursor | null): Promise<boolean> {
    return cursor ? this.source.hasAfter(program, cursor) : (await this.source.after(program, null, 1)).transactions.length > 0;
  }

  /**
   * The ProgramData watch: the router's and every watched strategy's last-deploy slot, in one
   * `getMultipleAccounts` per 100 programs. A program seen for the first time has its version in
   * force recorded and its earlier ones backfilled; a changed slot is an upgrade, recorded with its
   * event in the outbox (flagged, for the router), and an upgraded strategy's markets are read again.
   * Postgres is opened only when a slot changed or an upgrade's transaction turns up late.
   */
  watchPrograms(): Promise<WatchOutcome> {
    this.runningWatch ??= this.watchOnce().finally(() => (this.runningWatch = null));
    return this.runningWatch;
  }

  private async watchOnce(): Promise<WatchOutcome> {
    if (!this.watched || !this.deploySlots) {
      await this.withDb(async (db) => {
        await this.watchedStrategies(db);
        const newest = await db
          .select({
            program: programVersions.program,
            version: max(programVersions.deploySlot),
            seen: sql<string>`max(coalesce(${programVersions.programDataSlot}, ${programVersions.deploySlot}))::text`,
          })
          .from(programVersions)
          .groupBy(programVersions.program);
        this.deploySlots = new Map(newest.map((r) => [r.program, BigInt(r.seen)]));
        this.versionSlots = new Map(newest.map((r) => [r.program, r.version!]));
      });
    }
    const known = this.deploySlots!;
    const strategyPrograms = this.watched!;
    const slots = await readDeploySlots(this.deps.rpcUrl, [ROUTER, ...strategyPrograms]);
    const changed = [...slots].flatMap(([program, s]) => (s && known.get(program) !== s.deploySlot ? [{ program, programData: s.programData, seenSlot: s.deploySlot }] : []));

    // Upgrades whose transaction was not served yet: asked of the chain first, written only once found.
    const signed: { program: string; programData: string; deploySlot: bigint }[] = [];
    for (const [program, u] of this.unsigned) {
      if ((await deployHistory(this.deps.rpcUrl, u.programData)).some((d) => d.deploySlot === u.deploySlot)) signed.push({ program, ...u });
      else if (++u.looks >= VERSION_TRANSACTION_LOOKS) this.unsigned.delete(program);
    }

    const outcome: WatchOutcome = { quiet: true, recorded: [], upgraded: [] };
    if (!changed.length && !signed.length) return outcome;
    return this.withDb(async (db) => {
      const failed: { program: string; error: unknown }[] = [];
      for (const { program, programData, seenSlot } of changed) {
        const role = program === ROUTER ? "router" : "strategy";
        const previousSlot = this.versionSlots.get(program) ?? null;
        try {
          const recorded = await recordVersion(db, this.deps.rpcUrl, { program, role, programData, previousSlot });
          // Not settled (the slot's transaction not served, the code unchanged): asked again on the next watch.
          if (recorded && !recorded.settled) continue;
          known.set(program, seenSlot);
          // An extension moved the slot and kept the code: no version to record.
          if (!recorded || recorded.deploySlot === previousSlot) continue;
          this.versionSlots.set(program, recorded.deploySlot);
          outcome.recorded.push(program);
          if (!recorded.signed) this.unsigned.set(program, { programData, deploySlot: recorded.deploySlot, looks: 0 });
          else this.unsigned.delete(program);
          if (previousSlot === null) continue;
          outcome.upgraded.push(program);
          if (role === "strategy") {
            const own = await db.select({ address: markets.address }).from(markets).where(eq(markets.strategyProgram, program));
            await this.refresh(db, own.map((m) => m.address));
          }
        } catch (error) {
          failed.push({ program, error });
        }
      }
      for (const s of signed) {
        if (await signVersion(db, this.deps.rpcUrl, s)) this.unsigned.delete(s.program);
      }
      outcome.quiet = outcome.recorded.length === 0;
      if (failed.length) throw new AggregateError(failed.map((f) => f.error), `recording versions of ${failed.map((f) => f.program).join(", ")} failed`);
      return outcome;
    });
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
