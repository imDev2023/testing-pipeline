import type { ReactNode } from "react";
import type { Market } from "terminal-api/contract";
import { PRODUCT_PANELS, type ProductRegistry } from "@/products/registry";
import { Actions } from "../forms/Actions";
import bands from "./Market.module.css";

/**
 * The market page's lower band (docs/spec/pipescope-screens.md, Market page): on the left a product's
 * panel when the market's strategy is one of ours (PIPESCOPE-147), then the explanation (#127) and the
 * strategy's forms under Actions, with the product's own forms after them; on the right the facts
 * panel. At one column the left side comes first, so the order is trades, panel, explanation,
 * actions, facts.
 */
export function MarketLowBand({ market, facts, registry = PRODUCT_PANELS }: { market: Market; facts: ReactNode; registry?: ProductRegistry }) {
  const product = registry[market.strategy];
  return (
    <div className={`${bands.low} ${bands.withForms}`}>
      <div className={bands.lowMain}>
        {product?.Panel && <product.Panel market={market} />}
        <Actions market={market} productForms={product?.Forms ? <product.Forms market={market} /> : null} />
      </div>
      {facts}
    </div>
  );
}
