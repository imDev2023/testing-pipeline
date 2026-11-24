// The lending AMM's items in the explainer's evidence (docs/spec/lending-pool.md, "Aviary's panel";
// docs/spec/pipescope-explainer.md, Inputs; #88): the panel's facts for the sampled market, read at
// one slot by the same reading and the same view as the panel, and the three risks the spec names
// for every lending AMM market. They are F items: chain facts and fixed text Aviary keeps, never
// author text, and none of them is a verdict.
import { address, createSolanaRpc } from "@solana/kit";
import { eq } from "drizzle-orm";
import { markets, type Db } from "terminal-db";
import type { Fact } from "terminal-explainer";
import { AVIARY_MINT_NAMES } from "../../config";
import { mintFacts } from "../../facts";
import { readLending } from "./read";
import type { LendingView } from "./view";

const GROUP = "Lending AMM";

/** The risks of every lending AMM market, as docs/spec/lending-pool.md, "Aviary's panel", states them. */
export const LENDING_RISKS: readonly Fact[] = [
  {
    group: GROUP,
    label: "Risk: Kamino can stop redeems",
    value: "Kamino's lending market owner and emergency council can stop redeems from the reserve, as they did on Kamino's ETH reserve for about 16 hours from 2026-04-23; while they are stopped, sells larger than the market's buffer fail and LPs can leave only in kind, taking Kamino's cTokens.",
    source: "docs/spec/lending-pool.md, \"When Kamino can't pay\"",
  },
  {
    group: GROUP,
    label: "Risk: LPs bear Kamino's losses",
    value: "LPs bear any loss Kamino writes off on the reserve, pro rata through the value of their shares, with no insurance fund; bad debt Kamino has not written off yet still counts as borrowed, so the supply rate and the lent value do not show it.",
    source: "docs/spec/lending-pool.md, \"Kamino's losses fall on LPs\"",
  },
  {
    group: GROUP,
    label: "Risk: large sells can fail",
    value: "A sell that pays out more of the lent mint than the buffer plus what Kamino can pay right now fails; what Kamino can pay is its freely available liquidity and what remains of its withdrawal cap, each less 0.1%, at most the market's own lent value.",
    source: "docs/spec/lending-pool.md, \"Redeeming the shortfall\"",
  },
];

/** A u64 amount in whole tokens, with no grouping and no trailing zeros. */
export function units(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const value = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${value / scale}${fraction ? `.${fraction}` : ""}`;
}

const bps = (value: number) => `${(value / 100).toFixed(2)}%`;
const yesNo = (on: boolean | null, what: string) => (on === null ? `${what}: not read` : `${what}: ${on ? "on" : "off"}`);

export type FactNames = { lent: string; lentDecimals: number; other: string; otherDecimals: number };

/** The panel's facts of one market, in words the validator can check against the figures. */
export function lendingFacts(market: string, view: LendingView, names: FactNames): Fact[] {
  const source = `the market state ${view.marketState}, Kamino's reserve, its lending market and the LP mint, read at slot ${view.slot}`;
  const lent = (raw: bigint) => `${units(raw, names.lentDecimals)} ${names.lent}`;
  const other = (raw: bigint) => `${units(raw, names.otherDecimals)} ${names.other}`;
  const { kamino: k, sells, lp } = view;
  const facts: Fact[] = [];
  facts.push({
    group: GROUP,
    label: "Lent side",
    value: `On market ${market}, ${names.lent} (${view.lentMint}) is lent to Kamino reserve ${view.state.reserve}${view.lendingMarket ? ` in lending market ${view.lendingMarket}` : ""}; the other mint, ${view.otherMint}, is never lent.`,
    source,
  });
  facts.push({
    group: GROUP,
    label: "Buffer and lent value",
    value:
      view.lentValue === null
        ? `The buffer holds ${lent(view.buffer)}; the lent value cannot be read: ${k.problem ?? "Kamino's reserve could not be read"}.`
        : `The buffer holds ${lent(view.buffer)} and the market's cTokens are worth ${lent(view.lentValue)} at Kamino's stored rate, ${view.bufferShareBps === null ? "no share" : bps(view.bufferShareBps)} of the lent side in the buffer, against a band of ${bps(view.bandBps.min)} to ${bps(view.bandBps.max)} with a target of ${bps(view.bandBps.target)}. Withdraw mode is ${view.state.withdrawMode ? "on" : "off"}.`,
    source,
  });
  const sellWords =
    sells.refused === "market-closed"
      ? "No sell trades: the market has no liquidity yet."
      : sells.refused === "reserve-unreadable"
        ? "No sell trades: the program refuses to read Kamino's reserve."
        : sells.refused === "reserve-stale"
          ? `No sell trades until someone refreshes Kamino's reserve: its last refresh is ${k.refreshAgeSlots} slots old, beyond the 9000 slots quotes and swaps accept.`
          : `The largest sell the buffer pays alone is ${sells.bufferPaysAll ? "every sell the market can take" : sells.bufferAlone === null ? "none" : other(sells.bufferAlone)}, and a larger one redeems its shortfall from Kamino; with what Kamino can pay right now (${lent(k.canPay)}) on top, ${sells.withKaminoPaysAll ? "every sell the market can take is paid" : sells.withKamino === null ? "no sell is paid" : `the largest sell paid is ${other(sells.withKamino)}, and a larger one fails`}.`;
  facts.push({ group: GROUP, label: "Largest sells", value: sellWords, source });
  facts.push({
    group: GROUP,
    label: "Kamino reserve",
    value: k.problem
      ? k.problem
      : `Utilisation ${k.utilisationBps === null ? "not read" : bps(k.utilisationBps)}; freely available liquidity ${k.freeLiquidity === null ? "not read" : lent(k.freeLiquidity)}; supply rate ${k.supplyRateBps === null ? "not read" : `${bps(k.supplyRateBps)} a year`} at its stored state; ${yesNo(k.reserveEmergency, "reserve emergency mode")}; ${yesNo(k.lendingMarketEmergency, "lending market emergency mode")}; ${yesNo(k.blockCtokenUsage, "block_ctoken_usage")}; ${k.deprecated ? "deprecated after a total write-off" : "not deprecated"}; last refreshed ${k.refreshAgeSlots} slots before this read.`,
    source,
  });
  facts.push({
    group: GROUP,
    label: "LP shares and yield",
    value: `LP fee ${view.state.lpFeeBps} bps, kept in the market for its LPs. One LP share is worth ${lp.valueOther === null ? "nothing yet" : other(lp.valueOther)} and ${lp.valueLent === null ? "an unknown amount of the lent side" : lent(lp.valueLent)}. ${units(lp.locked, 9)} shares are locked in the market's lock account, besides the ${lp.minimumLiquidity} base units the first deposit locked for good. The market's lending yield so far is ${view.yieldSoFar === null ? "not known" : lent(view.yieldSoFar)} (its cTokens' value plus what it redeemed, less what it deposited).`,
    source,
  });
  return facts;
}

/**
 * The lending AMM's items for a version's evidence: the sampled market's panel facts, read now at one
 * slot, then the three risks; the risks alone when there is no market, or when the chain cannot be read.
 */
export async function lendingEvidence(db: Db, representative: string | null, rpcUrl: string | undefined): Promise<Fact[]> {
  if (!representative) return [...LENDING_RISKS];
  const [row] = await db.select({ state: markets.marketState }).from(markets).where(eq(markets.address, representative));
  const unread = (why: string): Fact[] => [{ group: GROUP, label: "Lending AMM panel of the sampled market", value: `Not read: ${why}.`, source: "Aviary's read of the market state and Kamino's reserve" }, ...LENDING_RISKS];
  if (!row || !rpcUrl) return unread("Aviary had no RPC to read it with when this evidence was built");
  try {
    const { view } = await readLending(createSolanaRpc(rpcUrl), address(row.state), null);
    const decimals = new Map((await mintFacts(db, representative)).map((m) => [m.mint, m.decimals]));
    const name = (mint: string) => AVIARY_MINT_NAMES[mint] ?? `token ${mint}`;
    const names: FactNames = { lent: name(view.lentMint), lentDecimals: decimals.get(view.lentMint) ?? 0, other: name(view.otherMint), otherDecimals: decimals.get(view.otherMint) ?? 0 };
    return [...lendingFacts(representative, view, names), ...LENDING_RISKS];
  } catch (e) {
    console.error(`reading the lending AMM market ${representative} for its evidence failed`, e);
    return unread("the chain did not answer when this evidence was built");
  }
}
