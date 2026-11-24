// The buy wall AMM's own forms under Actions (docs/spec/pool4-for-solana.md, Aviary's panel; #57):
// each keeper job that is due, by the keeper runner's own rules, as a button that prepares and
// simulates it for the viewer's wallet, with the runner's last attempt at it; and the recipients'
// handover forms, offered only to the wallet holding each role.
import { renderToStaticMarkup } from "react-dom/server";
import type { MarketKeeper } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { BuyWallFormsBody, jobFormValues } from "@/products/buyWall/BuyWallForms";
import { demoMarket, demoRead } from "./fixtures/buyWall";

const FEE_RECIPIENT = "4Q3DcWHTGaN6d6vVdTUxW4KEsD5iZky5wtgxNzf3bUzu";
const REWARDS_RECIPIENT = "7GDwQsJpPZTR6CwgPZkuHQakhziAs1xRoYzdrmQyibjd";
const SOMEONE = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW";
const NOW = new Date("2026-11-24T12:00:00Z");

const keeper = (due: MarketKeeper["due"]): MarketKeeper => ({ market: demoMarket.address, product: "buy-wall-amm", slot: 525_833_600, due, records: { ok: true, error: null } });
const unit = (over: Partial<MarketKeeper["due"][number]>): MarketKeeper["due"][number] => ({ job: "settle", key: "settle", slot: null, owed: null, last: null, due_since: null, ...over });
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").replace(/ ([,.;:])/g, "$1");
const render = (k: MarketKeeper, wallet: string | null = null) =>
  textOf(
    renderToStaticMarkup(
      <WalletProvider chain="solana:devnet">
        <BuyWallFormsBody market={demoMarket} read={demoRead} keeper={{ status: "loaded", data: k }} wallet={wallet} now={NOW} />
      </WalletProvider>,
    ),
  );

describe("the buy wall AMM's keeper jobs", () => {
  it("shows each job that is due as a button, saying what it would move and the keeper runner's last attempt", () => {
    const text = render(
      keeper([
        unit({ job: "place_wall", key: "place_wall", owed: "12000000" }),
        unit({ job: "settle", key: "settle", owed: "5000000", last: { at: "2026-11-24T11:00:00.000Z", outcome: "parked", signature: null, error: "custom program error: 0x1771", cap: null }, due_since: "2026-11-24T10:00:00.000Z" }),
        unit({ job: "pay_rewards", key: "pay_rewards", owed: "750000" }),
        unit({ job: "sweep_fees", key: "sweep_fees:0", slot: 0, owed: "4000000", last: { at: "2026-11-23T12:00:00.000Z", outcome: "sent", signature: "5sweep", error: null, cap: null } }),
        unit({ job: "sweep_fees", key: "sweep_fees:2", slot: 2, owed: "1000000" }),
      ]),
    );
    expect(text).toContain("Place the buy wall 0.012 SOL of idle SOL or spent wall to place again");
    expect(text).toContain("Settle the retired tokens 5 9qTA...mbd7 retired: the reward share is kept, the rest burned");
    expect(text).toContain("Aviary's keeper runner, 1h ago: parked after its last retry: custom program error: 0x1771. Due since 2h ago.");
    expect(text).toContain("Pay the rewards 0.75 9qTA...mbd7 to 7GDw...ibjd");
    expect(text).toContain("Sweep the fee recipient's share 0.004 SOL to 4Q3D...bUzu");
    expect(text).toContain("Aviary's keeper runner, 1d ago: sent.");
    expect(text).toContain("Sweep the suite share 0.001 SOL to CbqE...9VZF");
    expect(text.match(/Aviary's keeper runner has not tried it yet\./g)).toHaveLength(3);
    // Each one a button; anyone may press it, so it asks for a wallet first.
    expect(text.match(/Connect wallet/g)).toHaveLength(5);
    expect(text).toContain("Anyone may run them, and Aviary's keeper runner does");
  });

  it("links to the keeper page", () => {
    const html = renderToStaticMarkup(
      <WalletProvider chain="solana:devnet">
        <BuyWallFormsBody market={demoMarket} read={demoRead} keeper={{ status: "loaded", data: keeper([]) }} wallet={null} now={NOW} />
      </WalletProvider>,
    );
    expect(html).toContain('href="/keeper"');
  });

  it("says when no job is due", () => {
    expect(render(keeper([]))).toContain("No keeper job is due on this market now.");
  });

  it("says when the keeper runner's records could not be read, keeping the buttons", () => {
    const k = { ...keeper([unit({ owed: "5" })]), records: { ok: false, error: "the database did not answer" } };
    expect(render(k)).toContain("The keeper runner's records could not be read: the database did not answer.");
    expect(render(k)).toContain("Settle the retired tokens");
  });

  it("fills each job's form as the strategy's metadata action takes it, from the market's state", () => {
    const recipients = { fee: FEE_RECIPIENT, rewards: REWARDS_RECIPIENT, designer: null, suite: "CbqE9TtDJf67xFnXybBrzV6Tg4Mw71hX2VhWcm4R9VZF" } as const;
    expect(jobFormValues(unit({ job: "place_wall", key: "place_wall" }), recipients)).toEqual({ args: {}, inputs: {} });
    expect(jobFormValues(unit({ job: "settle" }), recipients)).toEqual({ args: {}, inputs: {} });
    expect(jobFormValues(unit({ job: "pay_rewards", key: "pay_rewards" }), recipients)).toEqual({ args: {}, inputs: { rewards_recipient: REWARDS_RECIPIENT } });
    expect(jobFormValues(unit({ job: "sweep_fees", key: "sweep_fees:0", slot: 0 }), recipients)).toEqual({ args: { slot: "0" }, inputs: { recipient: FEE_RECIPIENT } });
    expect(jobFormValues(unit({ job: "sweep_fees", key: "sweep_fees:2", slot: 2 }), recipients)).toEqual({ args: { slot: "2" }, inputs: { recipient: recipients.suite } });
    expect(jobFormValues(unit({ job: "sweep_fees", key: "sweep_fees:1", slot: 1 }), recipients)).toBeNull();
  });
});

describe("the recipients' handover forms", () => {
  it("offers each role's handover only to the wallet holding it", () => {
    const none = render(keeper([]), SOMEONE);
    expect(none).not.toContain("Hand over the fee recipient role");
    expect(none).not.toContain("Hand over the rewards recipient role");
    const fee = render(keeper([]), FEE_RECIPIENT);
    expect(fee).toContain("Hand over the fee recipient role");
    expect(fee).not.toContain("Hand over the rewards recipient role");
    expect(fee).toContain("Your wallet is this market's fee recipient");
    const rewards = render(keeper([]), REWARDS_RECIPIENT);
    expect(rewards).toContain("Hand over the rewards recipient role");
    expect(rewards).not.toContain("Hand over the fee recipient role");
  });

  it("offers no handover with no wallet connected", () => {
    const text = render(keeper([]), null);
    expect(text).not.toContain("Hand over the");
  });
});
