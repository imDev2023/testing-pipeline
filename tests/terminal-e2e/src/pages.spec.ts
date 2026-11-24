// Every page this ticket adds, at 1440, 390 and 360 px in the light and the dark theme
// (PIPESCOPE-96): it wears the shell, nothing scrolls sideways, it requests nothing from any origin but
// Aviary's own, fonts included, and its screenshot is saved for the PR.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { postKeeperHeartbeat, seedKeeperRecords } from "./keeper";
import { screenshot } from "./screenshot";
import { CP_MARKET, REFUSING_MARKET, THREE_MINT_MARKET } from "./markets";
import { CANARY_CURVE_STRATEGY, CANARY_MARKETS } from "./canary";
import { EXPLAINED_MARKET, EXPLAINED_STRATEGY, HOSTILE_TEXT } from "./explanation";
import { OWN_ORIGINS } from "./target";
import { connectTestWallet, installTestWallet } from "./wallet";

const UNKNOWN_ADDRESS = "6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp";

// A market and a strategy of devnet's, both in the recorded fixtures: the buy wall AMM's demo market and its strategy.
const MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const STRATEGY = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
// A strategy whose metadata link does not answer, and a market whose token has a transfer hook and a transfer fee.
const STRATEGY_UNAVAILABLE = "yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx";
const MARKET_HOOKED = "8XUe71aQTkUrP8SZfL2Z6PuXgdzYe9szTLEqiExrVyMW";
// Aviary's token-image check market on devnet (deployments/devnet-demo-token-image.json): its token names an image Aviary keeps.
const MARKET_TOKEN_IMAGE = "4DZbJgcdZyZUoYxKsN8atmMjTipBQ3zd6Yjzkp2i5HsR";
// Markets whose strategy's metadata is unreachable, fails Pipeline's validator, or holds Pipeline's old
// `actions` section (PIPESCOPE-141); and the tax AMM's demo market (deployments/devnet-demo-tax-amm.json),
// whose tax side is wrapped SOL, and the suite share's wallet, whose slot anyone may pay out.
const MARKET_METADATA_UNREACHABLE = "ChLMN5jumUA3E9WBmoXUNma3SJk4sgUmWpzhAS2ifv69";
const MARKET_METADATA_INVALID = "CmDa9bCsmeDHNUp2KYv9DEGMA2nhQcxCkwQoZ7GfagVh";
const MARKET_OLD_ACTIONS = "EdMom6pkDgCgXZFSmrEadPRnZDEyqbAg9xDVKrnusSQT";
const TAX_MARKET = "4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c";
const SUITE_TREASURY = "CbqE9TtDJf67xFnXybBrzV6Tg4Mw71hX2VhWcm4R9VZF";
const TAX_AMM = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
// A market no swap has gone through, and one with a single swap, whose lone candle the chart still draws.
const MARKET_WITHOUT_TRADES = "DH7QCdTHGsjHcsm7SgXYRgdQvX34VT8oMQkFWVoCe3SQ";
const MARKET_WITH_ONE_TRADE = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
// The lending AMM's demo market (#87), with its panel and its history (#88).
const MARKET_LENDING = "AMJ4eVWMgqc9hZMmKDipbvwU6EQkmAvhUf4F42dNSDuu";

/** A token image has loaded and has a picture: one that failed is complete too, so its width says. */
const imageLoaded = (img: Locator) => expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

/** The facts panel or section has loaded: each part's heading is there. */
const factsReady = async (page: Page, parts: string[]) => {
  const facts = page.getByRole("region", { name: "Facts" });
  for (const part of parts) await expect(facts.getByRole("heading", { name: part, exact: true })).toBeVisible();
};

/** The strategy's forms under Actions have loaded: its forms, or why it has none. */
const actionsReady = (page: Page) => expect(page.getByRole("region", { name: "Actions" })).toHaveAttribute("aria-busy", "false");

/** A market page is ready once its chart, or the panel that stands in for it, its trades, its forms and its facts have loaded. */
const marketReady = (chart: "chart" | "none") => async (page: Page) => {
  await expect(page.getByRole("link", { name: "Explorer" }).first()).toBeVisible();
  await factsReady(page, ["This market", "Its strategy", "Its mints"]);
  await actionsReady(page);
  const trades = page.getByRole("region", { name: "Trades" });
  if (chart === "chart") {
    await expect(page.getByText(/^Built from Pipeline's swap events on this market: [\d,]+ swaps? so far\./)).toBeVisible();
    await expect(trades.getByRole("table")).toBeVisible();
  } else {
    await expect(page.getByText("No swap has gone through Pipeline on this market yet, so there is no price to chart.")).toBeVisible();
    await expect(trades.getByText("No swap has gone through Pipeline on this market yet.")).toBeVisible();
  }
};

/** The trade box on Pipeline's example market, 0.1 SOL typed: quoted, and with the test wallet, reviewed or failed. */
const swapBox = (page: Page) => page.getByRole("region", { name: "Swap" });
const typed = (amount: string, wallet: "connect" | "none", then: "quote" | "review" | "failed" | "refused") => async (page: Page) => {
  await marketReady("chart")(page);
  if (wallet === "connect") await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
  await swapBox(page).getByLabel("You pay, fees included").fill(amount);
  if (then === "refused") return void (await expect(swapBox(page).getByText(/^No quote: /)).toBeVisible());
  await expect(page.getByRole("region", { name: "What this swap costs" }).getByText("Leaves your wallet")).toBeVisible();
  await expect(swapBox(page).getByRole("button", { name: wallet === "connect" ? "Review swap" : "Connect wallet" })).toBeEnabled();
  if (then === "quote") return;
  await swapBox(page).getByRole("button", { name: "Review swap" }).click();
  const review = page.getByRole("region", { name: "Review this swap" });
  if (then === "review") await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeEnabled();
  else {
    await expect(review.getByText("The simulation failed, so there is nothing to sign.")).toBeVisible();
    await review.getByText(/^The program's last \d+ log lines?$/).click();
  }
};

/** What Canary saw has loaded on a market page, with its mark beside its heading. */
const canaryReady = async (page: Page) => {
  const saw = page.getByRole("region", { name: "What Canary saw" });
  await expect(saw.getByText(/^Canary traded a private copy of this market on /)).toBeVisible();
  await expect(saw.getByRole("heading", { name: "What Canary saw" }).locator('[data-canary="mark"]')).toBeVisible();
};

/** One of a market page's action forms, by its author's label, opened. */
const actionForm = async (page: Page, label: string) => {
  const form = page.locator("details").filter({ has: page.locator("summary").getByText(label, { exact: true }) });
  if ((await form.getAttribute("open")) === null) await form.locator("summary").click();
  return form;
};

/** The tax AMM's demo market with the test wallet: an action's form filled and simulated, its review passed or refused. */
const actionReviewed = (label: string, inputs: Record<string, string>, args: Record<string, string>, then: "passed" | "refused") => async (page: Page) => {
  await marketReady("chart")(page);
  await connectTestWallet(page, page.getByRole("banner").getByRole("button", { name: "Connect wallet" }));
  const form = await actionForm(page, label);
  for (const [name, value] of Object.entries(inputs)) await form.getByRole("textbox", { name: new RegExp(`^${name} an? `) }).fill(value);
  for (const [name, value] of Object.entries(args)) await form.getByRole("textbox", { name: new RegExp(` ${name} (u8|u16|u64|pubkey)`) }).fill(value);
  await form.getByRole("button", { name: "Simulate this action" }).click();
  const review = form.getByRole("region", { name: "Review this action" });
  if (then === "passed") {
    await expect(review.getByText(/This is what signing would change in your wallet:$/)).toBeVisible({ timeout: 30_000 });
    await expect(review.getByRole("button", { name: "Sign in wallet" })).toBeEnabled();
  } else {
    await expect(review.getByText("The simulation failed, so there is nothing to sign.")).toBeVisible({ timeout: 30_000 });
    await review.getByText(/^The program's last \d+ log lines?$/).click();
  }
  await form.scrollIntoViewIfNeeded();
};


/** The explanation panel, once it has loaded. */
const explanation = async (page: Page) => {
  const panel = page.getByRole("region", { name: "Explanation" });
  await expect(panel).toHaveAttribute("aria-busy", "false");
  return panel;
};

/** An explanation is shown under its code-written label, with its unknowns open and its points closed. */
const explained = async (page: Page) => {
  const panel = await explanation(page);
  await expect(panel.getByText(/^Written by an AI on \d{1,2} [A-Z][a-z]{2} \d{4} from on-chain data and Canary results for this strategy version \(deployed in slot [\d,]+\)\. It can be wrong\. It is not an audit, a safety rating or advice\.$/)).toBeVisible();
  await expect(panel.getByRole("heading", { name: "What the evidence does not settle" })).toBeVisible();
  await expect(panel.locator("details").filter({ has: page.getByText(/^Read the full explanation \(\d+ points?\)$/) })).not.toHaveAttribute("open");
  await expect(panel.getByRole("button", { name: "This is wrong" })).toBeVisible();
  return panel;
};

/** A chip, clicked, opens the evidence and marks the row with its id, in view with the focus on it. */
const chipShowsRow = async (page: Page, chip: Locator) => {
  const id = (await chip.textContent())!;
  // As tall to the touch as every other control: 44 px on phones, 32 px wider (--control-min-height).
  const reach = (page.viewportSize()?.width ?? 0) <= 720 ? 20 : 14;
  await chip.scrollIntoViewIfNeeded();
  const hits = await chip.evaluate((el, dy) => {
    const r = el.getBoundingClientRect();
    return [-dy, dy].map((d) => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2 + d) === el);
  }, reach);
  expect(hits).toEqual([true, true]);
  await chip.click();
  const row = page.locator(`#explanation-evidence-${id}`);
  await expect(row).toHaveAttribute("data-marked", "true");
  await expect(row).toBeInViewport();
  await expect(row).toBeFocused();
  await expect(row.locator("code")).toHaveText(id);
  await expect(page.locator("[data-marked]")).toHaveCount(1);
};

/** A version with no explanation says so, with the line on when one is written. */
const unexplained = async (page: Page) => {
  const panel = await explanation(page);
  await expect(panel.getByText("No explanation for this version yet.", { exact: true })).toBeVisible();
  await expect(panel.getByText(/^An explanation is written once for each strategy version, .+ Opening a page never makes one\.$/)).toBeVisible();
  await expect(panel.getByRole("button", { name: "This is wrong" })).toHaveCount(0);
};

/** The wallet page with the test wallet connected from its own button: every panel loaded, and with "unwrap" its unwrap reviewed. */
const walletReady = (then: "connected" | "unwrap") => async (page: Page) => {
  await connectTestWallet(page, page.getByRole("main").getByRole("button", { name: "Connect wallet" }));
  await expect(page.getByRole("region", { name: "What you hold that trades on Pipeline" }).getByRole("table")).toBeVisible();
  await expect(page.getByRole("region", { name: "Your swaps through Pipeline" }).getByRole("table")).toBeVisible();
  const unwrap = page.getByRole("region", { name: "Wrapped SOL" });
  await expect(unwrap.getByRole("button", { name: "Unwrap" })).toBeVisible();
  if (then === "connected") return;
  await unwrap.getByRole("button", { name: "Unwrap" }).click();
  await expect(unwrap.getByRole("button", { name: "Sign in wallet" })).toBeEnabled();
};

const PAGES: { name: string; path: string; status: number; ready: (page: Page) => Promise<unknown>; wallet?: boolean }[] = [
  { name: "feed", path: "/", status: 200, ready: (page: Page) => expect(page.getByRole("region", { name: "Markets" }).getByRole("row").nth(1)).toBeVisible() },
  {
    name: "feed-filtered",
    path: "/?liquidity=0.1&hide=metadata-unreachable",
    status: 200,
    ready: (page: Page) => expect(page.getByText(/^Showing [\d,]+ of [\d,]+ markets\./)).toBeVisible(),
  },
  { name: "feed-strategies", path: "/?tab=strategies", status: 200, ready: (page: Page) => expect(page.getByRole("region", { name: "Strategies" }).getByRole("row").nth(1)).toBeVisible() },
  { name: "market", path: `/markets/${MARKET}`, status: 200, ready: marketReady("chart") },
  { name: "market-flipped", path: `/markets/${MARKET}?flip=1&interval=1h`, status: 200, ready: marketReady("chart") },
  {
    // The buy wall AMM's panel and its forms (#57), on its demo market: every part read from the market's state at one slot.
    name: "market-buy-wall",
    path: `/markets/${MARKET}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      const panel = page.getByRole("region", { name: "Buy wall AMM", exact: true });
      await expect(panel.getByText(/^Read from the market's state at slot [\d,]+, not from its vaults/)).toBeVisible();
      for (const part of ["Price and the buy wall", "Inventory cap", "Retired, owed and burned", "The fee", "Parameters and recipients"]) await expect(panel.getByRole("heading", { name: part, exact: true })).toBeVisible();
      await expect(panel.getByText("No wallet yet: it waits in the market until the program names one")).toBeVisible();
      const forms = page.getByRole("region", { name: "Buy wall AMM: keeper jobs and roles" });
      await expect(forms.getByRole("heading", { name: "Keeper jobs due" })).toBeVisible();
      await expect(forms.getByText(/^No keeper job is due on this market now\.$|^Simulate this job$/).first()).toBeVisible();
    },
  },
  { name: "market-hooked", path: `/markets/${MARKET_HOOKED}`, status: 200, ready: async (page: Page) => factsReady(page, ["This market", "Its strategy", "Its mints"]) },
  { name: "market-one-trade", path: `/markets/${MARKET_WITH_ONE_TRADE}`, status: 200, ready: marketReady("chart") },
  {
    name: "market-token-image",
    path: `/markets/${MARKET_TOKEN_IMAGE}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      await imageLoaded(page.getByRole("heading", { level: 1 }).locator("img"));
    },
  },
  {
    name: "market-lending",
    path: `/markets/${MARKET_LENDING}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      const panel = page.getByRole("region", { name: "Lending AMM", exact: true });
      await expect(panel.getByText(/^Read from the market state and Kamino's reserve at slot [\d,]+\./)).toBeVisible();
      for (const part of ["Lent side", "Buffer", "Kamino reserve", "LP shares"]) await expect(panel.getByRole("heading", { name: part, exact: true })).toBeVisible();
      // Its events are stored by the strategies' reconciliation, every five minutes, which the suite's setup does not wait for; the API's tests and the devnet run check what it lists.
      await expect(page.getByRole("region", { name: "Lending AMM history" })).toHaveAttribute("aria-busy", "false");
      await expect(page.getByRole("region", { name: "Actions" }).getByRole("heading", { name: "Add liquidity", exact: true })).toBeVisible();
    },
  },
  {
    name: "market-forms-unavailable",
    path: `/markets/${MARKET_METADATA_UNREACHABLE}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      await expect(page.getByText("No forms. Aviary builds a strategy's forms from its metadata, and this strategy's metadata is unavailable: the link could not be fetched.")).toBeVisible();
      await page.getByRole("region", { name: "Actions" }).getByText("What fetching the link found").click();
    },
  },
  {
    name: "market-forms-invalid",
    path: `/markets/${MARKET_METADATA_INVALID}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      await expect(page.getByText(/this strategy's metadata is unavailable: the document did not pass Pipeline's validator\.$/)).toBeVisible();
      await page.getByRole("region", { name: "Actions" }).getByText("What Pipeline's validator said").click();
    },
  },
  {
    name: "market-forms-old-actions",
    path: `/markets/${MARKET_OLD_ACTIONS}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      await expect(page.getByText("These forms come from the metadata's older actions section, which Pipeline no longer reads.")).toBeVisible();
    },
  },
  {
    name: "market-forms-review",
    path: `/markets/${TAX_MARKET}`,
    status: 200,
    ready: actionReviewed("Pay out a tax slot", { tax_mint: WSOL_MINT, recipient: SUITE_TREASURY }, { slot: "5" }, "passed"),
    wallet: true,
  },
  {
    name: "market-forms-refused",
    path: `/markets/${TAX_MARKET}`,
    status: 200,
    ready: actionReviewed("Change the taxes", {}, { buy_tax_bps: "600", sell_tax_bps: "900" }, "refused"),
    wallet: true,
  },
  {
    // The buy wall AMM's own create form (#57): IMD's launch values filled in, the whole fee split beside them.
    name: "create-buy-wall",
    path: `/create?strategy=${STRATEGY}`,
    status: 200,
    ready: async (page: Page) => {
      const form = page.getByRole("region", { name: "The create form" });
      await expect(form.getByRole("textbox", { name: /\bfee_bps u16\b/ })).toHaveValue("100");
      await expect(form.getByRole("textbox", { name: /\breward_share_bps u16\b/ })).toHaveValue("1500");
      await expect(form.getByRole("region", { name: "The whole fee split" }).getByText("0.1% of each swap (10% of the fee)").first()).toBeVisible();
      await expect(form.getByText("Enter the token's mint above to fill in the seed.")).toBeVisible();
    },
  },
  { name: "create", path: "/create", status: 200, ready: (page: Page) => expect(page.getByRole("region", { name: "Choose a strategy" }).getByRole("listitem").first()).toBeVisible() },
  {
    name: "create-form",
    path: `/create?strategy=${TAX_AMM}`,
    status: 200,
    ready: async (page: Page) => {
      const form = page.getByRole("region", { name: "The create form" });
      await form.getByRole("textbox", { name: /^mint_0 a mint/ }).fill(WSOL_MINT);
      await expect(form.getByLabel("The facts of mint_0")).toBeVisible();
    },
  },
  { name: "market-no-trades", path: `/markets/${MARKET_WITHOUT_TRADES}`, status: 200, ready: marketReady("none") },
  { name: "market-trade-quote", path: `/markets/${CP_MARKET}`, status: 200, ready: typed("0.1", "none", "quote"), wallet: true },
  { name: "market-trade-review", path: `/markets/${CP_MARKET}`, status: 200, ready: typed("0.1", "connect", "review"), wallet: true },
  { name: "market-trade-too-little", path: `/markets/${CP_MARKET}`, status: 200, ready: typed("500", "connect", "failed"), wallet: true },
  { name: "market-trade-refused", path: `/markets/${REFUSING_MARKET}`, status: 200, ready: typed("0.01", "connect", "refused"), wallet: true },
  // A market of three mints (#122), whose trades between two mints other than the pair on show are priced in their own pair.
  { name: "market-three-mints", path: `/markets/${THREE_MINT_MARKET}`, status: 200, ready: marketReady("chart") },
  // The wallet page (#122): without a wallet; with the test wallet, its head, its wrapped SOL, what it holds and its swaps; and its unwrap reviewed.
  { name: "wallet", path: "/wallet", status: 200, ready: (page: Page) => expect(page.getByText(/^Connect a wallet to see what it holds that trades on Pipeline/)).toBeVisible() },
  { name: "wallet-connected", path: "/wallet", status: 200, ready: walletReady("connected"), wallet: true },
  { name: "wallet-unwrap-review", path: "/wallet", status: 200, ready: walletReady("unwrap"), wallet: true },
  // Canary on the pages (#125): the open bonding curve's notice and tick, the outside builder's cost
  // fail, a stranded market with no trade box, a market that refuses every trade, and a strategy's lines.
  {
    name: "market-canary-notice",
    path: `/markets/${CANARY_MARKETS.open_curve}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("none")(page);
      await canaryReady(page);
      const notice = swapBox(page).locator('[data-canary="notice"]');
      await expect(notice).toContainText(/^In Canary's test on \d{1,2} [A-Z][a-z]{2} \d{4}, a wallet that bought 1 SOL or more could not sell back/);
      await expect(notice.getByRole("checkbox", { name: "I have read this" })).not.toBeChecked();
      await unexplained(page);
    },
  },
  {
    name: "market-canary-cost-fail",
    path: `/markets/${CANARY_MARKETS.outside_builder}`,
    status: 200,
    ready: async (page: Page) => {
      await factsReady(page, ["This market", "Its strategy", "Its mints"]);
      await canaryReady(page);
      const cost = page.locator('details[data-check="cost"]');
      await expect(cost).toHaveAttribute("open", "");
      await expect(cost.locator("summary")).toContainText(/fail\s*What a round trip costs/);
      await expect(cost.getByRole("row", { name: /^0\.01 SOL 4\d\.\d% back$/ })).toBeVisible();
    },
  },
  {
    name: "market-canary-stranded",
    path: `/markets/${CANARY_MARKETS.stranded}`,
    status: 200,
    ready: async (page: Page) => {
      await factsReady(page, ["This market", "Its strategy", "Its mints"]);
      await canaryReady(page);
      await expect(page.getByRole("region", { name: "This market cannot be traded" })).toContainText(/^This market cannot be traded through Pipeline\. The current version of its strategy, deployed in slot [\d,]+, cannot read this market's state/);
      await expect(page.getByRole("region", { name: "Swap" })).toHaveCount(0);
      await expect(page.locator("header").getByText("the strategy's current version cannot read this market")).toBeVisible();
    },
  },
  {
    name: "market-canary-refuses",
    path: `/markets/${CANARY_MARKETS.refusing}`,
    status: 200,
    ready: async (page: Page) => {
      await factsReady(page, ["This market", "Its strategy", "Its mints"]);
      await canaryReady(page);
      await expect(swapBox(page).getByText("This market refuses every trade by its own rules (WrongStatus: Not allowed in the curve's current status). A quote here returns the strategy's own error.")).toBeVisible();
    },
  },
  {
    name: "strategy-canary",
    path: `/strategies/${CANARY_CURVE_STRATEGY}`,
    status: 200,
    ready: async (page: Page) => {
      const section = page.getByRole("region", { name: "What Canary saw on this version" });
      await expect(section.getByText(/^Canary traded a private copy of each of this version's [\d,]+ markets on /)).toBeVisible();
      await expect(section.locator('[data-check="readable"]')).toContainText(/fail\s*, [\d,]+ of [\d,]+/);
      await expect(page.getByRole("region", { name: /^Its markets/ }).getByRole("row").last()).toBeVisible();
      await unexplained(page);
    },
  },
  {
    name: "strategy",
    path: `/strategies/${STRATEGY}`,
    status: 200,
    ready: async (page: Page) => {
      // A body row: on a phone the table's head is not a row, so the last row is one either way.
      await expect(page.getByRole("region", { name: /^Its markets/ }).getByRole("row").last()).toBeVisible();
      await expect(page.getByRole("region", { name: /^Version history/ }).getByRole("row").last()).toBeVisible();
      await factsReady(page, ["Its program", "Its trust flags", "Instructions beyond Pipeline's own"]);
      await expect(page.getByRole("list", { name: "Instructions beyond Pipeline's own" })).toBeVisible();
    },
  },
  {
    name: "strategy-unavailable",
    path: `/strategies/${STRATEGY_UNAVAILABLE}`,
    status: 200,
    ready: async (page: Page) => {
      await expect(page.getByText("Metadata unavailable, so it is listed under its address")).toBeVisible();
      await factsReady(page, ["Its program", "Its trust flags", "Instructions beyond Pipeline's own"]);
      // Its explanation carries a point with markup, as the validator never lets through: it reads as text.
      const panel = await explained(page);
      await panel.getByText(/^Read the full explanation/).click();
      await expect(panel.getByText(HOSTILE_TEXT, { exact: true })).toBeVisible();
      expect(await panel.locator("script, strong, b, em, a").count()).toBe(0);
    },
  },
  {
    name: "strategy-explained",
    path: `/strategies/${EXPLAINED_STRATEGY}`,
    status: 200,
    ready: async (page: Page) => {
      await factsReady(page, ["Its program", "Its trust flags", "Instructions beyond Pipeline's own"]);
      const panel = await explained(page);
      // Beside the facts at desktop width, above them in one column.
      const [at, facts] = [await panel.boundingBox(), await page.getByRole("region", { name: "Facts" }).boundingBox()];
      if ((page.viewportSize()?.width ?? 0) > 1080) expect(Math.abs(at!.y - facts!.y)).toBeLessThan(2);
      else expect(at!.y + at!.height).toBeLessThanOrEqual(facts!.y);
      // Its version was upgraded and has its explanation but no Canary results yet: only the tests are pending.
      await expect(page.getByText(/^Upgraded on \d{1,2} [A-Z][a-z]{2} \d{4}; /)).toHaveText(/; tests for this version are pending\.$/);
      await chipShowsRow(page, panel.locator("p").getByRole("button", { name: /^Show evidence / }).first());
    },
  },
  {
    name: "market-explained",
    path: `/markets/${EXPLAINED_MARKET}`,
    status: 200,
    ready: async (page: Page) => {
      await marketReady("chart")(page);
      const panel = await explained(page);
      await expect(panel.getByText(/^It describes the strategy version, not this market: where it says "the sampled market", it means the strategy's busiest one\./)).toBeVisible();
      // A summary chip, far above its row on a long page, brings the row into view; then a point's.
      await chipShowsRow(page, panel.locator("p").getByRole("button", { name: /^Show evidence / }).first());
      await panel.getByText(/^Read the full explanation/).click();
      await expect(panel.getByRole("heading", { name: "Who can change it" })).toBeVisible();
      await chipShowsRow(page, panel.locator("li[data-basis]").getByRole("button", { name: /^Show evidence / }).last());
    },
  },
  {
    name: "search",
    path: "/search?q=e",
    status: 200,
    ready: (page: Page) => expect(page.getByRole("region", { name: /^Mints/ }).getByText(/^The first 20 of [\d,]+\./)).toBeVisible(),
  },
  { name: "search-market", path: "/search?q=7BctW", status: 200, ready: (page: Page) => expect(page.getByRole("link", { name: "Market 7Bct...5CAK" })).toBeVisible() },
  { name: "search-token-image", path: "/search?q=image%20check", status: 200, ready: (page: Page) => imageLoaded(page.getByRole("region", { name: /^Mints/ }).locator("img").first()) },
  { name: "search-nothing-typed", path: "/search", status: 200, ready: (page: Page) => expect(page.getByRole("list", { name: "Examples" })).toBeVisible() },
  { name: "search-no-match", path: "/search?q=Nothing0Here", status: 200, ready: (page: Page) => expect(page.getByText(/^Nothing registered with Pipeline on devnet matches/)).toBeVisible() },
  { name: "fees", path: "/fees", status: 200, ready: (page: Page) => expect(page.getByRole("heading", { name: "An example" })).toBeVisible() },
  { name: "devnet-help", path: "/devnet", status: 200, ready: (page: Page) => expect(page.getByRole("heading", { name: "Get devnet USDC" })).toBeVisible() },
  { name: "keeper", path: "/keeper", status: 200, ready: (page: Page) => expect(page.getByRole("region", { name: "Latest jobs" }).getByRole("table")).toBeVisible() },
  { name: "nothing-there", path: `/markets/${UNKNOWN_ADDRESS}`, status: 404, ready: (page: Page) => expect(page.getByText(UNKNOWN_ADDRESS)).toBeVisible() },
  { name: "no-page", path: "/no-such-page", status: 404, ready: (page: Page) => expect(page.getByRole("heading", { name: "No page here" })).toBeVisible() },
];

// The keeper page shows the test keeper's records and its latest heartbeat (src/keeper.ts).
test.beforeAll(async () => {
  await seedKeeperRecords();
  await postKeeperHeartbeat();
});

for (const { name, path, status, ready, wallet } of PAGES) {
  test(`${name} wears the shell, stays inside the window and calls only Aviary's own origins`, async ({ page }, testInfo) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));
    // The Playwright test wallet, holding no key: it connects and reviews as recorded, and never signs.
    if (wallet) await installTestWallet(page, null);

    const response = await page.goto(path);
    expect(response?.status()).toBe(status);
    await ready(page);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);

    // The header: the name, linking to the feed, and the devnet tag.
    const header = page.getByRole("banner");
    const brand = header.getByRole("link").filter({ hasNotText: "Skip to the page" }).first();
    await expect(brand).toHaveAttribute("href", "/");
    await expect(brand).not.toHaveText("");
    await expect(header.getByText("devnet", { exact: true })).toBeVisible();
    await expect(header.getByRole("searchbox", { name: "Search" })).toBeVisible();

    // The header's wallet button.
    await expect(header.getByRole("button", { name: /^(Connect wallet|E69P\.\.\.JnAW)$/ })).toBeVisible();

    // The footer: the three styles of "Who is speaking", the devnet line, Fees, Devnet help and the theme control.
    const footer = page.getByRole("contentinfo");
    await expect(footer.getByText(/^Plain text was read from the chain or measured by /)).toBeVisible();
    await expect(footer.getByText("Text set like this was written by an AI from those facts.")).toBeVisible();
    await expect(footer.getByText("Text like this was written by a strategy's or token's author and is not verified.")).toBeVisible();
    await expect(footer.getByText(/^Devnet only\. .+ never holds your keys: every transaction is signed in your own wallet, after a simulation you see first\.$/)).toBeVisible();
    await expect(footer.getByRole("link", { name: "Fees" })).toHaveAttribute("href", "/fees");
    await expect(footer.getByRole("link", { name: "Devnet help" })).toBeVisible();
    await expect(footer.getByRole("link", { name: "Keeper" })).toHaveAttribute("href", "/keeper");
    await expect(footer.getByRole("radio")).toHaveCount(3);

    // Nothing scrolls sideways at any width down to 360 px.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);

    // Every request went to Aviary's own origins, and both typefaces came from there and loaded.
    const foreign = requested.filter((url) => !url.startsWith("data:") && !OWN_ORIGINS.includes(new URL(url).origin));
    expect(foreign).toEqual([]);
    const fonts = requested.filter((url) => url.endsWith(".woff2"));
    expect(fonts.length).toBeGreaterThan(0);
    const loaded = await page.evaluate(() => [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family.replaceAll('"', "")));
    expect(loaded).toEqual(expect.arrayContaining(["Archivo", "Literata"]));

    // Canary yellow only on Canary's mark beside its heading and on the trade box's notice, and nothing
    // green or red, in any element's computed colours (docs/spec/pipescope-screens.md, Colour and theme).
    expect(await colourViolations(page)).toEqual([]);

    await screenshot(page, testInfo, name);
  });
}

/**
 * Every computed colour on the page that breaks the screens' rule about colour: canary yellow outside
 * Canary's mark and the trade box's notice, a Canary mark or notice anywhere else, and anything green
 * or red. Each element and its ::before and ::after are read: text, backgrounds and their gradients,
 * borders, outlines, SVG fills and strokes, and decorations.
 */
function colourViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const PROPS = ["color", "background-color", "background-image", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "fill", "stroke", "text-decoration-color", "column-rule-color", "box-shadow"];
    const found: string[] = [];
    const describe = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.split(/\s+/)[0]}` : ""} "${(el.textContent ?? "").trim().slice(0, 40)}"`;
    /** Each rgb() or rgba() colour in a computed value, as red, green, blue and alpha. */
    const colours = (value: string) => [...value.matchAll(/rgba?\(([\d.]+),?\s*([\d.]+),?\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\)/g)].map((m) => ({ r: +m[1]!, g: +m[2]!, b: +m[3]!, a: m[4] === undefined ? 1 : +m[4] }));
    const hsl = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const [R, G, B] = [r / 255, g / 255, b / 255];
      const max = Math.max(R, G, B);
      const min = Math.min(R, G, B);
      const l = (max + min) / 2;
      const d = max - min;
      if (d === 0) return { h: 0, s: 0, l };
      const s = d / (1 - Math.abs(2 * l - 1));
      const h = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4);
      return { h: (h + 360) % 360, s, l };
    };
    const isCanary = (c: { r: number; g: number; b: number }) => c.r >= 245 && c.g >= 200 && c.g <= 225 && c.b <= 40;
    const isGreenOrRed = (c: { r: number; g: number; b: number }) => {
      const { h, s, l } = hsl(c);
      return s >= 0.25 && l >= 0.12 && l <= 0.88 && (h < 20 || h > 340 || (h > 75 && h < 165));
    };
    for (const el of document.querySelectorAll("body *")) {
      const inCanary = el.closest("[data-canary]") !== null;
      for (const pseudo of [null, "::before", "::after"]) {
        const style = getComputedStyle(el, pseudo);
        if (pseudo && (style.content === "none" || style.content === "normal")) continue;
        if (style.display === "none" || style.visibility === "hidden") continue;
        for (const prop of PROPS) {
          for (const c of colours(style.getPropertyValue(prop))) {
            if (c.a === 0) continue;
            if (isCanary(c) && !inCanary) found.push(`canary yellow in ${prop} of ${describe(el)}${pseudo ?? ""}`);
            else if (!isCanary(c) && isGreenOrRed(c)) found.push(`green or red rgb(${c.r}, ${c.g}, ${c.b}) in ${prop} of ${describe(el)}${pseudo ?? ""}`);
          }
        }
      }
    }
    // Canary's marks sit in a heading, and its notice in the trade box, nowhere else.
    for (const el of document.querySelectorAll('[data-canary="mark"]')) if (!el.closest("h1, h2, h3, h4")) found.push(`a Canary mark outside a heading: ${describe(el)}`);
    for (const el of document.querySelectorAll('[data-canary="notice"]')) if (!el.closest('section[aria-labelledby]')?.querySelector("h2")?.textContent?.includes("Swap")) found.push(`a Canary notice outside the trade box: ${describe(el)}`);
    for (const el of document.querySelectorAll("[data-canary]")) if (!["mark", "notice"].includes(el.getAttribute("data-canary") ?? "")) found.push(`an unknown Canary element: ${describe(el)}`);
    return found;
  });
}
