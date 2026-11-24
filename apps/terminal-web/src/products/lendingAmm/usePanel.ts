"use client";

// One read of a lending AMM market's panel, shared by its panel and its forms (#88), which the market
// page places apart (the panel above Actions, the forms under it): both read the same answer of
// `GET /v1/markets/{market}/lending-amm` for the connected wallet, and a confirmed action reads it
// again for both, so the figures and the forms never disagree.
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { LendingPanel } from "terminal-api/lending-amm";
import { ApiFailure, getFromApi } from "@/api";
import type { Loaded } from "@/components/Panel";

type Entry = { state: Loaded<LendingPanel>; listeners: Set<() => void>; controller: AbortController | null; users: number };
const entries = new Map<string, Entry>();

const keyOf = (market: string, wallet: string | null) => `${market}:${wallet ?? ""}`;

function entryOf(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { state: { status: "loading" }, listeners: new Set(), controller: null, users: 0 };
    entries.set(key, entry);
  }
  return entry;
}

function set(entry: Entry, state: Loaded<LendingPanel>) {
  entry.state = state;
  for (const listener of entry.listeners) listener();
}

/** Reads the panel again for every component showing this market and wallet. */
function load(market: string, wallet: string | null, { quiet }: { quiet: boolean }) {
  const entry = entryOf(keyOf(market, wallet));
  entry.controller?.abort();
  const controller = new AbortController();
  entry.controller = controller;
  // A refresh keeps the figures on screen until the new ones arrive; only the first read shows loading.
  if (!quiet || entry.state.status !== "loaded") set(entry, { status: "loading" });
  getFromApi(`/v1/markets/${market}/lending-amm${wallet ? `?wallet=${wallet}` : ""}`, LendingPanel, { signal: controller.signal }).then(
    (data) => !controller.signal.aborted && set(entry, { status: "loaded", data }),
    (e: unknown) => !controller.signal.aborted && set(entry, { status: "failed", message: e instanceof ApiFailure ? e.message : "Something went wrong on this page." }),
  );
}

const LOADING: Loaded<LendingPanel> = { status: "loading" };

/** The market's panel for the connected wallet: its read, `retry` after a failure, and `refresh` after an action. */
export function useLendingPanel(market: string, wallet: string | null) {
  const key = keyOf(market, wallet);
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryOf(key);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    [key],
  );
  const state = useSyncExternalStore(subscribe, () => entryOf(key).state, () => LOADING);
  useEffect(() => {
    const entry = entryOf(key);
    entry.users++;
    if (entry.users === 1) load(market, wallet, { quiet: false });
    return () => {
      entry.users--;
      if (entry.users === 0) {
        entry.controller?.abort();
        entries.delete(key);
      }
    };
  }, [key, market, wallet]);
  return {
    state,
    retry: useCallback(() => load(market, wallet, { quiet: false }), [market, wallet]),
    refresh: useCallback(() => load(market, wallet, { quiet: true }), [market, wallet]),
  };
}
