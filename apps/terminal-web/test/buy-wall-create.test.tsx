// The buy wall AMM's create form (docs/spec/pool4-for-solana.md, Creation parameters and Creating a
// market; #57): the strategy's own create form pre-filled with IMD's launch values, kept in one place,
// the whole fee split beside it, the designer and suite shares included, and the seed's amounts, so
// the market is created and seeded in one transaction; shown on the create page in place of the
// generic form for the buy wall AMM's program only.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Form, StrategyForms } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { BuyWallCreate, FeeSplit } from "@/products/buyWall/BuyWallCreate";
import { CREATE_FORM_DEFAULTS } from "@/products/buyWall/config";
import { PRODUCT_PANELS } from "@/products/registry";
import { BUY_WALL } from "./fixtures/buyWall";

const SPEC = readFileSync(`${import.meta.dirname}/../../../docs/spec/pool4-for-solana.md`, "utf8");
const arg = (name: string, type: Form["args"][number]["type"], label: string, decimals_of: Form["args"][number]["decimals_of"] = null) => ({ name, type, label, description: null, decimals_of });
const init: Form = {
  name: "pipeline_init_market",
  label: null,
  description: "Creates a market for a token against wrapped SOL. Seed it with the seed action in the same transaction; its parameters never change after creation.",
  kind: null,
  discriminator: "0011223344556677",
  check: { outcome: "pass", instruction: "PipelineInitMarket", reason: "found" },
  args: [
    arg("fee_bps", "u16", "Fee (basis points)"),
    arg("wall_split_bps", "u16", "Share of the market's fee for the buy wall (basis points)"),
    arg("fee_recipient", "pubkey", "Fee recipient"),
    arg("reward_share_bps", "u16", "Reward share of trimmed tokens (basis points)"),
    arg("rewards_recipient", "pubkey", "Rewards recipient"),
    arg("cap_floor_bps", "u16", "Cap floor (basis points of the seeded tokens)"),
    arg("cap_decay_bps", "u16", "Cap decay a day (basis points of the seeded tokens)"),
    arg("seeder", "pubkey", "Seeder"),
  ],
  accounts: [{ name: "token_mint", source: { kind: "input", name: "token_mint" }, writable: false, signer: false }],
  inputs: [{ name: "token_mint", mint: true }],
  market_state: "new_keypair",
};
const seed: Form = {
  name: "seed",
  label: "Seed the market",
  description: null,
  kind: "add_liquidity",
  discriminator: "8899aabbccddeeff",
  check: { outcome: "pass", instruction: "Seed", reason: "found" },
  args: [arg("token_amount", "u64", "Tokens", { kind: "mint", index: 0 }), arg("sol_amount", "u64", "Wrapped SOL", { kind: "mint", index: 1 })],
  accounts: [],
  inputs: [],
  market_state: null,
};
const view: StrategyForms = { program: BUY_WALL, deploy_slot: 524_292_769, metadata: "valid", actions_section: "aviary_actions", unavailable: null, errors: [], instructions_beyond_pipeline: 7, actions: [seed], init };

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").replace(/ ([,.;:)])/g, "$1");
const html = () =>
  renderToStaticMarkup(
    <WalletProvider chain="solana:devnet">
      <BuyWallCreate view={view} />
    </WalletProvider>,
  );

describe("the buy wall AMM's create form", () => {
  it("is the create page's form for the buy wall AMM's program", () => {
    expect(PRODUCT_PANELS[BUY_WALL]?.Create).toBe(BuyWallCreate);
  });

  it("keeps IMD's launch values, as the spec states them, in one place", () => {
    expect(SPEC).toContain("a 1% fee, a 15% reward share, a cap floor of 20% and a cap decay of 20% a day");
    expect(CREATE_FORM_DEFAULTS).toMatchObject({ fee_bps: 100, reward_share_bps: 1_500, cap_floor_bps: 2_000, cap_decay_bps: 2_000 });
  });

  it("starts with IMD's launch values filled in", () => {
    const page = html();
    for (const [name, value] of Object.entries(CREATE_FORM_DEFAULTS)) expect(page, name).toMatch(new RegExp(`id="[^"]*-arg-${name}"[^>]*value="${value}"`));
    expect(textOf(page)).toContain("IMD's own launch values for Pool4: a 1% fee, a 15% reward share, a cap floor of 20% and a cap decay of 20% a day. 50% of the market's part of the fee goes to the buy wall.");
  });

  it("asks for the seed's amounts with the market's parameters, to create and seed it in one transaction", () => {
    const text = textOf(html());
    expect(text).toContain("The seed What the market opens with, from your wallet, for good");
    // Its amounts are in the token entered above, so they wait for it.
    expect(text).toContain("Enter the token's mint above to fill in the seed.");
    expect(text).toContain("created and seeded in one transaction");
    expect(text).toContain("Connect wallet");
  });

  it("shows the whole fee split, the designer and suite shares included", () => {
    const text = textOf(renderToStaticMarkup(<FeeSplit feeBps={100} wallSplitBps={5_000} />));
    expect(text).toContain("Fee 1% of each swap, in SOL, on top of Pipeline's own fee");
    expect(text).toContain("Designer share, for IMD and Adam 0.1% of each swap (10% of the fee)");
    expect(text).toContain("Suite share 0.1% of each swap (10% of the fee)");
    expect(text).toContain("Buy wall 0.4% of each swap (50% of the market's 80%)");
    expect(text).toContain("Fee recipient 0.4% of each swap (50% of the market's 80%)");
  });

  it("follows the values typed, and says when they cannot make a fee split", () => {
    expect(textOf(renderToStaticMarkup(<FeeSplit feeBps={300} wallSplitBps={10_000} />))).toContain("Fee recipient 0% of each swap (0% of the market's 80%)");
    expect(textOf(renderToStaticMarkup(<FeeSplit feeBps={null} wallSplitBps={5_000} />))).toContain("Enter the fee and the buy wall split to see how each swap's fee is split.");
  });
});
