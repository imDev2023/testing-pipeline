"use client";

// The containment the market page shows now (#76), shared by the containment panel, which reads it
// again as the chain moves, and the trade box, whose one-line rule before a buy follows the panel's
// latest read rather than the page's, which may have failed or gone stale since.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { MarketContainment } from "terminal-api/containment";

type Live = { shown: MarketContainment | null; publish: (read: MarketContainment) => void };

const LiveContainment = createContext<Live | null>(null);

/** Holds a market page's containment, from the page's own read until the panel reads it again. */
export function ContainmentLive({ initial, children }: { initial: MarketContainment | null; children: ReactNode }) {
  const [shown, publish] = useState(initial);
  const value = useMemo(() => ({ shown, publish }), [shown]);
  return <LiveContainment.Provider value={value}>{children}</LiveContainment.Provider>;
}

/** The page's containment now, and how the panel replaces it; null outside a market page. */
export const useLiveContainment = (): Live | null => useContext(LiveContainment);
