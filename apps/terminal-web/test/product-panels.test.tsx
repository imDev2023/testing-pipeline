// The place each of our products hangs its panel (docs/spec/README.md, Our products live inside Aviary;
// SUITE-15, PIPESCOPE-147): a registry keyed by strategy program puts a product's panel on the market
// page's lower band, after the trades and before the explanation and the forms, and its own forms
// under Actions with the strategy's others, on that program's markets and nowhere else.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { Market } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { MarketLowBand } from "@/components/market/MarketLowBand";
import { PRODUCT_PANELS, type ProductRegistry } from "@/products/registry";
import { TaxLaunch } from "@/products/taxAmm/TaxLaunch";
import { TaxPanel } from "@/products/taxAmm/TaxPanel";

const TEST_PROGRAM = "TestPane1111111111111111111111111111111111";
/** The tax AMM's program: one of ours, with its own panel, but not the test registry's. */
const OTHER_PROGRAM = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";

const market = (strategy: string, address: string): Market => ({
  address,
  strategy,
  market_state: "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz",
  created_at: "2026-11-24T00:00:00.000Z",
  created_by: "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW",
  created_signature: null,
  fee_mint: null,
  supports_exact_out: false,
  mints: [],
  quote_mint: "So11111111111111111111111111111111111111112",
  base_mint: "AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx",
  stats_24h: { trades: 0, volume_quote: "0" },
  strategy_name: null,
  strategy_metadata: "valid",
  flags: [],
  canary: null,
});

const registry: ProductRegistry = {
  [TEST_PROGRAM]: {
    Panel: ({ market }) => <p>Test product panel for {market.address}</p>,
    Forms: () => <p>Test product form</p>,
  },
};
const facts = <section aria-label="Facts">The facts panel</section>;

describe("the product panels' registry", () => {
  it("holds only our own products' programs, as deployments/devnet.json records them", () => {
    const deployed = JSON.parse(readFileSync(`${import.meta.dirname}/../../../deployments/devnet.json`, "utf8")) as { programs: Record<string, { programId: string }> };
    const ours = Object.values(deployed.programs).map((p) => p.programId);
    expect(Object.keys(PRODUCT_PANELS).length).toBeGreaterThan(0);
    for (const program of Object.keys(PRODUCT_PANELS)) expect(ours).toContain(program);
  });

  it("hangs the tax AMM's tax panel and launch form on its program (#75)", () => {
    expect(PRODUCT_PANELS[OTHER_PROGRAM]).toEqual({ Panel: TaxPanel, Create: TaxLaunch });
    expect(PRODUCT_PANELS[TEST_PROGRAM]).toBeUndefined();
  });

  it("puts a registered product's panel before the explanation and the forms, and its forms under Actions, on its program's markets", () => {
    const html = renderToStaticMarkup(<MarketLowBand market={market(TEST_PROGRAM, "4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c")} registry={registry} facts={facts} />);
    const [panel, explanation, actions, form, factsAt] = ["Test product panel for 4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c", ">Explanation<", ">Actions<", "Test product form", "The facts panel"].map((text) => html.indexOf(text)) as [number, number, number, number, number];
    expect(panel).toBeGreaterThan(-1);
    expect(panel).toBeLessThan(explanation);
    expect(explanation).toBeLessThan(actions);
    expect(form).toBeGreaterThan(actions);
    expect(form).toBeLessThan(factsAt);
  });

  it("shows nothing of it on another program's markets", () => {
    const html = renderToStaticMarkup(<MarketLowBand market={market(OTHER_PROGRAM, "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK")} registry={registry} facts={facts} />);
    expect(html).not.toContain("Test product");
    expect(html).toContain(">Actions<");
    expect(html).toContain("The facts panel");
  });
});
