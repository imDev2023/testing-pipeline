// The lending AMM in Aviary, on devnet (#88): the Playwright test wallet holds a devnet key (Aviary
// never holds one) and, through the real pages of the local run, creates a lending AMM market from the
// create form, adds, rebalances, removes in cash and in kind and locks; the panel's two largest sells
// are checked against the strategy's own quote at the same moment; with Kamino's reserve emergency
// mode turned on by #77's script the panel shows it and the removal form offers only in kind; and with
// the test borrower holding enough of the reserve, a rebalance pressed in the page puts the market in
// withdraw mode. A second wallet, the project's, creates a market of a token hooked by our
// containment hook (unlocked), built by Aviary with the hook's accounts.
//
// It sends real devnet transactions and changes our shared devnet Kamino reserve for a few minutes,
// putting it back as it was, so its project exists only when asked for (`pnpm --filter terminal-e2e
// lending:devnet`, E2E_LENDING_DEVNET), never in CI. The signatures go to test-results/lending.json.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { decodeMarket, marketViewFromMarket, quoteStrategy, resolveAccounts, SimulationError, TradeMode, type MarketView } from "@pipeline-sol/sdk";
import { getCreateAccountInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction, getMintSize, getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  address,
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
import { LendingPanel } from "terminal-api/lending-amm";
import { screenshot } from "./screenshot";
import { API, SEND_RPC } from "./target";
import { connectTestWallet, installTestWallet, projectWalletSigner, testTraderSigner } from "./wallet";

const PROGRAM = "Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG";
const KLEND = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
/** A token our containment hook binds, unlocked by its deadline on 2026-11-22 (deployments/devnet-demo-containment-hook.json), which the project wallet holds. */
const HOOKED_TOKEN = "AQSAyaGKsgrGqDDhA6ijW6cfuPwQkkcToSBWQBMFuk9v";
const KAMINO_DIR = `${import.meta.dirname}/../../../scripts/kamino-devnet`;
const signatures: [string, string][] = [];
const rpc = () => createSolanaRpc(SEND_RPC);

/** #77's script, `scripts/kamino-devnet`, run with its own keys: emergency mode, the test borrower, the second depositor, a refresh. */
function kamino(...args: string[]) {
  const out = execFileSync("node", ["src/cli.ts", ...args], { cwd: KAMINO_DIR, env: process.env, encoding: "utf8", timeout: 300_000 });
  signatures.push([`kamino-devnet ${args.join(" ")}`, out.match(/[1-9A-HJ-NP-Za-km-z]{86,88}/g)?.at(-1) ?? "(no signature printed)"]);
  return out;
}

async function send(signer: KeyPairSigner, instructions: Instruction[], what: string): Promise<string> {
  const { value: blockhash } = await rpc().getLatestBlockhash({ commitment: "confirmed" }).send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  const signature = getSignatureFromTransaction(signed);
  await rpc().sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  for (let i = 0; i < 90; i++) {
    const { value } = await rpc().getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`${what}: ${signature} failed`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") {
      signatures.push([what, signature]);
      return signature;
    }
    await new Promise((done) => setTimeout(done, 1_000));
  }
  throw new Error(`${what}: ${signature} did not confirm`);
}

/** A plain SPL test token, 6 decimals, its supply minted to `owner`. */
async function testToken(owner: KeyPairSigner): Promise<Address> {
  const mint = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  const rent = await rpc().getMinimumBalanceForRentExemption(space).send();
  const [ata] = await findAssociatedTokenPda({ owner: owner.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await send(
    owner,
    [
      getCreateAccountInstruction({ payer: owner, newAccount: mint, lamports: rent, space, programAddress: TOKEN_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: owner.address, freezeAuthority: null }),
      getCreateAssociatedTokenIdempotentInstruction({ payer: owner, ata, owner: owner.address, mint: mint.address }),
      getMintToInstruction({ mint: mint.address, token: ata, mintAuthority: owner, amount: 10_000_000_000_000n }),
    ],
    "create the test token",
  );
  return mint.address;
}

const panelRegion = (page: Page) => page.getByRole("region", { name: "Lending AMM", exact: true });
const actions = (page: Page) => page.getByRole("region", { name: "Actions" });
const form = (page: Page, title: string) => actions(page).locator("details").filter({ has: page.getByRole("heading", { name: title, exact: true }) });

async function readPanel(market: string, wallet?: string): Promise<LendingPanel> {
  return LendingPanel.parse(await (await fetch(`${API}/v1/markets/${market}/lending-amm${wallet ? `?wallet=${wallet}` : ""}`)).json());
}

/** Simulates the form's action, checks the review shows the wallet's changes, signs it in the test wallet and waits for it to confirm. */
async function simulateAndSign(page: Page, within: Locator, button: RegExp, what: string) {
  await within.getByRole("button", { name: button }).click();
  const review = within.getByRole("region", { name: /^Review / });
  await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeEnabled({ timeout: 60_000 });
  await expect(review).toContainText(/SOL/);
  await review.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(review).toContainText(/Confirmed in slot/, { timeout: 90_000 });
  const link = await review.getByRole("link", { name: /^Transaction / }).getAttribute("href");
  signatures.push([what, decodeURIComponent(link!.match(/tx\/([^?]+)/)![1]!)]);
  return review;
}

/** Waits until the panel's read, which every confirmed action reads again, satisfies `ok`. */
async function untilPanel(market: string, wallet: string, ok: (p: LendingPanel) => boolean, timeout = 60_000): Promise<LendingPanel> {
  let last: LendingPanel | null = null;
  await expect(async () => {
    last = await readPanel(market, wallet);
    expect(ok(last)).toBe(true);
  }).toPass({ timeout });
  return last!;
}

/** The program's pricing (src/pricing.rs, `exact_in`), to check a quote's figure against the panel's reserves. */
function exactIn(reserveIn: bigint, reserveOut: bigint, amount: bigint, feeBps: number): bigint {
  const net = amount - (amount * BigInt(feeBps) + 9_999n) / 10_000n;
  return (reserveOut * net) / (reserveIn + net);
}

async function marketView(market: string): Promise<MarketView> {
  const { value } = await rpc().getAccountInfo(address(market), { encoding: "base64", commitment: "confirmed" }).send();
  const decoded = decodeMarket(new Uint8Array(Buffer.from(value!.data[0], "base64")))!;
  return marketViewFromMarket(address(market), decoded, [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS]);
}

/** A sale of `amount` of the other mint into the market, quoted by the strategy itself: its accounts, its output, or its refusal. */
async function sell(view: MarketView, panel: LendingPanel, amount: bigint, payer: Address) {
  const trade = { mode: TradeMode.ExactIn, inputIndex: 1 - panel.lent_index, outputIndex: panel.lent_index, amount, trader: payer, extra: new Uint8Array() };
  try {
    const accounts = await resolveAccounts(rpc(), view, trade, payer, { commitment: "confirmed" });
    const { quote } = await quoteStrategy(rpc(), view, trade, accounts, payer, { commitment: "confirmed" });
    return { redeems: accounts.some((a) => a.address === KLEND), out: quote.amountOut, refused: null };
  } catch (e) {
    if (e instanceof SimulationError) return { redeems: false, out: 0n, refused: JSON.stringify(e.err, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v)) };
    throw e;
  }
}

test.describe.configure({ mode: "serial" });

let trader: KeyPairSigner;
/** LENDING_MARKET reruns the later steps on a market an earlier run created, rather than spending the trader's SOL on another. */
let market = process.env.LENDING_MARKET ?? "";

test.beforeAll(async () => {
  trader = await testTraderSigner();
  // Quotes and swaps of a market holding cTokens need the reserve refreshed within the last 9,000 slots.
  kamino("refresh", "--reserve", "wsol");
});

test.afterAll(() => {
  // Whatever happened, Kamino's devnet reserve goes back as it was.
  // Each is a no-op when the state is already back (the borrower owing nothing refuses quietly).
  for (const args of [["emergency", "off"], ["repay"], ["supply", "--reserve", "wsol"]]) {
    try {
      kamino(...args);
    } catch (e) {
      console.error(`kamino-devnet ${args.join(" ")} failed`, e);
    }
  }
  mkdirSync(`${import.meta.dirname}/../test-results`, { recursive: true });
  writeFileSync(`${import.meta.dirname}/../test-results/lending.json`, `${JSON.stringify({ market, signatures }, null, 2)}\n`);
});

test.describe("the lending AMM on devnet", () => {
  test("creates a market from the create form, pre-filled, in one transaction with its first deposit", async ({ page }, testInfo) => {
    test.skip(Boolean(process.env.LENDING_MARKET), "LENDING_MARKET names the market an earlier run created");
    test.setTimeout(300_000);
    const token = await testToken(trader);
    await installTestWallet(page, trader);
    await page.goto(`/create?strategy=${PROGRAM}`);
    const create = page.getByRole("region", { name: "The create form" });
    await connectTestWallet(page, create.getByRole("button", { name: "Connect wallet" }));
    await expect(create.getByLabel(/LP fee, in basis points/)).toHaveValue("30");
    await expect(create).toContainText("lent_index is 1, filled in");
    await create.getByLabel("The token, by its mint's address").fill(token);
    await expect(create.getByLabel("The token's facts")).toBeVisible({ timeout: 30_000 });
    await create.getByLabel("First deposit of the token").fill("1000000");
    // About 1 SOL: small enough that Kamino's free liquidity (about 5.8 SOL) is above five times its target lent value, so its first rebalance lends rather than entering withdraw mode, and large enough that the test borrower's 3.5 SOL puts it in withdraw mode later.
    await create.getByLabel(/^First deposit of/).last().fill("1");
    await screenshot(page, testInfo, "lending-create-form");
    const review = await simulateAndSign(page, create, /^Simulate creating the market$/, "create_market + init_fee_account x2 + add_liquidity");
    await review.getByRole("link", { name: "Open the new market's page" }).click({ timeout: 90_000 });
    await page.waitForURL(/\/markets\//);
    market = page.url().split("/markets/")[1]!.split(/[?#]/)[0]!;
    const panel = await untilPanel(market, trader.address, (p) => p.open);
    expect(panel).toMatchObject({ lp_fee_bps: 30, lent_index: 1, other_mint: token, buffer: "1000000000", ctokens: "0" });
  });

  test("adds, rebalances, removes in cash and in kind, and locks, each simulated and signed from its form", async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    await installTestWallet(page, trader);
    await page.goto(`/markets/${market}`);
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    await expect(panelRegion(page)).toContainText("Read from the market state", { timeout: 60_000 });

    const add = form(page, "Add liquidity");
    await add.getByLabel(/How much of the lent token to add/).fill("0.1");
    await simulateAndSign(page, add, /^Simulate add liquidity$/, "add_liquidity");
    let panel = await untilPanel(market, trader.address, (p) => p.rebalance.due);
    const remove = form(page, "Remove liquidity");
    // A market too large for Kamino's free liquidity would enter withdraw mode instead of lending (the panel says so): an earlier run's market is first brought down to about 1 SOL, in cash.
    if (panel.rebalance.withdraw_mode_after) {
      await expect(panelRegion(page)).toContainText("and enter withdraw mode", { timeout: 30_000 });
      const shares = BigInt(panel.wallet!.shares);
      const lp = shares - (shares * 1_000_000_000n) / BigInt(panel.lent_total!);
      await remove.locator("summary").click();
      await remove.getByLabel("LP shares to remove").fill((Number(lp) / 1e9).toFixed(9));
      await remove.getByLabel(/In cash/).check();
      await simulateAndSign(page, remove, /^Simulate remove liquidity$/, "remove_liquidity in cash, down to about 1 SOL");
      await remove.getByRole("button", { name: "Done" }).click();
    }
    // All of it sits in the buffer, above its band, so rebalance is due: a deposit into Kamino.
    await untilPanel(market, trader.address, (p) => p.rebalance.due && p.rebalance.deposit !== null);
    await expect(panelRegion(page)).toContainText("Due: it would deposit", { timeout: 30_000 });
    await screenshot(page, testInfo, "lending-rebalance-due");

    const rebalance = form(page, "Rebalance");
    await rebalance.locator("summary").click();
    await simulateAndSign(page, rebalance, /^Simulate rebalance$/, "rebalance (deposit)");
    panel = await untilPanel(market, trader.address, (p) => p.ctokens !== "0" && p.band === "within");
    expect(panel.buffer_share_bps).toBeGreaterThanOrEqual(1999);

    if ((await remove.getAttribute("open")) === null) await remove.locator("summary").click();
    await remove.getByLabel("LP shares to remove").fill("0.5");
    await expect(remove.getByLabel(/In cash/)).toBeEnabled();
    await remove.getByLabel(/In cash/).check();
    await simulateAndSign(page, remove, /^Simulate remove liquidity$/, "remove_liquidity in cash");
    await remove.getByRole("button", { name: "Done" }).click();
    await remove.getByLabel("LP shares to remove").fill("0.5");
    await remove.getByLabel(/In kind/).check();
    await simulateAndSign(page, remove, /^Simulate remove liquidity$/, "remove_liquidity in kind");

    const lockedBefore = BigInt((await readPanel(market)).lp.locked);
    const lock = form(page, "Lock LP shares");
    await lock.locator("summary").click();
    await lock.getByLabel("LP shares to lock, for good").fill("0.1");
    await simulateAndSign(page, lock, /^Simulate lock lp shares$/, "lock_lp");
    await untilPanel(market, trader.address, (p) => BigInt(p.lp.locked) === lockedBefore + 100_000_000n);

    // The history lists what was done, from the strategy's own events.
    await page.reload();
    const history = page.getByRole("region", { name: "Lending AMM history" });
    for (const words of ["Liquidity removed in cash", "Liquidity removed in kind", "LP shares locked", "Rebalanced: deposited", "First deposit", "Market created"]) await expect(history).toContainText(words, { timeout: 120_000 });
    await screenshot(page, testInfo, "lending-after-actions");
  });

  test("gives the two largest sells as the real edges of the strategy's own quote", async () => {
    test.setTimeout(300_000);
    kamino("refresh", "--reserve", "wsol");
    const view = await marketView(market);
    let panel = await readPanel(market);
    expect(panel.sells.refused).toBeNull();
    const edge = BigInt(panel.sells.into_market.buffer_alone!);
    const atEdge = await sell(view, panel, edge, trader.address);
    const past = await sell(view, panel, edge + 1n, trader.address);
    expect(atEdge).toMatchObject({ redeems: false, refused: null });
    expect(past).toMatchObject({ redeems: true, refused: null });
    // The quote prices from the same total the panel reads: the lent side's buffer plus its cTokens at Kamino's stored rate.
    expect(atEdge.out).toBe(exactIn(BigInt(panel.other_reserve), BigInt(panel.lent_total!), edge, panel.lp_fee_bps));
    expect(atEdge.out).toBeLessThanOrEqual(BigInt(panel.buffer));
    // Kamino holds more free than the market lent, so on top of the buffer it pays every sale this market can take.
    expect(panel.sells.with_kamino_pays_all).toBe(true);

    // Kamino is left with less free than the market lent, so there is a second edge: the second depositor takes back what it holds, up to that, and the test borrower borrows the rest.
    const free = BigInt(panel.kamino.free_liquidity!);
    const lent = BigInt(panel.lent_value!);
    const want = free - lent / 2n;
    const held = 4_900_000_000n;
    const takeBack = want < held ? want : held;
    const borrowed = want - takeBack;
    const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(9);
    kamino("take-back", "--reserve", "wsol", "--amount", sol(takeBack));
    try {
      if (borrowed > 0n) kamino("borrow", "--amount", sol(borrowed));
      kamino("refresh", "--reserve", "wsol");
      panel = await readPanel(market);
      expect(panel.sells.with_kamino_pays_all).toBe(false);
      const second = BigInt(panel.sells.into_market.with_kamino!);
      const atSecond = await sell(view, panel, second, trader.address);
      const beyond = await sell(view, panel, second + 1n, trader.address);
      expect(atSecond).toMatchObject({ redeems: true, refused: null });
      expect(beyond.refused).toMatch(/Custom/);
      signatures.push(["largest sells", JSON.stringify({ slot: panel.slot, free: panel.kamino.free_liquidity, buffer_alone: edge.toString(), with_kamino: second.toString(), refusedBeyond: beyond.refused })]);
    } finally {
      if (borrowed > 0n) kamino("repay");
      kamino("supply", "--reserve", "wsol");
    }
  });

  test("with Kamino's reserve emergency mode on, the panel shows it and offers only the in-kind removal", async ({ page }, testInfo) => {
    test.setTimeout(400_000);
    kamino("emergency", "on");
    try {
      await installTestWallet(page, trader);
      await page.goto(`/markets/${market}`);
      await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
      await expect(panelRegion(page)).toContainText("Kamino's reserve emergency mode is on", { timeout: 60_000 });
      await expect(panelRegion(page)).toContainText(/Reserve emergency mode\s*On/);
      const remove = form(page, "Remove liquidity");
      await remove.locator("summary").click();
      await remove.getByLabel("LP shares to remove").fill("0.2");
      await expect(remove.getByLabel(/In cash/)).toBeDisabled();
      await expect(remove.getByLabel(/In kind/)).toBeChecked();
      await expect(remove).toContainText("so a removal in cash would fail. In kind works whatever state Kamino is in");
      await screenshot(page, testInfo, "lending-emergency");
      await simulateAndSign(page, remove, /^Simulate remove liquidity$/, "remove_liquidity in kind under emergency mode");
      const panel = await readPanel(market);
      expect(panel.sells.with_kamino).toBe(panel.sells.buffer_alone);
    } finally {
      kamino("emergency", "off");
    }
  });

  test("with the test borrower holding enough of the reserve, a rebalance puts the market in withdraw mode", async ({ page }, testInfo) => {
    test.setTimeout(400_000);
    // Kamino's free liquidity must fall below five times the market's exposure, the larger of its lent value and its target lent value: the test borrower borrows (3.5 SOL at most), and the second depositor takes back whatever more that needs.
    kamino("refresh", "--reserve", "wsol");
    const before = await readPanel(market);
    const lentTotal = BigInt(before.lent_total!);
    const exposure = [BigInt(before.lent_value!), lentTotal - (lentTotal * 2_000n) / 10_000n].reduce((a, b) => (a > b ? a : b));
    const need = BigInt(before.kamino.free_liquidity!) - 4n * exposure;
    const borrow = need < 3_500_000_000n ? need : 3_500_000_000n;
    const takeBack = need - borrow;
    const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(9);
    kamino("borrow", "--amount", sol(borrow));
    if (takeBack > 0n) kamino("take-back", "--reserve", "wsol", "--amount", sol(takeBack));
    try {
      await installTestWallet(page, trader);
      await page.goto(`/markets/${market}`);
      await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
      await untilPanel(market, trader.address, (p) => p.rebalance.due && p.rebalance.withdraw_mode_after === true);
      await expect(panelRegion(page)).toContainText("and enter withdraw mode", { timeout: 30_000 });
      const rebalance = form(page, "Rebalance");
      await rebalance.locator("summary").click();
      await simulateAndSign(page, rebalance, /^Simulate rebalance$/, "rebalance (enters withdraw mode)");
      await untilPanel(market, trader.address, (p) => p.withdraw_mode);
      await expect(panelRegion(page)).toContainText("The market is in withdraw mode", { timeout: 30_000 });
      await expect(panelRegion(page).getByText("Withdraw mode", { exact: true }).locator("xpath=following-sibling::dd")).toContainText(/^On/);
      await screenshot(page, testInfo, "lending-withdraw-mode");
    } finally {
      kamino("repay");
      if (takeBack > 0n) kamino("supply", "--reserve", "wsol");
    }
  });

  test("creates a market of a token hooked by our containment hook, Aviary adding the hook's accounts", async ({ page }) => {
    test.setTimeout(300_000);
    const wallet = await projectWalletSigner();
    await installTestWallet(page, wallet);
    await page.goto(`/create?strategy=${PROGRAM}`);
    const create = page.getByRole("region", { name: "The create form" });
    await connectTestWallet(page, create.getByRole("button", { name: "Connect wallet" }));
    await create.getByLabel("The token, by its mint's address").fill(HOOKED_TOKEN);
    await expect(create.getByLabel("The token's facts")).toContainText(/Transfer hook/i, { timeout: 30_000 });
    // A fee no other market of this pair uses, so the market's address is new on every run.
    await create.getByLabel(/LP fee, in basis points/).fill(String(31 + (Date.now() % 150)));
    await create.getByLabel("First deposit of the token").fill("1000");
    await create.getByLabel(/^First deposit of/).last().fill("0.05");
    const review = await simulateAndSign(page, create, /^Simulate creating the market$/, "hooked token: create_market + init_fee_account x2 + add_liquidity");
    await expect(review.getByRole("link", { name: "Open the new market's page" })).toBeVisible({ timeout: 90_000 });
  });
});
