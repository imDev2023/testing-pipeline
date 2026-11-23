// Copied from Top-pad b833a7b, packages/db/src/cli.ts; owned here since.
// `pnpm --filter terminal-db migrate`: applies the migrations to the database in DATABASE_URL (the project's .env).
import { runMigrations } from "./migrate.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set: put the database's connection string in the project's .env.");
  process.exit(1);
}
await runMigrations(url);
console.log(`Migrated ${new URL(url).host}.`);
