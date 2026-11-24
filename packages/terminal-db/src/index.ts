// Copied from Top-pad b833a7b, packages/db/src/index.ts; owned here since.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import journal from "../migrations/meta/_journal.json" with { type: "json" };
import * as schema from "./schema.ts";

export * from "./schema.ts";
export { schema };

/**
 * One short-lived client per request: Workers must not share sockets across requests, and Hyperdrive
 * pools for us. A long-lived client (the keeper runner's) passes `idleTimeoutSeconds`, so its
 * connection closes while idle and Neon can sleep, and `connectTimeoutSeconds`.
 */
export function createDb(connectionString: string, options: { idleTimeoutSeconds?: number; connectTimeoutSeconds?: number } = {}) {
  const client = postgres(connectionString, {
    max: 5,
    fetch_types: false,
    prepare: false,
    onnotice: () => {},
    ...(options.idleTimeoutSeconds === undefined ? {} : { idle_timeout: options.idleTimeoutSeconds }),
    ...(options.connectTimeoutSeconds === undefined ? {} : { connect_timeout: options.connectTimeoutSeconds }),
  });
  return { db: drizzle(client, { schema }), close: () => client.end({ timeout: 5 }) };
}

export type Db = ReturnType<typeof createDb>["db"];

/** How many migrations this code was built with: a database that has applied fewer is not ready for it. */
export const MIGRATION_COUNT: number = journal.entries.length;

/** The database's clock and how many migrations it has applied, read in one round trip for the health route. */
export async function probe(db: Db): Promise<{ serverTime: Date; migrations: number }> {
  const rows = await db.execute<{ server_time: Date | string; migrations: number | string }>(sql`
    select now() as server_time,
           (select count(*) from drizzle.__drizzle_migrations) as migrations
  `);
  const row = rows[0];
  if (!row) throw new Error("the health query returned no row");
  return { serverTime: new Date(row.server_time), migrations: Number(row.migrations) };
}
export * from "./keeper.ts";
export * from "./outbox.ts";
export * from "./canary.ts";
