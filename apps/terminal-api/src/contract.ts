// The API's zod contract: what each endpoint answers, shared with the web app, which is a pure
// client of the API (docs/spec/pipescope-architecture.md, "terminal-web"). Every endpoint is
// labelled unstable until v1 ships (PIPESCOPE-32).
import { z } from "zod";

/** `GET /health`: healthy only when the database and the RPC both answer. */
export const Health = z.object({
  ok: z.boolean(),
  cluster: z.string(),
  database: z.object({
    ok: z.boolean(),
    latencyMs: z.number().int().nullable(),
    /** How many migrations the database has applied, so a deploy with one missing never looks ready. */
    migrations: z.number().int().nullable(),
    error: z.string().nullable(),
  }),
  rpc: z.object({
    ok: z.boolean(),
    latencyMs: z.number().int().nullable(),
    slot: z.number().int().nullable(),
    error: z.string().nullable(),
  }),
  version: z.object({ id: z.string(), tag: z.string(), timestamp: z.string() }),
});
export type Health = z.infer<typeof Health>;

/** Every refusal and failure: one sentence a page can show as it is. */
export const ApiError = z.object({ error: z.string(), retryAfterSeconds: z.number().int().optional() });
export type ApiError = z.infer<typeof ApiError>;
