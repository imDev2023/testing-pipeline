// The feed's filters in the page's address (docs/spec/pipescope-screens.md, Feed, "Filters";
// PIPESCOPE-72): each one of the screens' config steps, read back from the address exactly as
// written, so a filtered feed's link reopens the same filters, and turned into the API's query in
// lamports and seconds; the line under them, with its counts.
import { describe, expect, it } from "vitest";
import { FEED_FILTERS } from "../src/config";
import { apiQuery, describeFilters, filtersFrom, filtersOn, NO_FILTERS, pageHref } from "../src/feedFilters";

describe("filters in the address", () => {
  it("start off, so the default feed lists everything", () => {
    expect(filtersFrom({})).toEqual(NO_FILTERS);
    expect(filtersOn(NO_FILTERS)).toBe(false);
    expect(pageHref(NO_FILTERS)).toBe("/");
  });

  it("reopen exactly the filters a link was made with", () => {
    const filters = { liquidity: 1, volume: 0.01, created: 24, hide: ["freeze-authority", "upgradeable"] };
    const href = pageHref(filters);
    expect(href).toBe("/?liquidity=1&volume=0.01&created=24h&hide=freeze-authority%2Cupgradeable");
    expect(filtersFrom(Object.fromEntries(new URL(href, "https://aviary.trade").searchParams))).toEqual(filters);
  });

  it("offer only the screens' config steps, ignoring any other value without a word", () => {
    expect(FEED_FILTERS).toEqual({ liquiditySol: [0.1, 1, 10], volume24hSol: [0.01, 0.1, 1], createdWithinHours: [1, 24, 168] });
    expect(filtersFrom({ liquidity: "2", volume: "abc", created: "5h", hide: "not-a-flag,,upgradeable" })).toEqual({ ...NO_FILTERS, hide: ["upgradeable"] });
    expect(filtersFrom({ created: "7d" }).created).toBe(168);
    expect(filtersFrom({ created: "1h" }).created).toBe(1);
  });

  it("keep the tab beside them", () => {
    expect(pageHref({ ...NO_FILTERS, liquidity: 10 }, "strategies")).toBe("/?tab=strategies&liquidity=10");
  });
});

describe("the API's query", () => {
  it("is in lamports and seconds, each SOL step exact", () => {
    expect(apiQuery({ liquidity: 0.1, volume: 0.01, created: 168, hide: ["mint-authority", "metadata-invalid"] })).toBe(
      "min_sol_liquidity=100000000&min_sol_volume_24h=10000000&created_within=604800&hide=mint-authority%2Cmetadata-invalid",
    );
    expect(apiQuery(NO_FILTERS)).toBe("");
  });
});

describe("the line under the filters", () => {
  it("says nothing is curated with none on", () => {
    expect(describeFilters(NO_FILTERS, { total: 61, matching: 61, noSolSide: 28 })).toEqual({ text: "All 61 markets are listed. Nothing is curated or hidden.", clear: false, solNote: null });
  });

  it("says how many it shows, offers to clear them, and names the markets with no SOL side while liquidity or volume is on", () => {
    expect(describeFilters({ ...NO_FILTERS, liquidity: 1 }, { total: 61, matching: 12, noSolSide: 28 })).toEqual({
      text: "Showing 12 of 61 markets.",
      clear: true,
      solNote: "The 28 markets with no SOL side are left out while a liquidity or volume filter is on.",
    });
    expect(describeFilters({ ...NO_FILTERS, hide: ["upgradeable"] }, { total: 1, matching: 1, noSolSide: 1 })).toEqual({ text: "Showing 1 of 1 market.", clear: true, solNote: null });
    expect(describeFilters({ ...NO_FILTERS, volume: 0.1 }, { total: 3, matching: 0, noSolSide: 1 }).solNote).toBe("The 1 market with no SOL side is left out while a liquidity or volume filter is on.");
  });
});
