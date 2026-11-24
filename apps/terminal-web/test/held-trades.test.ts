// New trades on the market page wait while the reader is on the table (PIPESCOPE-111), even when a
// resync brings more than a page of them, which then replaces the list only once the reader leaves
// it (#214).
import type { Trade } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { heldCount, holdArrivals, releaseHeld, takeResyncPage, type Held, type TradesShown } from "../src/heldTrades";

const SOL = "So11111111111111111111111111111111111111112";
const TOKEN = "4gqiCkoxxD72nbXGc7XtxQx4UjBHD3KiJyXpMvEZ6u8c";

const trade = (slot: number): Trade => ({
  signature: `sig-${slot}`,
  event_index: 0,
  slot,
  block_index: 0,
  block_time: "2026-11-23T12:12:38.000Z",
  market: "C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w",
  trader: "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt",
  input_mint: SOL,
  output_mint: TOKEN,
  mode: "exact_in",
  net_sent: "1000000",
  received: "241072692",
  pipeline_fee: "2500",
  fee_mint: SOL,
  integrator: null,
  integrator_fee: "0",
  quote_mint: SOL,
  base_mint: TOKEN,
  side: "buy",
});
const slots = (trades: readonly Trade[]) => trades.map((t) => t.slot);

const shown: TradesShown = { list: [trade(10), trade(9)], next: "9_0_0" };
const none: Held = { trades: [], replaces: null };
/** More trades landed than a page holds: the newest page, and the cursor to the rest. */
const fullPage = { trades: [trade(60), trade(59), trade(58)], next: "58_0_0" };

describe("a resync that brings a full page", () => {
  it("replaces the list at once when the reader is not on the table", () => {
    expect(takeResyncPage(shown, none, fullPage, false)).toEqual({ shown: { list: fullPage.trades, next: "58_0_0" }, held: none });
  });

  it("waits while the reader is on the table, leaving every row where it is, and replaces the list when they leave", () => {
    const { shown: still, held } = takeResyncPage(shown, holdArrivals(none, [trade(11)]), fullPage, true);
    expect(still).toBe(shown);
    expect(heldCount(held)).toEqual({ trades: 3, more: true });
    // A trade arriving after it waits with it.
    const later = holdArrivals(held, [trade(61)]);
    expect(releaseHeld(still, later)).toEqual({ list: [trade(61), ...fullPage.trades], next: "58_0_0" });
  });
});

describe("trades held while the reader is on the table", () => {
  it("join the top of the list when they leave it, keeping its cursor to earlier trades", () => {
    const held = holdArrivals(holdArrivals(none, [trade(12)]), [trade(11), trade(12)]);
    expect(heldCount(held)).toEqual({ trades: 2, more: false });
    const released = releaseHeld(shown, held);
    expect(slots(released.list)).toEqual([12, 11, 10, 9]);
    expect(released.next).toBe("9_0_0");
  });
});
