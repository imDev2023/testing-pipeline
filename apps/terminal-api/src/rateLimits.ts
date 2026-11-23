import type { Context, MiddlewareHandler } from "hono";
import type { ApiError } from "./contract";
import { RATE_LIMIT_PERIOD_SECONDS } from "./config";
import type { AppEnv } from "./index";

/**
 * Every read counts against the reader's IP in the READS binding (PIPESCOPE-90), whose limit lives
 * in `wrangler.jsonc`; over it, the answer is a 429 that names the wait, in words and as
 * `Retry-After`, so the panel that asked can say so. Quotes, prepares and trade signatures (TRADES)
 * and reports (REPORTS) are counted by their own routes as those land.
 */
export const limitReads: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
  // A quote is counted with the prepares and trade signatures instead (limitTrades).
  if (c.req.path === "/v1/quote") return next();
  return countAsRead(c, next);
};

/** Quotes, prepares and trade signatures together, in the TRADES binding (PIPESCOPE-90). */
export const limitTrades: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.TRADES.limit({ key: ip });
  if (success) return next();
  return refuse(c);
};

/** Counts any request as a read: the keeper runner's heartbeats, whose signature check anyone could otherwise make the API run without end. */
export const countAsRead: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Cloudflare sets the client's address on every request; `wrangler dev` sets it to the local caller's.
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const { success } = await c.env.READS.limit({ key: ip });
  if (success) return next();
  return refuse(c);
};

const refuse = (c: Context<AppEnv>) => {
  c.header("Retry-After", String(RATE_LIMIT_PERIOD_SECONDS));
  return c.json<ApiError>(
    { error: `Too many requests from your address. Try again in ${RATE_LIMIT_PERIOD_SECONDS} seconds.`, retryAfterSeconds: RATE_LIMIT_PERIOD_SECONDS },
    429,
  );
};
