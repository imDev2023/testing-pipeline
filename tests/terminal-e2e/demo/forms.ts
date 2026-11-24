// Aviary's forms demo on a local validator (#123, the ticket's local run): devnet's router with the
// tax AMM's deployed bytes, registered with the router here from its committed metadata
// (programs/tax-amm/metadata.json), which a local fixture serves through the API's test-only fetcher
// setting (TEST_METADATA_FIXTURES); then, with the Playwright test wallet holding the test trader's
// key, a tax market is created from the create-market page, and each custom action the tax AMM's
// metadata describes is sent from its generic form on the market page, each simulated first with its
// balance changes shown, with a buy and a sell through the trade box between them so there is tax to
// pay out and burn. Last, the API's one-slot read of the market's state with its two vaults.
//
//   node tests/terminal-e2e/demo/forms.ts
//
// Before it, from the repo's root (each long-running one in a shell of its own):
//   solana program dump -u devnet J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t fixtures/forms-demo/deploy/tax_amm.so
//   SKIP_PROGRAMS="buy-wall-amm containment-hook lending-amm" CARGO_TARGET_DIR=fixtures/forms-demo \
//     scripts/local-validator.sh fixtures/test-ledger-forms --rpc-port 8971 --faucet-port 9971 \
//     --gossip-port 8981 --dynamic-port-range 8500-8550
//   (apps/terminal-api) RPC_URL=http://127.0.0.1:8971 DATABASE_URL=<a fresh migrated database> TERMINAL_API_PORT=8873 \
//     node scripts/dev.ts --var TEST_METADATA_FIXTURES:http://127.0.0.1:8874/__metadata --enable-containers=false
//   (apps/terminal-web) NEXT_PUBLIC_API_URL=http://localhost:8873 pnpm exec opennextjs-cloudflare build && pnpm exec opennextjs-cloudflare preview --port 3173
//
// Environment: DEMO_RPC (http://127.0.0.1:8971), DEMO_API (http://localhost:8873), DEMO_WEB
// (http://localhost:3173), DEMO_METADATA_PORT (8874, where this script serves the metadata). The
// registrar is the project's upgrade authority (~/.config/testing-pipeline/devnet/), which the local
// validator makes the tax AMM's; the trader is the e2e test trader. Both are funded by the local
// validator's faucet; nothing goes to devnet. The demo plays Cloudflare's part too: it fires the
// API's every-minute cron at each minute. Each signature and the balance changes each review showed
// are written to test-results/forms-demo.json for the PR, and screenshots to screenshots/demo/.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pipeline from "@pipeline-sol/sdk";
import { chromium, type Page } from "@playwright/test";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  AuthorityType,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressDecoder,
  getAddressEncoder,
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
import { Fees, MarketRead, StrategyForms } from "terminal-api/contract";
import { connectTestWallet, installTestWallet, testTraderSigner, TEST_TRADER } from "../src/wallet.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const RPC = process.env.DEMO_RPC ?? "http://127.0.0.1:8971";
const API = process.env.DEMO_API ?? "http://localhost:8873";
const WEB = process.env.DEMO_WEB ?? "http://localhost:3173";
const METADATA_PORT = Number(process.env.DEMO_METADATA_PORT ?? 8874);
const SCREENSHOTS = join(ROOT, "tests/terminal-e2e/screenshots/demo/forms");
const RESULTS = join(ROOT, "tests/terminal-e2e/test-results/forms-demo.json");
const TAX_AMM = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t" as Address;
const WSOL = pipeline.NATIVE_MINT_ADDRESS;
/** Where the strategy's metadata is said to live: main's committed file, served here from this checkout's copy. */
const METADATA_URI = "https://raw.githubusercontent.com/imDev2023/testing-pipeline/main/programs/tax-amm/metadata.json";
const METADATA = readFileSync(join(ROOT, "programs/tax-amm/metadata.json"));
const TOKEN_DECIMALS = 6;
const NO_ADDRESS = "11111111111111111111111111111111";
const TOKEN_SUPPLY = 10_000_000n * 10n ** BigInt(TOKEN_DECIMALS);

// The browser's test wallet sends through RPC_URL: here, the local validator.
process.env.RPC_URL = RPC;
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

async function fund(address: Address, sol: bigint) {
  const { value: balance } = await rpc.getBalance(address).send();
  if (balance >= sol * 1_000_000_000n) return;
  await rpc.requestAirdrop(address, lamports(sol * 1_000_000_000n)).send();
  await until(`the airdrop to ${address}`, async () => (await rpc.getBalance(address).send()).value > balance, 60_000);
}

/** Plays Cloudflare's every-minute cron against the local API: fires it at once, then at the start of each minute. */
function cronTicker(): () => void {
  let timer: ReturnType<typeof setTimeout>;
  const fire = () => fetch(`${API}/__scheduled?cron=${encodeURIComponent("* * * * *")}`).catch((e: unknown) => log(`cron failed: ${String(e)}`));
  const tick = () => {
    timer = setTimeout(async () => {
      await fire();
      tick();
    }, 60_000 - (Date.now() % 60_000) + 500);
  };
  void fire();
  tick();
  return () => clearTimeout(timer);
}

/** The test-only fetcher's fixture: answers the metadata URI with the committed document, as GitHub serves it, and 404 for anything else. */
function serveMetadata() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost").searchParams.get("url");
    if (url === METADATA_URI) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(METADATA);
    } else {
      res.writeHead(404, { "content-type": "text/plain" }).end("404: Not Found");
    }
  });
  return new Promise<typeof server>((ready) => server.listen(METADATA_PORT, "127.0.0.1", () => ready(server)));
}

/** A classic SPL token with no mint or freeze authority left, its whole supply in the trader's wallet, as a token must be for a tax market's seed. */
async function launchToken(payer: KeyPairSigner, holder: Address): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  const [holding] = await findAssociatedTokenPda({ owner: holder, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await send(payer, [
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: mint.address, decimals: TOKEN_DECIMALS, mintAuthority: payer.address, freezeAuthority: null }),
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: holding, owner: holder, mint: mint.address }),
    getMintToInstruction({ mint: mint.address, token: holding, mintAuthority: payer, amount: TOKEN_SUPPLY }),
    getSetAuthorityInstruction({ owned: mint.address, owner: payer, authorityType: AuthorityType.MintTokens, newAuthority: null }),
  ]);
  return mint.address;
}

/** The create form's values, as typed into the page: the same values the terms hash is worked out from. */
function createValues(trader: Address) {
  return {
    tax_side: "1",
    buy_tax_bps: "300",
    sell_tax_bps: "500",
    buy_tax_min_bps: "0",
    buy_tax_max_bps: "1000",
    sell_tax_min_bps: "0",
    sell_tax_max_bps: "1000",
    tax_authority: trader,
    seeder: trader,
    recipient_0: trader,
    // An unused recipient slot holds no address (the all-zero key, written in base58 as 32 ones).
    recipient_1: NO_ADDRESS,
    recipient_2: NO_ADDRESS,
    recipient_3: NO_ADDRESS,
    share_0: "5000",
    share_1: "0",
    share_2: "0",
    share_3: "0",
    burn_share_bps: "5000",
    virtual_side: "0",
    virtual_reserve: "0",
  };
}

/**
 * The hash of the market's terms that `seed` checks (docs/spec/tax-amm.md, "The seed"): the SHA-256 of
 * the two mints, the create form's `init_data` and an empty pending change, as base58, which is what
 * a seeder who created the market types into the seed form's `expected_terms`.
 */
function termsHash(mints: [Address, Address], values: Record<string, string>): string {
  const init = (JSON.parse(METADATA.toString()) as { init: pipeline.MetadataInit }).init;
  const encoded = pipeline.encodeArgs(init.args ?? [], values);
  const hasher = createHash("sha256");
  for (const mint of mints) hasher.update(new Uint8Array(getAddressEncoder().encode(mint)));
  for (const arg of init.args ?? []) hasher.update(encoded[arg.name]!);
  hasher.update(new Uint8Array(12));
  return getAddressDecoder().decode(new Uint8Array(hasher.digest()));
}

type Step = { name: string; signature: string; slot: string; changes: string[] };
const steps: Step[] = [];

async function shot(page: Page, name: string) {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`), fullPage: true, animations: "disabled" });
}

/** Fills a form's fields: each address the form asks for by its input's name, each argument by its name and type. */
async function fill(scope: ReturnType<Page["locator"]>, inputs: Record<string, string>, args: Record<string, string>) {
  for (const [name, value] of Object.entries(inputs)) await scope.getByRole("textbox", { name: new RegExp(`^${name} (a mint, by its address|an address)$`) }).fill(value);
  for (const [name, value] of Object.entries(args)) await scope.getByRole("textbox", { name: new RegExp(`\\b${name} (u8|u16|u32|u64|i64|pubkey|bytes|string)\\b`) }).fill(value);
}

/** Simulates what the scope's form holds, checks the review shows what signing changes in the wallet, signs it and waits for it to confirm. */
async function simulateAndSign(page: Page, scope: ReturnType<Page["locator"]>, button: string, review: string, name: string): Promise<Step> {
  await scope.getByRole("button", { name: button }).click();
  const panel = scope.getByRole("region", { name: review });
  const passed = panel.getByText("This is what signing would change in your wallet:", { exact: false });
  const failed = panel.getByRole("alert");
  await passed.or(failed).first().waitFor({ timeout: 60_000 });
  if (await failed.isVisible()) {
    await shot(page, `${name}-refused`);
    throw new Error(`${name}: the review refused it: ${(await failed.innerText()).replace(/\s+/g, " ")}`);
  }
  const changes = await panel.locator("dl > div").allInnerTexts();
  await shot(page, `${name}-review`);
  await panel.getByRole("button", { name: "Sign in wallet" }).click();
  await panel.getByText(/^Confirmed in slot [\d,]+\.$/).waitFor({ timeout: 70_000 });
  const slot = (await panel.getByText(/^Confirmed in slot/).innerText()).replace(/\D/g, "");
  const href = await panel.getByRole("link", { name: /Transaction .* on the explorer/ }).getAttribute("href");
  const signature = decodeURIComponent(new URL(href!).pathname.split("/").pop()!);
  await shot(page, `${name}-confirmed`);
  const step = { name, signature, slot, changes: changes.map((c) => c.replace(/\s+/g, " ").trim()) };
  steps.push(step);
  log(`${name}: confirmed in slot ${slot}, ${signature}; the review showed ${step.changes.join("; ")}`);
  return step;
}

/** One of the market page's action forms, by its author's label, opened. */
async function actionForm(page: Page, label: string) {
  const form = page.locator("details").filter({ has: page.locator("summary").getByText(label, { exact: true }) });
  if ((await form.getAttribute("open")) === null) await form.locator("summary").click();
  return form;
}

/** A swap through the trade box: `typed` of the mint it pays with, reviewed, signed and confirmed. */
async function swap(page: Page, typed: string, name: string) {
  const box = page.getByRole("region", { name: "Swap", exact: true });
  await box.getByLabel("You pay, fees included").fill(typed);
  await box.getByRole("button", { name: "Review swap" }).click({ timeout: 30_000 });
  const review = page.getByRole("region", { name: "Review this swap" });
  await review.getByRole("button", { name: "Sign in wallet" }).click({ timeout: 60_000 });
  await review.getByText(/^Confirmed in slot [\d,]+\. The trade is at the top of Trades\.$/).waitFor({ timeout: 70_000 });
  log(`${name}: ${typed} through the trade box, confirmed`);
  await review.getByRole("button", { name: "Make another swap" }).click();
}

const authority = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/testing-pipeline/devnet/upgrade-authority.json"), "utf8")) as number[]));
const trader = await testTraderSigner();
const fixture = await serveMetadata();
const stopCron = cronTicker();
const browser = await chromium.launch();
try {
  await fund(authority.address, 10n);
  await fund(trader.address, 20n);
  // Aviary's fee wallet as devnet has it: SOL for the quotes' simulations it pays for (PIPESCOPE-132),
  // and its wrapped-SOL account, which a buy paid in SOL pays the integrator fee into.
  const fees = Fees.parse(await (await fetch(`${API}/v1/fees`)).json());
  await fund(address(fees.fee_wallet), 1n);
  const [feeAccount] = await findAssociatedTokenPda({ owner: address(fees.fee_wallet), mint: WSOL, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  if (fees.fee_mints.find((m) => m.mint === WSOL)?.account !== feeAccount) throw new Error("the fee wallet's wrapped-SOL account is not its associated token account");
  await send(authority, [getCreateAssociatedTokenIdempotentInstruction({ payer: authority, ata: feeAccount, owner: address(fees.fee_wallet), mint: WSOL })]);

  // 1. The tax AMM, registered with devnet's router as its author would, naming its committed metadata.
  const { value: configAccount } = await rpc.getAccountInfo(await pipeline.configPda(), { encoding: "base64" }).send();
  const config = pipeline.decodeConfig(Uint8Array.from(Buffer.from(configAccount!.data[0], "base64")))!;
  if (!(await rpc.getAccountInfo(await pipeline.strategyPda(TAX_AMM), { encoding: "base64" }).send()).value) {
    const signature = await send(authority, [
      await pipeline.registerStrategy({ payer: authority.address, registrar: authority.address, strategyProgram: TAX_AMM, listingFeeRecipient: config.listingFeeRecipient, metadataUri: METADATA_URI, maxListingFeeLamports: config.listingFeeLamports }),
    ]);
    log(`registered with the router: ${signature}`);
  }
  const forms = await until(
    "the strategy's forms, from its fetched metadata and its version's instruction list",
    async () => {
      const view = StrategyForms.parse(await (await fetch(`${API}/v1/strategies/${TAX_AMM}/forms`)).json());
      return view.metadata === "valid" && view.deploy_slot !== null && view;
    },
    180_000,
  );
  log(`forms: ${forms.actions.map((a) => `${a.name} (${a.check.outcome}, ${a.check.instruction})`).join(", ")}; create form ${forms.init?.check.outcome}`);

  // 2. A token to list, its supply in the trader's wallet and no authority left.
  const token = await launchToken(authority, trader.address);
  log(`token ${token}: ${TOKEN_SUPPLY} base units in the test trader's wallet, no mint authority`);

  // 3. The create-market page: the tax AMM chosen, the mints entered by address, simulated, reviewed and signed.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  page.on("pageerror", (e) => log(`page error: ${e.message}`));
  await installTestWallet(page, trader);
  await page.goto(`${WEB}/create`);
  await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
  const choice = page.getByRole("listitem").filter({ hasText: "J4sA...nW9t" });
  await choice.getByRole("button", { name: "Open its create form" }).click();
  const createPanel = page.getByRole("region", { name: "The create form" });
  const values = createValues(trader.address);
  await fill(createPanel, { mint_0: WSOL, mint_1: token }, values);
  await createPanel.getByLabel("The facts of mint_1").waitFor();
  await shot(page, "create-filled");
  await simulateAndSign(page, createPanel, "Simulate creating the market", "Review the new market", "create");
  await createPanel.getByRole("link", { name: "Open the new market's page" }).click({ timeout: 90_000 });
  await page.waitForURL(/\/markets\//);
  const market = page.url().split("/markets/")[1]!.split(/[?#]/)[0]!;
  log(`the new market's page: ${market}`);
  await page.getByRole("heading", { name: "Actions" }).waitFor();

  // 4. Seed, from the generic form: 0.5 SOL (wrapped for it and unwrapped after) and 1,000,000 tokens, with the terms' hash.
  const seed = await actionForm(page, "Seed liquidity");
  await fill(seed, {}, { amount_0: "0.5", amount_1: "1000000", expected_terms: termsHash([WSOL, token], values) });
  await simulateAndSign(page, seed, "Simulate this action", "Review this action", "seed");

  // 5. A buy and a sell through the trade box, so the market collects tax in the token (its tax side).
  await page.reload();
  await page.getByRole("region", { name: "Swap", exact: true }).waitFor();
  await swap(page, "0.05", "buy");
  await page.getByRole("region", { name: "Swap", exact: true }).getByRole("button", { name: "Switch the two sides" }).click();
  await swap(page, "40000", "sell");

  // 6. Pay out the first recipient's slot, then burn the burn slot's tax, each from its generic form.
  const distribute = await actionForm(page, "Pay out a tax slot");
  await fill(distribute, { tax_mint: token, recipient: trader.address }, { slot: "0" });
  await simulateAndSign(page, distribute, "Simulate this action", "Review this action", "distribute");
  const burn = await actionForm(page, "Burn the burn slot's tax");
  // The burn slot has no wallet: its recipient is the empty address, as the tax AMM's own demo passes it.
  await fill(burn, { tax_mint: token, recipient: NO_ADDRESS }, { slot: "4" });
  await simulateAndSign(page, burn, "Simulate this action", "Review this action", "burn");

  // 7. The tax authority's three actions: new taxes, new recipients, then renouncing the authority.
  const setTaxes = await actionForm(page, "Change the taxes");
  await fill(setTaxes, {}, { buy_tax_bps: "600", sell_tax_bps: "900" });
  await simulateAndSign(page, setTaxes, "Simulate this action", "Review this action", "set_taxes");
  const setRecipients = await actionForm(page, "Change the tax recipients");
  await fill(setRecipients, {}, { recipient_0: trader.address, recipient_1: NO_ADDRESS, recipient_2: NO_ADDRESS, recipient_3: NO_ADDRESS, share_0: "10000", share_1: "0", share_2: "0", share_3: "0", burn_share_bps: "0" });
  await simulateAndSign(page, setRecipients, "Simulate this action", "Review this action", "set_recipients");
  const renounce = await actionForm(page, "Renounce the tax authority");
  await simulateAndSign(page, renounce, "Simulate this action", "Review this action", "renounce_tax_authority");

  // 8. The one-slot read a product's panel makes: the market's state and its two vaults, at one slot.
  const view = (await (await fetch(`${API}/v1/markets/${market}`)).json()) as { mints: { vault: string | null }[] };
  const read = MarketRead.parse(await (await fetch(`${API}/v1/markets/${market}/state?accounts=${view.mints.map((m) => m.vault).join(",")}`)).json());
  log(`one-slot read at slot ${read.slot}: ${read.accounts.map((a) => `${a.role} ${a.address} ${a.exists ? `${a.size} bytes, owner ${a.owner}` : "missing"}`).join("; ")}`);

  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify({ market, token, trader: TEST_TRADER, steps, read: { slot: read.slot, accounts: read.accounts.map((a) => ({ address: a.address, role: a.role, size: a.size })) } }, null, 2)}\n`);
  log(`done: ${steps.length} transactions from the forms; results in ${RESULTS}`);
} finally {
  await browser.close();
  stopCron();
  fixture.close();
}
