// The strategy's forms as the market page draws them (docs/spec/pipescope-screens.md, Explanation,
// actions and facts; #123): each form's heading says which instruction it calls; its result line
// passes when the instruction it sends is in the deployed program, naming the instruction that runs
// when the metadata's name says otherwise, and warns "what this form calls could not be checked"
// when it is not; every author text in it, the explainer's hostile fixtures included, is plain text in
// the author's style; and a strategy with no forms says why, with what the validator said.
import { renderToStaticMarkup } from "react-dom/server";
import type { Form, Market, StrategyForms } from "terminal-api/contract";
import { authorText } from "terminal-explainer";
import { hostileMetadata } from "terminal-explainer/fixtures";
import { describe, expect, it } from "vitest";
import { ActionsBody } from "@/components/forms/Actions";
import { WalletProvider } from "@/components/wallet/WalletProvider";

const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const market: Market = {
  address: "4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c",
  strategy: STRATEGY,
  market_state: "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz",
  created_at: "2026-11-24T00:00:00.000Z",
  created_by: "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW",
  created_signature: null,
  fee_mint: null,
  supports_exact_out: false,
  mints: [
    { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", token: null, decimals: 9, vault: null, liquidity: null, flags: [] },
    { mint: "AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx", symbol: null, token: { symbol: "AVIMG", name: null, image: null }, decimals: 6, vault: null, liquidity: null, flags: [] },
  ],
  quote_mint: "So11111111111111111111111111111111111111112",
  base_mint: "AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx",
  stats_24h: { trades: 0, volume_quote: "0" },
  strategy_name: "Aviary Tax AMM",
  strategy_metadata: "valid",
  flags: [],
};

const form = (over: Partial<Form>): Form => ({
  name: "distribute",
  label: "Pay out a tax slot",
  description: null,
  kind: "claim",
  discriminator: "bf2cdfcfa4ec7e3d",
  check: { outcome: "pass", instruction: "Distribute", reason: "found" },
  args: [{ name: "slot", type: "u8", label: "Slot", description: null, decimals_of: null }],
  accounts: [
    { name: "payer", source: { kind: "wallet" }, writable: true, signer: true },
    { name: "tax_vault", source: { kind: "pda", program: "strategy", seeds: [{ kind: "str", text: "vault" }] }, writable: true, signer: false },
  ],
  inputs: [{ name: "tax_mint", mint: true }],
  market_state: null,
  ...over,
});
const forms = (over: Partial<StrategyForms>): StrategyForms => ({ program: STRATEGY, deploy_slot: 525_400_000, metadata: "valid", actions_section: "aviary_actions", unavailable: null, errors: [], instructions_beyond_pipeline: 5, actions: [], init: null, ...over });

const render = (view: StrategyForms) =>
  renderToStaticMarkup(
    <WalletProvider chain="solana:devnet">
      <ActionsBody forms={view} market={market} />
    </WalletProvider>,
  );
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .replace(/ ([.,:])/g, "$1")
    .trim();

describe("an action's form", () => {
  it("names the instruction that runs in its heading and its result line, the first form open", () => {
    const html = render(forms({ actions: [form({}), form({ name: "burn", label: "Burn the burn slot's tax" })] }));
    expect(html.match(/<details[^>]*>/g)).toEqual([expect.stringContaining("open"), expect.not.stringContaining("open")]);
    const text = textOf(html);
    expect(text).toContain("Pay out a tax slot calls Distribute");
    expect(text).toContain("pass Calls Distribute on the strategy J4sA...nW9t. An instruction with the discriminator this form sends is in the deployed program, as deployed in slot 525,400,000.");
    // The burn action is the program's distribute under another name: the form says so.
    expect(text).toContain("Burn the burn slot's tax calls Distribute");
    expect(text).toContain("The metadata names it burn, but the instruction that runs is Distribute.");
    expect(text).toContain("You sign this directly on the strategy. The router's swap protections (a minimum received, nothing taken beyond what you signed) do not apply to it.");
  });

  it("warns when the instruction it sends is not in the deployed program", () => {
    const text = textOf(render(forms({ actions: [form({ name: "withdraw_all", label: "Claim your rewards", check: { outcome: "warn", instruction: null, reason: "not-in-program" } })] })));
    expect(text).toContain("Claim your rewards calls withdraw_all");
    expect(text).toContain("warn Calls withdraw_all on the strategy J4sA...nW9t: what this form calls could not be checked, since no instruction of the deployed program has the discriminator it sends.");
  });

  it("gives each field its author's label and, plainly, its name and type, and lists every account it touches", () => {
    const text = textOf(render(forms({ actions: [form({})] })));
    expect(text).toContain("tax_mint a mint, by its address");
    expect(text).toContain("Slot slot u8");
    expect(text).toContain("Every account it touches");
    expect(text).toContain("payer your wallet yes yes");
    expect(text).toContain("tax_vault an address derived from the program itself by a rule in the metadata yes no");
    expect(text).toContain("Connect wallet");
  });

  describe.each(Object.entries(hostileMetadata))("with the hostile fixture %s's text", (_, json) => {
    const fixture = json as { name: string; description?: string };
    const label = authorText(fixture.name, 64).text;
    const description = fixture.description ? authorText(fixture.description, 600).text : null;

    it("sets its label and description in the author's style, as plain text", () => {
      const html = render(forms({ actions: [form({ label, description })] }));
      const spans = [...html.matchAll(/<span class="[^"]*author[^"]*">([^<]*)<\/span>/g)].map((m) => textOf(m[1]!));
      expect(spans).toContain(label);
      if (description) expect(spans).toContain(description);
      // No element came from the author's text: every tag in the form is one the page writes.
      expect(html).not.toMatch(/<(script|img|a|b|i)\b/);
    });
  });
});

describe("Actions without forms", () => {
  it("says the metadata is unavailable and why, what fetching it found, and counts the program's own instructions", () => {
    const text = textOf(render(forms({ metadata: "unreachable", unavailable: "metadata-unreachable", errors: ["HTTP 404"] })));
    expect(text).toBe("No forms. Aviary builds a strategy's forms from its metadata, and this strategy's metadata is unavailable: the link could not be fetched. What fetching the link found HTTP 404 The deployed program has 5 instructions beyond Pipeline's own.");
  });

  it("says what Pipeline's validator said of an invalid document", () => {
    const text = textOf(render(forms({ metadata: "invalid", unavailable: "metadata-invalid", errors: ["name: required"], instructions_beyond_pipeline: null })));
    expect(text).toBe("No forms. Aviary builds a strategy's forms from its metadata, and this strategy's metadata is unavailable: the document did not pass Pipeline's validator. What Pipeline's validator said name: required Aviary has not read the deployed program's instructions yet.");
  });

  it("says when valid metadata describes no actions", () => {
    expect(textOf(render(forms({ instructions_beyond_pipeline: 1 })))).toBe("No forms: this strategy's metadata describes no actions. The deployed program has 1 instruction beyond Pipeline's own.");
  });
});
