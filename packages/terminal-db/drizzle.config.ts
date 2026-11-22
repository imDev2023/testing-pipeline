// Copied from Top-pad b833a7b, packages/db/drizzle.config.ts; owned here since.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
