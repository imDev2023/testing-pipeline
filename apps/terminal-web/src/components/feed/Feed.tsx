"use client";

// The feed (docs/spec/pipescope-screens.md, Feed; PIPESCOPE-70): one table of markets, newest first,
// with strategies on a second tab, each tab with its count, under a head that says how many there
// are and that nothing is curated. Above the markets, the four filters (PIPESCOPE-05, PIPESCOPE-72),
// kept in the page's address, with the line under them; each strategy named from its valid metadata
// in the author's style, and every row's trust flags. The Canary column comes with #125, token names
// with #120.
// Live (docs/spec/pipescope-architecture.md, Live rooms): the feed's room sends each market new or
// changed; a new one joins the top, a changed one updates in place, and while the pointer or the
// focus is on the table new rows wait, so the row under it never moves. While a filter is on, the
// room's news is read again through the API with the filters, so no row the filters leave out
// arrives.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarketsPage, StrategiesList, type FlagFact, type LiveEvent, type Market, type Strategy } from "terminal-api/contract";
import { ApiFailure, getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { FEED_ROWS_PER_LOAD } from "@/config";
import { apiQuery, describeFilters, filtersOn, NO_FILTERS, pageHref, type FeedFilters } from "@/feedFilters";
import { formatInteger } from "@/format";
import { placeMarkets } from "@/liveMerge";
import { LIVE_ROOMS, useLiveRoom } from "@/live";
import { ROUTES } from "@/routes";
import { descriptionsOf, FlagList } from "../Flags";
import { Age, MarketsTable } from "../MarketsTable";
import { ShortAddress } from "../ShortAddress";
import { StrategyName } from "../StrategyName";
import { FilterBar } from "./FilterBar";
import table from "../ListingTable.module.css";
import styles from "./Feed.module.css";

export type FeedTab = "markets" | "strategies";

type Loaded = {
  markets: Market[];
  /** Every market, and those the filters keep, and those with no SOL side. */
  total: number;
  matching: number;
  noSolSide: number;
  /** Every flag any market has, for "Hide markets with", and any strategy has, for the strategies' rows. */
  marketFlags: FlagFact[];
  strategyFlags: FlagFact[];
  next: string | null;
  strategies: Strategy[];
};
type State = { status: "loading" } | { status: "failed"; message: string } | { status: "loaded"; data: Loaded };

const plural = (n: number, one: string, many: string) => `${formatInteger(n)} ${n === 1 ? one : many}`;
const failureOf = (e: unknown) => (e instanceof ApiFailure ? e.message : "Something went wrong on this page.");

export function Feed({ tab, filters = NO_FILTERS }: { tab: FeedTab; filters?: FeedFilters }) {
  const router = useRouter();
  const query = apiQuery(filters);
  const filtered = filtersOn(filters);
  const marketsPath = `/v1/markets?limit=${FEED_ROWS_PER_LOAD}${query ? `&${query}` : ""}`;
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<{ status: "idle" | "loading" } | { status: "failed"; message: string }>({ status: "idle" });

  // What the page shows, kept in step with every change as it is made, so live arrivals, a resync and
  // a further page each build on the latest and none overwrites another.
  const loaded = useRef<Loaded | null>(null);
  const show = useCallback((data: Loaded) => {
    loaded.current = data;
    setState({ status: "loaded", data });
  }, []);
  /** The room opened before the first page arrived: what changed in between is read once it has. */
  const resyncDue = useRef(false);

  // ---- Live ----
  const holding = useRef(false);
  const [held, setHeld] = useState<Market[]>([]);
  const heldNow = useRef<Market[]>([]);
  /** How many of the held markets the counts shown do not include yet: those the room sent, not those a resync's counts already hold. */
  const heldUncounted = useRef(0);
  /** A filtered resync's first page that arrived while the reader was on the table, put in place once they leave it. */
  const pendingPage = useRef<MarketsPage | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  /** The markets path the page shows now: an answer to an earlier one (the filters changed while it was on its way) is dropped. */
  const pathNow = useRef(marketsPath);

  /**
   * Markets from the room or a resync, put in place: a market shown updates where it is, a newer one
   * joins the top or, while the reader is on the table, waits; an older one not loaded yet stays for
   * its own page (placeMarkets). `counted` says the counts shown already include them, as a
   * resync's, which come from the API, do.
   */
  const arrive = useCallback(
    (arriving: Market[], { counted }: { counted: boolean }) => {
      const data = loaded.current;
      if (!data || !arriving.length) return;
      const { markets: placed, added } = placeMarkets([...heldNow.current, ...data.markets], arriving);
      const waiting = placed.slice(0, heldNow.current.length);
      const markets = placed.slice(heldNow.current.length);
      if (added.length) setFresh((before) => new Set([...before, ...added.map((m) => m.address)]));
      const more = counted ? 0 : added.length;
      if (holding.current) {
        heldNow.current = [...added, ...waiting];
        heldUncounted.current += more;
        setHeld(heldNow.current);
        show({ ...data, markets });
        return;
      }
      heldNow.current = waiting;
      show({ ...data, markets: [...added, ...markets], total: data.total + more, matching: data.matching + more });
    },
    [show],
  );

  /** A filtered resync's first page in place of the rows shown, with the API's counts: a market the filters no longer keep goes. */
  const replaceFirstPage = useCallback(
    (page: MarketsPage) => {
      const data = loaded.current;
      if (!data) return;
      const shown = new Set(data.markets.map((m) => m.address));
      const added = page.markets.filter((m) => !shown.has(m.address));
      if (added.length) setFresh((before) => new Set([...before, ...added.map((m) => m.address)]));
      show({ ...data, markets: page.markets, next: page.next, total: page.total, matching: page.matching, noSolSide: page.no_sol_side, marketFlags: page.flags_present });
    },
    [show],
  );

  const releaseHeld = useCallback(() => {
    holding.current = false;
    const waiting = heldNow.current;
    const uncounted = heldUncounted.current;
    const pending = pendingPage.current;
    heldNow.current = [];
    heldUncounted.current = 0;
    pendingPage.current = null;
    setHeld([]);
    if (pending) return replaceFirstPage(pending);
    const data = loaded.current;
    if (waiting.length && data) show({ ...data, markets: [...waiting, ...data.markets], total: data.total + uncounted, matching: data.matching + uncounted });
  }, [show, replaceFirstPage]);

  /**
   * Whatever changed while the page was away from its room, or before it joined, or (with a filter
   * on) whatever the room said changed: the first page read again. Unfiltered, it is put in place;
   * filtered, it replaces the rows shown, so a market the filters no longer keep goes. Either way the
   * API's counts are then the ones shown.
   */
  const resync = useCallback(() => {
    if (!loaded.current) {
      resyncDue.current = true;
      return;
    }
    const path = marketsPath;
    getFromApi(path, MarketsPage).then(
      (page) => {
        if (pathNow.current !== path || !loaded.current) return;
        if (filtered) {
          if (holding.current) pendingPage.current = page;
          else replaceFirstPage(page);
          return;
        }
        arrive(page.markets, { counted: true });
        heldUncounted.current = 0;
        const data = loaded.current;
        show({ ...data, total: page.total, matching: page.matching, noSolSide: page.no_sol_side, marketFlags: page.flags_present });
      },
      () => {},
    );
  }, [arrive, marketsPath, show, filtered, replaceFirstPage]);

  useLiveRoom(LIVE_ROOMS.feed, {
    onEvents: (events: LiveEvent[]) => {
      // With a filter on, a market the room sends may be one the filters leave out, or one they no longer keep: read the page again.
      if (filtered || events.some((e) => e.type === "resync")) return resync();
      arrive(
        events.flatMap((e) => (e.type === "market" ? [e.market] : [])),
        { counted: false },
      );
    },
    onOpen: resync,
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    loaded.current = null;
    pathNow.current = marketsPath;
    heldNow.current = [];
    heldUncounted.current = 0;
    pendingPage.current = null;
    Promise.all([getFromApi(marketsPath, MarketsPage, { signal }), getFromApi("/v1/strategies", StrategiesList, { signal })]).then(
      ([page, list]) => {
        // Markets held for the filters before belong to no list now.
        setHeld([]);
        show({
          markets: page.markets,
          total: page.total,
          matching: page.matching,
          noSolSide: page.no_sol_side,
          marketFlags: page.flags_present,
          strategyFlags: list.flags_present,
          next: page.next,
          strategies: list.strategies,
        });
        if (resyncDue.current) {
          resyncDue.current = false;
          resync();
        }
      },
      (e: unknown) => {
        if (!signal.aborted) setState({ status: "failed", message: failureOf(e) });
      },
    );
    return () => controller.abort();
  }, [attempt, show, resync, marketsPath]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const loadMore = useCallback(async () => {
    const next = loaded.current?.next;
    if (!next) return;
    const path = marketsPath;
    setMore({ status: "loading" });
    try {
      const page = await getFromApi(`${path}&before=${encodeURIComponent(next)}`, MarketsPage);
      // An answer for filters no longer shown belongs to no list on the page now.
      const data = loaded.current;
      if (pathNow.current !== path || !data) return setMore({ status: "idle" });
      // Built on what the page shows now, live arrivals during the read included; a market already shown is not shown twice.
      const shown = new Set(data.markets.map((m) => m.address));
      show({ ...data, markets: [...data.markets, ...page.markets.filter((m) => !shown.has(m.address))], total: page.total, matching: page.matching, noSolSide: page.no_sol_side, next: page.next });
      setMore({ status: "idle" });
    } catch (e) {
      if (pathNow.current === path) setMore({ status: "failed", message: failureOf(e) });
    }
  }, [show, marketsPath]);

  /** Each change of a filter is a new address, so the feed can be linked as it is shown. */
  const choose = useCallback((next: FeedFilters) => router.replace(pageHref(next), { scroll: false }), [router]);

  return (
    <div className={styles.feed}>
      <header className={styles.head}>
        <h1>New on Pipeline</h1>
        {state.status === "loaded" && (
          <p className={styles.lede}>
            {plural(state.data.total, "market", "markets")} on {plural(state.data.strategies.length, "strategy", "strategies")}, newest first. Anyone can register a
            strategy and Pipeline vets none of them, so every one is listed here with what {BRAND.name} read and measured.
          </p>
        )}
      </header>

      {state.status === "loading" && <p className={styles.note}>Loading the markets and strategies…</p>}
      {state.status === "failed" && (
        <div className={styles.failed} role="alert">
          <p>Could not load the markets and strategies. {state.message}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {state.status === "loaded" && (
        <>
          <nav className={styles.tabs} aria-label="Show">
            <Link href={pageHref(filters)} aria-current={tab === "markets" ? "page" : undefined} className={styles.tab}>
              Markets <span className={styles.count}>{formatInteger(state.data.total)}</span>
            </Link>
            <Link href={pageHref(filters, "strategies")} aria-current={tab === "strategies" ? "page" : undefined} className={styles.tab}>
              Strategies <span className={styles.count}>{formatInteger(state.data.strategies.length)}</span>
            </Link>
          </nav>
          {tab === "markets" ? (
            <section aria-label="Markets" className={styles.section}>
              <FilterBar filters={filters} flags={state.data.marketFlags} onChange={choose} />
              <FilterLine filters={filters} data={state.data} />
              {held.length > 0 && (
                <p>
                  <button type="button" onClick={releaseHeld}>
                    Show {plural(held.length, "new market", "new markets")}
                  </button>
                </p>
              )}
              <div
                onPointerEnter={() => (holding.current = true)}
                onPointerLeave={releaseHeld}
                onFocus={() => (holding.current = true)}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) releaseHeld();
                }}
              >
                {state.data.markets.length === 0 && filtered ? (
                  <p className={styles.empty}>No market matches these filters. Loosen one, or clear them all.</p>
                ) : (
                  <MarketsTable markets={state.data.markets} flagDescriptions={descriptionsOf(state.data.marketFlags)} rowClass={(m) => (fresh.has(m.address) ? styles.fresh : undefined)} />
                )}
              </div>
              {state.data.next && (
                <div className={styles.more}>
                  <button type="button" onClick={loadMore} disabled={more.status === "loading"}>
                    {more.status === "loading" ? "Loading more markets…" : `Show ${FEED_ROWS_PER_LOAD} more markets`}
                  </button>
                  {more.status === "failed" && (
                    <p role="alert" className={styles.note}>
                      Could not load more markets. {more.message}
                    </p>
                  )}
                </div>
              )}
            </section>
          ) : (
            <section aria-label="Strategies" className={styles.section}>
              <StrategiesTable strategies={state.data.strategies} flagDescriptions={descriptionsOf(state.data.strategyFlags)} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

/** The line under the filters: what is listed, a link that clears them, and the note on markets with no SOL side. */
function FilterLine({ filters, data }: { filters: FeedFilters; data: Loaded }) {
  const line = describeFilters(filters, { total: data.total, matching: data.matching, noSolSide: data.noSolSide });
  return (
    <p className={styles.line} aria-live="polite">
      {line.text}
      {line.solNote && <> {line.solNote}</>}
      {line.clear && (
        <>
          {" "}
          <Link href={pageHref(NO_FILTERS)} scroll={false}>
            Clear the filters
          </Link>
        </>
      )}
    </p>
  );
}

/** Who can upgrade a strategy's program, in a row. */
function upgradedBy(s: Strategy) {
  if (s.upgrade_authority) return <>Upgradeable by <ShortAddress address={s.upgrade_authority} /></>;
  if (s.flags.includes("frozen")) return "Frozen";
  if (s.flags.includes("program-missing")) return "No program deployed";
  return <span className={table.none}>Not read yet</span>;
}

function StrategiesTable({ strategies, flagDescriptions }: { strategies: Strategy[]; flagDescriptions: ReadonlyMap<string, string> }) {
  return (
    <div className={table.scroll}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col">Strategy</th>
            <th scope="col">Registered</th>
            <th scope="col" className={table.num}>
              Markets
            </th>
            <th scope="col">This version</th>
            <th scope="col">Trust flags</th>
          </tr>
        </thead>
        <tbody>
          {strategies.map((s) => (
            <tr key={s.program} className={table.row}>
              <td className={table.main}>
                <Link href={ROUTES.strategy(s.program)} className={table.rowLink}>
                  <StrategyName program={s.program} name={s.name} metadata={s.metadata.status} lines />
                </Link>
              </td>
              <td>
                <span className={table.label}>Registered</span>
                <Age iso={s.registered_at} />
              </td>
              <td className={table.num}>
                <span className={table.label}>Markets</span>
                {formatInteger(s.market_count)}
              </td>
              <td>
                <span className={table.label}>This version</span>
                {s.current_version ? `Slot ${formatInteger(s.current_version.deploy_slot)}` : <span className={table.none}>Not read yet</span>}
                <span className={table.sub}>{upgradedBy(s)}</span>
              </td>
              <td className={table.wide}>
                <span className={table.label}>Trust flags</span>
                <FlagList flags={s.flags} descriptions={flagDescriptions} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
