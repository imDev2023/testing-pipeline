// Canary's container (docs/spec/pipescope-architecture.md, "Canary runner"; CANARY-24; #124), on
// Top-pad's `visionContainer.ts` pattern: `crates/canary`'s image (crates/canary/Dockerfile), one
// instance (`max_instances` 1 in wrangler.jsonc, and one object by name here), on `basic`, asleep
// CANARY.container.sleepAfter after its last run, with internet access off. It never reaches the
// network and is given no RPC key, nor any variable: everything a run reads comes in the snapshot
// `CanaryRun` posts. Runs from every version's `CanaryRun` take their turn, one at a time, so the
// quarter vCPU and 1 GiB serve one market's run at a time. Loaded by the Worker only (./worker),
// never by the tests.
import { Container } from "@cloudflare/containers";
import type { CanaryContainerAnswer } from "./canaryRunCore";
import { CANARY } from "./config";
import type { Bindings } from "./env";

export class CanaryContainer extends Container<Bindings> {
  defaultPort = CANARY.container.port;
  sleepAfter = CANARY.container.sleepAfter;
  enableInternet = false;

  /** The run in progress; each new one waits for those before it. */
  private turn: Promise<unknown> = Promise.resolve();
  /** Whether the binary has answered `/health` since the container last started. */
  private answering = false;

  /**
   * Posts one snapshot (a `POST /run` body) and returns the binary's answer, after the runs before
   * it. A failure is returned, not thrown, so the caller decides when to try again (its alarm).
   */
  async run(body: string): Promise<CanaryContainerAnswer> {
    const queued = Date.now();
    const mine = this.turn.then(() =>
      // A run that waited past its turn's budget is given back, so its alarm stays within its time.
      Date.now() - queued > CANARY.container.queueWaitMs ? { status: "failed" as const, error: `waited more than ${CANARY.container.queueWaitMs / 60_000} minutes for the container` } : this.post(body),
    );
    this.turn = mine;
    return mine;
  }

  private async post(body: string): Promise<CanaryContainerAnswer> {
    try {
      await this.ready();
      const response = await this.containerFetch("http://canary/run", {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(CANARY.container.answerTimeoutMs),
      });
      if (response.ok) return (await response.json()) as CanaryContainerAnswer;
      const text = await response.text().catch(() => "");
      // 400: the binary refused the snapshot, which trying again cannot change.
      if (response.status === 400) return { status: "refused", error: ((): string => { try { return (JSON.parse(text) as { error?: string }).error ?? text; } catch { return text; } })() };
      return { status: "failed", error: `the container answered ${response.status}: ${text.slice(0, 300)}` };
    } catch (e) {
      return { status: "failed", error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * After a start, waits for the binary itself to answer `GET /health`: the port can take a
   * connection before the binary listens on it (locally, Docker's port proxy does), and a run posted
   * then is cut off.
   */
  private async ready(): Promise<void> {
    if (this.answering) return;
    for (let attempt = 1; ; attempt++) {
      const response = await this.containerFetch("http://canary/health").catch(() => null);
      // Read to its end: the library counts a request in flight until its body is, and the
      // container never sleeps while one is.
      await response?.arrayBuffer().catch(() => null);
      if (response?.ok) {
        this.answering = true;
        return;
      }
      if (attempt >= CANARY.container.readyAttempts) throw new Error(`the binary did not answer /health after ${attempt} tries`);
      await new Promise((done) => setTimeout(done, CANARY.container.readyEveryMs));
    }
  }

  override onStart(): void {
    console.log("canary container: started");
  }

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    this.answering = false;
    console.log(`canary container: stopped (${reason}, exit code ${exitCode})`);
  }
}
