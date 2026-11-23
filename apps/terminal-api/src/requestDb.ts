// A database client per request for the read endpoints: opened on first use, so a request that
// needs none never wakes Postgres, and closed once the handler is done with it.
import type { Context, MiddlewareHandler } from "hono";
import { createDb, type Db } from "terminal-db";
import type { AppEnv } from "./index";

export type DbEnv = AppEnv & { Variables: { db: () => Db } };

export const requestDb: MiddlewareHandler<DbEnv> = async (c, next) => {
  let client: ReturnType<typeof createDb> | null = null;
  c.set("db", () => (client ??= createDb(c.env.HYPERDRIVE.connectionString)).db);
  try {
    await next();
  } finally {
    if (client) c.executionCtx.waitUntil((client as ReturnType<typeof createDb>).close());
  }
};

export const dbOf = (c: Context<DbEnv>): Db => c.var.db();
