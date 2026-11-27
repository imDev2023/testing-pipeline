// The containment hook in Aviary (docs/spec/containment-hook.md, "In Aviary"; #76): the panel on a
// contained token's home market page, its Unlock button once the unlock is due and never before, the
// trade box's one-line rule before a buy, and the tax AMM's launch form refusing a mint whose transfer
// hook is ours.
import { renderToStaticMarkup } from "react-dom/server";
import { CONTAINMENT_HOOK_PROGRAM_ADDRESS } from "containment-hook-scripts/client/index.ts";
import type { ContainedMint, MarketContainment } from "terminal-api/containment";
import type { Market, MintFacts } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { ContainmentPanelBody } from "@/products/containment/ContainmentPanel";
import { CONTAINED_RULE, containedLaunchRefusal, containedRuleFor, deadlineWait, timeLeft } from "@/products/containment/view";

const TOKEN = "CnTd1QhbTzyCLTVCQXrVBmy1xKkRjqF1Gw5k1y2nEaHw";
const WSOL = "So11111111111111111111111111111111111111112";
const LAUNCHER = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW";
const OTHER = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";
// 27 Nov 2026, 20:00:00 UTC.
const NOW = 1_795_809_600;

const market: Market = {
  address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  strategy: "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t",
  market_state: "4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c",
  created_at: "2026-11-27T19:00:00.000Z",
  created_by: LAUNCHER,
  created_signature: null,
  fee_mint: WSOL,
  supports_exact_out: false,
  mints: [
    { mint: TOKEN, symbol: null, token: { symbol: "CTD", name: "Contained", image: null }, decimals: 9, vault: null, liquidity: null, flags: ["transfer-hook", "transfer-hook-authority"] },
    { mint: WSOL, symbol: "SOL", token: null, decimals: 9, vault: null, liquidity: null, flags: [] },
  ],
  quote_mint: WSOL,
  base_mint: TOKEN,
  stats_24h: { trades: 0, volume_quote: "0" },
  strategy_name: "Aviary Tax AMM",
  strategy_metadata: "valid",
  flags: [],
  canary: null,
};

const contained: ContainedMint = {
  mint: TOKEN,
  status: "contained",
  quote_mint: WSOL,
  goal: "100000000",
  collected: "54635805",
  // 5 Dec 2026, 07:58:31 UTC: 7 days, 11 hours and 58 minutes after NOW.
  deadline: 1_796_457_511,
  bound_at: 1_795_806_000,
  unlocked_at: null,
  unlocked_by: null,
  due: null,
  tax: {
    recipients: [
      { wallet: LAUNCHER, of_tax_bps: 6_750, launcher: true },
      { wallet: OTHER, of_tax_bps: 2_250, launcher: false },
    ],
    burn_of_tax_bps: 0,
    suite_of_tax_bps: 1_000,
    launcher_of_tax_bps: 6_750,
    authority: { kind: "address", address: LAUNCHER, launcher: true },
    pending: null,
  },
  supply: { total: "1000000000000000000", in_pool: "800000000000000000", outside: "200000000000000000", quote_in_pool: "2500000000" },
  weak: { goal: false, deadline: false },
  group_extensions: [],
};

const read = (entry: Partial<ContainedMint> = {}): MarketContainment => ({
  market: market.address,
  slot: 526_100_000,
  chain_time: NOW,
  contained: [{ ...contained, ...entry }],
  weak_terms: { goal_of_quote_reserve_bps: 1_000, deadline_min_seconds: 604_800 },
});

/** The panel's text, its tags dropped and its spaces folded. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").replace(/ ([,.;:)])/g, "$1");
const html = (view: MarketContainment) =>
  renderToStaticMarkup(
    <WalletProvider chain="solana:devnet">
      <ContainmentPanelBody market={market} read={view} entry={view.contained[0]!} onUnlocked={() => {}} />
    </WalletProvider>,
  );
const render = (entry: Partial<ContainedMint> = {}) => textOf(html(read(entry)));

describe("the containment panel", () => {
  it("says the token is contained, with the rule in one line", () => {
    expect(render()).toContain(`Contained ${CONTAINED_RULE}`);
    expect(CONTAINED_RULE).toBe("This token can only be bought and sold in this market until it unlocks, and cannot be sent to another wallet.");
  });

  it("shows the tax collected against the unlock goal, in the quote mint, as a number and a bar", () => {
    expect(render()).toContain("Tax collected 0.05464 SOL of the goal of 0.1 SOL, 54.6%");
    expect(html(read())).toMatch(/role="progressbar"[^>]*aria-valuenow="54.6"/);
    expect(render({ collected: "50000" })).toContain("Tax collected 0.00005 SOL of the goal of 0.1 SOL, under 0.1%");
  });

  it("shows the unlock deadline as a date and the time left", () => {
    expect(render()).toContain("Unlock deadline 5 Dec 2026, 07:58 UTC, in 7 days 11 hours");
  });

  it("says who receives the tax, the launcher's part, that the tax authority is live, and what a sole recipient's goal costs", () => {
    const text = render();
    expect(text).toContain("Tax goes to E69P...JnAW, the launcher, 67.5% of every tax; 8qTR...vQC2, 22.5%; the suite share, 10%");
    expect(text).toContain("Tax authority E69P...JnAW, the launcher: may change the rates inside their ranges and the tax recipients");
    expect(text).toContain("Whoever receives the tax gets most of it back, so they can reach the goal for a fraction of what it costs anyone else.");
  });

  it("shows a pending change of rates", () => {
    expect(render({ tax: { ...contained.tax!, pending: { buy_bps: 100, sell_bps: 200, from_slot: 526_100_500 } } })).toContain("Changing To 1% buy and 2% sell from slot 526,100,500");
  });

  it("shows the supply held outside the pool and the real quote it can be sold into", () => {
    expect(render()).toContain("Outside the pool 200M CTD CnTd...EaHw, 20% of the supply. Its holders can sell it into the 2.5 SOL buyers paid into the pool.");
  });

  it("warns on weak terms, and only then", () => {
    expect(render()).not.toContain("Weak terms");
    expect(render({ weak: { goal: true, deadline: true } })).toContain(
      "Weak terms The goal is under 10% of the market's reserve of SOL, virtual reserve included, so forcing the unlock costs others little. The deadline is less than 7 days after the token was bound.",
    );
  });

  it("says containment watches token movements, not who controls a key", () => {
    expect(render()).toContain("Containment watches token movements, not who controls a key: a program or smart wallet holding the token can change hands without a transfer.");
  });

  it("warns that venues may still refuse a mint with group extensions after its unlock, and only for such a mint", () => {
    expect(render()).not.toContain("group");
    expect(render({ group_extensions: ["GroupPointer"] })).toContain("This mint carries Token-2022's group pointer extension, so after its unlock some venues may still not accept it.");
  });

  it("has no Unlock button before the unlock is due", () => {
    expect(html(read())).not.toMatch(/<button[^>]*[Uu]nlock/);
    expect(render()).not.toContain("The unlock is due");
  });

  it("shows the Unlock button to anyone once the unlock is due, by the goal or by the deadline", () => {
    expect(render({ due: "goal", collected: "133135805" })).toContain("The unlock is due: the goal is reached. Anyone may send the unlock");
    expect(html(read({ due: "goal" }))).toContain('aria-label="Connect wallet to unlock"');
    expect(render({ due: "deadline", deadline: NOW - 60 })).toContain("The unlock is due: the deadline has passed.");
  });

  it("once unlocked, says when and by which of the two, and offers no button", () => {
    const byGoal = render({ status: "unlocked", unlocked_at: NOW - 3_600, unlocked_by: "goal", collected: "133135805" });
    expect(byGoal).toContain("Unlocked on 27 Nov 2026, 19:00 UTC, by reaching its goal.");
    expect(byGoal).toContain("It is now an ordinary Token-2022 token");
    expect(byGoal).not.toContain(CONTAINED_RULE);
    expect(render({ status: "unlocked", unlocked_at: NOW - 60, unlocked_by: "deadline", deadline: NOW - 120 })).toContain("Unlocked on 27 Nov 2026, 19:59 UTC, by its deadline.");
    expect(html(read({ status: "unlocked", unlocked_at: NOW, unlocked_by: "goal" }))).not.toMatch(/<button[^>]*[Uu]nlock/);
  });
});

describe("timeLeft", () => {
  it("says the time left in its two largest units, and past the deadline how long ago", () => {
    expect(timeLeft(NOW + 90, NOW)).toBe("in 1 minute 30 seconds");
    expect(timeLeft(NOW + 3 * 86_400 + 5 * 3_600 + 59, NOW)).toBe("in 3 days 5 hours");
    expect(timeLeft(NOW - 7_200, NOW)).toBe("passed 2 hours ago");
  });
});

describe("deadlineWait", () => {
  it("is how long the panel waits to read again, a second past the earliest deadline still ahead", () => {
    expect(deadlineWait(read({ deadline: NOW + 90 }))).toBe(91_000);
    expect(deadlineWait(read({ deadline: NOW - 1 }))).toBeNull();
    expect(deadlineWait(read({ status: "unlocked", unlocked_at: NOW, deadline: NOW + 90 }))).toBeNull();
  });

  it("is none for a deadline further away than a browser timer can wait, about 24.8 days, which would fire at once", () => {
    expect(deadlineWait(read({ deadline: NOW + 25 * 86_400 }))).toBeNull();
  });
});

describe("the trade box's rule", () => {
  it("is the panel's one line before a buy of a contained token, and nothing before a sell or once unlocked", () => {
    expect(containedRuleFor(read(), TOKEN)).toBe(CONTAINED_RULE);
    expect(containedRuleFor(read(), WSOL)).toBeNull();
    expect(containedRuleFor(read({ status: "unlocked", unlocked_at: NOW }), TOKEN)).toBeNull();
    expect(containedRuleFor(null, TOKEN)).toBeNull();
  });
});

describe("the tax AMM's launch form", () => {
  const facts = (address: string | null, authority: string | null): MintFacts => ({
    mint: TOKEN,
    symbol: null,
    token: { symbol: "CTD", name: "Contained", image: null },
    readable: true,
    token_program: "Token-2022",
    decimals: 9,
    supply: "1",
    mint_authority: null,
    freeze_authority: null,
    extensions: [{ name: "Transfer hook", detail: "every transfer calls this program", address, authority }],
    vault_amount: null,
    vault_share_percent: null,
    flags: [],
    read_slot: 1,
  });

  it("refuses a mint whose transfer hook is ours, saying why, before any signature", () => {
    expect(containedLaunchRefusal(facts(CONTAINMENT_HOOK_PROGRAM_ADDRESS, OTHER))).toBe(
      "CTD's transfer hook is Aviary's containment hook, so this form cannot launch it: a contained token is launched by the containment hook's launch script, which binds it to its home market before the seed, and a token already bound has its home market.",
    );
  });

  it("leaves any other mint to the program's own mint rules", () => {
    expect(containedLaunchRefusal(facts(OTHER, LAUNCHER))).toBeNull();
    expect(containedLaunchRefusal(facts(null, null))).toBeNull();
  });
});
