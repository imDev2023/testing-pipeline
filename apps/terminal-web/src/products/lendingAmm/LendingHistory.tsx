"use client";

// A lending AMM market's history (docs/spec/lending-pool.md, "Custom actions and metadata"; #88): the
// strategy's own events on the market, newest first, each in a plain sentence with who it names and
// its transaction: liquidity added and removed, the lent side taken alone, shares locked, rebalances,
// withdraw mode entered and left, and a swap's redeem from Kamino.
import { useCallback, useState } from "react";
import type { Market, MarketMint } from "terminal-api/contract";
import { LendingHistory as History, type LendingEvent } from "terminal-api/lending-amm";
import { getFromApi } from "@/api";
import { ShortAddress, ShortSignature } from "@/components/Address";
import { PanelFrame, useLoad } from "@/components/Panel";
import { formatDate, formatTokenAmount } from "@/format";
import styles from "./LendingAmm.module.css";
import { Amount } from "./LendingPanel";

const LP_DECIMALS = 9;
const shares = (raw: string) => {
  const written = formatTokenAmount(BigInt(raw), LP_DECIMALS);
  return `${written} ${written === "1" ? "LP share" : "LP shares"}`;
};

/** The market's mints by mint index, as the events give amounts, and its lent mint. */
function mintsOf(market: Market, lentMint: string) {
  const blank = (mint: string): MarketMint => ({ mint, symbol: null, token: null, decimals: null, vault: null, liquidity: null, flags: null });
  return { byIndex: (i: number) => market.mints[i] ?? blank(`mint ${i}`), lent: market.mints.find((m) => m.mint === lentMint) ?? blank(lentMint) };
}

/** One event as a sentence. */
export function EventSentence({ market, lentMint, event }: { market: Market; lentMint: string; event: LendingEvent }) {
  const { byIndex, lent } = mintsOf(market, lentMint);
  const f = event.fields as Record<string, string | boolean | number | string[]>;
  const pair = (amounts: string[]) => (
    <>
      <Amount raw={amounts[0]!} mint={byIndex(0)} /> and <Amount raw={amounts[1]!} mint={byIndex(1)} />
    </>
  );
  switch (event.kind) {
    case "market-created":
      return <>Market created, with an LP fee of {Number(f.lp_fee_bps) / 100}%.</>;
    case "market-seeded":
      return <>Seeded by a launchpad with {pair(f.amounts as string[])}, for {shares(f.shares as string)}.</>;
    case "liquidity-added":
      return (
        <>
          {f.first ? "First deposit" : "Liquidity added"}: {pair(f.amounts as string[])}, for {shares(f.shares as string)}.
        </>
      );
    case "liquidity-removed":
      return (
        <>
          Liquidity removed {f.in_kind ? "in kind" : "in cash"}: {shares(f.shares as string)} for {pair(f.amounts as string[])}
          {f.in_kind && f.ctokens !== "0" ? <> and {formatTokenAmount(BigInt(f.ctokens as string), lent.decimals ?? 0)} cTokens</> : null}.
        </>
      );
    case "lent-side-removed":
      return (
        <>
          The lent side taken alone: {shares(f.shares as string)} for <Amount raw={f.lent as string} mint={lent} /> and {formatTokenAmount(BigInt(f.ctokens as string), lent.decimals ?? 0)} cTokens, leaving the other side in the market.
        </>
      );
    case "shares-locked":
      return <>{shares(f.amount as string)} locked, {shares(f.locked as string)} locked in all.</>;
    case "rebalanced":
      return (
        <>
          Rebalanced: {f.direction === "deposit" ? "deposited" : "redeemed"} <Amount raw={f.liquidity as string} mint={lent} /> {f.direction === "deposit" ? "into" : "from"} Kamino, leaving <Amount raw={f.buffer as string} mint={lent} /> in the buffer.
        </>
      );
    case "withdraw-mode-entered":
      return (
        <>
          Entered withdraw mode: Kamino had <Amount raw={f.free_liquidity as string} mint={lent} /> free against an exposure of <Amount raw={f.exposure as string} mint={lent} />.
        </>
      );
    case "withdraw-mode-left":
      return (
        <>
          Left withdraw mode: Kamino had <Amount raw={f.free_liquidity as string} mint={lent} /> free against an exposure of <Amount raw={f.exposure as string} mint={lent} />.
        </>
      );
    case "shortfall-redeemed":
      return (
        <>
          A sale beyond the buffer redeemed <Amount raw={f.liquidity as string} mint={lent} /> from Kamino for its shortfall of <Amount raw={f.shortfall as string} mint={lent} />.
        </>
      );
  }
}

/** The history panel, a page at a time, newest first. */
export function LendingHistory({ market, lentMint }: { market: Market; lentMint: string }) {
  const load = useCallback((signal: AbortSignal) => getFromApi(`/v1/markets/${market.address}/lending-amm/history`, History, { signal }), [market.address]);
  const { state, retry } = useLoad(load);
  return (
    <PanelFrame title="Lending AMM history" what="this market's history" state={state} retry={retry}>
      {(first) => <HistoryList market={market} lentMint={lentMint} first={first} />}
    </PanelFrame>
  );
}

export function HistoryList({ market, lentMint, first }: { market: Market; lentMint: string; first: History }) {
  const [pages, setPages] = useState<History[]>([first]);
  const [more, setMore] = useState<"idle" | "loading" | "failed">("idle");
  const events = pages.flatMap((p) => p.events);
  const next = pages.at(-1)?.next_before ?? null;
  const older = async () => {
    if (!next) return;
    setMore("loading");
    try {
      const page = await getFromApi(`/v1/markets/${market.address}/lending-amm/history?before=${next}`, History);
      setPages((all) => [...all, page]);
      setMore("idle");
    } catch {
      setMore("failed");
    }
  };
  if (!events.length) return <p className={styles.quiet}>Nothing yet: Aviary has seen none of the strategy&apos;s events on this market.</p>;
  return (
    <div className={styles.history}>
      <ol className={styles.events}>
        {events.map((event) => (
          <li key={`${event.signature}:${event.slot}:${event.kind}`} className={styles.event}>
            <span className={styles.when}>{event.block_time ? formatDate(new Date(event.block_time)) : `Slot ${event.slot}`}</span>
            <span className={styles.detail}>
              <span>
                <EventSentence market={market} lentMint={lentMint} event={event} />
              </span>
              <span className={styles.who}>
                {event.account && (
                  <>
                    by <ShortAddress address={event.account} />,{" "}
                  </>
                )}
                <ShortSignature signature={event.signature} />
              </span>
            </span>
          </li>
        ))}
      </ol>
      {next && (
        <div>
          <button type="button" onClick={older} disabled={more === "loading"}>
            {more === "loading" ? "Loading older events…" : "Show older events"}
          </button>
          {more === "failed" && <span className={styles.quiet}> Could not load them. Try again.</span>}
        </div>
      )}
    </div>
  );
}
