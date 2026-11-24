"use client";

// The market page's top band (docs/spec/pipescope-screens.md, Market page: Chart and Trades), live:
// the market's room sends each swap as it is indexed, which joins Trades and moves the forming
// candle; a page that joins the room again resyncs through the API from the last trade it saw
// (docs/spec/pipescope-architecture.md, Live rooms). New rows arrive at the top, the row under the
// pointer never moves, and nothing flashes for a reader who asked for reduced motion.
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Candles, TradesPage, type Candle, type LiveEvent, type Market, type Trade } from "terminal-api/contract";
import { ApiFailure, getFromApi } from "@/api";
import { CHART_INTERVALS, CHART_OPENS_AT, LIVE_CANDLE_REFRESH_MS, TRADES_SHOWN } from "@/config";
import { formatAge, formatAmount, formatDate, formatInteger, formatPrice } from "@/format";
import { heldCount, holdArrivals, releaseHeld as released, takeResyncPage, type Held } from "@/heldTrades";
import { afterCursor, mergeCandles, mergeTrades, readTrade, sortArrivals } from "@/liveMerge";
import { LIVE_ROOMS, useLiveRoom } from "@/live";
import { ShortAddress, ShortSignature } from "../Address";
import { MintLabel } from "../MintLabel";
import type { Loaded } from "../Panel";
import table from "../ListingTable.module.css";
import { CandleChart } from "./CandleChart";
import { TradeBox } from "./TradeBox";
import { StrandedPanel, type CanaryRead } from "../canary/MarketCanary";
import styles from "./Market.module.css";

type Interval = (typeof CHART_INTERVALS)[number];
const isInterval = (value: string | null): value is Interval => CHART_INTERVALS.includes(value as Interval);
const failureOf = (e: unknown) => (e instanceof ApiFailure ? e.message : "Something went wrong on this page.");
const plural = (n: number, one: string, many: string) => `${formatInteger(n)} ${n === 1 ? one : many}`;

type TradesState = { list: Trade[]; next: string | null };
const NONE_HELD: Held = { trades: [], replaces: null };

export function MarketLive({ market, canary }: { market: Market; canary: CanaryRead }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const flipped = params.get("flip") === "1";
  const interval: Interval = isInterval(params.get("interval")) ? (params.get("interval") as Interval) : CHART_OPENS_AT;
  const pair = flipped ? { base: market.quote_mint, quote: market.base_mint } : { base: market.base_mint, quote: market.quote_mint };
  const mintOf = (address: string) => market.mints.find((m) => m.mint === address)!;
  const decimals = useMemo(() => Object.fromEntries(market.mints.map((m) => [m.mint, m.decimals])), [market.mints]);

  // The chart's length and Flip live in the page's address, so a chart can be linked as it is shown.
  const hrefWith = (change: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(change)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };

  // ---- Candles ----
  const candlesPath = `/v1/markets/${market.address}/candles?interval=${interval}&base=${pair.base}&quote=${pair.quote}`;
  // What was loaded, and for which length and pair: another one is loading until its answer arrives.
  const [candlesFor, setCandlesFor] = useState<{ path: string; state: Loaded<{ candles: Candle[]; tradeCount: number }> } | null>(null);
  const candles: Loaded<{ candles: Candle[]; tradeCount: number }> = candlesFor?.path === candlesPath ? candlesFor.state : { status: "loading" };
  const [candleAttempt, setCandleAttempt] = useState(0);
  const shownCandles = useRef<Candle[]>([]);
  const setCandles = useCallback((state: Loaded<{ candles: Candle[]; tradeCount: number }>) => setCandlesFor({ path: candlesPath, state }), [candlesPath]);
  useEffect(() => {
    const controller = new AbortController();
    shownCandles.current = [];
    getFromApi(candlesPath, Candles, { signal: controller.signal }).then(
      (answer) => {
        shownCandles.current = answer.candles;
        setCandles({ status: "loaded", data: { candles: answer.candles, tradeCount: answer.trade_count } });
      },
      (e: unknown) => !controller.signal.aborted && setCandles({ status: "failed", message: failureOf(e) }),
    );
    return () => controller.abort();
  }, [candlesPath, candleAttempt, setCandles]);

  /**
   * Reads the forming candle again (and any after it), at most once per LIVE_CANDLE_REFRESH_MS while
   * trades land. A read belongs to the length and pair it was asked for: when the reader picks
   * another length or flips the pair, a pending read is dropped and an answer still on its way is
   * thrown away, so one series is never mixed into another.
   */
  const showing = useRef(candlesPath);
  const refreshing = useRef<{ timer: ReturnType<typeof setTimeout> | null; last: number }>({ timer: null, last: 0 });
  useEffect(() => {
    showing.current = candlesPath;
    const state = refreshing.current;
    return () => {
      clearTimeout(state.timer ?? undefined);
      state.timer = null;
    };
  }, [candlesPath]);
  const refreshCandles = useCallback(() => {
    const state = refreshing.current;
    if (state.timer) return;
    const path = candlesPath;
    const run = async () => {
      state.timer = null;
      state.last = Date.now();
      const from = shownCandles.current.at(-1)?.start;
      try {
        const answer = await getFromApi(`${path}${from ? `&from=${Date.parse(from) / 1000}` : ""}`, Candles);
        if (showing.current !== path) return;
        shownCandles.current = mergeCandles(shownCandles.current, answer.candles);
        setCandlesFor({ path, state: { status: "loaded", data: { candles: shownCandles.current, tradeCount: answer.trade_count } } });
      } catch {
        // The next trade, or the next visit, reads it again.
      }
    };
    state.timer = setTimeout(run, Math.max(0, state.last + LIVE_CANDLE_REFRESH_MS - Date.now()));
  }, [candlesPath]);

  // ---- Trades ----
  const tradesPath = `/v1/markets/${market.address}/trades`;
  const [tradesFor, setTradesFor] = useState<{ path: string; state: Loaded<TradesState> } | null>(null);
  const trades: Loaded<TradesState> = tradesFor?.path === tradesPath ? tradesFor.state : { status: "loading" };
  const setTrades = useCallback((state: Loaded<TradesState>) => setTradesFor({ path: tradesPath, state }), [tradesPath]);
  const [tradesAttempt, setTradesAttempt] = useState(0);
  const [earlier, setEarlier] = useState<{ status: "idle" | "loading" } | { status: "failed"; message: string }>({ status: "idle" });
  /** Trades that arrived while the pointer or the focus was on the table, so no row moved under it (./heldTrades). */
  const [held, setHeld] = useState<Held>(NONE_HELD);
  const heldNow = useRef<Held>(NONE_HELD);
  const hold = useCallback((next: Held) => {
    heldNow.current = next;
    setHeld(next);
  }, []);
  const holding = useRef(false);
  /** Trades that arrived live, drawn with a brief wash for readers who allow motion. */
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const shownTrades = useRef<TradesState | null>(null);
  const resyncDue = useRef(false);

  const show = useCallback(
    (state: TradesState) => {
      shownTrades.current = state;
      setTrades({ status: "loaded", data: state });
    },
    [setTrades],
  );

  /** New trades, from the room or a resync: at the top, unless the reader is on the table, when they wait. */
  const arrive = useCallback(
    (arriving: Trade[]) => {
      const current = shownTrades.current;
      if (!current || !arriving.length) return;
      const { fresh: fresher, updates } = sortArrivals([...current.list, ...heldNow.current.trades], arriving);
      // The indexer's copy of a fast-path trade replaces its provisional row where it stands.
      if (updates.length) {
        hold(holdArrivals(heldNow.current, updates.filter((u) => heldNow.current.trades.some((h) => h.signature === u.signature && h.event_index === u.event_index))));
        show({ ...current, list: mergeTrades(current.list, updates.filter((u) => current.list.some((t) => t.signature === u.signature && t.event_index === u.event_index))) });
      }
      if (!fresher.length) return;
      const now = shownTrades.current!;
      setFresh((before) => new Set([...before, ...fresher.map((t) => `${t.signature}:${t.event_index}`)]));
      if (holding.current) hold(holdArrivals(heldNow.current, fresher));
      else show({ ...now, list: mergeTrades(now.list, fresher) });
    },
    [hold, show],
  );

  /**
   * Whatever landed since the newest trade shown, through the API; with more than a page of them, the
   * newest page replaces the list, once the reader leaves the table if they are on it.
   */
  const resync = useCallback(async () => {
    const current = shownTrades.current;
    if (!current) {
      resyncDue.current = true;
      return;
    }
    const after = afterCursor(mergeTrades(current.list, heldNow.current.trades));
    try {
      if (!after) {
        const page = await getFromApi(`${tradesPath}?limit=${TRADES_SHOWN}`, TradesPage);
        arrive(page.trades);
      } else {
        const page = await getFromApi(`${tradesPath}?limit=${TRADES_SHOWN}&after=${after}`, TradesPage);
        if (page.next) {
          const taken = takeResyncPage(shownTrades.current ?? current, heldNow.current, { trades: page.trades, next: page.next }, holding.current);
          hold(taken.held);
          if (taken.shown !== shownTrades.current) show(taken.shown);
        } else arrive(page.trades);
      }
    } catch {
      // The room's next connection resyncs again.
    }
    refreshCandles();
  }, [arrive, hold, refreshCandles, show, tradesPath]);

  useEffect(() => {
    const controller = new AbortController();
    shownTrades.current = null;
    getFromApi(`${tradesPath}?limit=${TRADES_SHOWN}`, TradesPage, { signal: controller.signal }).then(
      (page) => {
        show({ list: page.trades, next: page.next });
        // The room opened while this page was read: what landed in between is read now.
        if (resyncDue.current) {
          resyncDue.current = false;
          void resync();
        }
      },
      (e: unknown) => !controller.signal.aborted && setTrades({ status: "failed", message: failureOf(e) }),
    );
    return () => controller.abort();
    // The resync is read through its ref-held state; reloading on its identity would refetch on every arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tradesPath, tradesAttempt, show, setTrades]);

  const releaseHeld = useCallback(() => {
    holding.current = false;
    const waiting = heldNow.current;
    const current = shownTrades.current;
    hold(NONE_HELD);
    if (current) {
      const next = released(current, waiting);
      if (next !== current) show(next);
    }
  }, [hold, show]);

  const loadEarlier = async () => {
    const current = shownTrades.current;
    if (!current?.next) return;
    setEarlier({ status: "loading" });
    try {
      const page = await getFromApi(`${tradesPath}?limit=${TRADES_SHOWN}&before=${encodeURIComponent(current.next)}`, TradesPage);
      show({ list: mergeTrades(current.list, page.trades), next: page.next });
      setEarlier({ status: "idle" });
    } catch (e) {
      setEarlier({ status: "failed", message: failureOf(e) });
    }
  };

  useLiveRoom(LIVE_ROOMS.market(market.address), {
    onEvents: (events: LiveEvent[]) => {
      // More swaps landed at once than a room is sent: caught up through the API, as after a reconnection.
      if (events.some((e) => e.type === "resync")) return void resync();
      const arriving = events.flatMap((e) => (e.type === "trade" && e.trade.market === market.address ? [e.trade] : []));
      if (!arriving.length) return;
      arrive(arriving);
      refreshCandles();
    },
    onOpen: () => void resync(),
  });

  /** A trade the trade box sent, read back by the fast path: at the top of Trades now, replaced in place once the indexer has it. */
  const traded = useCallback(
    (arriving: Trade[]) => {
      arrive(arriving.filter((t) => t.market === market.address));
      refreshCandles();
    },
    [arrive, refreshCandles, market.address],
  );

  // ---- The chart's panel ----
  const baseMint = mintOf(pair.base);
  const quoteMint = mintOf(pair.quote);
  const last = candles.status === "loaded" ? candles.data.candles.at(-1) : undefined;

  return (
    <>
      <section className={`${styles.panel} ${styles.chartArea}`} aria-labelledby="panel-price">
        <h2 id="panel-price" className={styles.srOnly}>
          Price
        </h2>
        {candles.status === "loading" && <p className={styles.note}>Loading the chart…</p>}
        {candles.status === "failed" && (
          <div className={styles.failed} role="alert">
            <p>Could not load the chart. {candles.message}</p>
            <button
              type="button"
              onClick={() => {
                setCandles({ status: "loading" });
                setCandleAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}
        {candles.status === "loaded" && candles.data.candles.length === 0 && (
          <p className={styles.noTrades}>No swap has gone through Pipeline on this market yet, so there is no price to chart.</p>
        )}
        {candles.status === "loaded" && last && (
          <>
            <div className={styles.chartTop}>
              <p className={styles.price}>
                <span className={styles.priceValue}>{formatPrice(Number(last.close))}</span>{" "}
                <span className={styles.priceUnit}>
                  <MintLabel mint={quoteMint.mint} symbol={quoteMint.symbol} token={quoteMint.token} /> for one <MintLabel mint={baseMint.mint} symbol={baseMint.symbol} token={baseMint.token} />
                </span>{" "}
                <Link className={styles.flip} href={hrefWith({ flip: flipped ? null : "1" })} scroll={false} replace title="Show the price the other way round">
                  Flip
                </Link>
              </p>
              <div className={styles.lengths} role="group" aria-label="Candle length">
                {CHART_INTERVALS.map((length) => (
                  <button
                    key={length}
                    type="button"
                    aria-pressed={length === interval}
                    onClick={() => router.replace(hrefWith({ interval: length === CHART_OPENS_AT ? null : length }), { scroll: false })}
                  >
                    {length}
                  </button>
                ))}
              </div>
            </div>
            <CandleChart candles={candles.data.candles} />
            <p className={styles.note}>
              Built from Pipeline&apos;s swap events on this market: {plural(candles.data.tradeCount, "swap", "swaps")} so far. Prices are in the market&apos;s own mints; there
              are no dollar prices on devnet.
            </p>
          </>
        )}
      </section>

      {canary.ok && canary.value.summary?.stranded ? (
        // A stranded market has no trade box: its strategy's current version can give no quote and take no swap.
        <StrandedPanel market={market} canary={canary.value} />
      ) : market.mints.every((m) => m.decimals !== null) ? (
        <TradeBox market={market} canary={canary} onTraded={traded} />
      ) : (
        <p className={`${styles.panel} ${styles.tradeArea}`}>This market&apos;s mints have not been read yet, so it cannot be quoted. Try again in a minute.</p>
      )}

      <section className={styles.tradesArea} aria-labelledby="panel-trades" aria-busy={trades.status === "loading"}>
        <div className={styles.tradesHead}>
          <h2 id="panel-trades">Trades</h2>
          {heldCount(held).trades > 0 && (
            <button type="button" onClick={releaseHeld}>
              {heldCount(held).more ? `Show ${formatInteger(heldCount(held).trades)}+ new trades` : `Show ${plural(heldCount(held).trades, "new trade", "new trades")}`}
            </button>
          )}
        </div>
        {trades.status === "loading" && <p className={styles.note}>Loading this market&apos;s trades…</p>}
        {trades.status === "failed" && (
          <div className={styles.failed} role="alert">
            <p>Could not load this market&apos;s trades. {trades.message}</p>
            <button
              type="button"
              onClick={() => {
                setTrades({ status: "loading" });
                setTradesAttempt((n) => n + 1);
              }}
            >
              Try again
            </button>
          </div>
        )}
        {trades.status === "loaded" && trades.data.list.length === 0 && <p className={styles.note}>No swap has gone through Pipeline on this market yet.</p>}
        {trades.status === "loaded" && trades.data.list.length > 0 && (
          <>
            <div
              className={table.scroll}
              onPointerEnter={() => (holding.current = true)}
              onPointerLeave={releaseHeld}
              onFocus={() => (holding.current = true)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) releaseHeld();
              }}
            >
              <TradesTable trades={trades.data.list} pair={pair} decimals={decimals} symbols={market.mints} fresh={fresh} />
            </div>
            {trades.data.next && (
              <div className={styles.more}>
                <button type="button" onClick={loadEarlier} disabled={earlier.status === "loading"}>
                  {earlier.status === "loading" ? "Loading earlier trades…" : "Show earlier trades"}
                </button>
                {earlier.status === "failed" && (
                  <p role="alert" className={styles.note}>
                    Could not load earlier trades. {earlier.message}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}

function TradesTable({
  trades,
  pair,
  decimals,
  symbols,
  fresh,
}: {
  trades: Trade[];
  pair: { base: string; quote: string };
  decimals: Readonly<Record<string, number | null>>;
  symbols: Market["mints"];
  fresh: ReadonlySet<string>;
}) {
  const label = (mint: string) => {
    const named = symbols.find((m) => m.mint === mint);
    return <MintLabel mint={mint} symbol={named?.symbol ?? null} token={named?.token ?? null} />;
  };
  const amount = (value: number | null, mint: string) => (
    <span>
      {value === null ? "not read" : formatAmount(value)} {label(mint)}
    </span>
  );
  return (
    <table className={`${table.table} ${styles.trades}`}>
      <thead>
        <tr>
          <th scope="col">When</th>
          <th scope="col">Side</th>
          <th scope="col" className={table.num}>
            Paid
          </th>
          <th scope="col" className={table.num}>
            Received
          </th>
          <th scope="col" className={table.num}>
            Price
          </th>
          <th scope="col">Trader</th>
          <th scope="col">Transaction</th>
        </tr>
      </thead>
      <tbody>
        {trades.map((t) => {
          const read = readTrade(t, pair, decimals);
          const id = `${t.signature}:${t.event_index}`;
          return (
            <tr key={id} className={`${table.row} ${styles.tradeRow} ${fresh.has(id) ? styles.fresh : ""}`}>
              <td>
                <span className={table.label}>When</span>
                {t.block_time ? (
                  <time dateTime={t.block_time} title={formatDate(new Date(t.block_time))}>
                    {formatAge(new Date(t.block_time))}
                  </time>
                ) : (
                  <span className={table.none}>slot {formatInteger(t.slot)}</span>
                )}
              </td>
              <td className={styles.side}>
                <span className={table.label}>Side</span>
                {read.side}
              </td>
              <td className={table.num}>
                <span className={table.label}>Paid</span>
                {amount(read.paid.amount, read.paid.mint)}
              </td>
              <td className={table.num}>
                <span className={table.label}>Received</span>
                {amount(read.received.amount, read.received.mint)}
              </td>
              <td className={table.num}>
                <span className={table.label}>Price</span>
                {read.price === null ? <span className={table.none}>not read</span> : formatPrice(read.price)}
              </td>
              <td>
                <span className={table.label}>Trader</span>
                <ShortAddress address={t.trader} />
              </td>
              <td>
                <span className={table.label}>Transaction</span>
                <ShortSignature signature={t.signature} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
