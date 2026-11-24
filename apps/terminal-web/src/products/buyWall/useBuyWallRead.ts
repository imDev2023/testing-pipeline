"use client";

// One read of a buy wall market for its panel and its forms (#57): the market's state and its token's
// mint, at one slot, through the API's one-slot read (`GET /v1/markets/{market}/state`, PIPESCOPE-146),
// read again every BUY_WALL_REFRESH_MS, after the market's trades arrive in its live room, and when a
// form's transaction confirms (`refreshBuyWall`). The panel and the forms on one page share each read.
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { MarketRead, type Market } from "terminal-api/contract";
import { getFromApi } from "@/api";
import type { Loaded } from "@/components/Panel";
import { LIVE_ROOMS, useLiveRoom } from "@/live";
import { BUY_WALL_REFRESH_MS, BUY_WALL_TRADE_PAUSE_MS } from "./config";

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

/** The market's token: its one mint that is not wrapped SOL (docs/spec/pool4-for-solana.md, Shape). */
export const tokenOf = (market: Market) => market.mints.find((m) => m.mint !== WRAPPED_SOL)?.mint ?? market.base_mint;

type Entry = { state: Loaded<MarketRead>; listeners: Set<() => void>; reading: Promise<void> | null };
const entries = new Map<string, Entry>();

function entryOf(market: string): Entry {
  let entry = entries.get(market);
  if (!entry) {
    entry = { state: { status: "loading" }, listeners: new Set(), reading: null };
    entries.set(market, entry);
  }
  return entry;
}

/** Reads the market again, once for everyone on the page asking at the same moment. */
function read(market: Market): Promise<void> {
  const entry = entryOf(market.address);
  if (entry.reading) return entry.reading;
  const publish = (state: Loaded<MarketRead>) => {
    entry.state = state;
    for (const listener of entry.listeners) listener();
  };
  entry.reading = getFromApi(`/v1/markets/${encodeURIComponent(market.address)}/state?accounts=${tokenOf(market)}`, MarketRead)
    .then(
      (data) => publish({ status: "loaded", data }),
      // A read that fails after one that worked keeps what was shown; the next read may answer.
      (e: unknown) => {
        if (entry.state.status !== "loaded") publish({ status: "failed", message: e instanceof Error ? e.message : String(e) });
      },
    )
    .finally(() => {
      entry.reading = null;
    });
  return entry.reading;
}

const refreshers = new Map<string, () => void>();
/** Reads the market again for its panel and forms: after one of their transactions confirms. */
export function refreshBuyWall(market: string): void {
  refreshers.get(market)?.();
}

const LOADING: Loaded<MarketRead> = { status: "loading" };

/** The latest read of a buy wall market, with `now`, the time the allowance is brought up to, in Unix seconds. */
export function useBuyWallRead(market: Market): { state: Loaded<MarketRead>; retry: () => void; now: () => bigint } {
  const again = useCallback(() => void read(market), [market]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryOf(market.address);
      entry.listeners.add(listener);
      refreshers.set(market.address, again);
      return () => {
        entry.listeners.delete(listener);
        if (!entry.listeners.size) refreshers.delete(market.address);
      };
    },
    [market.address, again],
  );
  const state = useSyncExternalStore(subscribe, () => entryOf(market.address).state, () => LOADING);

  // Read on arrival, then every BUY_WALL_REFRESH_MS while the page is in view.
  useEffect(() => {
    again();
    const timer = setInterval(() => document.visibilityState === "visible" && again(), BUY_WALL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [again]);

  // A trade changes the price, the cap and the ledgers: read again once a burst of trades has passed.
  const pause = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (pause.current && clearTimeout(pause.current)), []);
  useLiveRoom(LIVE_ROOMS.market(market.address), {
    onEvents: (events) => {
      if (!events.some((e) => e.type === "trade")) return;
      if (pause.current) clearTimeout(pause.current);
      pause.current = setTimeout(again, BUY_WALL_TRADE_PAUSE_MS);
    },
    onOpen: () => {},
  });

  return { state, retry: again, now: () => BigInt(Math.floor(Date.now() / 1000)) };
}
