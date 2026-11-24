"use client";

// A strategy's markets (docs/spec/pipescope-screens.md, Strategy page, "Its markets"): the feed's
// table without the strategy column, newest first, loaded as the feed loads its rows.
import { useCallback, useState } from "react";
import { MarketsPage } from "terminal-api/contract";
import { ApiFailure, getFromApi } from "@/api";
import { FEED_ROWS_PER_LOAD } from "@/config";
import { formatInteger } from "@/format";
import { descriptionsOf } from "../Flags";
import { MarketsTable } from "../MarketsTable";
import { useLoad } from "../Panel";
import styles from "./Strategy.module.css";

const pageOf = (program: string, before?: string) =>
  `/v1/markets?strategy=${encodeURIComponent(program)}&limit=${FEED_ROWS_PER_LOAD}${before ? `&before=${encodeURIComponent(before)}` : ""}`;

export function StrategyMarkets({ program }: { program: string }) {
  const load = useCallback((signal: AbortSignal) => getFromApi(pageOf(program), MarketsPage, { signal }), [program]);
  const { state, retry } = useLoad(load);
  const [later, setLater] = useState<{ markets: MarketsPage["markets"]; next: string | null } | null>(null);
  const [more, setMore] = useState<{ status: "idle" | "loading" } | { status: "failed"; message: string }>({ status: "idle" });

  const next = later ? later.next : state.status === "loaded" ? state.data.next : null;
  const loadMore = useCallback(async () => {
    if (!next) return;
    setMore({ status: "loading" });
    try {
      const page = await getFromApi(pageOf(program, next), MarketsPage);
      setLater((had) => ({ markets: [...(had?.markets ?? []), ...page.markets], next: page.next }));
      setMore({ status: "idle" });
    } catch (e) {
      setMore({ status: "failed", message: e instanceof ApiFailure ? e.message : "Something went wrong on this page." });
    }
  }, [next, program]);

  return (
    <section className={styles.section} aria-labelledby="strategy-markets">
      <h2 id="strategy-markets" className={styles.title}>
        Its markets {state.status === "loaded" && <span className={styles.count}>{formatInteger(state.data.total)}</span>}
      </h2>
      {state.status === "loading" && <p className={styles.note}>Loading this strategy&apos;s markets…</p>}
      {state.status === "failed" && (
        <div className={styles.failed} role="alert">
          <p>Could not load this strategy&apos;s markets. {state.message}</p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {state.status === "loaded" &&
        (state.data.total === 0 ? (
          <p className={styles.note}>No market has been created from this strategy yet.</p>
        ) : (
          <>
            <MarketsTable markets={[...state.data.markets, ...(later?.markets ?? [])]} strategyColumn={false} flagDescriptions={descriptionsOf(state.data.flags_present)} />
            {next && (
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
          </>
        ))}
    </section>
  );
}
