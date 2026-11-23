// Adapted from Top-pad b833a7b, apps/api/src/index.ts; owned here since.
// The API (Hono with the zod contract in ./contract) and the every-minute cron. Kept apart from
// ./worker, the Worker's entry, so the tests, which run in Node, load this alone.
import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { JobName } from "./config";
import type { ApiError } from "./contract";
import { runDueJobs, type Job } from "./dispatcher";
import type { Bindings } from "./env";
import { feed } from "./feed";
import { health } from "./health";
import { keeperRoutes } from "./keeper";
import { ROOM_HEADER, roomOf } from "./roomCore";
import { limitReads } from "./rateLimits";
import { strategyRoutes } from "./strategies";

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

/**
 * The live rooms (./liveRoom): a page opens a WebSocket here and the Worker hands the upgrade to the
 * room, named, so a room woken from hibernation knows which it is.
 */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const joinRoom = (c: Context<AppEnv>, room: string) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") return c.json<ApiError>({ error: "A live room is a WebSocket: open it with an upgrade." }, 426);
  const request = new Request(c.req.raw);
  request.headers.set(ROOM_HEADER, room);
  return c.env.LIVE_ROOMS.get(c.env.LIVE_ROOMS.idFromName(room)).fetch(request);
};
app.get("/v1/live/feed", (c) => joinRoom(c, roomOf.feed));
app.get("/v1/live/markets/:market", (c) => {
  const market = c.req.param("market");
  if (!ADDRESS.test(market)) return c.json<ApiError>({ error: "This is not a market's address." }, 400);
  return joinRoom(c, roomOf.market(market));
});

/** How the indexer stands: its version, its cursor and when each job last ran (./indexer). */
app.get("/v1/indexer", async (c) => c.json(await indexer(c.env).status()));

/** The one indexer, by name, so every caller reaches the same instance. */
export const indexer = (env: Bindings) => env.INDEXER.get(env.INDEXER.idFromName("router"));
keeperRoutes(app);

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
  };
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
