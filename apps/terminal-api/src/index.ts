// Adapted from Top-pad b833a7b, apps/api/src/index.ts; owned here since.
// The API (Hono with the zod contract in ./contract) and the every-minute cron. Kept apart from
// ./worker, the Worker's entry, so the tests, which run in Node, load this alone.
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { JobName } from "./config";
import type { ApiError } from "./contract";
import { runDueJobs, type Job } from "./dispatcher";
import type { Bindings } from "./env";
import { health } from "./health";
import { keeperRoutes } from "./keeper";
import { limitReads } from "./rateLimits";

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

keeperRoutes(app);

/**
 * The jobs that have been built, by name. Empty until the indexer's ticket (#116) adds the first;
 * each later ticket adds its own, and ./config says how often each runs.
 */
export function jobs(_env: Bindings): Partial<Record<JobName, Job>> {
  return {};
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
