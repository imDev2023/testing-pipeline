// The place each of our products hangs its panel in Aviary (docs/spec/README.md, Our products live
// inside Aviary; SUITE-15, PIPESCOPE-147): keyed by the product's strategy program, a product adds a
// panel, which the market page shows after the trades and before the explanation and the forms, and
// its own forms, which it shows under Actions with the strategy's others, on that program's markets
// and nowhere else. A panel is Aviary's own reading of the chain, so it is set plainly, takes its
// colours from the theme stylesheet and uses no green or red (docs/spec/pipescope-screens.md, For
// other tickets). It reads the chain through the API's one-slot read of a market's state with the
// outside accounts it names (`GET /v1/markets/{market}/state`, PIPESCOPE-146).
//
// Filled by the products' Aviary tickets: the lending AMM's (#88) and the buy wall AMM's (#57); the
// tax AMM's (#75) and the containment hook's (#76) add theirs.
import type { ComponentType } from "react";
import type { Market } from "terminal-api/contract";
import { BUY_WALL_AMM_PROGRAM_ADDRESS } from "terminal-api/products/buy-wall";
import { BuyWallCreate } from "./buyWall/BuyWallCreate";
import { BUY_WALL_FORMS, BuyWallForms } from "./buyWall/BuyWallForms";
import { BuyWallPanel } from "./buyWall/BuyWallPanel";
import { LendingAmmCreate } from "./lendingAmm/LendingCreate";
import { LENDING_FORMS, LendingAmmForms } from "./lendingAmm/LendingForms";
import { LendingAmmPanel } from "./lendingAmm/LendingPanel";
import { LENDING_AMM_PROGRAM } from "./lendingAmm/program";

/** What one product adds to its markets' pages. */
export type ProductPlace = {
  /** Its panel, between the trades and the explanation. */
  Panel?: ComponentType<{ market: Market }>;
  /** Its own forms, under Actions after the strategy's metadata forms. */
  Forms?: ComponentType<{ market: Market }>;
  /** The metadata forms its own forms fill in, which Actions then leaves out of the strategy's list. */
  replaces?: readonly string[];
  /** Its own create form on the create-market page, in place of the metadata's. */
  Create?: ComponentType<{ program: string }>;
};

/** The products by strategy program. */
export type ProductRegistry = Readonly<Record<string, ProductPlace>>;

export const PRODUCT_PANELS: ProductRegistry = {
  [LENDING_AMM_PROGRAM]: { Panel: LendingAmmPanel, Forms: LendingAmmForms, replaces: LENDING_FORMS, Create: LendingAmmCreate },
  [BUY_WALL_AMM_PROGRAM_ADDRESS]: { Panel: BuyWallPanel, Forms: BuyWallForms, replaces: BUY_WALL_FORMS, Create: BuyWallCreate },
};
