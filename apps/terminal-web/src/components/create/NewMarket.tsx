"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Market } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { NEW_MARKET_ASK_EVERY_MS, NEW_MARKET_WAIT_MS } from "@/config";
import { ROUTES } from "@/routes";

/** The new market's page, linked once Aviary has read the market, or after the wait in any case. */
export function NewMarket({ market }: { market: string }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let stopped = false;
    const until = Date.now() + NEW_MARKET_WAIT_MS;
    const ask = async () => {
      while (!stopped && Date.now() < until) {
        try {
          await getFromApi(`/v1/markets/${market}`, Market);
          break;
        } catch {
          await new Promise((done) => setTimeout(done, NEW_MARKET_ASK_EVERY_MS));
        }
      }
      if (!stopped) setReady(true);
    };
    void ask();
    return () => {
      stopped = true;
    };
  }, [market]);
  return ready ? (
    <p>
      <Link href={ROUTES.market(market)}>Open the new market&apos;s page</Link>
    </p>
  ) : (
    <p>{BRAND.name} is reading the new market; its page is linked here as soon as it has.</p>
  );
}
