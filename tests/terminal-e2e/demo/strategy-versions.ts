// Aviary's strategy-versions demo on a local validator (#117, the ticket's local demo run): a
// strategy, Pipeline's test-strategy-cp, is deployed, registered with devnet's router and then
// upgraded; within a minute of the upgrade the indexer records the new strategy version with its
// slot and hash, the outbox holds its event, and the strategy page's version history shows both
// versions. Then the router itself is upgraded, and is recorded and flagged.
//
//   node tests/terminal-e2e/demo/strategy-versions.ts
//
// Before it, from the repo's root (each long-running one in a shell of its own):
//   tests/terminal-e2e/demo/build-test-strategy.sh fixtures/versions-demo
//   solana-keygen new --no-bip39-passphrase --outfile fixtures/versions-demo/authority.json
//   SKIP_PROGRAMS="tax-amm buy-wall-amm containment-hook lending-amm" \
//     ROUTER_UPGRADE_AUTHORITY=fixtures/versions-demo/authority.json \
//     scripts/local-validator.sh fixtures/test-ledger-versions --rpc-port 8999 --faucet-port 9990 \
//     --gossip-port 8990 --dynamic-port-range 8300-8400
//   (apps/terminal-api) RPC_URL=http://127.0.0.1:8999 DATABASE_URL=<a migrated database> TERMINAL_API_PORT=8841 node scripts/dev.ts
//   (apps/terminal-web) NEXT_PUBLIC_API_URL=http://localhost:8841 pnpm exec opennextjs-cloudflare build && pnpm exec opennextjs-cloudflare preview --port 3141
//
// Environment: DEMO_RPC (http://127.0.0.1:8999), DEMO_API (http://localhost:8841), DEMO_WEB
// (http://localhost:3141), DATABASE_URL (the API's database, for the outbox, which has no endpoint),
// DEMO_DIR (fixtures/versions-demo). The keys are throwaway local ones; nothing goes to devnet.
// The demo plays Cloudflare's part too: it fires the API's every-minute cron at each minute.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pipeline from "@pipeline-sol/sdk";
import { chromium } from "@playwright/test";
import {
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { createDb, readOutbox } from "terminal-db";
import { RouterVersions, StrategyVersions } from "terminal-api/contract";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const RPC = process.env.DEMO_RPC ?? "http://127.0.0.1:8999";
const API = process.env.DEMO_API ?? "http://localhost:8841";
const WEB = process.env.DEMO_WEB ?? "http://localhost:3141";
const DIR = process.env.DEMO_DIR ?? join(ROOT, "fixtures/versions-demo");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set: name the database the demo's API writes to.");
const SCREENSHOTS = join(ROOT, "tests/terminal-e2e/screenshots/demo");
/** How long after the upgrade lands the new version must be recorded: the next minute's watch, and the time it takes. */
const WITHIN_MS = 90_000;

const rpc = createSolanaRpc(RPC);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

const keypair = async (file: string) => createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(file, "utf8")) as number[]));

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(1_000);
  }
}

async function send(payer: KeyPairSigner, instructions: Instruction[]): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signed = await signTransactionMessageWithSigners(
    pipe(createTransactionMessage({ version: 0 }), (m) => setTransactionMessageFeePayerSigner(payer, m), (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m), (m) => appendTransactionMessageInstructions(instructions, m)),
  );
  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64" }).send();
  await until(`transaction ${signature}`, async () => {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(value[0].err)}`);
    return value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized";
  }, 60_000);
  return signature;
}

/** `solana program deploy`: a first deploy at the keypair's address, or an upgrade of the address. */
function deploy(so: string, programId: string, authority: string): void {
  execFileSync("solana", ["program", "deploy", "--url", RPC, "--keypair", authority, "--upgrade-authority", authority, "--program-id", programId, so], { stdio: ["ignore", "inherit", "inherit"] });
}

/** The program's ProgramData slot, read straight from the chain. */
async function programDataSlot(program: string): Promise<bigint> {
  const { value } = await rpc.getAccountInfo(await pipeline.programDataPda(program as Address), { encoding: "base64", dataSlice: { offset: 0, length: 45 } }).send();
  if (!value) throw new Error(`${program} has no ProgramData`);
  return Buffer.from(value.data[0], "base64").readBigUInt64LE(4);
}

/** An executable's hash as Pipeline's SDK and solana-verify compute it: the bytes without trailing zeros. */
function executableSha256(so: string): string {
  const bytes = readFileSync(so);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return createHash("sha256").update(bytes.subarray(0, end)).digest("hex");
}

const getJson = async (path: string) => {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`);
  return response.json();
};

/** Plays Cloudflare's every-minute cron against the local API: fires it at the start of each minute. */
function cronTicker(): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const tick = () => {
    timer = setTimeout(async () => {
      const at = new Date().toISOString().slice(11, 19);
      await fetch(`${API}/__scheduled?cron=${encodeURIComponent("* * * * *")}`).then((r) => log(`cron fired at ${at}: ${r.status}`), (e) => log(`cron at ${at} failed: ${e}`));
      tick();
    }, 60_000 - (Date.now() % 60_000) + 500);
  };
  tick();
  return () => clearTimeout(timer);
}

const authorityFile = join(DIR, "authority.json");
const authority = await keypair(authorityFile);
const strategy = await keypair(join(DIR, "strategy-keypair.json"));
const { db, close } = createDb(DATABASE_URL);
const stopCron = cronTicker();
try {
  // 1. Fund the authority from the local faucet.
  const { value: balance } = await rpc.getBalance(authority.address).send();
  if (balance < 50_000_000_000n) await until("the airdrop", async () => (await rpc.requestAirdrop(authority.address, lamports(100_000_000_000n)).send()) && (await rpc.getBalance(authority.address).send()).value > balance, 60_000);
  log(`authority ${authority.address}, strategy ${strategy.address}`);

  // 2. Deploy version 1 and register it with the router, as an author would.
  if (!(await rpc.getAccountInfo(strategy.address).send()).value) deploy(join(DIR, "v1.so"), join(DIR, "strategy-keypair.json"), authorityFile);
  const firstSlot = await programDataSlot(strategy.address);
  const strategyPda = await pipeline.strategyPda(strategy.address);
  if (!(await rpc.getAccountInfo(strategyPda).send()).value) {
    const { value: configAccount } = await rpc.getAccountInfo(await pipeline.configPda(), { encoding: "base64" }).send();
    const config = pipeline.decodeConfig(Uint8Array.from(Buffer.from(configAccount!.data[0], "base64")));
    if (!config) throw new Error("the router's config does not decode");
    const signature = await send(authority, [
      await pipeline.registerStrategy({ payer: authority.address, registrar: authority.address, strategyProgram: strategy.address, listingFeeRecipient: config.listingFeeRecipient, metadataUri: "https://example.org/aviary-versions-demo.json", maxListingFeeLamports: config.listingFeeLamports }),
    ]);
    log(`registered with the router: ${signature}`);
  }
  log(`version 1 deployed in slot ${firstSlot}; waiting for the indexer to record it`);
  const first = await until("version 1", async () => {
    const { versions } = StrategyVersions.parse(await getJson(`/v1/strategies/${strategy.address}/versions`));
    return versions.length >= 1 && versions;
  }, 150_000);
  log(`recorded: ${JSON.stringify(first)}`);

  // 3. Upgrade it to version 2, and time how long the indexer takes to record it.
  deploy(join(DIR, "v2.so"), strategy.address, authorityFile);
  const landed = Date.now();
  const secondSlot = await programDataSlot(strategy.address);
  log(`upgraded in slot ${secondSlot}; waiting for the next minute's watch`);
  const second = await until("version 2", async () => {
    const { versions } = StrategyVersions.parse(await getJson(`/v1/strategies/${strategy.address}/versions`));
    return versions.length >= 2 && versions;
  }, WITHIN_MS);
  const took = Date.now() - landed;
  const wantHash = executableSha256(join(DIR, "v2.so"));
  if (second[0]!.deploy_slot !== Number(secondSlot) || second[0]!.executable_sha256 !== wantHash || !second[0]!.current) throw new Error(`version 2 is recorded wrong: ${JSON.stringify(second[0])}, wanted slot ${secondSlot} and hash ${wantHash}`);
  log(`version 2 recorded ${(took / 1000).toFixed(1)} s after the upgrade landed: slot ${second[0]!.deploy_slot}, hash ${second[0]!.executable_sha256}, transaction ${second[0]!.signature}`);
  const instructions = (await getJson(`/v1/strategies/${strategy.address}/instructions`)) as { instructions: { name: string }[] };
  log(`version 2's instructions: ${instructions.instructions.map((i) => i.name).join(", ")}`);

  const event = (await readOutbox(db, "versions-demo", { limit: 1000 })).find((e) => e.kind === "strategy_version" && e.subject === strategy.address && e.payload.deploySlot === String(secondSlot));
  if (!event) throw new Error("the outbox holds no strategy_version event for the upgrade");
  log(`outbox event ${event.id}: ${JSON.stringify({ kind: event.kind, subject: event.subject, slot: String(event.slot), payload: event.payload })}`);

  // 4. The strategy page's version history shows both versions.
  const browser = await chromium.launch();
  try {
    for (const colorScheme of ["light", "dark"] as const) {
      for (const width of [1440, 390, 360]) {
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
        await page.goto(`${WEB}/strategies/${strategy.address}`);
        const rows = page.getByRole("region", { name: /^Version history/ }).getByRole("row");
        await rows.filter({ hasText: second[0]!.deploy_slot.toLocaleString("en-US") }).waitFor();
        const text = await page.getByRole("region", { name: /^Version history/ }).innerText();
        for (const v of second) if (!text.includes(v.deploy_slot.toLocaleString("en-US"))) throw new Error(`the page does not show the version of slot ${v.deploy_slot}`);
        if (!text.includes("The current version. The results and explanation on this page are for it.")) throw new Error("the page does not mark the current version");
        await page.screenshot({ path: join(SCREENSHOTS, `${width}-${colorScheme}`, "strategy-versions.png"), fullPage: true });
        await page.close();
      }
    }
    log(`the strategy page shows both versions; screenshots in ${SCREENSHOTS}`);
  } finally {
    await browser.close();
  }

  // 5. Upgrade the router itself, with its own bytes: recorded and flagged within a minute.
  const routerBefore = await programDataSlot(pipeline.PIPELINE_PROGRAM_ADDRESS);
  deploy(join(ROOT, "fixtures/router/pipeline.so"), pipeline.PIPELINE_PROGRAM_ADDRESS, authorityFile);
  const routerLanded = Date.now();
  const routerSlot = await programDataSlot(pipeline.PIPELINE_PROGRAM_ADDRESS);
  log(`router upgraded from slot ${routerBefore} in slot ${routerSlot}`);
  const router = await until("the router's upgrade", async () => {
    const { versions } = RouterVersions.parse(await getJson("/v1/router"));
    return versions[0]?.deploy_slot === Number(routerSlot) && versions;
  }, WITHIN_MS);
  if (!router[0]!.flagged) throw new Error(`the router's upgrade is not flagged: ${JSON.stringify(router[0])}`);
  const routerEvent = (await readOutbox(db, "versions-demo", { limit: 1000 })).find((e) => e.kind === "router_upgraded" && e.payload.deploySlot === String(routerSlot));
  if (!routerEvent) throw new Error("the outbox holds no router_upgraded event");
  log(`router upgrade recorded and flagged ${((Date.now() - routerLanded) / 1000).toFixed(1)} s after it landed: ${JSON.stringify(router[0])}; outbox event ${routerEvent.id}`);
  log("done");
} finally {
  stopCron();
  await close();
}
