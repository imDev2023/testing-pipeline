// The buy wall AMM's panel and forms on devnet (#57, the ticket's browser run): with the Playwright
// test wallet holding the test trader's devnet key, on Aviary's local run against devnet,
//
//   1. a Token-2022 token is made whose transfer hook is cleared (no program, no authority) and whose
//      mint authority is removed, its supply in the trader's wallet, as a contained token is after its
//      unlock: the case the hosted API refuses and Aviary builds itself with Pipeline's SDK;
//   2. the create page's buy wall form, pre-filled with IMD's launch values, creates and seeds a market
//      of it in one transaction;
//   3. the new market's panel is read, a buy and a sell go through the trade box, and each keeper job
//      that falls due is pressed from its button (place_wall, settle, pay_rewards and the fee sweeps),
//      each simulated, reviewed and signed;
//   4. the trader hands its fee recipient role to the project wallet, after which the form is gone;
//   5. on the demo market (#56) a buy and a sell go through the trade box and each keeper job that
//      falls due is pressed;
//
// with screenshots at 1440 and 390 px in both themes. It sends real devnet transactions and spends
// about 0.7 SOL of the test trader's (the seed's 0.5 SOL stays in the new market for good), so it runs
// only when asked:
//
//   node tests/terminal-e2e/demo/buy-wall.ts
//
// Environment: RPC_URL (devnet; the test wallet sends through it), DEMO_API (http://localhost:8857),
// DEMO_WEB (http://localhost:3157). Each signature and what each review showed are written to
// test-results/buy-wall-demo.json for the PR, and screenshots to screenshots/demo/buy-wall/.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "@playwright/test";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  AuthorityType,
  extension,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction,
  getInitializeTransferHookInstruction,
  getMintSize,
  getMintToInstruction,
  getSetAuthorityInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import {
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { MarketKeeper } from "terminal-api/contract";
import { connectTestWallet, installTestWallet, projectWalletSigner, testTraderSigner } from "../src/wallet.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const API = process.env.DEMO_API ?? "http://localhost:8857";
const WEB = process.env.DEMO_WEB ?? "http://localhost:3157";
const RPC = process.env.RPC_URL;
if (!RPC) throw new Error("RPC_URL is not set: run this through direnv, which loads the project's .env");
const SCREENSHOTS = join(ROOT, "tests/terminal-e2e/screenshots/demo/buy-wall");
const RESULTS = join(ROOT, "tests/terminal-e2e/test-results/buy-wall-demo.json");
const DEMO_MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const DECIMALS = 6;
const UNSET = "11111111111111111111111111111111" as Address;
/** The new market's seed in SOL, and the buy-and-sell rounds traded on it. */
const SEED_SOL = "0.5";
const BUY_SOL = "0.6";
const ROUNDS = 3;
const SUPPLY = 1_000_000n * 10n ** BigInt(DECIMALS);

const rpc = createSolanaRpc(RPC);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

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
  }, 90_000);
  return signature;
}

/**
 * A Token-2022 token with a TransferHook extension whose program and authority are both unset, its
 * whole supply in `holder`'s wallet, its mint authority then removed and no freeze authority: what
 * the buy wall AMM's seed accepts (docs/spec/pool4-for-solana.md, Mint rules).
 */
async function launchClearedHookToken(payer: KeyPairSigner, holder: Address): Promise<{ mint: Address; signatures: string[] }> {
  const mint = await generateKeyPairSigner();
  // Only the extension's size matters here; the all-zero key is how Token-2022 stores "unset".
  const space = getMintSize([extension("TransferHook", { authority: UNSET, programId: UNSET })]);
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
  const [account] = await findAssociatedTokenPda({ owner: holder, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
  const made = await send(payer, [
    getCreateAccountInstruction({ payer, newAccount: mint, lamports: rent, space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    // Token-2022 will not start a hook with neither set: the payer holds its authority, removed below.
    getInitializeTransferHookInstruction({ mint: mint.address, authority: payer.address, programId: null }),
    getInitializeMintInstruction({ mint: mint.address, decimals: DECIMALS, mintAuthority: payer.address, freezeAuthority: null }),
    getCreateAssociatedTokenIdempotentInstruction({ payer, ata: account, owner: holder, mint: mint.address, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    getMintToInstruction({ mint: mint.address, token: account, mintAuthority: payer, amount: SUPPLY }),
    getSetAuthorityInstruction({ owned: mint.address, owner: payer, authorityType: AuthorityType.MintTokens, newAuthority: null }),
    getSetAuthorityInstruction({ owned: mint.address, owner: payer, authorityType: AuthorityType.TransferHookProgramId, newAuthority: null }),
  ]);
  return { mint: mint.address, signatures: [made] };
}

type Step = { name: string; signature: string; slot: string; changes: string[] };
const steps: Step[] = [];
const record: Record<string, unknown> = { steps };
const save = () => {
  mkdirSync(dirname(RESULTS), { recursive: true });
  writeFileSync(RESULTS, `${JSON.stringify(record, null, 2)}\n`);
};

async function shot(page: Page, name: string) {
  mkdirSync(SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: join(SCREENSHOTS, `${name}.png`), fullPage: true, animations: "disabled" });
}

/** Simulates what `scope`'s button prepares, checks the review shows the wallet's changes, signs it and waits for it to confirm. */
async function simulateAndSign(page: Page, scope: Locator, button: string | RegExp, review: string, name: string): Promise<Step> {
  await scope.getByRole("button", { name: button }).click();
  const panel = scope.getByRole("region", { name: review });
  const passed = panel.getByText("This is what signing would change in your wallet:", { exact: false });
  const failed = panel.getByRole("alert");
  await passed.or(failed).first().waitFor({ timeout: 90_000 });
  if (await failed.isVisible()) {
    await shot(page, `${name}-refused`);
    throw new Error(`${name}: the review refused it: ${(await failed.innerText()).replace(/\s+/g, " ")}`);
  }
  const changes = await panel.locator("dl > div").allInnerTexts();
  await shot(page, `${name}-review`);
  await panel.getByRole("button", { name: "Sign in wallet" }).click();
  await panel.getByText(/^Confirmed in slot [\d,]+\.$/).waitFor({ timeout: 90_000 });
  const slot = (await panel.getByText(/^Confirmed in slot/).innerText()).replace(/\D/g, "");
  const href = await panel.getByRole("link", { name: /Transaction .* on the explorer/ }).getAttribute("href");
  const signature = decodeURIComponent(new URL(href!).pathname.split("/").pop()!);
  await shot(page, `${name}-confirmed`);
  const step = { name, signature, slot, changes: changes.map((c) => c.replace(/\s+/g, " ").trim()) };
  steps.push(step);
  save();
  log(`${name}: confirmed in slot ${slot}, ${signature}; the review showed ${step.changes.join("; ")}`);
  return step;
}

/** A swap through the trade box: `typed` of the mint it pays with, reviewed, signed and confirmed. */
async function swap(page: Page, typed: string, name: string) {
  const box = page.getByRole("region", { name: "Swap", exact: true });
  await box.getByLabel("You pay, fees included").fill(typed);
  await box.getByRole("button", { name: "Review swap" }).click({ timeout: 60_000 });
  const review = page.getByRole("region", { name: "Review this swap" });
  await review.getByRole("button", { name: "Sign in wallet" }).click({ timeout: 90_000 });
  await review.getByText(/^Confirmed in slot [\d,]+\. The trade is at the top of Trades\.$/).waitFor({ timeout: 90_000 });
  const href = await review.getByRole("link", { name: /Transaction .* on the explorer/ }).getAttribute("href");
  const signature = href ? decodeURIComponent(new URL(href).pathname.split("/").pop()!) : "";
  steps.push({ name, signature, slot: "", changes: [`${typed} through the trade box`] });
  save();
  log(`${name}: ${typed} through the trade box, confirmed ${signature}`);
  await review.getByRole("button", { name: "Make another swap" }).click();
}

const keeperOf = async (market: string) => MarketKeeper.parse(await (await fetch(`${API}/v1/markets/${market}/keeper`)).json());

/** Each due job's heading in the forms, by its unit's key. */
const JOB_TITLES: Record<string, string> = {
  place_wall: "Place the buy wall",
  settle: "Settle the retired tokens",
  pay_rewards: "Pay the rewards",
  "sweep_fees:0": "Sweep the fee recipient's share",
  "sweep_fees:1": "Sweep the designer share",
  "sweep_fees:2": "Sweep the suite share",
};

/** The market's own forms under Actions: the buy wall AMM's keeper jobs and handovers. */
const productForms = (page: Page) => page.getByRole("region", { name: "Buy wall AMM: keeper jobs and roles" });

/** Presses every keeper job due on the market, one at a time, from its button, until none is due; returns the jobs pressed. */
async function pressDueJobs(page: Page, market: string, prefix: string, wanted: number): Promise<string[]> {
  const pressed: string[] = [];
  for (let round = 0; round < 8; round++) {
    const due = (await keeperOf(market)).due;
    if (!due.length) break;
    const unit = due[0]!;
    await page.reload();
    const forms = productForms(page);
    const item = forms.getByRole("listitem").filter({ has: page.getByRole("heading", { level: 4, name: JOB_TITLES[unit.key] ?? unit.key, exact: true }) });
    await item.waitFor({ timeout: 60_000 });
    if (pressed.length === 0) await shot(page, `${prefix}-due`);
    await simulateAndSign(page, item, /^Simulate /, "Review this action", `${prefix}-${unit.key.replace(":", "-")}`);
    // The pressed job stays on screen, confirmed, until its review is left.
    await item.getByRole("button", { name: "Done" }).click();
    pressed.push(unit.key);
    // The next read of the market shows what the job moved; wait for the API to see the job no longer due.
    await until(`${unit.key} to be done`, async () => !(await keeperOf(market)).due.some((d) => d.key === unit.key), 60_000);
  }
  if (pressed.length < wanted) throw new Error(`${prefix}: only ${pressed.length} jobs fell due (${pressed.join(", ")}), wanted ${wanted}`);
  return pressed;
}

/** The trader's balance of `mint`, in base units. */
async function tokenBalance(owner: Address, mint: Address, tokenProgram: Address): Promise<bigint> {
  const [account] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
  const { value } = await rpc.getTokenAccountBalance(account, { commitment: "confirmed" }).send().catch(() => ({ value: { amount: "0" } }));
  return BigInt(value.amount);
}

/** Every width and theme the PR shows, each a fresh page connected to the test wallet. */
async function photograph(browser: Awaited<ReturnType<typeof chromium.launch>>, trader: KeyPairSigner, path: string, name: string, ready: (page: Page) => Promise<void>) {
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
      await installTestWallet(page, trader);
      await page.goto(`${WEB}${path}`);
      await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: /Connect wallet|Connect/ }).first());
      await ready(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 0) log(`${name} at ${width}-${theme}: scrolls sideways by ${overflow} px`);
      mkdirSync(join(SCREENSHOTS, `${width}-${theme}`), { recursive: true });
      await page.screenshot({ path: join(SCREENSHOTS, `${width}-${theme}`, `${name}.png`), fullPage: true, animations: "disabled" });
      await page.close();
    }
  }
}

const trader = await testTraderSigner();
const project = await projectWalletSigner();
const browser = await chromium.launch();
try {
  // 1. The token: Token-2022, its transfer hook cleared, its mint authority removed.
  const token = await launchClearedHookToken(trader, trader.address);
  record.token = token;
  save();
  log(`token ${token.mint}: Token-2022 with a cleared transfer hook, ${SUPPLY} base units in the test trader's wallet, no mint or freeze authority`);

  // 2. The create page: the buy wall AMM's own form, pre-filled with IMD's launch values; the token and the seed entered.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
  page.on("pageerror", (e) => log(`page error: ${e.message}`));
  await installTestWallet(page, trader);
  await page.goto(`${WEB}/create`);
  await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
  await page.getByRole("listitem").filter({ hasText: "BmXE...g4V6" }).getByRole("button", { name: "Open its create form" }).click();
  const createPanel = page.getByRole("region", { name: "The create form" });
  await createPanel.getByRole("region", { name: "The whole fee split" }).waitFor();
  await shot(page, "create-prefilled");
  await createPanel.getByRole("textbox", { name: /^token_mint a mint, by its address$/ }).fill(token.mint);
  await createPanel.getByLabel("The facts of token_mint").waitFor({ timeout: 60_000 });
  await createPanel.getByRole("textbox", { name: /\btoken_amount u64\b/ }).fill("1000000");
  await createPanel.getByRole("textbox", { name: /\bsol_amount u64\b/ }).fill(SEED_SOL);
  await shot(page, "create-filled");
  const created = await simulateAndSign(page, createPanel, "Simulate creating and seeding the market", "Review the new market", "create-and-seed");
  await createPanel.getByRole("link", { name: "Open the new market's page" }).click({ timeout: 120_000 });
  await page.waitForURL(/\/markets\//);
  const market = page.url().split("/markets/")[1]!.split(/[?#]/)[0]!;
  record.market = market;
  save();
  log(`the new market: ${market}, created and seeded in ${created.signature}`);

  // 3. The panel, then a buy and a sell back through the trade box.
  await page.getByRole("region", { name: "Buy wall AMM" }).getByText("Read from the market's state at slot").waitFor({ timeout: 60_000 });
  await shot(page, "market-new");
  await photograph(browser, trader, `/markets/${market}`, "market-new", async (p) => void (await p.getByRole("region", { name: "Buy wall AMM" }).getByText("Read from the market's state").waitFor({ timeout: 60_000 })));
  // Rounds of a buy and a sell back: the wall's share of their fees, and the trims as the cap falls, build idle SOL past WALL_THRESHOLD.
  for (let round = 1; round <= ROUNDS; round++) {
    await page.getByRole("region", { name: "Swap", exact: true }).waitFor();
    await swap(page, BUY_SOL, `new-buy-${round}`);
    const bought = await until("the bought tokens", async () => (await tokenBalance(trader.address, token.mint, TOKEN_2022_PROGRAM_ADDRESS)) || null, 60_000);
    await page.getByRole("region", { name: "Swap", exact: true }).getByRole("button", { name: "Switch the two sides" }).click();
    await swap(page, String(Number(bought) / 10 ** DECIMALS), `new-sell-${round}`);
    await page.getByRole("region", { name: "Swap", exact: true }).getByRole("button", { name: "Switch the two sides" }).click();
  }
  const due = await until("the jobs the trades made due", async () => {
    const keys = (await keeperOf(market)).due.map((d) => d.key);
    return keys.includes("settle") && keys.includes("place_wall") && keys;
  }, 120_000);
  log(`due on the new market: ${due.join(", ")}`);
  await photograph(browser, trader, `/markets/${market}`, "market-new-due", async (p) => void (await productForms(p).getByRole("heading", { name: "Place the buy wall" }).waitFor({ timeout: 60_000 })));
  record.newMarketJobs = await pressDueJobs(page, market, "new", 5);

  // 4. The fee recipient role, handed by the trader to the project wallet; the form is then gone.
  await page.reload();
  const handover = productForms(page).getByRole("region", { name: "Hand over the fee recipient role" });
  await handover.getByRole("textbox", { name: "New fee recipient" }).fill(project.address);
  await simulateAndSign(page, handover, "Simulate the handover", "Review this action", "handover-fee-recipient");
  await handover.getByText(/^The role has left your wallet for /).waitFor({ timeout: 60_000 });
  await shot(page, "handover-confirmed-kept");
  await handover.getByRole("button", { name: "Done" }).click();
  await until("the handover form to leave", async () => {
    await page.reload();
    await productForms(page).getByRole("heading", { name: "Keeper jobs due" }).waitFor();
    return (await productForms(page).getByRole("region", { name: "Hand over the fee recipient role" }).count()) === 0;
  }, 60_000);
  await page.getByRole("region", { name: "Buy wall AMM" }).getByText(`${project.address.slice(0, 4)}...${project.address.slice(-4)}`).first().waitFor({ timeout: 60_000 });
  await shot(page, "after-handover");
  await photograph(browser, trader, `/markets/${market}`, "market-new-after", async (p) => void (await p.getByRole("region", { name: "Buy wall AMM" }).getByText("Read from the market's state").waitFor({ timeout: 60_000 })));

  // 5. The demo market: a buy and a sell through the trade box, then each keeper job that falls due.
  await page.goto(`${WEB}/markets/${DEMO_MARKET}`);
  await page.getByRole("region", { name: "Buy wall AMM" }).getByText("Read from the market's state at slot").waitFor({ timeout: 60_000 });
  await photograph(browser, trader, `/markets/${DEMO_MARKET}`, "market-demo", async (p) => void (await p.getByRole("region", { name: "Buy wall AMM" }).getByText("Read from the market's state").waitFor({ timeout: 60_000 })));
  const demoToken = "9qTA6qhsFwpvDvqMmiQifnQK53ijsoFXYLpH2fJembd7" as Address;
  const tokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
  const before = await tokenBalance(trader.address, demoToken, tokenProgram);
  await swap(page, "0.5", "demo-buy");
  const got = await until("the demo market's bought tokens", async () => {
    const now = await tokenBalance(trader.address, demoToken, tokenProgram);
    return now > before ? now - before : null;
  }, 60_000);
  await page.getByRole("region", { name: "Swap", exact: true }).getByRole("button", { name: "Switch the two sides" }).click();
  await swap(page, String(Number(got) / 1e6), "demo-sell");
  await until("a job the trades made due on the demo market", async () => (await keeperOf(DEMO_MARKET)).due.length > 0, 120_000);
  record.demoMarketJobs = await pressDueJobs(page, DEMO_MARKET, "demo", 1);
  await photograph(browser, trader, `/markets/${DEMO_MARKET}`, "market-demo-after", async (p) => void (await p.getByRole("region", { name: "Buy wall AMM" }).getByText("Read from the market's state").waitFor({ timeout: 60_000 })));
  save();
  log(`done: ${steps.length} transactions, written to ${RESULTS}`);
} finally {
  await browser.close();
}
