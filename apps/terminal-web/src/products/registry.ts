// The place each of our products hangs its panel in Aviary (docs/spec/README.md, Our products live
// inside Aviary; SUITE-15, PIPESCOPE-143): keyed by the product's strategy program, a product adds a
// panel, which the market page shows after the trades and before the explanation and the forms, and
// its own forms, which it shows under Actions with the strategy's others, on that program's markets
// and nowhere else. A panel is Aviary's own reading of the chain, so it is set plainly, takes its
// colours from the theme stylesheet and uses no green or red (docs/spec/pipescope-screens.md, For
// other tickets). It reads the chain through the API's one-slot read of a market's state with the
// outside accounts it names (`GET /v1/markets/{market}/state`, PIPESCOPE-142).
//
// Empty until the products' Aviary tickets fill it: the tax AMM's (#75), the containment hook's
// (#76), the buy wall AMM's (#57) and the lending AMM's (#88).
import type { ComponentType } from "react";
import type { Market } from "terminal-api/contract";

/** What one product adds to its markets' pages. */
export type ProductPlace = {
  /** Its panel, between the trades and the explanation. */
  Panel?: ComponentType<{ market: Market }>;
  /** Its own forms, under Actions after the strategy's metadata forms. */
  Forms?: ComponentType<{ market: Market }>;
};

/** The products by strategy program. */
export type ProductRegistry = Readonly<Record<string, ProductPlace>>;

export const PRODUCT_PANELS: ProductRegistry = {};
