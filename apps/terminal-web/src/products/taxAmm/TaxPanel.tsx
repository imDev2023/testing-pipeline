"use client";

// The tax panel on a tax market's page (docs/spec/tax-amm.md, "In Aviary"; #75), between the trades and
// the explanation (PIPESCOPE-147): the tax side, the buy tax and the sell tax with their fixed ranges
// and any change of rates waiting for its slot; the tax authority, or that there is none or that it
// renounced; where every tax goes, the suite share first; the tax collected and what each slot is owed,
// with a button per slot that sends its payout; and the real reserves and the virtual reserve beside
// what the vaults hold. All of it is read from the market state and its vaults at one slot through the
// API's one-slot read (PIPESCOPE-146), set plainly as Aviary's own reading of the chain, and read again
// after a payout lands.
import Link from "next/link";
import { useCallback, useState } from "react";
import { MarketKeeper, MarketRead, type Market, type MarketMint } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { SLOT_MS_ESTIMATE } from "@/config";
import { formatAge, formatInteger } from "@/format";
import { outcomeText, waitingReason } from "@/keeperText";
import { ROUTES } from "@/routes";
import { FactList, FactPart } from "@/components/facts/Facts";
import { TokenAmount } from "@/components/MarketsTable";
import { MintLabel } from "@/components/MintLabel";
import { PanelFrame, useLoad, type Loaded } from "@/components/Panel";
import { ShortAddress } from "@/components/ShortAddress";
import { taxPanelView, type PayableSlot, type TaxPanelView } from "./panel";
import { Payout } from "./Payout";
import { partName, SplitTable } from "./SplitTable";
import styles from "./TaxAmm.module.css";

const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** About how long `slots` slots take, in words: "about 1 minute 20 seconds". */
export function aboutSlots(slots: bigint): string {
  const seconds = Math.max(1, Math.round((Number(slots) * SLOT_MS_ESTIMATE) / 1000));
  const [m, s] = [Math.floor(seconds / 60), seconds % 60];
  const parts = [m && `${m} ${m === 1 ? "minute" : "minutes"}`, s && `${s} ${s === 1 ? "second" : "seconds"}`].filter(Boolean);
  return `about ${parts.join(" ")}`;
}

/**
 * A panel's load that can be read again quietly: `refresh` keeps what is shown until the new answer
 * comes, so a payout's confirmation stays on screen while the panel reads the market again.
 */
function useRefreshable<T>(load: (signal: AbortSignal) => Promise<T>): { state: Loaded<T>; retry: () => void; refresh: () => void } {
  const { state, retry } = useLoad(load);
  const [fresh, setFresh] = useState<{ load: typeof load; data: T } | null>(null);
  const refresh = useCallback(() => {
    load(new AbortController().signal).then(
      (data) => setFresh({ load, data }),
      () => undefined,
    );
  }, [load]);
  const shown: Loaded<T> = state.status === "loaded" && fresh?.load === load ? { status: "loaded", data: fresh.data } : state;
  return { state: shown, retry: () => (setFresh(null), retry()), refresh };
}

/** Reads the market's state, its vaults with it at one slot, and the keeper runner's records of its payouts. */
function useTaxReads(market: Market) {
  const vaults = market.mints.map((m) => m.vault).filter((v): v is string => v !== null);
  const named = vaults.join(",");
  const loadState = useCallback((signal: AbortSignal) => getFromApi(`/v1/markets/${market.address}/state${named ? `?accounts=${named}` : ""}`, MarketRead, { signal }), [market.address, named]);
  const loadKeeper = useCallback((signal: AbortSignal) => getFromApi(`/v1/markets/${market.address}/keeper`, MarketKeeper, { signal }), [market.address]);
  return { state: useRefreshable(loadState), keeper: useRefreshable(loadKeeper), vaults };
}

export function TaxPanel({ market }: { market: Market }) {
  const { state, keeper, vaults } = useTaxReads(market);
  const reload = () => {
    state.refresh();
    keeper.refresh();
  };
  return (
    <PanelFrame title="Taxes" what="the market's state" state={state.state} retry={state.retry}>
      {(read) => {
        const named = (address: string | null) => (address ? (read.accounts.find((a) => a.address === address && a.role === "named")?.data ?? null) : null);
        const view = taxPanelView({ state: read.accounts[0]?.data ?? null, slot: read.slot, vaults: market.mints.map((m) => named(m.vault)) });
        if (!view) return <p className={styles.note}>This market&apos;s state is not a tax market&apos;s, so there are no taxes to show.</p>;
        return <TaxPanelBody market={market} view={view} slot={read.slot} keeper={keeper.state} vaultsRead={vaults.length > 0} onPaid={reload} />;
      }}
    </PanelFrame>
  );
}

export function TaxPanelBody({ market, view, slot, keeper, vaultsRead, onPaid }: { market: Market; view: TaxPanelView; slot: number; keeper: Loaded<MarketKeeper>; vaultsRead: boolean; onPaid: () => void }) {
  const mints = view.state.mints.map((address) => market.mints.find((m) => m.mint === address) ?? null);
  const taxMint = mints[view.taxSide];
  const amount = (raw: bigint, mint: MarketMint | null) => (mint ? <TokenAmount raw={String(raw)} decimals={mint.decimals} mint={mint.mint} symbol={mint.symbol} token={mint.token} /> : formatInteger(raw));
  const label = (mint: MarketMint | null) => (mint ? <MintLabel mint={mint.mint} symbol={mint.symbol} token={mint.token} /> : "its mint");
  const taxName = taxMint?.symbol ?? taxMint?.token?.symbol ?? "the tax side";

  return (
    <div className={styles.panel}>
      <p className={styles.note}>Read from the market&apos;s state at slot {formatInteger(slot)}. Every tax here is taken outside the price, which stays the market&apos;s.</p>

      <FactPart title="Rates">
        <FactList
          facts={[
            { name: "Taxed in", value: <>{label(taxMint ?? null)}, whichever way a trade goes</> },
            { name: "Buy tax", value: <Rate bps={view.rates.buy} range={view.rates.buyRange} what={`taken when ${taxName} is paid in`} /> },
            { name: "Sell tax", value: <Rate bps={view.rates.sell} range={view.rates.sellRange} what={`taken when ${taxName} is paid out`} /> },
            view.pending && {
              name: "Changing",
              value: (
                <>
                  To {percent(view.pending.buy)} buy and {percent(view.pending.sell)} sell from slot {formatInteger(view.pending.fromSlot)}, in {aboutSlots(view.pending.slotsLeft)}; until then the rates above apply.
                </>
              ),
            },
            {
              name: "Tax authority",
              value:
                view.authority.kind === "address" ? (
                  <>
                    <ShortAddress address={view.authority.address} />
                    <span className={styles.sub}>May change the rates inside their ranges and the tax recipients, or renounce.</span>
                  </>
                ) : view.authority.kind === "renounced" ? (
                  "Renounced: the rates and the tax recipients can never change again."
                ) : (
                  "None: the market was created without one, so its rates and tax recipients never change."
                ),
            },
          ]}
        />
      </FactPart>

      <FactPart title="Where every tax goes">
        <SplitTable split={view.split} caption="Where every tax of this market goes" />
      </FactPart>

      <FactPart title="Collected and owed">
        <FactList
          facts={[
            { name: "Collected so far", value: amount(view.collected, taxMint ?? null) },
            { name: "Owed, not yet paid out", value: amount(view.owedTotal, taxMint ?? null) },
          ]}
        />
        <p className={styles.note}>
          Tax waits in the market&apos;s vault until someone pays it out. Anyone may pay a slot out, at any time, and the <Link href={ROUTES.keeper}>keeper runner</Link> pays them on its own.
        </p>
        <ul className={styles.slots} aria-label="Each slot's payout">
          {view.slots.map((slot) => (
            <li key={slot.slot} className={styles.slot}>
              <SlotLine slot={slot} owed={amount(slot.owed, taxMint ?? null)} keeper={keeper} />
              <Payout market={market} slot={slot} taxMint={taxMint ?? null} onPaid={onPaid} />
            </li>
          ))}
        </ul>
      </FactPart>

      <FactPart title="Liquidity">
        <FactList
          facts={[
            { name: "Real reserves", value: <span className={styles.lines}>{view.reserves.map((r, i) => <span key={i}>{amount(r, mints[i] ?? null)}</span>)}</span> },
            {
              name: "Virtual reserve",
              value: view.virtual ? (
                <>
                  {amount(view.virtual.amount, mints[view.virtual.side] ?? null)}
                  <span className={styles.sub}>Priced as if the market held it, never paid out.</span>
                </>
              ) : (
                "None"
              ),
            },
            vaultsRead && {
              name: "The vaults hold",
              value: (
                <>
                  <span className={styles.lines}>{view.vaults.map((v, i) => <span key={i}>{v === null ? "Not read" : amount(v, mints[i] ?? null)}</span>)}</span>
                  <span className={styles.sub}>The tax owed waits in the {taxName} vault beside the reserve, and anything sent to a vault outside a trade stays there, so {`Aviary's`} liquidity for this market is its real reserves.</span>
                </>
              ),
            },
          ]}
        />
      </FactPart>
    </div>
  );
}

function Rate({ bps, range, what }: { bps: number; range: [number, number]; what: string }) {
  return (
    <>
      {percent(bps)}, fixed between {percent(range[0])} and {percent(range[1])}
      <span className={styles.sub}>{what[0]!.toUpperCase() + what.slice(1)}.</span>
    </>
  );
}

/** A slot's name, who it pays, what it is owed and what the keeper runner last did about it. */
function SlotLine({ slot, owed, keeper }: { slot: PayableSlot; owed: React.ReactNode; keeper: Loaded<MarketKeeper> }) {
  const recorded = keeper.status === "loaded" ? keeper.data.jobs.find((j) => j.job === "distribute" && j.slot === slot.slot) : undefined;
  return (
    <div className={styles.slotLine}>
      <span className={styles.slotName}>{partName(slot)}</span>
      <span className={styles.slotWho}>{slot.who === "burn" ? "Burned" : <ShortAddress address={slot.wallet!} />}</span>
      <span className={styles.slotOwed}>Owed {owed}</span>
      <span className={styles.slotKeeper}>
        {keeper.status === "failed"
          ? "The keeper runner's records could not be read."
          : keeper.status === "loading"
            ? "Reading the keeper runner's records…"
            : recorded
              ? recorded.outcome === "held" || recorded.outcome === "parked"
                ? `The keeper runner: ${waitingReason(recorded)}, ${formatAge(new Date(recorded.at))}.`
                : `The keeper runner: ${outcomeText(recorded)}, ${formatAge(new Date(recorded.at))}.`
              : "The keeper runner has recorded no payout of it yet."}
      </span>
    </div>
  );
}
