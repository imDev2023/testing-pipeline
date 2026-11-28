// The checks `pnpm terminal:deploy` (./deploy.ts) makes before and after it deploys Aviary's devnet
// Workers (#192), kept apart so they are tested in Node (test/deploy-checks.test.ts).
import type { Health } from "../src/contract.ts";

/**
 * The secrets `terminal-api-devnet` may hold (docs/spec/pipescope-architecture.md, "terminal-api"):
 * RPC_URL, the Helius devnet URL carrying Aviary's own key, and the verified builds' GitHub token;
 * never a wallet key or an LLM key (PIPESCOPE-37).
 */
export const ALLOWED_SECRETS = ["RPC_URL", "GH_ACTIONS_TOKEN"];

/** The `https://<name>.<subdomain>.workers.dev` URL wrangler printed for the Worker `name`, which `deploy` names on its own line. */
export function workersDevUrl(output: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = output.match(new RegExp(`https://${escaped}\\.[a-z0-9-]+\\.workers\\.dev`));
  if (!found) throw new Error(`wrangler printed no workers.dev URL for ${name}`);
  return found[0];
}

/** What is wrong with the secrets the API holds, by name, or null: RPC_URL set, and nothing outside ALLOWED_SECRETS. */
export function secretsProblem(names: string[]): string | null {
  if (!names.includes("RPC_URL")) return "RPC_URL is not set on terminal-api-devnet: run again with --set-rpc-url, which puts the project .env's RPC_URL (Aviary's own Helius key) through wrangler's stdin";
  const others = names.filter((name) => !ALLOWED_SECRETS.includes(name)).sort();
  return others.length ? `terminal-api-devnet holds secrets it must not: ${others.join(", ")} (PIPESCOPE-37)` : null;
}

/** What keeps `/health` from showing the deploy done, or null: it answers from `commit` (the version's tag), with the database and the RPC reachable. */
export function deployedProblem(health: Health, commit: string): string | null {
  if (health.version.tag !== commit) return `/health answers from ${health.version.tag || "an untagged version"}, not ${commit} yet`;
  if (!health.ok) {
    const failing = [health.database.ok ? null : `database: ${health.database.error}`, health.rpc.ok ? null : `rpc: ${health.rpc.error}`].filter(Boolean);
    return `/health is not ok: ${failing.join("; ")}`;
  }
  return null;
}

/**
 * What keeps the checkout's commit from being deployed, or null: a clean checkout, so the deployment
 * is a commit, and that commit main's newest on origin (PIPESCOPE-96), unless `--from-branch` deploys
 * a pushed commit of a pull request on purpose, to check its criteria on the deployment before it merges.
 */
export function commitProblem({ dirty, head, main, pushed, fromBranch }: { dirty: string; head: string; main: string; pushed: boolean; fromBranch: boolean }): string | null {
  if (dirty) return `the checkout has changes; commit them first, so what is deployed is a commit:\n${dirty}`;
  if (head === main) return null;
  if (!fromBranch) return `${head} is not origin/main's newest commit (${main}): deploy main, or pass --from-branch to deploy a pull request's pushed commit on purpose`;
  return pushed ? null : `${head} is on no branch on origin: push it first, so the deployed commit can be found`;
}
