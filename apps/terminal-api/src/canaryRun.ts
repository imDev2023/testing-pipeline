// The `CanaryRun` Durable Object, one per strategy version, by the name `<program>:<deploy slot>`
// (docs/spec/pipescope-architecture.md, "Canary runner"; #124). Its work is ./canaryRunCore; its
// storage holds only the runs it was asked for and how far each got (Data). Loaded by the Worker
// only (./worker), never by the tests.
import { DurableObject } from "cloudflare:workers";
import { createDb } from "terminal-db";
import { startCanary } from "./canary";
import { CanaryRunCore, type CanaryRunRequest, type CanaryRunStatus, type CanaryRunVersion } from "./canaryRunCore";
import type { Bindings } from "./env";
import { indexer } from "./index";

/** The one container, by name, so every version's runs reach the same instance. */
export const canaryContainer = (env: Bindings) => env.CANARY_CONTAINER.get(env.CANARY_CONTAINER.idFromName("canary"));

export class CanaryRun extends DurableObject<Bindings> {
  /** Whether this alarm opened Postgres, which it does only to record what it ran. */
  private wrote = false;

  private readonly core = new CanaryRunCore({
    storage: {
      get: (key) => this.ctx.storage.get(key),
      put: (key, value) => this.ctx.storage.put(key, value),
      setAlarm: (at) => this.ctx.storage.setAlarm(at),
      deleteAlarm: () => this.ctx.storage.deleteAlarm(),
    },
    now: () => Date.now(),
    rpcUrl: this.env.RPC_URL,
    openDb: () => {
      this.wrote = true;
      return createDb(this.env.HYPERDRIVE.connectionString);
    },
    container: { run: (body) => canaryContainer(this.env).run(body) },
    forward: (version, request) => startCanary(this.env)(version, request),
    log: (line) => console.log(line),
  });

  /** A trigger's request (./canaryTriggers, the re-run command). */
  async schedule(version: CanaryRunVersion, request: CanaryRunRequest): Promise<void> {
    await this.core.schedule(version, request);
  }

  async status(): Promise<CanaryRunStatus> {
    return this.core.status();
  }

  /** Each alarm runs what is due; when it recorded anything, the indexer makes the explainer's keys on its next job, since Canary's outcomes are part of them. */
  async alarm(): Promise<void> {
    this.wrote = false;
    try {
      await this.core.alarm();
    } finally {
      if (this.wrote) await indexer(this.env).canaryRecorded().catch((e: unknown) => console.error("canary: telling the indexer its results changed failed", e));
    }
  }
}
