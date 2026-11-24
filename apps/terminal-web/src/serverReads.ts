// Reads the address pages make on the server, so an address that is no market or strategy gets the
// "nothing there" page with a 404 (PIPESCOPE-101). Each is cached for the request, so the page and
// its title read the API once.
import { notFound } from "next/navigation";
import { cache } from "react";
import { CanaryResults, CanaryRollup, Market, StrategyDetail, StrategyExplanation } from "terminal-api/contract";
import { ApiFailure, getFromApi } from "./api";

/** The thing at an address, the 404 page when the API knows none, or the failure to show. */
async function readOrNotFound<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 404) notFound();
    return { ok: false, message: e instanceof ApiFailure ? e.message : "Something went wrong on this page." };
  }
}

export const readMarket = cache((address: string) => readOrNotFound(() => getFromApi(`/v1/markets/${encodeURIComponent(address)}`, Market)));
export const readStrategy = cache((program: string) => readOrNotFound(() => getFromApi(`/v1/strategies/${encodeURIComponent(program)}`, StrategyDetail)));

/**
 * What Canary saw, read with the page so the trade box, the head and the facts panel agree from the
 * first paint (#125): a market's latest results, or a strategy version's roll-up. A failure is kept to
 * show where the results would be, never a 404 for the page.
 */
async function readOrFailure<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    return { ok: false, message: e instanceof ApiFailure ? e.message : "Something went wrong on this page." };
  }
}

export const readMarketCanary = cache((address: string) => readOrFailure(() => getFromApi(`/v1/markets/${encodeURIComponent(address)}/canary`, CanaryResults)));
export const readVersionCanary = cache((program: string, deploySlot: number) => readOrFailure(() => getFromApi(`/v1/strategies/${encodeURIComponent(program)}/versions/${deploySlot}/canary`, CanaryRollup)));

/**
 * The explanation of a strategy's current version (#127), read with the page so the upgrade notice
 * under the head knows whether the new version has one; on a failure the panel loads it on its own.
 */
export const readStrategyExplanation = cache((program: string) => readOrFailure(() => getFromApi(`/v1/strategies/${encodeURIComponent(program)}/explanation`, StrategyExplanation)));
