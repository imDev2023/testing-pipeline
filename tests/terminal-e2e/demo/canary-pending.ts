// The upgrade notice on a local validator (#125, the ticket's local run): Aviary's API in `wrangler
// dev` with Canary's container and its web app, reading a local validator that runs devnet's router.
//
// 1. A strategy (Pipeline's Apache-2.0 test-strategy-cp at a fresh local address) is deployed and
//    registered with two markets on it, and Canary gives each its first results: the strategy page
//    and both market pages carry no upgrade notice, and What Canary saw shows the results.
// 2. The strategy is upgraded. As soon as the watch records the new version, the strategy page and
//    both market pages carry "Upgraded on <date>; tests and explanation for this version are
//    pending.", and Canary's part on each reads as pending.
// 3. When the new version's first results arrive for a market, its page drops the notice and shows
//    them; once both have them, so does the strategy page.
//
// If Canary's first results of the new version land before the pages are read, the pending window
// was missed, so the demo upgrades again (to the other build) and looks again, up to three times.
//
//   node tests/terminal-e2e/demo/canary-pending.ts
//
// Before it, from the repo's root (each long-running one in a shell of its own):
//   tests/terminal-e2e/demo/build-test-strategy.sh fixtures/canary-demo
//   solana-keygen new --no-bip39-passphrase --outfile fixtures/canary-demo/authority.json
//   SKIP_PROGRAMS="tax-amm buy-wall-amm containment-hook lending-amm" \
//     scripts/local-validator.sh fixtures/test-ledger-canary --rpc-port 8999 --faucet-port 9990 \
//     --gossip-port 8990 --dynamic-port-range 8300-8400
//   (apps/terminal-api) RPC_URL=http://127.0.0.1:8999 DATABASE_URL=<a migrated database> TERMINAL_API_PORT=8841 node scripts/dev.ts
//   (apps/terminal-web) NEXT_PUBLIC_API_URL=http://localhost:8841 pnpm exec next dev --port 3141
//
// The pages are read in headless Chromium (Playwright's, `pnpm --filter terminal-e2e exec playwright
// install chromium`), as a reader sees them once their panels have loaded.
//
// Environment: DEMO_RPC (http://127.0.0.1:8999), DEMO_API (http://localhost:8841), DEMO_WEB
// (http://localhost:3141), DEMO_DIR (fixtures/canary-demo). The keys are throwaway local ones;
// nothing goes to devnet. The demo fires the API's every-minute cron at each minute, as Cloudflare
// would. Docker must be running (the container runs in it).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pipeline from "@pipeline-sol/sdk";
import { chromium } from "@playwright/test";
import { createKeyPairSignerFromBytes, createSolanaRpc, lamports, type Address } from "@solana/kit";
import { CanaryResults, StrategyVersions } from "terminal-api/contract";
import { createCpMarket, sendAndConfirm } from "terminal-devnet/cpMarket";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const RPC = process.env.DEMO_RPC ?? "http://127.0.0.1:8999";
const API = process.env.DEMO_API ?? "http://localhost:8841";
const WEB = process.env.DEMO_WEB ?? "http://localhost:3141";
const DIR = process.env.DEMO_DIR ?? join(ROOT, "fixtures/canary-demo");
const NOTICE = /Upgraded on \d{1,2} [A-Z][a-z]{2} \d{4}; tests and explanation for this version are pending\./;
const PENDING = "Tests for this version are pending.";

const rpc = createSolanaRpc(RPC);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const started = Date.now();
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} +${((Date.now() - started) / 1000).toFixed(0)}s ${line}`);
const keypair = async (file: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms: number, everyMs = 1_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch((e: unknown) => {
      log(`  (${what}: ${e instanceof Error ? e.message : String(e)})`);
      return null;
    });
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

const browser = await chromium.launch();

/** A page of the web app as a reader sees it once its panels have loaded: its text. */
async function page(path: string): Promise<string> {
  const tab = await browser.newPage();
  try {
    const response = await tab.goto(`${WEB}${path}`);
    if (!response?.ok()) throw new Error(`GET ${WEB}${path} answered ${response?.status()}`);
    // Every panel loads under its heading; wait until none still says it is loading.
    await tab.waitForFunction(() => !/Loading [^.]*…/.test(document.body.innerText), undefined, { timeout: 30_000 });
    return (await tab.innerText("body")).replace(/\s+/g, " ");
  } finally {
    await tab.close();
  }
}

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

const canaryOf = async (market: Address) => CanaryResults.parse(await getJson(`/v1/markets/${market}/canary`));
const currentVersion = async (program: Address) => StrategyVersions.parse(await getJson(`/v1/strategies/${program}/versions`)).versions[0];

/** What a page says: whether it carries the upgrade notice, Canary's pending line, and Canary's results. */
async function says(path: string) {
  const text = await page(path);
  return { notice: text.match(NOTICE)?.[0] ?? null, pending: text.includes(PENDING), results: text.includes("Canary traded a private copy") };
}

const authorityFile = join(DIR, "authority.json");
const authority = await keypair(authorityFile);
const strategy = await keypair(join(DIR, "strategy-keypair.json"));
const stopCron = cronTicker();
try {
  // 1. A strategy and two markets, each run by Canary once the indexer has seen it.
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
  log(`strategy ${strategy.address}; markets ${markets.join(", ")}`);
  const first = await until("the strategy's version recorded", () => currentVersion(strategy.address), 180_000, 5_000);
  for (const market of markets) await until(`the first results of ${market}`, async () => (await canaryOf(market)).summary !== null, 300_000, 2_000);
  const pages = [`/strategies/${strategy.address}`, ...markets.map((m) => `/markets/${m}`)];
  for (const path of pages) {
    const now = await says(path);
    log(`${path} with version ${first.deploy_slot}'s results: notice ${now.notice ? "shown" : "none"}; Canary's results ${now.results ? "shown" : "not shown"}`);
    if (now.notice || !now.results) throw new Error(`${path} should show Canary's results and no notice before the upgrade`);
  }

  // 2. The upgrade, and the pages while the new version has no results.
  let seen: { version: number; pages: Record<string, Awaited<ReturnType<typeof says>>> } | null = null;
  for (let attempt = 1; attempt <= 3 && !seen; attempt++) {
    const before = (await currentVersion(strategy.address))!.deploy_slot;
    deploy(join(DIR, attempt % 2 === 1 ? "v2.so" : "v1.so"), strategy.address, authorityFile);
    log(`upgrade ${attempt} landed; waiting for the watch to record it`);
    const next = await until("the new version recorded", async () => {
      const v = await currentVersion(strategy.address);
      return v && v.deploy_slot !== before && v;
    }, 180_000, 500);
    const read: Record<string, Awaited<ReturnType<typeof says>>> = {};
    for (const path of pages) read[path] = await says(path);
    const results = await Promise.all(markets.map(canaryOf));
    if (results.some((r) => r.summary !== null)) {
      log(`version ${next.deploy_slot}'s first results landed before the pages were read; upgrading again`);
      continue;
    }
    seen = { version: next.deploy_slot, pages: read };
  }
  if (!seen) throw new Error("the pending window was missed three times");
  for (const [path, now] of Object.entries(seen.pages)) {
    log(`${path} after the upgrade to ${seen.version}: "${now.notice ?? "no notice"}"; Canary's part ${now.pending ? "pending" : "not pending"}`);
    if (!now.notice || !now.pending || now.results) throw new Error(`${path} should carry the upgrade notice and Canary's pending line`);
  }

  // 3. The new version's first results, and the pages without the notice.
  for (const market of markets) {
    await until(`${market}'s first results on version ${seen.version}`, async () => {
      const r = await canaryOf(market);
      return r.version.deploy_slot === seen.version && r.summary !== null;
    }, 300_000, 2_000);
    const now = await says(`/markets/${market}`);
    log(`/markets/${market} with version ${seen.version}'s results: notice ${now.notice ? "shown" : "none"}; Canary's results ${now.results ? "shown" : "not shown"}`);
    if (now.notice || !now.results) throw new Error(`/markets/${market} should drop the notice once its results arrive`);
  }
  const strategyPage = await says(pages[0]!);
  log(`${pages[0]} with version ${seen.version}'s results: notice ${strategyPage.notice ? "shown" : "none"}; Canary's results ${strategyPage.results ? "shown" : "not shown"}`);
  if (strategyPage.notice) throw new Error("the strategy page should drop the notice once the new version has results");
  log("done");
} finally {
  stopCron();
  await browser.close();
}
