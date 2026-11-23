// Aviary's metadata demo on a local validator (#119, the ticket's local run): devnet's router with
// the tax AMM's deployed bytes, which is registered with the router here as its author would, then
// given new metadata twice with `update_metadata`; within a minute of each `MetadataUpdated`
// landing, the API has fetched the document the event names and stored it with its hash, a new
// hash for a changed document. A third update can name one of the explainer's hostile metadata
// fixtures, served from this repo on GitHub, and the strategy page then shows its author text as
// plain text in the author's style, with screenshots at each width and theme.
//
//   node tests/terminal-e2e/demo/metadata-updated.ts
//
// Before it, from the repo's root (each long-running one in a shell of its own):
//   solana program dump -u devnet J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t fixtures/metadata-demo/deploy/tax_amm.so
//   SKIP_PROGRAMS="buy-wall-amm containment-hook lending-amm" CARGO_TARGET_DIR=fixtures/metadata-demo \
//     scripts/local-validator.sh fixtures/test-ledger-metadata --rpc-port 8961 --faucet-port 9961 \
//     --gossip-port 8960 --dynamic-port-range 8400-8450
//   (apps/terminal-api) RPC_URL=http://127.0.0.1:8961 DATABASE_URL=<a migrated database> TERMINAL_API_PORT=8861 node scripts/dev.ts
//   (apps/terminal-web, for the hostile fixture's screenshots) NEXT_PUBLIC_API_URL=http://localhost:8861 pnpm exec opennextjs-cloudflare build && pnpm exec opennextjs-cloudflare preview --port 3161
//
// Environment: DEMO_RPC (http://127.0.0.1:8961), DEMO_API (http://localhost:8861), DEMO_WEB
// (http://localhost:3161), DATABASE_URL (the API's database, for the snapshots it keeps),
// DEMO_HOSTILE_URL (a hostile fixture's https URL; without it the third update is skipped). The
// registrar is the project's upgrade authority (~/.config/testing-pipeline/devnet/), which the local
// validator makes the tax AMM's; nothing goes to devnet. The demo plays Cloudflare's part too: it
// fires the API's every-minute cron at each minute.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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
import postgres from "postgres";
import { StrategyDetail } from "terminal-api/contract";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const RPC = process.env.DEMO_RPC ?? "http://127.0.0.1:8961";
const API = process.env.DEMO_API ?? "http://localhost:8861";
const WEB = process.env.DEMO_WEB ?? "http://localhost:3161";
const HOSTILE = process.env.DEMO_HOSTILE_URL;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is not set: name the database the demo's API writes to.");
const SCREENSHOTS = join(ROOT, "tests/terminal-e2e/screenshots/demo");
const TAX_AMM = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t" as Address;
/** The tax AMM's metadata at two commits of this repo: two documents behind two https URLs, the second changed. */
const DOCUMENTS = ["410f4b3", "869c776"].map((commit) => `https://raw.githubusercontent.com/imDev2023/testing-pipeline/${commit}/programs/tax-amm/metadata.json`);
/** The bound the ticket sets: a `MetadataUpdated` is fetched within a minute. */
const WITHIN_MS = 60_000;

const rpc = createSolanaRpc(RPC);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, ms: number): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
    await sleep(500);
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

/** Plays Cloudflare's every-minute cron against the local API: fires it at the start of each minute. */
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

const strategyNow = async () => StrategyDetail.parse(await (await fetch(`${API}/v1/strategies/${TAX_AMM}`)).json());

/** The SHA-256 of a document's bytes as the web serves them, worked out here apart from the API. */
async function shaOf(url: string): Promise<string> {
  return createHash("sha256").update(Buffer.from(await (await fetch(url)).arrayBuffer())).digest("hex");
}

/** Sends `update_metadata` naming `uri`, and times how long until the API holds that document, by its hash. */
async function update(authority: KeyPairSigner, uri: string): Promise<{ signature: string; ms: number; sha256: string }> {
  const sha256 = await shaOf(uri);
  const signature = await send(authority, [await pipeline.updateMetadata({ registrar: authority.address, strategyProgram: TAX_AMM, metadataUri: uri })]);
  const landed = Date.now();
  log(`MetadataUpdated landed at second ${new Date(landed).getUTCSeconds()} of the minute: ${signature}`);
  await until(`the document at ${uri}`, async () => {
    const { metadata } = await strategyNow();
    return metadata.uri === uri && metadata.sha256 === sha256;
  }, WITHIN_MS + 30_000);
  return { signature, ms: Date.now() - landed, sha256 };
}

const authority = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/testing-pipeline/devnet/upgrade-authority.json"), "utf8")) as number[]));
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
const stopCron = cronTicker();
try {
  const { value: balance } = await rpc.getBalance(authority.address).send();
  if (balance < 1_000_000_000n) await until("the airdrop", async () => (await rpc.requestAirdrop(authority.address, lamports(10_000_000_000n)).send()) && (await rpc.getBalance(authority.address).send()).value > balance, 60_000);

  // 1. Register the tax AMM with devnet's router, as its author would, naming the first document.
  const { value: configAccount } = await rpc.getAccountInfo(await pipeline.configPda(), { encoding: "base64" }).send();
  const config = pipeline.decodeConfig(Uint8Array.from(Buffer.from(configAccount!.data[0], "base64")))!;
  if (!(await rpc.getAccountInfo(await pipeline.strategyPda(TAX_AMM), { encoding: "base64" }).send()).value) {
    const signature = await send(authority, [
      await pipeline.registerStrategy({ payer: authority.address, registrar: authority.address, strategyProgram: TAX_AMM, listingFeeRecipient: config.listingFeeRecipient, metadataUri: DOCUMENTS[0]!, maxListingFeeLamports: config.listingFeeLamports }),
    ]);
    log(`registered with the router: ${signature}`);
  }
  const first = await until("the registration's document", async () => {
    const strategy = await strategyNow();
    return strategy.metadata.status === "valid" && strategy.metadata.uri === DOCUMENTS[0] && strategy;
  }, 150_000);
  log(`registered and fetched: ${first.name} (${first.metadata.status}), hash ${first.metadata.sha256}`);

  // 2. Two MetadataUpdated events: each document fetched within a minute, the changed one with a new hash.
  for (const uri of [DOCUMENTS[1]!, DOCUMENTS[0]!]) {
    const { signature, ms, sha256 } = await update(authority, uri);
    if (ms > WITHIN_MS) throw new Error(`the document of ${signature} was stored ${ms / 1000} s after it landed, past a minute`);
    log(`fetched and stored ${(ms / 1000).toFixed(1)} s after it landed: ${uri}, hash ${sha256}`);
  }
  const rows = await sql<{ id: string; status: string; sha256: string | null; uri: string }[]>`select id, status, sha256, uri from metadata_snapshots where program = ${TAX_AMM} order by id`;
  log(`snapshots kept: ${rows.map((r) => `${r.id} ${r.status} ${r.sha256?.slice(0, 12)} ${r.uri.split("/")[5]}`).join("; ")}`);
  if (new Set(rows.map((r) => r.sha256)).size < 2) throw new Error("the changed document's new hash was not stored");

  // 3. A hostile fixture's document: its author text shows as plain text in the author's style, no link and no markup.
  if (HOSTILE) {
    const { ms } = await update(authority, HOSTILE);
    const strategy = await strategyNow();
    log(`hostile document stored ${(ms / 1000).toFixed(1)} s after it landed: name ${JSON.stringify(strategy.name)}, removed ${JSON.stringify(strategy.metadata.removed)}`);
    const browser = await chromium.launch();
    try {
      for (const colorScheme of ["light", "dark"] as const) {
        for (const width of [1440, 390, 360]) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
          await page.goto(`${WEB}/strategies/${TAX_AMM}`);
          const heading = page.getByRole("heading", { level: 1 });
          await heading.getByText(strategy.name!, { exact: true }).waitFor();
          const head = await page.locator("header").filter({ has: heading }).evaluate((el) => ({
            links: [...el.querySelectorAll("a")].map((a) => a.getAttribute("href")),
            markup: [...el.querySelectorAll("script, img, b, strong, em, i")].length,
            text: (el as HTMLElement).innerText,
          }));
          if (head.markup) throw new Error("the author's text became markup");
          if (head.links.some((href) => href && !href.startsWith("https://explorer.solana.com/"))) throw new Error(`the head links somewhere of the author's: ${head.links.join(", ")}`);
          if (!head.text.includes(strategy.name!) || (strategy.description && !head.text.includes(strategy.description))) throw new Error("the page does not show the author's text as it was stored");
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (overflow !== 0) throw new Error(`the page scrolls sideways by ${overflow} px at ${width} px`);
          await page.screenshot({ path: join(SCREENSHOTS, `${width}-${colorScheme}`, "strategy-hostile-metadata.png"), fullPage: true });
          await page.close();
        }
      }
      log(`the strategy page shows the hostile fixture's author text as plain text; screenshots in ${SCREENSHOTS}`);
    } finally {
      await browser.close();
    }
  }
  log("done");
} finally {
  stopCron();
  await sql.end();
}
