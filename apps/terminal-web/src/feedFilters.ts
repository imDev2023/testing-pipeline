// The feed's four filters (docs/spec/pipescope-screens.md, Feed, "Filters"; PIPESCOPE-05,
// PIPESCOPE-72): liquidity and volume in the last 24 hours, each at least one of the screens' config
// steps in SOL, the time since creation, and the trust flags to hide. They live in the page's
// address, so a filtered feed can be linked and reopens as it was; a value that is not one of the
// steps, or a flag Pipeline does not name, is ignored without a word.
import { FLAGS } from "@pipeline-sol/sdk";
import { FEED_FILTERS } from "./config";
import { formatInteger } from "./format";
import { ROUTES } from "./routes";

export type FeedFilters = { liquidity: number | null; volume: number | null; created: number | null; hide: string[] };

export const NO_FILTERS: FeedFilters = { liquidity: null, volume: null, created: null, hide: [] };

const LAMPORTS_PER_SOL = 1_000_000_000;

/** A creation step in hours as the address writes it: "1h", "24h", or "7d" for a whole number of days past a day. */
export const createdLabel = (hours: number) => (hours > 24 && hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`);

function step(raw: string | undefined, steps: number[], label: (n: number) => string = String): number | null {
  return steps.find((s) => label(s) === raw) ?? null;
}

/** The filters a page's address names. */
export function filtersFrom(params: Record<string, string | string[] | undefined>): FeedFilters {
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const named = new Set((one("hide") ?? "").split(","));
  return {
    liquidity: step(one("liquidity"), FEED_FILTERS.liquiditySol),
    volume: step(one("volume"), FEED_FILTERS.volume24hSol),
    created: step(one("created"), FEED_FILTERS.createdWithinHours, createdLabel),
    hide: [...named].filter((flag) => (FLAGS as string[]).includes(flag)),
  };
}

export const filtersOn = (f: FeedFilters) => f.liquidity !== null || f.volume !== null || f.created !== null || f.hide.length > 0;

/** The feed's address with these filters, on the tab named. */
export function pageHref(f: FeedFilters, tab: "markets" | "strategies" = "markets"): string {
  const params = new URLSearchParams();
  if (tab === "strategies") params.set("tab", "strategies");
  if (f.liquidity !== null) params.set("liquidity", String(f.liquidity));
  if (f.volume !== null) params.set("volume", String(f.volume));
  if (f.created !== null) params.set("created", createdLabel(f.created));
  if (f.hide.length) params.set("hide", f.hide.join(","));
  const query = params.toString();
  return query ? `${ROUTES.feed}?${query}` : ROUTES.feed;
}

/** SOL as whole lamports, exactly, for a step such as 0.1. */
const lamports = (sol: number) => String(Math.round(sol * LAMPORTS_PER_SOL));

/** The filters as `GET /v1/markets` takes them: lamports and seconds. */
export function apiQuery(f: FeedFilters): string {
  const params = new URLSearchParams();
  if (f.liquidity !== null) params.set("min_sol_liquidity", lamports(f.liquidity));
  if (f.volume !== null) params.set("min_sol_volume_24h", lamports(f.volume));
  if (f.created !== null) params.set("created_within", String(f.created * 3600));
  if (f.hide.length) params.set("hide", f.hide.join(","));
  return params.toString();
}

const markets = (n: number) => `${formatInteger(n)} ${n === 1 ? "market" : "markets"}`;

/** The line under the filters: what is listed, whether to offer to clear them, and the note on markets with no SOL side. */
export function describeFilters(f: FeedFilters, counts: { total: number; matching: number; noSolSide: number }): { text: string; clear: boolean; solNote: string | null } {
  if (!filtersOn(f)) return { text: `All ${markets(counts.total)} are listed. Nothing is curated or hidden.`, clear: false, solNote: null };
  const onSol = f.liquidity !== null || f.volume !== null;
  return {
    text: `Showing ${formatInteger(counts.matching)} of ${markets(counts.total)}.`,
    clear: true,
    solNote: onSol && counts.noSolSide > 0 ? `The ${markets(counts.noSolSide)} with no SOL side ${counts.noSolSide === 1 ? "is" : "are"} left out while a liquidity or volume filter is on.` : null,
  };
}
