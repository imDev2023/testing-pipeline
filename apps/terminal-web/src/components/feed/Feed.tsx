"use client";

// The feed (docs/spec/pipescope-screens.md, Feed; PIPESCOPE-70): one table of markets, newest first,
// with strategies on a second tab, each tab with its count, under a head that says how many there
// are and that nothing is curated. The Canary column, the trust flags and the filters come with
// their tickets (#125, #119); strategy names with strategy metadata (#119), token names with #120.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { MarketsPage, StrategiesList, type Market, type Strategy } from "terminal-api/contract";
import { ApiFailure, getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { FEED_ROWS_PER_LOAD } from "@/config";
import { formatAge, formatDate, formatInteger, formatTokenAmount } from "@/format";
import { ROUTES } from "@/routes";
import { MintLabel } from "../MintLabel";
import { ShortAddress } from "../ShortAddress";
import table from "../Table.module.css";
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

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all([getFromApi(`/v1/markets?limit=${FEED_ROWS_PER_LOAD}`, MarketsPage, { signal }), getFromApi("/v1/strategies", StrategiesList, { signal })]).then(
      ([page, { strategies }]) => setState({ status: "loaded", data: { markets: page.markets, total: page.total, next: page.next, strategies } }),
      (e: unknown) => {
        if (!signal.aborted) setState({ status: "failed", message: failureOf(e) });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const loadMore = useCallback(async () => {
    if (state.status !== "loaded" || !state.data.next) return;
    setMore({ status: "loading" });
    try {
      const page = await getFromApi(`/v1/markets?limit=${FEED_ROWS_PER_LOAD}&before=${encodeURIComponent(state.data.next)}`, MarketsPage);
      setState({ status: "loaded", data: { ...state.data, markets: [...state.data.markets, ...page.markets], total: page.total, next: page.next } });
      setMore({ status: "idle" });
    } catch (e) {
      setMore({ status: "failed", message: failureOf(e) });
    }
  }, [state]);

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
              <MarketsTable markets={state.data.markets} />
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

/** The amount a vault or a volume holds, in its mint's tokens, or a word when the mint is not read. */
function TokenAmount({ raw, decimals, mint, symbol }: { raw: string | null; decimals: number | null; mint: string; symbol: string | null }) {
  return (
    <span>
      {raw === null || decimals === null ? "not read" : formatTokenAmount(BigInt(raw), decimals)} <MintLabel mint={mint} symbol={symbol} />
    </span>
  );
}

function Age({ iso }: { iso: string }) {
  const date = new Date(iso);
  return (
    <time dateTime={iso} title={formatDate(date)}>
      {formatAge(date)}
    </time>
  );
}

function MarketsTable({ markets }: { markets: Market[] }) {
  return (
    <div className={table.scroll}>
      <table className={table.table}>
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Strategy</th>
            <th scope="col">Created</th>
            <th scope="col" className={table.num}>
              Liquidity
            </th>
            <th scope="col" className={table.num}>
              Volume, 24h
            </th>
          </tr>
        </thead>
        <tbody>
          {markets.map((m) => {
            const base = m.mints.find((x) => x.mint === m.base_mint)!;
            const quote = m.mints.find((x) => x.mint === m.quote_mint)!;
            return (
              <tr key={m.address} className={table.row}>
                <td className={table.main}>
                  <Link href={ROUTES.market(m.address)} className={table.rowLink}>
                    <MintLabel mint={base.mint} symbol={base.symbol} /> / <MintLabel mint={quote.mint} symbol={quote.symbol} />
                  </Link>
                  <span className={table.sub}>
                    market <ShortAddress address={m.address} />
                  </span>
                </td>
                <td>
                  <span className={table.label}>Strategy</span>
                  <Link href={ROUTES.strategy(m.strategy)} className={table.inner}>
                    <ShortAddress address={m.strategy} />
                  </Link>
                </td>
                <td>
                  <span className={table.label}>Created</span>
                  <Age iso={m.created_at} />
                </td>
                <td className={table.num}>
                  <span className={table.label}>Liquidity</span>
                  <span className={table.lines}>
                    {m.mints.map((x) => (
                      <TokenAmount key={x.mint} raw={x.liquidity} decimals={x.decimals} mint={x.mint} symbol={x.symbol} />
                    ))}
                  </span>
                </td>
                <td className={table.num}>
                  <span className={table.label}>Volume, 24h</span>
                  {m.stats_24h.trades === 0 ? (
                    <span className={table.none}>none</span>
                  ) : (
                    <>
                      <TokenAmount raw={m.stats_24h.volume_quote} decimals={quote.decimals} mint={quote.mint} symbol={quote.symbol} />
                      <span className={table.sub}>{plural(m.stats_24h.trades, "trade", "trades")}</span>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
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
