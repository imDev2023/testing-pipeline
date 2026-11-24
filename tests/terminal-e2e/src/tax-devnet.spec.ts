// The tax AMM in Aviary on devnet (#75), with the Playwright test wallet holding the test trader's key:
// a fresh token launched as a tax market from the launch form, in one transaction (create_market, a fee
// account for each mint and the seed); the market in the feed and on its page with the tax panel; a buy
// and a sell through the trade box; each slot paid out with the panel's button; then `set_taxes`,
// `set_recipients` and `renounce_tax_authority` each sent once from Aviary's generic forms. After each
// step every figure the panel shows is checked against the market state read from the chain, and the
// liquidity Aviary shows against the real reserves. The form also refuses a Token-2022 mint with a
// permanent delegate before any signature, saying which rule it breaks.
//
// It sends real devnet transactions, so its project exists only when asked for (`pnpm --filter
// terminal-e2e tax:devnet`, E2E_TAX_DEVNET), never in CI; every signature and address is written to
// test-results/tax-devnet.json for the pull request.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { address, createSolanaRpc, fetchEncodedAccount, generateKeyPairSigner, type Address } from "@solana/kit";
import { decodeTaxMarket, SUITE_TREASURY, TAX_AMM_PROGRAM_ADDRESS, type TaxMarket } from "tax-amm-scripts/client/index.ts";
import { Market } from "terminal-api/contract";
import { screenshot } from "./screenshot";
import { API } from "./target";
import { permanentDelegateToken, plainToken } from "./taxMints";
import { connectTestWallet, installTestWallet, testTraderSigner, TEST_TRADER, type TestWallet } from "./wallet";

const rpcUrl = () => process.env.RPC_URL ?? "";
const rpc = () => createSolanaRpc(rpcUrl());
const ZERO = "11111111111111111111111111111111";
const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;
const TOKEN_DECIMALS = 6;

const record: Record<string, unknown> = {};
const save = () => {
  mkdirSync(`${import.meta.dirname}/../test-results`, { recursive: true });
  writeFileSync(`${import.meta.dirname}/../test-results/tax-devnet.json`, `${JSON.stringify(record, (_, v: unknown) => (typeof v === "bigint" ? String(v) : v), 2)}\n`);
};

/** The market state as the chain holds it now. */
async function chainState(marketState: string): Promise<TaxMarket> {
  const account = await fetchEncodedAccount(rpc(), address(marketState), { commitment: "confirmed" });
  if (!account.exists) throw new Error(`${marketState} does not exist`);
  return decodeTaxMarket(account).data;
}

/** A token account's balance, or 0 for one that does not exist. */
async function tokenBalance(account: string): Promise<bigint> {
  try {
    return BigInt((await rpc().getTokenAccountBalance(address(account), { commitment: "confirmed" }).send()).value.amount);
  } catch {
    return 0n;
  }
}

/** The signature a confirmed review links to on the explorer. */
async function signatureOf(review: Locator): Promise<string> {
  const href = await review.getByRole("link", { name: /Transaction .* on the explorer/ }).getAttribute("href");
  return decodeURIComponent(new URL(href!).pathname.split("/").pop()!);
}

/** Signs a review once its simulation passed, and waits for the chain to confirm it; returns the signature. */
async function signReview(review: Locator): Promise<string> {
  await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeEnabled({ timeout: 45_000 });
  await review.getByRole("button", { name: "Sign in wallet" }).click();
  await expect(review.getByText(/^Confirmed in slot [\d,]+\./)).toBeVisible({ timeout: 90_000 });
  return signatureOf(review);
}

const panel = (page: Page) => page.getByRole("region", { name: "Taxes" });
const raw = async (locator: Locator) => BigInt((await locator.locator("[data-raw]").first().getAttribute("data-raw"))!);
/** A fact's value, by its name: the `dd` right after its `dt`. */
const fact = (scope: Locator, name: string) => scope.locator(`dt:text-is("${name}") + dd`).first();
const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** Every figure the panel shows, read from its page, equals the market state the chain holds now. */
async function panelMatchesChain(page: Page, marketState: string) {
  const state = await chainState(marketState);
  const slot = Number(await rpc().getSlot({ commitment: "confirmed" }).send());
  const scope = panel(page);
  const due = state.pendingFromSlot !== 0n && BigInt(slot) >= state.pendingFromSlot;
  const [buy, sell] = due ? [state.pendingBuyTaxBps, state.pendingSellTaxBps] : [state.buyTaxBps, state.sellTaxBps];
  await expect(fact(scope, "Buy tax")).toContainText(`${percent(buy)}, fixed between ${percent(state.buyTaxMinBps)} and ${percent(state.buyTaxMaxBps)}`);
  await expect(fact(scope, "Sell tax")).toContainText(`${percent(sell)}, fixed between ${percent(state.sellTaxMinBps)} and ${percent(state.sellTaxMaxBps)}`);
  await expect(fact(scope, "Tax authority")).toContainText(state.taxAuthorityRenounced ? "Renounced" : state.taxAuthority === ZERO ? "None" : short(state.taxAuthority));
  // Where every tax goes: the suite share, then each used recipient with its share of the creator's part.
  const split = scope.getByRole("table", { name: "Where every tax of this market goes" });
  const used = state.recipients.map((r, slot) => ({ r, slot })).filter(({ r }) => r !== ZERO);
  await expect(split.getByRole("row")).toHaveCount(1 + 1 + used.length + (state.burnShareBps > 0 ? 1 : 0));
  for (const { r, slot } of used) await expect(split.getByRole("row", { name: new RegExp(`Tax recipient ${slot + 1}`) })).toContainText(`${short(r)}${percent(state.shares[slot]!)}`);
  expect(await raw(fact(scope, "Collected so far"))).toBe(state.taxCollected);
  expect(await raw(fact(scope, "Owed, not yet paid out"))).toBe(state.owed.reduce((a, b) => a + b, 0n));
  const slots = scope.getByRole("list", { name: "Each slot's payout" }).getByRole("listitem");
  for (const { slot } of used) expect(await raw(slots.filter({ hasText: `Tax recipient ${slot + 1}` }))).toBe(state.owed[slot]!);
  expect(await raw(slots.filter({ hasText: "The suite share" }))).toBe(state.owed[5]!);
  const reserves = fact(scope, "Real reserves").locator("[data-raw]");
  expect([BigInt((await reserves.nth(0).getAttribute("data-raw"))!), BigInt((await reserves.nth(1).getAttribute("data-raw"))!)]).toEqual(state.reserves);
  const vaults = fact(scope, "The vaults hold").locator("[data-raw]");
  const held = [await tokenBalance(state.vaults[0]!), await tokenBalance(state.vaults[1]!)];
  expect([BigInt((await vaults.nth(0).getAttribute("data-raw"))!), BigInt((await vaults.nth(1).getAttribute("data-raw"))!)]).toEqual(held);
  return { state, held };
}

/** Opens one of the strategy's generic action forms under Actions, by its author's label. */
async function actionForm(page: Page, label: string): Promise<Locator> {
  const form = page.getByRole("region", { name: "Actions" }).locator("details").filter({ has: page.locator("summary", { hasText: label }) });
  if ((await form.getAttribute("open")) === null) await form.locator("summary").click();
  return form;
}

test.describe.configure({ mode: "serial" });

test.describe("the tax AMM in Aviary on devnet", () => {
  let wallet: TestWallet;
  let token: Address;
  let market: string;
  let marketState: string;
  let second: Address;

  // E2E_TAX_MARKET resumes on a market a run already launched, skipping the launch.
  const resumed = process.env.E2E_TAX_MARKET;
  test.beforeAll(async () => {
    if (!resumed) return;
    market = resumed;
    marketState = Market.parse(await (await fetch(`${API}/v1/markets/${market}`)).json()).market_state;
    Object.assign(record, { market, market_state: marketState, resumed: true });
  });

  test("the launch form refuses a mint the mint rules refuse, before any signature, saying which rule it breaks", async ({ page }) => {
    test.skip(Boolean(resumed), "resuming on a market already launched");
    test.setTimeout(180_000);
    const trader = await testTraderSigner();
    const refused = await permanentDelegateToken(rpcUrl(), trader);
    record.refused_mint = refused;
    wallet = await installTestWallet(page, trader);
    await page.goto(`/create?strategy=${TAX_AMM_PROGRAM_ADDRESS}`);
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    const launch = page.getByRole("region", { name: "Launch a tax market" });
    await launch.getByLabel("Its mint, by address").fill(refused.mint);
    await expect(launch.getByLabel("The token's facts")).toContainText("Permanent delegate");
    await launch.getByLabel("Amount of the token").fill("1000");
    await launch.getByLabel("Amount of SOL").fill("0.1");
    await launch.getByRole("button", { name: "Simulate the launch" }).click();
    const review = page.getByRole("region", { name: "Review the new tax market" });
    await expect(review.getByText("The simulation failed, so there is nothing to sign.")).toBeVisible({ timeout: 45_000 });
    await expect(launch.getByText(/breaks the tax AMM's mint rules: it carries Token-2022's permanent delegate extension \(number 12\), and the mint carries an extension the mint rules refuse\./)).toBeVisible();
    await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
    expect(wallet.requests).toHaveLength(0);
    await screenshot(page, test.info(), "tax-launch-refused");
  });

  test("a wallet launches a tax market in one transaction from the launch form, which defaults the tax side to SOL and shows the whole split first", async ({ page }) => {
    test.skip(Boolean(resumed), "resuming on a market already launched");
    test.setTimeout(300_000);
    const trader = await testTraderSigner();
    const made = await plainToken(rpcUrl(), trader, { decimals: TOKEN_DECIMALS, supply: 1_000_000n * 10n ** BigInt(TOKEN_DECIMALS) });
    token = made.mint;
    second = (await generateKeyPairSigner()).address;
    record.token = made;
    record.second_recipient = second;
    wallet = await installTestWallet(page, trader);
    await page.goto(`/create?strategy=${TAX_AMM_PROGRAM_ADDRESS}`);
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    const launch = page.getByRole("region", { name: "Launch a tax market" });
    await launch.getByLabel("Its mint, by address").fill(token);
    await expect(launch.getByLabel("The token's facts")).toBeVisible();
    // Taxed in the quote mint by default, so recipients are paid in SOL.
    await expect(launch.getByRole("radio", { name: "SOL, so recipients are paid in SOL" })).toBeChecked();
    await expect(launch.getByLabel("Tax recipient 1", { exact: true })).toHaveValue(TEST_TRADER);
    await launch.getByLabel("Tax recipient 1's share, in percent").fill("60");
    await launch.getByRole("button", { name: "Add a recipient" }).click();
    await launch.getByLabel("Tax recipient 2", { exact: true }).fill(second);
    await launch.getByLabel("Tax recipient 2's share, in percent").fill("40");
    await launch.getByLabel("Amount of the token").fill("100000");
    await launch.getByLabel("Amount of SOL").fill("0.5");
    // The whole split before signing, the suite share first.
    const split = launch.getByRole("table", { name: "The whole split of every tax, before you sign" });
    await expect(split.getByRole("row")).toHaveText([/Part.*Paid to/, /The suite share.*Taken first.*10%/, new RegExp(`Tax recipient 1.*${short(TEST_TRADER)}.*60%.*54%`), new RegExp(`Tax recipient 2.*${short(second)}.*40%.*36%`)]);
    await screenshot(page, test.info(), "tax-launch-filled");

    await launch.getByRole("button", { name: "Simulate the launch" }).click();
    const review = page.getByRole("region", { name: "Review the new tax market" });
    await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeEnabled({ timeout: 45_000 });
    await screenshot(page, test.info(), "tax-launch-review");
    const signature = await signReview(review);
    expect(wallet.sent).toHaveLength(1);

    // One transaction: create_market, a fee account for each mint and the seed, shortened by Aviary's lookup table.
    const tx = await (async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const found = await rpc().getTransaction(signature as never, { commitment: "confirmed", maxSupportedTransactionVersion: 0, encoding: "json" }).send();
        if (found?.meta) return found;
        await new Promise((done) => setTimeout(done, 1_000));
      }
      throw new Error(`${signature} was not served`);
    })();
    const logs = tx.meta!.logMessages ?? [];
    expect(logs.filter((l) => l === "Program log: Instruction: CreateMarket")).toHaveLength(1);
    expect(logs.filter((l) => l === "Program log: Instruction: InitFeeAccount")).toHaveLength(2);
    expect(logs.filter((l) => l === "Program log: Instruction: Seed")).toHaveLength(1);
    expect(tx.version).toBe(0);
    record.launch = { signature, slot: tx.slot, version: tx.version };

    await review.getByRole("link", { name: "Open the new market's page" }).click({ timeout: 90_000 });
    await expect(page).toHaveURL(/\/markets\//);
    market = page.url().split("/markets/")[1]!.split(/[?#]/)[0]!;
    const view = Market.parse(await (await fetch(`${API}/v1/markets/${market}`)).json());
    marketState = view.market_state;
    Object.assign(record, { market, market_state: marketState });
    save();

    // The market in the feed, its liquidity the seed, and on its own page with the tax panel.
    await page.goto("/");
    const row = page.getByRole("row").filter({ hasText: `market ${short(market)}` });
    await expect(row).toContainText("100,000", { timeout: 30_000 });
    await expect(row).toContainText("0.5 SOL");
    await page.goto(`/markets/${market}`);
    await expect(panel(page)).toBeVisible();
    const { state } = await panelMatchesChain(page, marketState);
    expect(state.taxSide).toBe(1);
    expect(state.reserves).toEqual([100_000n * 10n ** BigInt(TOKEN_DECIMALS), 500_000_000n]);
    await screenshot(page, test.info(), "tax-market-launched");
  });

  test("a buy and a sell through the trade box, after which the liquidity Aviary shows is the real reserves, not the vaults with the tax owed", async ({ page }) => {
    test.setTimeout(300_000);
    wallet = await installTestWallet(page, await testTraderSigner());
    await page.goto(`/markets/${market}`);
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    const box = page.getByRole("region", { name: "Swap" });
    const trade = async (name: string) => {
      await expect(box.getByRole("button", { name: "Review swap" })).toBeEnabled({ timeout: 30_000 });
      await box.getByRole("button", { name: "Review swap" }).click();
      const review = page.getByRole("region", { name: "Review this swap" });
      await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeEnabled({ timeout: 45_000 });
      await review.getByRole("button", { name: "Sign in wallet" }).click();
      await expect(review.getByText(/^Confirmed in slot [\d,]+\./)).toBeVisible({ timeout: 90_000 });
      const signature = await signatureOf(review);
      await screenshot(page, test.info(), `tax-${name}`);
      return signature;
    };
    await box.getByLabel("You pay, fees included").fill("0.05");
    const buy = await trade("buy");
    await box.getByRole("button", { name: "Make another swap" }).click();
    await box.getByRole("button", { name: "Switch the two sides" }).click();
    await box.getByLabel("You pay, fees included").fill("1000");
    const sell = await trade("sell");
    record.trades = { buy, sell };
    save();

    await page.reload();
    const { state, held } = await panelMatchesChain(page, marketState);
    const owed = state.owed.reduce((a, b) => a + b, 0n);
    expect(owed > 0n).toBe(true);
    // The SOL vault holds the reserve and the tax owed; Aviary's liquidity is the reserve.
    expect(held[1]).toBe(state.reserves[1]! + owed);
    const view = Market.parse(await (await fetch(`${API}/v1/markets/${market}`)).json());
    expect(view.mints.map((m) => m.liquidity)).toEqual(state.reserves.map(String));
    const facts = page.getByRole("region", { name: "This market" });
    await expect(fact(facts, "Liquidity")).toHaveText((await fact(panel(page), "Real reserves").textContent())!);
    record.liquidity = { reserves: state.reserves, vaults: held, owed };
    save();
    await screenshot(page, test.info(), "tax-market-traded");
  });

  test("each slot is paid out with the panel's button, and the panel then shows nothing owed, as the chain does", async ({ page }) => {
    test.setTimeout(300_000);
    wallet = await installTestWallet(page, await testTraderSigner());
    await page.goto(`/markets/${market}`);
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    const paid: Record<string, string> = {};
    for (const name of ["tax recipient 1", "tax recipient 2", "the suite share"]) {
      await panel(page).getByRole("button", { name: `Pay out ${name}` }).click();
      paid[name] = await signReview(panel(page).getByRole("region", { name: `Review: pay out ${name}` }));
      await panel(page).getByRole("region", { name: `Review: pay out ${name}` }).getByRole("button", { name: "Done" }).click();
      await expect(panel(page).getByRole("button", { name: `Pay out ${name}` })).toBeDisabled();
    }
    record.payouts = paid;
    save();
    const { state } = await panelMatchesChain(page, marketState);
    expect(state.owed).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
    expect(await tokenBalance(await suiteAccount())).toBeGreaterThan(0n);
    await screenshot(page, test.info(), "tax-market-paid-out");
  });

  test("set_taxes, set_recipients and renounce_tax_authority, each sent once from the generic forms, show on the panel", async ({ page }) => {
    test.setTimeout(600_000);
    wallet = await installTestWallet(page, await testTraderSigner());
    await page.goto(`/markets/${market}`);
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    const send = async (label: string, fill: (form: Locator) => Promise<void>) => {
      const form = await actionForm(page, label);
      await fill(form);
      await form.getByRole("button", { name: "Simulate this action" }).click();
      return signReview(form.getByRole("region", { name: "Review this action" }));
    };

    const third = (await generateKeyPairSigner()).address;
    const setTaxes = await send("Change the taxes", async (form) => {
      await form.getByLabel(/buy_tax_bps/).fill("600");
      await form.getByLabel(/sell_tax_bps/).fill("700");
    });
    const setRecipients = await send("Change the tax recipients", async (form) => {
      const values: Record<string, string> = { recipient_0: TEST_TRADER, recipient_1: third, recipient_2: ZERO, recipient_3: ZERO, share_0: "5000", share_1: "5000", share_2: "0", share_3: "0", burn_share_bps: "0" };
      for (const [name, value] of Object.entries(values)) await form.getByLabel(new RegExp(`\\b${name}\\b`)).fill(value);
    });
    await page.reload();
    // The new rates wait for their slot, shown with it.
    const pending = await chainState(marketState);
    expect([pending.pendingBuyTaxBps, pending.pendingSellTaxBps]).toEqual([600, 700]);
    await expect(fact(panel(page), "Changing")).toContainText(`To 6% buy and 7% sell from slot ${pending.pendingFromSlot.toLocaleString("en-US")}`);
    await panelMatchesChain(page, marketState);
    await screenshot(page, test.info(), "tax-market-changing");

    // Once their slot has come they are the market's rates; renouncing then keeps them for good.
    await expect(async () => expect(BigInt(await rpc().getSlot({ commitment: "confirmed" }).send())).toBeGreaterThanOrEqual(pending.pendingFromSlot)).toPass({ timeout: 300_000, intervals: [5_000] });
    const renounce = await send("Renounce the tax authority", async () => undefined);
    await page.reload();
    const { state } = await panelMatchesChain(page, marketState);
    expect(state.taxAuthorityRenounced).toBe(true);
    expect([state.buyTaxBps, state.sellTaxBps]).toEqual([600, 700]);
    expect(state.recipients.slice(0, 2)).toEqual([TEST_TRADER, third]);
    await expect(fact(panel(page), "Buy tax")).toContainText("6%, fixed between 0% and 10%");
    await expect(fact(panel(page), "Sell tax")).toContainText("7%, fixed between 0% and 10%");
    await expect(panel(page).getByRole("table", { name: "Where every tax of this market goes" })).toContainText(short(third));
    await expect(fact(panel(page), "Tax authority")).toHaveText("Renounced: the rates and the tax recipients can never change again.");
    record.authority = { set_taxes: setTaxes, set_recipients: setRecipients, renounce, third_recipient: third };
    save();
    await screenshot(page, test.info(), "tax-market-renounced");
  });
});

/** The suite treasury's wrapped-SOL account, which the suite share's payout pays. */
async function suiteAccount(): Promise<string> {
  const { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } = await import("@solana-program/token");
  return (await findAssociatedTokenPda({ owner: SUITE_TREASURY, mint: address("So11111111111111111111111111111111111111112"), tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
}
