// The buy wall AMM's panel on the market page (docs/spec/pool4-for-solana.md, Aviary's panel; #57):
// everything the spec lists, per market, read from the market state at one slot through the API's
// one-slot read, never from vault balances; registered for the buy wall AMM's program only.
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketRead } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { BuyWallPanelBody } from "@/products/buyWall/BuyWallPanel";
import { PRODUCT_PANELS } from "@/products/registry";
import { BUY_WALL, DEMO, demoMarket, demoRead } from "./fixtures/buyWall";

/** The panel's text, its tags dropped and its spaces folded. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").replace(/ ([,.;:])/g, "$1");
const render = (read: MarketRead = demoRead, now = 1_795_228_910n) => textOf(renderToStaticMarkup(<BuyWallPanelBody market={demoMarket} read={read} now={now} />));

describe("the buy wall AMM's panel", () => {
  it("is registered for the buy wall AMM's program, with its panel and its forms", () => {
    expect(PRODUCT_PANELS[BUY_WALL]?.Panel).toBeDefined();
    expect(PRODUCT_PANELS[BUY_WALL]?.Forms).toBeDefined();
  });

  it("says where it read the market, and credits IMD's Pool4 design", () => {
    expect(render()).toContain(`Read from the market's state at slot ${DEMO.slot.toLocaleString("en-US")}`);
    expect(render()).toContain("a port of IMD's Pool4 design");
  });

  it("shows the price, the wall's top, its SOL and what it has bought since placed, and its floor", () => {
    const text = render();
    expect(text).toContain("Price 0.0₅8903 SOL");
    expect(text).toContain("Wall's top 0.0₅8903 SOL");
    expect(text).toContain("In the wall 1.782 SOL");
    expect(text).toContain("Bought since placed 0 9qTA...mbd7, for 0 SOL");
    expect(text).toContain("Wall's floor 0.0₅8903 SOL");
    expect(text).toContain("Idle SOL 0 SOL waiting to be placed as the wall");
  });

  it("shows the cap against what the curve holds, the cap floor, the cap decay and the allowance built up", () => {
    const text = render();
    expect(text).toContain("Inventory cap 864,300 9qTA...mbd7");
    expect(text).toContain("The curve holds 864,300 9qTA...mbd7, 100% of the cap");
    expect(text).toContain("Cap floor 200,000 9qTA...mbd7, 20% of the 1M seeded");
    expect(text).toContain("Cap decay 200,000 9qTA...mbd7 a day, 20% of the seeded");
    expect(text).toContain("Allowance built up 51,480 9qTA...mbd7");
  });

  it("shows the allowance as it has built up since the market's last update, at most one day's", () => {
    expect(render(demoRead, 1_795_228_910n + 3_600n)).toContain("Allowance built up 59,810 9qTA...mbd7");
    expect(render(demoRead, 1_795_228_910n + 864_000n)).toContain("Allowance built up 200,000 9qTA...mbd7, a full day's");
  });

  it("shows retired tokens, rewards owed and the tokens burned as a share of the supply", () => {
    const text = render();
    expect(text).toContain("Retired 0 9qTA...mbd7");
    expect(text).toContain("Rewards owed 0 9qTA...mbd7");
    expect(text).toContain("Burned 175,400 9qTA...mbd7, 13.5% of the supply before these burns");
  });

  it("shows the fee and its whole split, each fee ledger, and that the designer share has no wallet yet", () => {
    const text = render();
    expect(text).toContain("Fee 1% of each swap, in SOL");
    expect(text).toContain("Designer share 10% of the fee (0.1% of each swap), for IMD and Adam");
    expect(text).toContain("Suite share 10% of the fee (0.1% of each swap)");
    expect(text).toContain("The market's part 80% of the fee: 50% to the buy wall (0.4% of each swap) and 50% to the fee recipient (0.4% of each swap)");
    expect(text).toContain("Owed to the fee recipient 0 SOL");
    expect(text).toContain("Owed to the designer share 0.01251 SOL No wallet yet: it waits in the market until the program names one");
    expect(text).toContain("Owed to the suite share 0 SOL");
  });

  it("shows the parameters and both recipients", () => {
    const text = render();
    expect(text).toContain("Reward share 15% of the trimmed tokens the cap's fall matched");
    expect(text).toContain("Seeded 1M 9qTA...mbd7 by 9rYt...ywCt on 20 Nov 2026, 04:13 UTC");
    expect(text).toContain("Fee recipient 4Q3D...bUzu");
    expect(text).toContain("Rewards recipient 7GDw...ibjd");
  });

  it("says when the market's state is not a buy wall market state", () => {
    const broken = { ...demoRead, accounts: [{ ...demoRead.accounts[0]!, data: Buffer.alloc(1024).toString("base64") }, demoRead.accounts[1]!] };
    expect(render(broken)).toContain("not a buy wall market state");
  });
});
