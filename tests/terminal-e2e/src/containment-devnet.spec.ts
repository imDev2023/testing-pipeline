// The containment hook in Aviary on devnet (#76), with the Playwright test wallet holding the test
// trader's key, on two contained tokens the hook's launch script launched with `--unlock none`
// (deployments/devnet-demo-containment-hook-aviary.json): one with a goal a round trip reaches, one
// with a deadline minutes away. On each home market page the panel shows the tax collected against
// the goal and the deadline, as the chain holds them, and no Unlock button before the unlock is due;
// a buy goes through the trade box with the one-line rule shown first, and a sell carries no integrator
// fee; the facts carry the mint's two hook flags. Once the goal is reached, and once the deadline has
// passed, the Unlock button appears for the connected wallet and sends `unlock`; afterwards the panel
// says when the token unlocked and by which of the two, the mint's hook fields are both unset on chain
// and the facts carry neither flag. Each state is shot at 1440 and 390 px in both themes.
//
// It sends real devnet transactions, so its project exists only when asked for (`pnpm --filter
// terminal-e2e containment:devnet`, E2E_CONTAINMENT_DEVNET), never in CI. The two tokens come from
// E2E_CONTAINED_GOAL and E2E_CONTAINED_DEADLINE, their mints; E2E_CONTAINED_TRADE is how much of the
// quote mint each round trip toward the goal pays in (0.5 by default; the deadline token's trade is a
// tenth of it). Every signature is written to test-results/containment-devnet.json for the pull request.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { address, assertAccountExists, createSolanaRpc, fetchEncodedAccount, getBase64Encoder, type Address } from "@solana/kit";
import { decodeConfig, findConfigPda, findUnlockPda, type Config } from "containment-hook-scripts/client/index.ts";
import { decodeTaxMarket } from "tax-amm-scripts/client/index.ts";
import { TradesPage } from "terminal-api/contract";
import { screenshot } from "./screenshot";
import { API } from "./target";
import { connectTestWallet, installTestWallet, testTraderSigner, TEST_TRADER } from "./wallet";

const rpc = () => createSolanaRpc(process.env.RPC_URL ?? "");
const TRADE = process.env.E2E_CONTAINED_TRADE ?? "0.5";
const CONTAINED_RULE = "This token can only be bought and sold in this market until it unlocks, and cannot be sent to another wallet.";
const SHOTS = [
  { width: 1440, height: 900, theme: "light" },
  { width: 1440, height: 900, theme: "dark" },
  { width: 390, height: 844, theme: "light" },
  { width: 390, height: 844, theme: "dark" },
] as const;

const record: Record<string, unknown> = {};
const save = () => {
  mkdirSync(`${import.meta.dirname}/../test-results`, { recursive: true });
  writeFileSync(`${import.meta.dirname}/../test-results/containment-devnet.json`, `${JSON.stringify(record, (_, v: unknown) => (typeof v === "bigint" ? String(v) : v), 2)}\n`);
};

const panel = (page: Page) => page.getByRole("region", { name: "Containment", exact: true });
const box = (page: Page) => page.getByRole("region", { name: "Swap" });
const tokenFacts = (page: Page) => page.getByRole("region", { name: "Facts" }).getByRole("region", { name: "Its mints" });
const raw = async (locator: Locator) => BigInt((await locator.locator("[data-raw]").first().getAttribute("data-raw"))!);
/** A fact's value, by its name: the `dd` right after its `dt`. */
const fact = (scope: Locator, name: string) => scope.locator(`dt:text-is("${name}") + dd`).first();

/** An account that must exist, read at `confirmed`. */
async function existing(at: Address) {
  const account = await fetchEncodedAccount(rpc(), at, { commitment: "confirmed" });
  assertAccountExists(account);
  return account;
}

/** The token's config and its home market's state, as the chain holds them now. */
async function onChain(mint: string): Promise<{ config: Config; collected: bigint; hook: { authority: boolean; program: boolean } }> {
  const [configAddress] = await findConfigPda({ mint: address(mint) });
  const config = decodeConfig(await existing(configAddress)).data;
  const state = decodeTaxMarket(await existing(config.marketState)).data;
  const mintAccount = (await rpc().getAccountInfo(address(mint), { encoding: "base64", commitment: "confirmed" }).send()).value!;
  const bytes = new Uint8Array(getBase64Encoder().encode(mintAccount.data[0]));
  // The transfer hook extension (14): its authority, then its program, zeroes for none.
  let at = 166;
  let hook = { authority: false, program: false };
  while (at + 4 <= bytes.length) {
    const type = bytes[at]! | (bytes[at + 1]! << 8);
    const length = bytes[at + 2]! | (bytes[at + 3]! << 8);
    if (type === 14) hook = { authority: bytes.subarray(at + 4, at + 36).some((b) => b !== 0), program: bytes.subarray(at + 36, at + 68).some((b) => b !== 0) };
    at += 4 + length;
  }
  return { config, collected: state.taxCollected, hook };
}

/** The cluster's clock now, Unix seconds. */
async function chainTime(): Promise<number> {
  const slot = await rpc().getSlot({ commitment: "confirmed" }).send();
  return Number(await rpc().getBlockTime(slot).send());
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

/** Shoots the panel at each width and theme, then puts the page back as the tests use it. */
async function shots(page: Page, name: string) {
  for (const shot of SHOTS) {
    await page.setViewportSize({ width: shot.width, height: shot.height });
    await page.emulateMedia({ colorScheme: shot.theme });
    await panel(page).scrollIntoViewIfNeeded();
    await screenshot(page, test.info(), `${name}-${shot.width}-${shot.theme}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

/** The market page of a contained token's home market, with the test wallet connected. */
async function openHome(page: Page, market: string) {
  await page.goto(`/markets/${market}`);
  await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
  await expect(panel(page).getByText(/^Read from the chain at slot [\d,]+\./)).toBeVisible();
}

/** The panel's figures equal the chain's: the tax collected and the goal in the quote mint's units, and the deadline. */
async function panelMatchesChain(page: Page, mint: string) {
  const { config, collected } = await onChain(mint);
  const collectedShown = fact(panel(page), "Tax collected").locator("[data-raw]");
  expect(BigInt((await collectedShown.nth(0).getAttribute("data-raw"))!)).toBe(collected);
  expect(BigInt((await collectedShown.nth(1).getAttribute("data-raw"))!)).toBe(config.unlockGoal);
  await expect(fact(panel(page), "Unlock deadline").locator("time")).toHaveAttribute("datetime", new Date(Number(config.unlockDeadline) * 1000).toISOString());
  return { config, collected };
}

/** A buy of the token through the trade box, the rule shown before it, then a sell of what it bought; returns both signatures. */
async function buyAndSell(page: Page, sol: string) {
  await expect(box(page).getByRole("note").filter({ hasText: CONTAINED_RULE })).toBeVisible();
  await box(page).getByLabel("You pay, fees included").fill(sol);
  await expect(box(page).getByRole("button", { name: "Review swap" })).toBeEnabled({ timeout: 30_000 });
  await box(page).getByRole("button", { name: "Review swap" }).click();
  const buy = await signReview(page.getByRole("region", { name: "Review this swap" }));
  await box(page).getByRole("button", { name: "Make another swap" }).click();
  await box(page).getByRole("button", { name: "Switch the two sides" }).click();
  // A sell of the token: no rule, and no Aviary fee, since the trader pays in neither SOL nor USDC.
  await expect(box(page).getByText(CONTAINED_RULE)).toHaveCount(0);
  await box(page).getByRole("button", { name: "Use it all" }).click();
  await expect(box(page).getByText(/^Aviary fee, none on this swap/)).toBeVisible({ timeout: 30_000 });
  await expect(box(page).getByRole("button", { name: "Review swap" })).toBeEnabled({ timeout: 30_000 });
  await box(page).getByRole("button", { name: "Review swap" }).click();
  const sell = await signReview(page.getByRole("region", { name: "Review this swap" }));
  return { buy, sell };
}

/** The sell as Aviary indexed it from the router's event: no integrator, and no integrator fee. */
async function sellCarriedNoFee(market: string, signature: string) {
  await expect
    .poll(async () => TradesPage.parse(await (await fetch(`${API}/v1/markets/${market}/trades`)).json()).trades.find((t) => t.signature === signature) ?? null, { timeout: 60_000 })
    .not.toBeNull();
  const trade = TradesPage.parse(await (await fetch(`${API}/v1/markets/${market}/trades`)).json()).trades.find((t) => t.signature === signature)!;
  expect(trade).toMatchObject({ side: "sell", trader: TEST_TRADER, integrator: null, integrator_fee: "0" });
  return trade;
}

/** The Unlock button, pressed and signed; then the panel says when and by which, the chain agrees and the facts drop both flags. */
async function unlock(page: Page, mint: string, by: "goal" | "deadline") {
  await expect(panel(page).getByText(by === "goal" ? "The unlock is due: the goal is reached." : "The unlock is due: the deadline has passed.", { exact: false })).toBeVisible();
  await shots(page, `containment-${by}-due`);
  await panel(page).getByRole("button", { name: "Unlock this token" }).click();
  const review = panel(page).getByRole("region", { name: "Review: unlock this token" });
  await expect(review.getByText(/This is what signing would change in your wallet:$/)).toBeVisible({ timeout: 45_000 });
  await shots(page, `containment-${by}-review`);
  const signature = await signReview(review);
  await expect(panel(page).getByText(new RegExp(`^Unlocked on \\d{1,2} [A-Z][a-z]{2} \\d{4}, \\d{2}:\\d{2} UTC, ${by === "goal" ? "by reaching its goal" : "by its deadline"}\\.`))).toBeVisible({ timeout: 60_000 });
  await expect(panel(page).getByRole("button", { name: /unlock/i })).toHaveCount(0);
  const chain = await onChain(mint);
  expect(chain.config.unlockedAt.__option).toBe("Some");
  expect(chain.hook).toEqual({ authority: false, program: false });
  await expect(tokenFacts(page).getByText("transfer-hook", { exact: true })).toHaveCount(0, { timeout: 30_000 });
  await expect(tokenFacts(page).getByText("transfer-hook-authority", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(box(page).getByText(CONTAINED_RULE)).toHaveCount(0);
  await shots(page, `containment-${by}-unlocked`);
  return signature;
}

/** The newest successful transaction of the token's unlock PDA, which only `bind` and `unlock` name: its unlock, once it has one. */
async function unlockSignature(mint: string): Promise<string> {
  const [unlockPda] = await findUnlockPda({ mint: address(mint) });
  const [newest] = (await rpc().getSignaturesForAddress(unlockPda, { limit: 5, commitment: "confirmed" }).send()).filter((s) => s.err === null);
  return newest!.signature;
}

/** A token a run already unlocked: the panel says when and by which, with no button; the chain agrees; the facts carry neither flag. */
async function alreadyUnlocked(page: Page, mint: string, by: "goal" | "deadline") {
  await expect(panel(page).getByText(new RegExp(`^Unlocked on \\d{1,2} [A-Z][a-z]{2} \\d{4}, \\d{2}:\\d{2} UTC, ${by === "goal" ? "by reaching its goal" : "by its deadline"}\\.`))).toBeVisible();
  await expect(panel(page).getByRole("button", { name: /unlock/i })).toHaveCount(0);
  expect((await onChain(mint)).hook).toEqual({ authority: false, program: false });
  await expect(tokenFacts(page).getByText("transfer-hook", { exact: true })).toHaveCount(0);
  await expect(tokenFacts(page).getByText("transfer-hook-authority", { exact: true })).toHaveCount(0);
  await expect(box(page).getByText(CONTAINED_RULE)).toHaveCount(0);
  await shots(page, `containment-${by}-unlocked`);
  return unlockSignature(mint);
}

/** A contained token's home market, from Aviary's API. */
async function homeOf(mint: string): Promise<string> {
  const { config } = await onChain(mint);
  return config.market;
}

test.describe.configure({ mode: "serial" });

test.describe("the containment hook in Aviary on devnet", () => {
  const goalMint = process.env.E2E_CONTAINED_GOAL ?? "";
  const deadlineMint = process.env.E2E_CONTAINED_DEADLINE ?? "";
  test.beforeAll(() => {
    if (!goalMint || !deadlineMint) throw new Error("E2E_CONTAINED_GOAL and E2E_CONTAINED_DEADLINE name the two contained tokens' mints (docs/toolchain.md, \"The containment hook in Aviary on devnet\").");
    Object.assign(record, { goal_mint: goalMint, deadline_mint: deadlineMint });
  });

  test("the deadline token: the panel against the chain and no Unlock button before the deadline; a buy shows the rule first, and a sell carries no integrator fee", async ({ page }) => {
    test.setTimeout(300_000);
    await installTestWallet(page, await testTraderSigner());
    const market = await homeOf(deadlineMint);
    record.deadline_market = market;
    await openHome(page, market);
    const { config } = await panelMatchesChain(page, deadlineMint);
    expect(Number(config.unlockDeadline)).toBeGreaterThan(await chainTime());
    await expect(panel(page).getByText(`Contained ${CONTAINED_RULE}`)).toBeVisible();
    await expect(panel(page).getByRole("button", { name: /unlock/i })).toHaveCount(0);
    await expect(tokenFacts(page).getByText("transfer-hook", { exact: true })).toBeVisible();
    await expect(tokenFacts(page).getByText("transfer-hook-authority", { exact: true })).toBeVisible();
    await shots(page, "containment-contained");
    const trades = await buyAndSell(page, String(Number(TRADE) / 10));
    record.deadline_trades = trades;
    record.deadline_sell = await sellCarriedNoFee(market, trades.sell);
    save();
  });

  test("the goal token: traded to its goal through the trade box, then unlocked with the Unlock button by the goal", async ({ page }) => {
    test.setTimeout(600_000);
    await installTestWallet(page, await testTraderSigner());
    const market = await homeOf(goalMint);
    record.goal_market = market;
    await openHome(page, market);
    // A run resumed after the button already unlocked it checks the unlocked state and records that unlock.
    if ((await onChain(goalMint)).config.unlockedAt.__option === "Some") {
      record.goal_unlock = await alreadyUnlocked(page, goalMint, "goal");
      record.goal_resumed = true;
      return save();
    }
    const before = await panelMatchesChain(page, goalMint);
    // Before the goal is reached there is no Unlock button (a run resumed after the goal skips this).
    if (before.collected < before.config.unlockGoal) await expect(panel(page).getByRole("button", { name: /unlock/i })).toHaveCount(0);
    const rounds: unknown[] = [];
    for (let round = 0; round < 4; round++) {
      const { config, collected } = await onChain(goalMint);
      if (collected >= config.unlockGoal) break;
      const trades = await buyAndSell(page, TRADE);
      rounds.push(trades);
      record.goal_rounds = rounds;
      save();
      // The test wallet stays connected across the reload.
      await page.reload();
      await expect(panel(page).getByText(/^Read from the chain at slot [\d,]+\./)).toBeVisible();
    }
    const { config, collected } = await onChain(goalMint);
    expect(collected).toBeGreaterThanOrEqual(config.unlockGoal);
    expect(await raw(fact(panel(page), "Tax collected"))).toBeGreaterThanOrEqual(config.unlockGoal);
    record.goal_unlock = await unlock(page, goalMint, "goal");
    save();
  });

  test("the deadline token: once the deadline has passed, unlocked with the Unlock button by the deadline", async ({ page }) => {
    test.setTimeout(1_800_000);
    await installTestWallet(page, await testTraderSigner());
    const { config } = await onChain(deadlineMint);
    // The panel reads again a second after the deadline, so the button appears on a page left open.
    await openHome(page, await homeOf(deadlineMint));
    await expect.poll(chainTime, { timeout: 1_500_000, intervals: [10_000] }).toBeGreaterThanOrEqual(Number(config.unlockDeadline));
    await expect(panel(page).getByRole("button", { name: "Unlock this token" })).toBeVisible({ timeout: 60_000 });
    record.deadline_unlock = await unlock(page, deadlineMint, "deadline");
    save();
  });
});
