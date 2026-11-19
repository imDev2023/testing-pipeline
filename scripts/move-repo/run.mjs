// Process helpers for the move: git and gh with time limits and retries, and the one switch that
// keeps a dry run from changing anything outside its own state folder.
import { spawnSync } from "node:child_process";

export const DRY = process.argv.includes("--dry-run");

// Runs a command and returns its stdout; throws with its stderr unless `allowFail`.
export function run(cmd, args, { input, cwd, timeout = 600_000, allowFail = false, env } = {}) {
  const r = spawnSync(cmd, args, {
    input,
    cwd,
    timeout,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: "utf8",
    maxBuffer: 1 << 30,
  });
  if (r.error && r.error.code === "ETIMEDOUT") {
    if (allowFail) return { ok: false, out: "", err: `timed out after ${timeout / 1000}s` };
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} timed out after ${timeout / 1000}s`);
  }
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.slice(0, 4).join(" ")} failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
  }
  return allowFail ? { ok: r.status === 0, out: r.stdout, err: r.stderr } : r.stdout;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const FLAKY = /connection reset|timed out|timeout|EOF|50[234]|TLS handshake|could not resolve|i\/o timeout|stream error|was submitted too quickly|abuse|secondary rate limit|HTTP 429/i;
const THROTTLED = /secondary rate limit|was submitted too quickly|abuse|HTTP 429|exceeded a secondary/i;

// gh with retries for the network trouble this Mac sees and for GitHub's secondary rate limit,
// which asks for at least a minute's wait.
// A call that creates something passes tries: 1, since a retry after a lost answer could create it twice.
export async function gh(args, { input, allowFail = false, tries = 8 } = {}) {
  for (let i = 1; ; i++) {
    const r = run("gh", args, { input, allowFail: true, timeout: 120_000 });
    if (r.ok) return allowFail ? r : r.out;
    const msg = `${r.err}\n${r.out}`;
    if (i < tries && FLAKY.test(msg)) {
      const wait = THROTTLED.test(msg) ? 60_000 * i : 5_000 * i;
      console.log(`  (GitHub: ${THROTTLED.test(msg) ? "rate limited" : "network trouble"}, retrying in ${wait / 1000}s)`);
      await sleep(wait);
      continue;
    }
    if (allowFail) return r;
    throw new Error(`gh ${args.slice(0, 4).join(" ")} failed: ${msg.trim().slice(0, 800)}`);
  }
}

// A REST call; `body` goes as JSON. Returns parsed JSON, or null for an empty answer.
export async function api(method, path, body, opts = {}) {
  const args = ["api", "-X", method, path, "-H", "X-GitHub-Api-Version: 2022-11-28"];
  if (opts.accept) args.push("-H", `Accept: ${opts.accept}`);
  if (opts.paginate) args.push("--paginate", "--slurp");
  if (body !== undefined) args.push("--input", "-");
  const r = await gh(args, { input: body === undefined ? undefined : JSON.stringify(body), allowFail: opts.allowFail, tries: opts.tries });
  if (opts.allowFail) {
    if (!r.ok) return { error: `${r.err}\n${r.out}`.trim() };
    return r.out.trim() ? JSON.parse(r.out) : null;
  }
  if (!r.trim()) return null;
  const v = JSON.parse(r);
  return opts.paginate ? v.flat() : v;
}

// A GraphQL query whose connection at `path` (a list of keys) is paged through in full.
export async function graphqlAll(query, path, vars = {}) {
  const out = [];
  let after = null;
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(vars)) args.push("-F", `${k}=${v}`);
    if (after) args.push("-f", `after=${after}`);
    const data = JSON.parse(await gh(args));
    let conn = data.data;
    for (const k of path) conn = conn[k];
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
}

// git with a hard time limit for network calls, which stall on this Mac, and retries.
export async function gitNet(args, { cwd, tries = 6, timeout = 300_000 } = {}) {
  const env = { GIT_HTTP_LOW_SPEED_LIMIT: "1000", GIT_HTTP_LOW_SPEED_TIME: "30", GIT_TERMINAL_PROMPT: "0" };
  for (let i = 1; ; i++) {
    const r = run("git", ["-c", "http.version=HTTP/1.1", ...args], { cwd, timeout, allowFail: true, env });
    if (r.ok) return r.out;
    if (i >= tries) throw new Error(`git ${args.slice(0, 3).join(" ")} failed: ${r.err.trim().slice(0, 600)}`);
    console.log(`  (git network trouble, retrying in ${5 * i}s)`);
    await sleep(5_000 * i);
  }
}

export const git = (cwd, ...args) => run("git", args, { cwd });

export class Stop extends Error {}
export function stop(msg) {
  throw new Stop(msg);
}

// Every change outside the state folder goes through here, so a dry run only prints it.
export async function change(what, fn) {
  if (DRY) {
    console.log(`  (dry run) would ${what}`);
    return undefined;
  }
  console.log(`  ${what}`);
  return fn();
}
