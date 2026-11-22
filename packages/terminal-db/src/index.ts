// Copied from Top-pad b833a7b, packages/db/src/index.ts; owned here since.
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import journal from "../migrations/meta/_journal.json" with { type: "json" };
import * as schema from "./schema";

export * from "./schema";
export { schema };

/** One short-lived client per request: Workers must not share sockets across requests, and Hyperdrive pools for us. */
export function createDb(connectionString: string) {
  const client = postgres(connectionString, { max: 5, fetch_types: false, prepare: false });
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
