// The trade box (docs/spec/pipescope-screens.md, Trade box, The amount typed, Review and sign; #121),
// with the Playwright test wallet (PIPESCOPE-94): quotes for the amount typed, the cost breakdown
// with every rate from the API, connecting from the header, "Use it all", the review's simulation,
// a declined signature, a wallet holding too little, a market refusing trades, and the Fees page.
// Nothing here sends a transaction, so it runs on the recorded fixtures in CI as on devnet; the swaps
// themselves are src/trade-devnet.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { Balances, PreparedSwap, Quote } from "terminal-api/contract";
import { formatTokenAmount } from "../../../apps/terminal-web/src/format";
import { CP_MARKET, CP_TOKEN, REFUSING_MARKET, WSOL } from "./markets";
import { API } from "./target";
import { connectTestWallet, installTestWallet, TEST_TRADER, type TestWallet } from "./wallet";


const box = (page: Page) => page.getByRole("region", { name: "Swap" });
const costs = (page: Page) => page.getByRole("region", { name: "What this swap costs" });
/** A row of a definition list by the start of its name: its value. */
const row = (scope: ReturnType<typeof box>, name: string | RegExp) => {
  const start = typeof name === "string" ? new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) : name;
  return scope.locator("dl > div").filter({ has: scope.page().locator("dt", { hasText: start }) }).locator("dd");
};

async function openMarket(page: Page, market: string, wallet: "connect" | "none" = "none"): Promise<TestWallet> {
  const testWallet = await installTestWallet(page, null);
  await page.goto(`/markets/${market}`);
  await expect(box(page).getByLabel("You pay, fees included")).toBeVisible();
  if (wallet === "connect") {
    await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
    await expect(page.getByRole("banner").getByRole("button", { name: /E69P\.\.\.JnAW/ })).toBeVisible();
  }
  return testWallet;
}

/** The API's own quote for a buy of `lamports` on the example market, as the box writes its amounts: the pool moves as devnet trades, so the box is checked against it. */
async function apiQuote(lamports: bigint) {
  const quote = Quote.parse(await (await fetch(`${API}/v1/quote?market=${CP_MARKET}&input_mint=${WSOL}&output_mint=${CP_TOKEN}&amount=${lamports}`)).json());
  const tokens = (raw: bigint) => `${formatTokenAmount(raw, 6)} 6DsW...eMyp`;
  return { expected: tokens(BigInt(quote.expected_out)), minimum: (bps: number) => tokens((BigInt(quote.expected_out) * BigInt(10_000 - bps)) / 10_000n) };
}

async function typeAmount(page: Page, amount: string) {
  await box(page).getByLabel("You pay, fees included").fill(amount);
}

test.describe("the trade box", () => {
  test("opens paying the quote mint and receiving the base mint, and its button asks for a wallet first", async ({ page }) => {
    await openMarket(page, CP_MARKET);
    await expect(box(page).getByLabel("Mint to pay with")).toHaveValue(WSOL);
    await expect(box(page).getByLabel("Mint to receive")).toHaveValue(CP_TOKEN);
    await expect(box(page).getByRole("button", { name: "Connect wallet" })).toBeEnabled();
    await expect(costs(page)).toBeVisible();
    await expect(box(page).getByText("One market, one hop, exact in. Every swap is simulated before your wallet is asked to sign. Devnet tokens have no value.")).toBeVisible();
  });

  test("quotes 0.1 SOL typed as everything that leaves the wallet, split as the screens show, at the API's rates", async ({ page }) => {
    await openMarket(page, CP_MARKET);
    await typeAmount(page, "0.1");
    const breakdown = costs(page);
    await expect(row(breakdown, "Goes into the market")).toHaveText("0.09926 SOL");
    await expect(row(breakdown, "Pipeline fee, 0.25%")).toHaveText("0.0002481 SOL");
    await expect(breakdown.getByText("of what goes into the market")).toBeVisible();
    await expect(row(breakdown, "Aviary fee, 0.5%")).toHaveText("0.0004963 SOL");
    await expect(row(breakdown, "The strategy's own fees and taxes")).toHaveText("included in the quote");
    await expect(row(breakdown, "Leaves your wallet")).toHaveText("0.1 SOL");
    const quoted = await apiQuote(100_000_000n);
    await expect(row(breakdown, "Expected output")).toHaveText(quoted.expected);
    await expect(row(breakdown, "Minimum received, after 1% slippage")).toHaveText(quoted.minimum(100));
    // The minimum follows the slippage chosen.
    await box(page).getByRole("button", { name: "3%" }).click();
    await expect(row(breakdown, "Minimum received, after 3% slippage")).toHaveText(quoted.minimum(300));
    await box(page).getByPlaceholder("Other").fill("60");
    await expect(box(page).getByText("Slippage is at most 50%.")).toBeVisible();
  });

  test("on a sell into SOL, charges no Aviary fee and takes Pipeline's from what arrives", async ({ page }) => {
    await openMarket(page, CP_MARKET);
    await box(page).getByRole("button", { name: "Switch the two sides" }).click();
    await expect(box(page).getByLabel("Mint to pay with")).toHaveValue(CP_TOKEN);
    await typeAmount(page, "5");
    const breakdown = costs(page);
    await expect(breakdown.getByText("Aviary fee, none on this swap: only charged when you pay in SOL or USDC")).toBeVisible();
    await expect(breakdown.getByText("of what arrives")).toBeVisible();
    await expect(row(breakdown, "Leaves your wallet")).toContainText("5 6DsW...eMyp");
    await expect(row(breakdown, "Goes into the market")).toContainText("5 6DsW...eMyp");
    await expect(row(breakdown, /^Pipeline fee/)).toHaveText(/SOL$/);
  });

  test("connects through the header's wallet button, shows the balance and uses it all but the SOL kept back", async ({ page, request }) => {
    await openMarket(page, CP_MARKET, "connect");
    const { balances } = Balances.parse(await (await request.get(`${API}/v1/traders/${TEST_TRADER}/balances?mints=${WSOL},${CP_TOKEN}`)).json());
    const lamports = BigInt(balances.find((b) => b.mint === WSOL)!.amount);
    await expect(box(page).getByText(/^Balance [\d.,]+ SOL$/)).toBeVisible();
    await box(page).getByRole("button", { name: "Use it all" }).click();
    const keep = 10_000_000n;
    const expected = lamports - keep;
    await expect(box(page).getByLabel("You pay, fees included")).toHaveValue(`${expected / 1_000_000_000n}.${String(expected % 1_000_000_000n).padStart(9, "0").replace(/0+$/, "")}`.replace(/\.$/, ""));
    await typeAmount(page, "0.1");
    await expect(box(page).getByRole("button", { name: "Review swap" })).toBeEnabled();
  });

  test("reviews the swap by simulating it exactly as it would be signed, and a declined signature returns to the review with nothing changed", async ({ page }) => {
    const wallet = await openMarket(page, CP_MARKET, "connect");
    await typeAmount(page, "0.1");
    const preparing = page.waitForResponse((r) => r.url().endsWith("/v1/swaps/prepare"));
    await box(page).getByRole("button", { name: "Review swap" }).click();
    const prepared = PreparedSwap.parse(await (await preparing).json());
    const review = page.getByRole("region", { name: "Review this swap" });
    await expect(review.getByText(/^The simulation went through\. It used [\d,]+ compute units\. This is what signing would change in your wallet:$/)).toBeVisible();
    await expect(row(review, "Leaves")).toHaveText("0.1 SOL");
    await expect(row(review, "Arrives, expected")).toHaveText((await apiQuote(100_000_000n)).expected);
    await expect(row(review, "Network fee")).toHaveText("0.000005 SOL");
    // Rent shows only when the swap creates a token account the wallet keeps: its first buy of the token.
    if (prepared.simulation.new_accounts.length) await expect(row(review, "Rent for a new token account")).toHaveText(/^0\.00\d+ SOL$/);
    else await expect(review.getByText(/^Rent for/)).toHaveCount(0);
    await expect(review.getByText("Signed in your own wallet. Aviary never holds your keys.")).toBeVisible();
    const sign = review.getByRole("button", { name: "Sign in wallet" });
    await expect(sign).toBeEnabled();

    wallet.declineNext();
    await sign.click();
    await expect(review.getByText("Your wallet did not sign it, so nothing was sent and nothing has changed.")).toBeVisible();
    await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeEnabled();
    expect(wallet.requests).toHaveLength(1);
    expect(wallet.sent).toHaveLength(0);

    // Changing the amount leaves the review and asks for a new quote.
    await typeAmount(page, "0.2");
    await expect(review).toBeHidden();
    await expect(costs(page)).toBeVisible();
  });

  test("tells a wallet holding too little so, decoded with its log lines, and keeps Sign in wallet off", async ({ page }) => {
    const wallet = await openMarket(page, CP_MARKET, "connect");
    await typeAmount(page, "500");
    await box(page).getByRole("button", { name: "Review swap" }).click();
    const review = page.getByRole("region", { name: "Review this swap" });
    await expect(review.getByText("The simulation failed, so there is nothing to sign.")).toBeVisible();
    await expect(review.getByText("Your wallet holds too little for this swap.")).toBeVisible();
    await expect(review.getByText(/"InstructionError"/)).toBeVisible();
    await review.getByText(/^The program's last \d+ log lines?$/).click();
    await expect(review.locator("pre")).toContainText("Program ");
    await expect(review.getByText("The sign button stays off while the simulation fails.")).toBeVisible();
    await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeDisabled();
    expect(wallet.requests).toHaveLength(0);
  });

  test("shows a market's refusal decoded, with the raw error and the log lines beneath, and builds nothing to sign", async ({ page }) => {
    await openMarket(page, REFUSING_MARKET, "connect");
    await typeAmount(page, "0.01");
    const swap = box(page);
    await expect(swap.getByText("No quote: the strategy refused it: WrongStatus, \"Not allowed in the curve's current status\".")).toBeVisible();
    await expect(swap.getByText('{"InstructionError":[1,{"Custom":6004}]}')).toBeVisible();
    await swap.getByText(/^The program's last \d+ log lines?$/).click();
    await expect(swap.locator("pre")).toContainText("Error Code: WrongStatus");
    await expect(swap.getByRole("button", { name: "Review swap" })).toBeDisabled();
    await expect(swap.getByText("There is no quote to build a swap from.")).toBeVisible();
  });
});

test.describe("the Fees page", () => {
  test("states every rate as the API serves it, with the example of 1 SOL", async ({ page }) => {
    await page.goto("/fees");
    const table = page.getByRole("table", { name: "The fees on a swap" });
    await expect(table.getByRole("row", { name: /Pipeline fee 0\.25%/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /Aviary fee 0\.5% Swaps you pay in SOL or USDC/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /Solana network fee 0\.000005 SOL a signature/ })).toBeVisible();
    const example = page.getByRole("region", { name: "An example" });
    await expect(row(example, "Goes into the market")).toHaveText("0.9926 SOL");
    await expect(row(example, "Pipeline fee, 0.25%")).toHaveText("0.002481 SOL");
    await expect(row(example, "Aviary fee, 0.5%")).toHaveText("0.004963 SOL");
    await expect(row(example, "Leaves your wallet")).toHaveText("1 SOL");
    await expect(page.getByRole("heading", { name: "What carries no Aviary fee" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What the fee cannot do" })).toBeVisible();
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Fees" })).toHaveAttribute("href", "/fees");
  });
});
