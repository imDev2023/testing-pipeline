// What a `CanaryRun` Durable Object does (docs/spec/pipescope-architecture.md, "Canary runner";
// docs/spec/pipescope-canary.md, When Canary runs; CANARY-22 to CANARY-25; #124), apart from the
// runtime so the tests run it in Node. One object runs one strategy version: it keeps the runs its
// triggers asked for in its own storage (the only thing it keeps there, ADR 0004), and its alarm
// does one market at a time:
//
// 1. the market's snapshot through the RPC (./canarySnapshot), with the version's instruction list
//    and callers from Postgres;
// 2. posted to the one container, and posted again with what the binary names as missing, until it
//    answers with records (the binary answers with records by CANARY-25's last round);
// 3. the records stored in Postgres (terminal-db's `storeCanaryMarket`), which writes the outbox
//    events the Telegram bot reads.
//
// A failure (the RPC, or the container restarting) leaves the market where it was, and the alarm
// tries it again after a wait, so a run goes on after a container restart from the market it was on.
// When the chain runs other code than the version's, the run hands its markets to the strategy's
// newer version, whose runs are the ones that count for them.
import { canaryRunMarkets, failCanaryMarket, finishCanaryRun, programVersions, startCanaryRun, storeCanaryMarket, type CanaryRecord, type CanaryTrigger, type Db } from "terminal-db";
import { and, desc, eq } from "drizzle-orm";
import { addMissing, firstSnapshot, rpcAccountReader, snapshotBody, type MissingAnswer, type Snapshot, type SnapshotInstructions } from "./canarySnapshot";
import { CANARY } from "./config";
import { readStrategyInstructions } from "./strategies";

/** A strategy version, as a run is addressed: its program and the deploy slot, in decimal. */
export type CanaryRunVersion = { program: string; deploySlot: string };

/** What a trigger asks a version's run for: these markets, at once or after each delay from `since` (now by default). */
export type CanaryRunRequest = { trigger: CanaryTrigger; markets: string[]; delaysMs?: readonly number[]; since?: number };

/**
 * The binary's answer to `POST /run` (crates/canary/src/http.rs); `refused` for its 400, which names
 * what it refused; `failed` when the container could not answer, which a later try may change.
 */
export type CanaryContainerAnswer = { status: "results"; harness: string; records: CanaryRecord[]; notes: string[] } | ({ status: "missing" } & MissingAnswer) | { status: "refused"; error: string } | { status: "failed"; error: string };

/** A refusal that trying again cannot change: the binary refused the snapshot (400), or never stopped asking for accounts. */
export class CanaryRefused extends Error {}

/** The Durable Object's storage and alarm, as the core uses them. */
export type CanaryRunStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
};

export type CanaryRunDeps = {
  storage: CanaryRunStorage;
  now: () => number;
  rpcUrl: string;
  openDb: () => { db: Db; close: () => Promise<void> };
  /** The one container: posts a snapshot body and returns the binary's answer; throws when it cannot answer. */
  container: { run: (body: string) => Promise<CanaryContainerAnswer> };
  /** Hands a request to another version's run. */
  forward: (version: CanaryRunVersion, request: CanaryRunRequest) => Promise<void>;
  log: (line: string) => void;
};

/** One run the object holds: due at `dueAt`, its markets done up to `next`. */
type PendingRun = {
  /** Which run this is, so the alarm's work lands on it however the list changed meanwhile. */
  id: string;
  trigger: CanaryTrigger;
  delayMs: number;
  /** When its trigger happened; it is due `delayMs` after. */
  since: number;
  dueAt: number;
  markets: string[];
  next: number;
  /** Its row in `canary_runs`, once it started. */
  runId: string | null;
  /** Failed tries on the market it is on, and waits for the watch to record a newer version. */
  attempts: number;
  waits: number;
};

type State = { version: CanaryRunVersion | null; runs: PendingRun[] };

/** What one market's work left of its run. */
type Outcome = "going" | "finished" | { handedOver: string[] };

const STATE = "state";

/** What `status` says: the version and the runs still to do, earliest first. */
export type CanaryRunStatus = { version: CanaryRunVersion | null; runs: { trigger: CanaryTrigger; delayMs: number; dueAt: number; markets: number; done: number; started: boolean }[] };

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class CanaryRunCore {
  constructor(private readonly deps: CanaryRunDeps) {}

  private async load(): Promise<State> {
    return (await this.deps.storage.get<State>(STATE)) ?? { version: null, runs: [] };
  }

  private async save(state: State): Promise<void> {
    await this.deps.storage.put(STATE, state);
  }

  /** Sets the alarm for the earliest run, or clears it when none is left. */
  private async arm(state: State): Promise<void> {
    if (!state.runs.length) return this.deps.storage.deleteAlarm();
    const now = this.deps.now();
    await this.deps.storage.setAlarm(Math.max(now, Math.min(...state.runs.map((r) => r.dueAt))));
  }

  /**
   * Takes a trigger's request: one run per delay after `since`. A market that a run due already
   * holds, and has yet to do, is left out of another run due now, so two triggers at once, or two
   * delays already past, run it once.
   */
  async schedule(version: CanaryRunVersion, request: CanaryRunRequest): Promise<void> {
    const state = await this.load();
    state.version ??= version;
    if (state.version.program !== version.program || state.version.deploySlot !== version.deploySlot) {
      throw new Error(`this run is version ${state.version.deploySlot} of ${state.version.program}, not ${version.deploySlot}`);
    }
    const now = this.deps.now();
    const since = request.since ?? now;
    const waiting = new Set(state.runs.filter((r) => r.dueAt <= now).flatMap((r) => r.markets.slice(r.next)));
    for (const delayMs of request.delaysMs ?? [0]) {
      const dueAt = since + delayMs;
      const markets = [...new Set(request.markets)].filter((m) => dueAt > now || !waiting.has(m));
      if (!markets.length) continue;
      state.runs.push({ id: crypto.randomUUID(), trigger: request.trigger, delayMs, since, dueAt, markets, next: 0, runId: null, attempts: 0, waits: 0 });
      // Of a request's runs already due, as a market found long after it was created has, the first is enough.
      if (dueAt <= now) markets.forEach((m) => waiting.add(m));
    }
    state.runs.sort((a, b) => a.dueAt - b.dueAt);
    await this.save(state);
    await this.arm(state);
  }

  async status(): Promise<CanaryRunStatus> {
    const state = await this.load();
    return {
      version: state.version,
      runs: state.runs.map((r) => ({ trigger: r.trigger, delayMs: r.delayMs, dueAt: r.dueAt, markets: r.markets.length, done: r.next, started: r.runId !== null })),
    };
  }

  /**
   * The alarm: one market of the earliest run that is due, then the alarm again for what is left.
   * A request can arrive while the market runs (the object takes calls while it waits on the RPC,
   * the container and Postgres), so the work is done on a copy of the run, and what it did is
   * applied to the runs as they are when it ends.
   */
  async alarm(): Promise<void> {
    const before = await this.load();
    const due = before.runs.find((r) => r.dueAt <= this.deps.now());
    if (!before.version || !due) return this.arm(before);
    const run = structuredClone(due);
    let outcome: Outcome;
    const { db, close } = this.deps.openDb();
    try {
      outcome = await this.work(db, before.version, run, before.runs);
    } finally {
      await close();
    }
    const state = await this.load();
    if (outcome === "finished") state.runs = state.runs.filter((r) => r.id !== run.id);
    else if (outcome === "going") state.runs = state.runs.map((r) => (r.id === run.id ? run : r));
    else state.runs = state.runs.filter((r) => !outcome.handedOver.includes(r.id));
    state.runs.sort((a, b) => a.dueAt - b.dueAt);
    await this.save(state);
    await this.arm(state);
  }

  /** One market of `run`, which it changes; says whether the run goes on, finished, or handed runs to a newer version. */
  private async work(db: Db, version: CanaryRunVersion, run: PendingRun, runs: PendingRun[]): Promise<Outcome> {
    const now = this.deps.now();
    const deploySlot = BigInt(version.deploySlot);
    const ours = { program: version.program, deploySlot };
    if (run.runId === null) run.runId = String(await startCanaryRun(db, { version: ours, trigger: run.trigger, delayMs: run.delayMs, markets: run.markets }));
    const runId = BigInt(run.runId);
    const market = run.markets[run.next]!;
    const reader = rpcAccountReader(this.deps.rpcUrl);
    let containerMs = 0;
    const done = async (): Promise<Outcome> => {
      run.next++;
      run.attempts = 0;
      run.waits = 0;
      if (run.next < run.markets.length) return "going";
      await finishCanaryRun(db, runId);
      return "finished";
    };
    try {
      const first = await firstSnapshot(reader, market);
      if (first.strategy !== version.program) {
        await failCanaryMarket(db, { runId, market, error: `the market's strategy is ${first.strategy}, not ${version.program}`, rpcRequests: reader.requests() });
        return done();
      }
      const [own] = await db
        .select({ executableSha256: programVersions.executableSha256 })
        .from(programVersions)
        .where(and(eq(programVersions.program, version.program), eq(programVersions.deploySlot, deploySlot)));
      if (own?.executableSha256 && first.strategyExecutableSha256 !== own.executableSha256) {
        const [newest] = await db.select({ deploySlot: programVersions.deploySlot }).from(programVersions).where(eq(programVersions.program, version.program)).orderBy(desc(programVersions.deploySlot)).limit(1);
        if (newest && newest.deploySlot > deploySlot) return this.handOver(db, runs.map((r) => (r.id === run.id ? run : r)), { program: version.program, deploySlot: String(newest.deploySlot) });
        run.waits++;
        if (run.waits < CANARY.versionWaits.attempts) {
          run.dueAt = now + CANARY.versionWaits.delayMs;
          return "going";
        }
        await failCanaryMarket(db, { runId, market, error: "the chain runs strategy code that is no version Aviary has recorded", rpcRequests: reader.requests() });
        return done();
      }

      let snapshot: Snapshot = { ...first.snapshot };
      const instructions = await this.instructionsOf(db, version.program, deploySlot);
      if (instructions) snapshot.instructions = instructions;
      for (;;) {
        const started = Date.now();
        const answer = await this.deps.container.run(snapshotBody(snapshot));
        containerMs += Date.now() - started;
        if (answer.status === "results") {
          await storeCanaryMarket(db, { runId, version: ours, market, records: answer.records, notes: answer.notes, rounds: snapshot.round, rpcRequests: reader.requests(), containerMs });
          return done();
        }
        if (answer.status === "refused") throw new CanaryRefused(`the binary refused the snapshot: ${answer.error}`);
        if (answer.status === "failed") throw new Error(answer.error);
        if (snapshot.round >= CANARY.roundsGuard) throw new CanaryRefused(`the binary still lacked accounts after ${snapshot.round} rounds`);
        snapshot = await addMissing(reader, snapshot, answer);
      }
    } catch (e) {
      run.attempts++;
      if (e instanceof CanaryRefused || run.attempts >= CANARY.retry.attempts) {
        this.deps.log(`canary: ${market} could not be run on version ${version.deploySlot} of ${version.program}: ${errorText(e)}`);
        await failCanaryMarket(db, { runId, market, error: errorText(e), rpcRequests: reader.requests() });
        return done();
      }
      run.dueAt = now + Math.min(CANARY.retry.firstDelayMs * 2 ** (run.attempts - 1), CANARY.retry.maxDelayMs);
      this.deps.log(`canary: ${market} failed (try ${run.attempts} of ${CANARY.retry.attempts}), again at ${new Date(run.dueAt).toISOString()}: ${errorText(e)}`);
      return "going";
    }
  }

  /** The version's instructions and their callers, as the snapshot carries them (CANARY-46); none when its bytes were never read. */
  private async instructionsOf(db: Db, program: string, deploySlot: bigint): Promise<SnapshotInstructions | null> {
    const list = await readStrategyInstructions(db, program, { deploySlot });
    if (list.anchor === null) return null;
    return { anchor: list.anchor, instructions: list.instructions.map((i) => ({ name: i.name, calls: i.calls, signers: i.signers.map((s) => s.address) })) };
  }

  /**
   * The chain runs a newer version: every market still to do goes to that version's run, each run
   * still due when it was; a run already started records its markets as moved and ends.
   */
  private async handOver(db: Db, runs: PendingRun[], to: CanaryRunVersion): Promise<Outcome> {
    for (const run of runs) {
      const left = run.markets.slice(run.next);
      await this.deps.forward(to, { trigger: run.trigger, markets: left, delaysMs: [run.delayMs], since: run.since });
      if (run.runId !== null) {
        const runId = BigInt(run.runId);
        for (const market of left) {
          await db.insert(canaryRunMarkets).values({ runId, market, status: "moved", error: `the strategy was upgraded; version ${to.deploySlot} runs it` }).onConflictDoNothing();
        }
        await finishCanaryRun(db, runId);
      }
    }
    return { handedOver: runs.map((r) => r.id) };
  }
}
