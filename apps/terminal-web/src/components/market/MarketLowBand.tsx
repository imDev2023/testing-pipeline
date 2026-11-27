import type { ReactNode } from "react";
import type { Market, StrategyExplanation } from "terminal-api/contract";
import { ContainmentPanel, type ContainmentRead } from "@/products/containment/ContainmentPanel";
import { PRODUCT_PANELS, type ProductRegistry } from "@/products/registry";
import { Explanation } from "../explanation/Explanation";
import { Actions } from "../forms/Actions";
import bands from "./Market.module.css";

/**
 * The market page's lower band (docs/spec/pipescope-screens.md, Market page): on the left a product's
 * panel when the market's strategy is one of ours (PIPESCOPE-147), the containment panel first on a
 * contained token's home market (#76), then the strategy version's
 * explanation (#127) and the strategy's forms under Actions, with the product's own forms after them; on the right the facts
 * panel. At one column the left side comes first, so the order is trades, panel, explanation,
 * actions, facts.
 */
export function MarketLowBand({
  market,
  facts,
  explanation,
  containment = null,
  registry = PRODUCT_PANELS,
}: {
  market: Market;
  facts: ReactNode;
  /** The strategy's explanation as the page read it; without it, the panel loads it on its own. */
  explanation?: { ok: true; value: StrategyExplanation } | { ok: false; message: string };
  /** The containment of a market that can be a contained token's home market, a tax AMM market, as the page read it (#76); null for any other. */
  containment?: ContainmentRead | null;
  registry?: ProductRegistry;
}) {
  const product = registry[market.strategy];
  return (
    <div className={`${bands.low} ${bands.withForms}`}>
      <div className={bands.lowMain}>
        {containment && <ContainmentPanel market={market} initial={containment} />}
        {product?.Panel && <product.Panel market={market} />}
        <Explanation program={market.strategy} onMarket read={explanation} />
        <Actions market={market} productForms={product?.Forms ? <product.Forms market={market} /> : null} replaced={product?.replaces} />
      </div>
      {facts}
    </div>
  );
}
