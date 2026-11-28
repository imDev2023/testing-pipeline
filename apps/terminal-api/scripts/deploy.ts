// `pnpm terminal:deploy [--set-rpc-url]`: deploys Aviary's two devnet Workers together
// (docs/spec/pipescope-architecture.md, Environments; docs/toolchain.md, "Aviary's hosted devnet
// deployment"; #192), from a clean checkout so what runs is a commit:
//
// 1. the secrets of `terminal-api-devnet`: RPC_URL set and nothing that may be a wallet or LLM key
//    (PIPESCOPE-37); `--set-rpc-url` first puts the project .env's RPC_URL through wrangler's stdin,
//    so the key is never on a command line;
// 2. the migrations, applied to Neon through NEON_DATABASE_URL (the project .env's direct
//    connection string; DATABASE_URL stays the local run's Docker Postgres);
// 3. `terminal-api-devnet`, tagged with the commit, which `/health` then reports as its version;
// 4. `terminal-web-devnet`, built with NEXT_PUBLIC_API_URL set to the URL wrangler gave the API, and
//    checked for the test wallet before it deploys;
// 5. `/health` answering from that commit with Neon and the RPC reachable, and the web's pages up.
//
// Wrangler runs on the account's own login (`wrangler login`), not the shared API token, which may
// not read Hyperdrive.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { deployedProblem, secretsProblem, workersDevUrl } from "./deployChecks.ts";
import type { Health } from "../src/contract.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const API_DIR = resolve(import.meta.dirname, "..");
const WEB_DIR = resolve(ROOT, "apps/terminal-web");
const API_NAME = "terminal-api-devnet";
const WEB_NAME = "terminal-web-devnet";
/** How long `/health` may take to answer from the new version with everything reachable. */
const HEALTH_WAIT_MS = 180_000;

const setRpcUrl = process.argv.includes("--set-rpc-url");

/** The environment wrangler runs in: the account's login, so the shared API token is left out. */
const wranglerEnv = (extra: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  delete env.CLOUDFLARE_API_TOKEN;
  return env;
};

/** Runs a command, showing its output as it goes, and gives back what it printed; a failure stops the deploy. */
function run(command: string, args: string[], options: { cwd: string; env?: Record<string, string | undefined>; input?: string; quiet?: boolean }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const take = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
      output += chunk.toString();
      if (!options.quiet) stream.write(chunk);
    };
    child.stdout.on("data", take(process.stdout));
    child.stderr.on("data", take(process.stderr));
    child.stdin.end(options.input ?? "");
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} ${args[0] ?? ""} ${args[1] ?? ""} exited with ${code}`))));
  });
}

const step = (line: string) => console.log(`\n== ${line}`);
const fail = (line: string): never => {
  console.error(`\nterminal:deploy: ${line}`);
  process.exit(1);
};

// A clean checkout, so the deployment is a commit.
const dirty = (await run("git", ["status", "--porcelain"], { cwd: ROOT, quiet: true })).trim();
if (dirty) fail(`the checkout has changes; commit them first, so what is deployed is a commit:\n${dirty}`);
const commit = (await run("git", ["rev-parse", "--short=12", "HEAD"], { cwd: ROOT, quiet: true })).trim();
const subject = (await run("git", ["log", "-1", "--format=%s"], { cwd: ROOT, quiet: true })).trim().slice(0, 100);
const neon = process.env.NEON_DATABASE_URL ?? fail("NEON_DATABASE_URL is not set: it is the Neon project's direct connection string, in the project's .env.");

step(`the secrets of ${API_NAME}`);
if (setRpcUrl) {
  const rpcUrl = process.env.RPC_URL ?? fail("RPC_URL is not set: it is the Helius devnet URL carrying Aviary's own key, in the project's .env.");
  await run("pnpm", ["exec", "wrangler", "secret", "put", "RPC_URL", "--env", "devnet"], { cwd: API_DIR, env: wranglerEnv(), input: rpcUrl });
}
const listed = JSON.parse(await run("pnpm", ["exec", "wrangler", "secret", "list", "--env", "devnet", "--format", "json"], { cwd: API_DIR, env: wranglerEnv(), quiet: true }).catch(() => "[]")) as { name: string }[];
const problem = secretsProblem(listed.map((s) => s.name));
if (problem) fail(problem);
console.log(`secrets: ${listed.map((s) => s.name).join(", ")}`);

step("the migrations, on Neon");
await run("pnpm", ["--filter", "terminal-db", "migrate"], { cwd: ROOT, env: { ...process.env, DATABASE_URL: neon } });

step(`${API_NAME}, at ${commit}`);
const apiOutput = await run("pnpm", ["exec", "wrangler", "deploy", "--env", "devnet", "--tag", commit, "--message", subject], { cwd: API_DIR, env: wranglerEnv() });
const api = workersDevUrl(apiOutput, API_NAME);

step(`${WEB_NAME}, reading ${api}`);
await run("pnpm", ["exec", "opennextjs-cloudflare", "build"], { cwd: WEB_DIR, env: { ...process.env, NEXT_PUBLIC_API_URL: api } });
await run("node", ["scripts/check-no-test-wallet.ts"], { cwd: WEB_DIR });
const webOutput = await run("pnpm", ["exec", "opennextjs-cloudflare", "deploy", "--env", "devnet"], { cwd: WEB_DIR, env: wranglerEnv() });
const web = workersDevUrl(webOutput, WEB_NAME);

step("the deployment answers");
const deadline = Date.now() + HEALTH_WAIT_MS;
let health: Health | null = null;
for (;;) {
  const why = await fetch(`${api}/health`, { signal: AbortSignal.timeout(20_000) })
    .then(async (response) => {
      health = (await response.json()) as Health;
      return deployedProblem(health, commit);
    })
    .catch((e: unknown) => `/health did not answer: ${e instanceof Error ? e.message : String(e)}`);
  if (!why) break;
  if (Date.now() > deadline) fail(`${why}, after ${HEALTH_WAIT_MS / 1000} s`);
  await new Promise((done) => setTimeout(done, 5_000));
}
console.log(JSON.stringify(health));
for (const path of ["/", "/devnet"]) {
  const response = await fetch(`${web}${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) fail(`${web}${path} answered ${response.status}`);
}
console.log(`\nDeployed ${commit}:\n  ${api}\n  ${web}`);
