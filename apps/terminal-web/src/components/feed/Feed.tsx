"use client";

// The feed (docs/spec/pipescope-screens.md, Feed; PIPESCOPE-70): one table of markets, newest first,
// with strategies on a second tab, each tab with its count, under a head that says how many there
// are and that nothing is curated. The Canary column, the trust flags and the filters come with
// their tickets (#125, #119); strategy names with strategy metadata (#119), token names with #120.
// Live (docs/spec/pipescope-architecture.md, Live rooms): the feed's room sends each market new or
// changed; a new one joins the top, a changed one updates in place, and while the pointer or the
// focus is on the table new rows wait, so the row under it never moves.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarketsPage, StrategiesList, type LiveEvent, type Market, type Strategy } from "terminal-api/contract";
import { ApiFailure, getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { FEED_ROWS_PER_LOAD } from "@/config";
import { formatInteger } from "@/format";
import { placeMarkets } from "@/liveMerge";
import { LIVE_ROOMS, useLiveRoom } from "@/live";
import { ROUTES } from "@/routes";
import { Age, MarketsTable } from "../MarketsTable";
import { ShortAddress } from "../ShortAddress";
import table from "../ListingTable.module.css";
import styles from "./Feed.module.css";

export type FeedTab = "markets" | "strategies";

type Loaded = { markets: Market[]; total: number; next: string | null; strategies: Strategy[] };
type State = { status: "loading" } | { status: "failed"; message: string } | { status: "loaded"; data: Loaded };

const plural = (n: number, one: string, many: string) => `${formatInteger(n)} ${n === 1 ? one : many}`;
const failureOf = (e: unknown) => (e instanceof ApiFailure ? e.message : "Something went wrong on this page.");

export function Feed({ tab }: { tab: FeedTab }) {
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
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());

  /**
   * Markets from the room or a resync, put in place: a market shown updates where it is, a newer one
   * joins the top or, while the reader is on the table, waits; an older one not loaded yet stays for
   * its own page (placeMarkets).
   */
  const arrive = useCallback(
    (arriving: Market[]) => {
      const data = loaded.current;
      if (!data || !arriving.length) return;
      const { markets: placed, added } = placeMarkets([...heldNow.current, ...data.markets], arriving);
      const waiting = placed.slice(0, heldNow.current.length);
      const markets = placed.slice(heldNow.current.length);
      if (added.length) setFresh((before) => new Set([...before, ...added.map((m) => m.address)]));
      if (holding.current) {
        heldNow.current = [...added, ...waiting];
        setHeld(heldNow.current);
        show({ ...data, markets });
        return;
      }
      heldNow.current = waiting;
      show({ ...data, markets: [...added, ...markets], total: data.total + added.length });
    },
    [show],
  );

  const releaseHeld = useCallback(() => {
    holding.current = false;
    const waiting = heldNow.current;
    const data = loaded.current;
    heldNow.current = [];
    setHeld([]);
    if (waiting.length && data) show({ ...data, markets: [...waiting, ...data.markets], total: data.total + waiting.length });
  }, [show]);

  /** Whatever changed while the page was away from its room, or before it joined: the first page read again, and put in place. */
  const resync = useCallback(() => {
    if (!loaded.current) {
      resyncDue.current = true;
      return;
    }
    getFromApi(`/v1/markets?limit=${FEED_ROWS_PER_LOAD}`, MarketsPage).then(
      (page) => arrive(page.markets),
      () => {},
    );
  }, [arrive]);

  useLiveRoom(LIVE_ROOMS.feed, {
    onEvents: (events: LiveEvent[]) => {
      if (events.some((e) => e.type === "resync")) resync();
      arrive(events.flatMap((e) => (e.type === "market" ? [e.market] : [])));
    },
    onOpen: resync,
  });

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    loaded.current = null;
    Promise.all([getFromApi(`/v1/markets?limit=${FEED_ROWS_PER_LOAD}`, MarketsPage, { signal }), getFromApi("/v1/strategies", StrategiesList, { signal })]).then(
      ([page, { strategies }]) => {
        show({ markets: page.markets, total: page.total, next: page.next, strategies });
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
  }, [attempt, show, resync]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const loadMore = useCallback(async () => {
    const next = loaded.current?.next;
    if (!next) return;
    setMore({ status: "loading" });
    try {
      const page = await getFromApi(`/v1/markets?limit=${FEED_ROWS_PER_LOAD}&before=${encodeURIComponent(next)}`, MarketsPage);
      // Built on what the page shows now, live arrivals during the read included; a market already shown is not shown twice.
      const data = loaded.current!;
      const shown = new Set(data.markets.map((m) => m.address));
      show({ ...data, markets: [...data.markets, ...page.markets.filter((m) => !shown.has(m.address))], total: page.total, next: page.next });
      setMore({ status: "idle" });
    } catch (e) {
      setMore({ status: "failed", message: failureOf(e) });
    }
  }, [show]);

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
            <Link href={ROUTES.feed} aria-current={tab === "markets" ? "page" : undefined} className={styles.tab}>
              Markets <span className={styles.count}>{formatInteger(state.data.total)}</span>
            </Link>
            <Link href={ROUTES.feedStrategies} aria-current={tab === "strategies" ? "page" : undefined} className={styles.tab}>
              Strategies <span className={styles.count}>{formatInteger(state.data.strategies.length)}</span>
            </Link>
          </nav>
          {tab === "markets" ? (
            <section aria-label="Markets" className={styles.section}>
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
                <MarketsTable markets={state.data.markets} rowClass={(m) => (fresh.has(m.address) ? styles.fresh : undefined)} />
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
              <StrategiesTable strategies={state.data.strategies} />
            </section>
          )}
        </>
      )}
    </div>
  );
}

function StrategiesTable({ strategies }: { strategies: Strategy[] }) {
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
          </tr>
        </thead>
        <tbody>
          {strategies.map((s) => (
            <tr key={s.program} className={table.row}>
              <td className={table.main}>
                <Link href={ROUTES.strategy(s.program)} className={table.rowLink}>
                  <ShortAddress address={s.program} />
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
