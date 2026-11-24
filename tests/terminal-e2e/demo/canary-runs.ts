// Canary's runs on a local validator (#124, the ticket's local run): Aviary's API in `wrangler dev`
// with Canary's container, reading a local validator that runs devnet's router.
//
// 1. A strategy (Pipeline's Apache-2.0 test-strategy-cp at a fresh local address) is deployed and
//    registered, and two markets are created and funded on it: each gets its first Canary results
//    from the container, started by the indexer's outbox.
// 2. The strategy is upgraded: the new version is run on both markets, and the old version's
//    results stay attached to it.
// 3. While the new version's run is on its first market, the container is killed: the run's alarm
//    tries the market again and the run ends with both markets done.
//
//   node tests/terminal-e2e/demo/canary-runs.ts
//
// Before it, from the repo's root (each long-running one in a shell of its own):
//   tests/terminal-e2e/demo/build-test-strategy.sh fixtures/canary-demo
//   solana-keygen new --no-bip39-passphrase --outfile fixtures/canary-demo/authority.json
//   SKIP_PROGRAMS="tax-amm buy-wall-amm containment-hook lending-amm" \
//     scripts/local-validator.sh fixtures/test-ledger-canary --rpc-port 8999 --faucet-port 9990 \
//     --gossip-port 8990 --dynamic-port-range 8300-8400
//   (apps/terminal-api) RPC_URL=http://127.0.0.1:8999 DATABASE_URL=<a migrated database> TERMINAL_API_PORT=8841 node scripts/dev.ts
//
// Environment: DEMO_RPC (http://127.0.0.1:8999), DEMO_API (http://localhost:8841), DATABASE_URL
// (the API's database, for the runs' records), DEMO_DIR (fixtures/canary-demo). The keys are
// throwaway local ones; nothing goes to devnet. The demo plays Cloudflare's part too: it fires the
// API's every-minute cron at each minute. Docker must be running (the container runs in it).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pipeline from "@pipeline-sol/sdk";
import { createKeyPairSignerFromBytes, createSolanaRpc, lamports, type Address } from "@solana/kit";
import { and, eq } from "drizzle-orm";
import { canaryRunMarkets, canaryRuns, createDb } from "terminal-db";
import { CanaryResults, CanaryRollup, StrategyVersions } from "terminal-api/contract";
import { createCpMarket, sendAndConfirm } from "terminal-devnet/cpMarket";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const RPC = process.env.DEMO_RPC ?? "http://127.0.0.1:8999";
const API = process.env.DEMO_API ?? "http://localhost:8841";
const DIR = process.env.DEMO_DIR ?? join(ROOT, "fixtures/canary-demo");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set: name the database the demo's API writes to.");
/** The container's image, as `wrangler dev` names it. */
const IMAGE = "cloudflare-dev/canarycontainer";

const rpc = createSolanaRpc(RPC);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const started = Date.now();
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} +${((Date.now() - started) / 1000).toFixed(0)}s ${line}`);
const keypair = async (file: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms: number, everyMs = 1_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(everyMs);
  }
}

function deploy(so: string, programId: string, authority: string): void {
  execFileSync("solana", ["program", "deploy", "--url", RPC, "--keypair", authority, "--upgrade-authority", authority, "--program-id", programId, so], { stdio: ["ignore", "inherit", "inherit"] });
}

const getJson = async (path: string) => {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return response.json();
};

function cronTicker(): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    timer = setTimeout(async () => {
      await fetch(`${API}/__scheduled?cron=${encodeURIComponent("* * * * *")}`).catch((e: unknown) => log(`cron failed: ${String(e)}`));
      tick();
    }, 60_000 - (Date.now() % 60_000) + 500);
  };
  tick();
  return () => clearTimeout(timer);
}

/** The market's results under its strategy's current version, once it has some for `deploySlot`. */
async function resultsFor(market: Address, deploySlot: number) {
  const results = CanaryResults.parse(await getJson(`/v1/markets/${market}/canary`));
  return results.version.deploy_slot === deploySlot && results.results.length > 0 && results;
}

const summary = (r: CanaryResults) => r.results.map((x) => `${x.check} ${x.outcome}`).join(", ");

/** The containers `wrangler dev` runs from Canary's image. */
const canaryContainers = () =>
  execFileSync("docker", ["ps", "--format", "{{.ID}} {{.Image}}"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.split(" ")[1]?.startsWith(IMAGE))
    .map((line) => line.split(" ")[0]!);

const authorityFile = join(DIR, "authority.json");
const authority = await keypair(authorityFile);
const strategy = await keypair(join(DIR, "strategy-keypair.json"));
const { db, close } = createDb(DATABASE_URL);
const stopCron = cronTicker();
try {
  // 1. A strategy and two markets on it, each run by Canary once the indexer has seen it.
  const { value: balance } = await rpc.getBalance(authority.address).send();
  if (balance < 50_000_000_000n) await until("the airdrop", async () => (await rpc.requestAirdrop(authority.address, lamports(100_000_000_000n)).send()) && (await rpc.getBalance(authority.address).send()).value > balance, 60_000);
  if (!(await rpc.getAccountInfo(strategy.address, { encoding: "base64" }).send()).value) deploy(join(DIR, "v1.so"), join(DIR, "strategy-keypair.json"), authorityFile);
  if (!(await rpc.getAccountInfo(await pipeline.strategyPda(strategy.address), { encoding: "base64" }).send()).value) {
    const { value: configAccount } = await rpc.getAccountInfo(await pipeline.configPda(), { encoding: "base64" }).send();
    const config = pipeline.decodeConfig(Uint8Array.from(Buffer.from(configAccount!.data[0], "base64")))!;
    await sendAndConfirm(rpc, authority, [
      await pipeline.registerStrategy({ payer: authority.address, registrar: authority.address, strategyProgram: strategy.address, listingFeeRecipient: config.listingFeeRecipient, metadataUri: "https://example.org/aviary-canary-demo.json", maxListingFeeLamports: config.listingFeeLamports }),
    ]);
  }
  const markets = [(await createCpMarket(rpc, authority, strategy.address)).market, (await createCpMarket(rpc, authority, strategy.address)).market];
  const created = Date.now();
  log(`strategy ${strategy.address}; markets ${markets.join(", ")}`);
  const v1 = await until("version 1 recorded", async () => StrategyVersions.parse(await getJson(`/v1/strategies/${strategy.address}/versions`)).versions[0], 180_000, 5_000);
  for (const market of markets) {
    const results = await until(`the first results of ${market}`, () => resultsFor(market, v1.deploy_slot), 300_000, 2_000);
    log(`${market}: first results ${((Date.now() - created) / 1000).toFixed(0)} s after it was created, on version ${v1.deploy_slot}: ${summary(results)}`);
  }

  // 2 and 3. The upgrade: a run of the new version on both markets, with the container killed during its first market.
  deploy(join(DIR, "v2.so"), strategy.address, authorityFile);
  log("upgraded; waiting for the run of the new version, to kill the container under it");
  const run = await until(
    "the new version's run to start",
    async () => (await db.select().from(canaryRuns).where(and(eq(canaryRuns.program, strategy.address), eq(canaryRuns.trigger, "strategy_version"))))[0],
    180_000,
    50,
  );
  const killed = canaryContainers();
  if (killed.length) execFileSync("docker", ["kill", ...killed], { stdio: "ignore" });
  const doneBefore = await db.select().from(canaryRunMarkets).where(eq(canaryRunMarkets.runId, run.id));
  log(`run ${run.id} of version ${run.deploySlot} started at ${run.startedAt.toISOString()}; killed container ${killed.join(", ") || "(none running)"} with ${doneBefore.length} of ${run.markets} markets done`);
  const finished = await until("the run to end", async () => {
    const [row] = await db.select().from(canaryRuns).where(eq(canaryRuns.id, run.id));
    return row?.finishedAt && row;
  }, 300_000, 2_000);
  const done = await db.select().from(canaryRunMarkets).where(eq(canaryRunMarkets.runId, run.id));
  log(`run ${run.id} ended ${((finished.finishedAt!.getTime() - run.startedAt.getTime()) / 1000).toFixed(0)} s after it started: ${done.map((d) => `${d.market} ${d.status} in ${d.rounds} round(s)`).join("; ")}`);
  if (done.length !== run.markets || done.some((d) => d.status !== "done") || !markets.every((m) => done.some((d) => d.market === m))) throw new Error("the run did not do every market of the strategy");
  if (!killed.length) throw new Error("no container was running to kill: the resume was not shown");

  const v2 = Number(run.deploySlot);
  for (const market of markets) {
    const now = await until(`${market}'s results on version ${v2}`, () => resultsFor(market, v2), 60_000);
    const before = CanaryResults.parse(await getJson(`/v1/markets/${market}/canary?version=${v1.deploy_slot}`));
    if (before.version.current || before.results.length === 0 || before.results.some((r) => r.strategy_version.deploy_slot !== v1.deploy_slot)) throw new Error(`version ${v1.deploy_slot}'s results of ${market} are not kept with it`);
    log(`${market}: version ${v2} (current) ${summary(now)}; version ${v1.deploy_slot} (kept, not current) ${before.results.length} results`);
  }
  const rollup = CanaryRollup.parse(await getJson(`/v1/strategies/${strategy.address}/versions/${v2}/canary`));
  log(`version ${v2}'s roll-up: ${rollup.markets} markets; ${Object.entries(rollup.checks).map(([check, c]) => `${check} ${JSON.stringify(c.outcomes)}`).join(", ")}`);
  log("done");
} finally {
  stopCron();
  await close();
}
