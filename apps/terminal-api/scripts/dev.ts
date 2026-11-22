// `pnpm --filter terminal-api dev`: the local run of `terminal-api` (docs/toolchain.md, "Aviary's
// local run"): `wrangler dev` against devnet and the Docker Postgres, from the project's .env,
// which direnv loads (RPC_URL on a Helius devnet key, DATABASE_URL on the Docker Postgres).
// The RPC's URL carries its key, so it reaches wrangler through the environment and never on a
// command line, where `ps` would show it.
import { spawn } from "node:child_process";

export const API_PORT = 8811;

const missing = ["RPC_URL", "DATABASE_URL"].filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`${missing.join(" and ")} not set: put them in the project's .env (see .env.example) and let direnv load it.`);
  process.exit(1);
}

const child = spawn("pnpm", ["exec", "wrangler", "dev", "--port", String(API_PORT), "--test-scheduled", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: process.env.DATABASE_URL },
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
