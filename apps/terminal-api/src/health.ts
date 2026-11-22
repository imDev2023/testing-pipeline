// Adapted from Top-pad b833a7b, apps/api/src/index.ts (`/health`); owned here since.
import { createSolanaRpc } from "@solana/kit";
import { createDb, probe } from "terminal-db";
import { Health } from "./contract";
import { HEALTH_TIMEOUT_MS } from "./config";
import type { Bindings } from "./env";

/** What of a request's ExecutionContext the probe needs: closing the database client after the answer. */
type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

/**
 * Healthy only when the database answers through Hyperdrive and the cluster's slot comes back
 * through RPC_URL, so a deploy with a wrong binding, a missing secret or unapplied migrations never
 * looks ready. A failure is named in words; its detail stays in the Worker's logs, since it can
 * carry the database's host or the RPC's key.
 */
export async function health(env: Bindings, ctx: WaitUntil): Promise<Health> {
  const [database, rpc] = await Promise.all([databaseHealth(env, ctx), rpcHealth(env)]);
  const { id, tag, timestamp } = env.CF_VERSION_METADATA;
  return Health.parse({ ok: database.ok && rpc.ok, cluster: env.CLUSTER, database, rpc, version: { id, tag, timestamp } });
}

async function databaseHealth(env: Bindings, ctx: WaitUntil): Promise<Health["database"]> {
  const { db, close } = createDb(env.HYPERDRIVE.connectionString);
  const started = performance.now();
  try {
    const { migrations } = await withTimeout(probe(db), HEALTH_TIMEOUT_MS);
    return { ok: true, latencyMs: Math.round(performance.now() - started), migrations, error: null };
  } catch (e) {
    console.error("health: the database query failed", e);
    return { ok: false, latencyMs: null, migrations: null, error: "the database did not answer" };
  } finally {
    ctx.waitUntil(close());
  }
}

async function rpcHealth(env: Bindings): Promise<Health["rpc"]> {
  const started = performance.now();
  try {
    const slot = await createSolanaRpc(env.RPC_URL)
      .getSlot({ commitment: "confirmed" })
      .send({ abortSignal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    return { ok: true, latencyMs: Math.round(performance.now() - started), slot: Number(slot), error: null };
  } catch (e) {
    // The error can quote the URL, and the URL carries the key: log only what kind of failure it was.
    console.error("health: the RPC did not answer", e instanceof Error ? e.name : typeof e);
    return { ok: false, latencyMs: null, slot: null, error: "the RPC did not answer" };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
