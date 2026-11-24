// Adapted from Top-pad b833a7b, apps/api/src/index.ts; owned here since.
// The API (Hono with the zod contract in ./contract) and the every-minute cron. Kept apart from
// ./worker, the Worker's entry, so the tests, which run in Node, load this alone.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import { createDb, markets } from "terminal-db";
import { canaryRoutes, startCanary } from "./canary";
import { sweepCanary } from "./canaryTriggers";
import type { JobName } from "./config";
import type { ApiError } from "./contract";
import { runDueJobs, type Job } from "./dispatcher";
import { makeExplainerKeys } from "./explainer";
import type { Bindings } from "./env";
import { feed, notFound } from "./feed";
import { formRoutes } from "./forms";
import { dbOf, requestDb } from "./requestDb";
import { health } from "./health";
import { keeperRoutes } from "./keeper";
import { ROOM_HEADER, roomOf } from "./roomCore";
import { limitReads } from "./rateLimits";
import { lendingAmmRoutes } from "./products/lendingAmm/routes";
import { actionRoutes } from "./trading/actionRoutes";
import { tradingRoutes } from "./trading/routes";
import { strategyRoutes } from "./strategies";
import { imageRoutes } from "./tokenImages";
import { searchRoutes } from "./search";
import { walletRoutes } from "./wallet";

export type AppEnv = { Bindings: Bindings };

export const app = new Hono<AppEnv>();

// Public (PIPESCOPE-32): any origin may read, with no key and no credentials.
app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST"], exposeHeaders: ["Retry-After"], maxAge: 86_400 }));
app.use("*", limitReads);

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json<ApiError>({ error: err.message }, err.status);
  console.error(err);
  return c.json<ApiError>({ error: "Something went wrong in Aviary's API. Try again in a moment." }, 500);
});

app.notFound((c) => c.json<ApiError>({ error: "There is nothing at this address of Aviary's API." }, 404));

app.get("/health", async (c) => {
  const body = await health(c.env, c.executionCtx);
  return c.json(body, body.ok ? 200 : 503);
});

app.route("/", feed);
app.route("/", strategyRoutes);
app.route("/", formRoutes);
app.route("/", imageRoutes);
app.route("/", searchRoutes);
app.route("/", walletRoutes);
app.route("/", canaryRoutes);

/**
 * The live rooms (./liveRoom): a page opens a WebSocket here and the Worker hands the upgrade to the
 * room, named, so a room woken from hibernation knows which it is.
 */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isUpgrade = <E extends AppEnv>(c: Context<E>) => c.req.header("upgrade")?.toLowerCase() === "websocket";
const notUpgrade = <E extends AppEnv>(c: Context<E>) => c.json<ApiError>({ error: "A live room is a WebSocket: open it with an upgrade." }, 426);
const joinRoom = <E extends AppEnv>(c: Context<E>, room: string) => {
  const request = new Request(c.req.raw);
  request.headers.set(ROOM_HEADER, room);
  return c.env.LIVE_ROOMS.get(c.env.LIVE_ROOMS.idFromName(room)).fetch(request);
};
app.get("/v1/live/feed", (c) => (isUpgrade(c) ? joinRoom(c, roomOf.feed) : notUpgrade(c)));
app.get("/v1/live/markets/:market", requestDb, async (c) => {
  const market = c.req.param("market");
  if (!ADDRESS.test(market)) return c.json<ApiError>({ error: "This is not a market's address." }, 400);
  if (!isUpgrade(c)) return notUpgrade(c);
  // A room only for a market Aviary knows, so no address opens one, and the socket, for nothing
  // (PIPESCOPE-140). Live updates need no database, so when it cannot be read the room opens anyway.
  try {
    const [known] = await dbOf(c).select({ address: markets.address }).from(markets).where(eq(markets.address, market)).limit(1);
    if (!known) throw notFound("market");
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    console.error(`reading whether ${market} is a market failed; its room opens anyway`, e);
  }
  return joinRoom(c, roomOf.market(market));
});

/** How the indexer stands: its version, its cursor and when each job last ran (./indexer). */
app.get("/v1/indexer", async (c) => c.json(await indexer(c.env).status()));

/** The one indexer, by name, so every caller reaches the same instance. */
export const indexer = (env: Bindings) => env.INDEXER.get(env.INDEXER.idFromName("router"));
keeperRoutes(app);
tradingRoutes(app);
actionRoutes(app);
lendingAmmRoutes(app);

/**
 * The jobs that have been built, by name; each later ticket adds its own, and ./config says how
 * often each runs. Each passes the Worker's version, so an indexer still running older code resets
 * itself (./indexer).
 */
export function jobs(env: Bindings): Partial<Record<JobName, Job>> {
  const version = env.CF_VERSION_METADATA.id;
  return {
    reconcileRouter: async () => void (await indexer(env).reconcile(version)),
    reconcileStrategies: async () => void (await indexer(env).reconcileStrategies(version)),
    registrySnapshot: async () => void (await indexer(env).snapshot(version)),
    programDataWatch: async () => void (await indexer(env).watchPrograms(version)),
    pruneCandles: async () => void (await indexer(env).prune(version)),
    metadataRefetch: async () => void (await indexer(env).refetchMetadata(version)),
    mintRefresh: async () => void (await indexer(env).refreshMints(version)),
    canarySweep: () => canarySweep(env),
    explainerKeys: () => explainerKeys(env),
  };
}

/**
 * Canary's scheduled sweep (CANARY-23): what the outbox still holds, drained by the indexer, which
 * does every drain (./indexer), then every market on its strategy's current version.
 */
async function canarySweep(env: Bindings): Promise<void> {
  await indexer(env).drainOutbox();
  const { db, close } = createDb(env.HYPERDRIVE.connectionString);
  try {
    await sweepCanary(db, startCanary(env));
  } finally {
    await close();
  }
}

/** The explainer's keys (./explainer): each strategy's current version's key, recorded pending with its evidence when new. */
async function explainerKeys(env: Bindings): Promise<void> {
  const { db, close } = createDb(env.HYPERDRIVE.connectionString);
  try {
    const { made, revived, waiting } = await makeExplainerKeys(db, { rpcUrl: env.RPC_URL });
    if (made.length || revived.length || waiting.length) console.log("explainer keys", { made, revived, waiting });
  } finally {
    await close();
  }
}

export default {
  fetch: app.fetch,
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(
      runDueJobs(controller.scheduledTime, jobs(env)).then(({ ran, failed }) => {
        if (ran.length || failed.length) console.log("cron", { ran, failed });
      }),
    );
  },
} satisfies ExportedHandler<Bindings>;
