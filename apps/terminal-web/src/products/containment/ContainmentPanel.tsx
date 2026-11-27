"use client";

// The containment panel on a contained token's home market page (docs/spec/containment-hook.md, "In
// Aviary"; #76), above the tax panel: that the token is contained, with the rule in one line; the tax
// collected against the unlock goal, as a number and a bar; the unlock deadline and the time left; the
// Unlock button once the unlock is due; who receives the tax and whether that can change, since a
// sole recipient can reach the goal for a fraction of its cost (`HOOK-49`); the supply held outside
// the pool (`HOOK-50`); weak terms (H049); what containment cannot see (`HOOK-48`); a mint's group
// extensions (`HOOK-11`); and once unlocked, when and by which of the two. The hook is not a strategy,
// so the panel is Aviary's own, read through `GET /v1/markets/{market}/containment` at one slot, set
// plainly in the theme's colours with no green or red, and read again as the chain moves.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { MarketContainment, type ContainedMint } from "terminal-api/containment";
import type { Market, MarketMint } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { CONTAINMENT_REFRESH_MS } from "@/config";
import { formatDate, formatInteger } from "@/format";
import { FactList, FactPart } from "@/components/facts/Facts";
import { FACTS_STALE_EVENT } from "@/components/facts/MarketFacts";
import { TokenAmount } from "@/components/MarketsTable";
import { MintLabel } from "@/components/MintLabel";
import { PanelFrame, type Loaded } from "@/components/Panel";
import { ShortAddress } from "@/components/ShortAddress";
import { aboutSlots } from "../taxAmm/TaxPanel";
import { Unlock } from "./Unlock";
import { CONTAINED_RULE, goalShare, timeLeft } from "./view";
import styles from "./Containment.module.css";

export type ContainmentRead = { ok: true; value: MarketContainment } | { ok: false; message: string };

const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
const listed = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/**
 * The panel, from the page's own read and then its own: read again every `CONTAINMENT_REFRESH_MS`, as
 * the deadline passes and after an unlock lands. A market with no contained token shows nothing.
 */
export function ContainmentPanel({ market, initial }: { market: Market; initial: ContainmentRead }) {
  const router = useRouter();
  const [state, setState] = useState<Loaded<MarketContainment>>(initial.ok ? { status: "loaded", data: initial.value } : { status: "failed", message: initial.message });
  const asked = useRef(0);
  const load = useCallback((): Promise<unknown> => {
    const mine = ++asked.current;
    return getFromApi(`/v1/markets/${encodeURIComponent(market.address)}/containment`, MarketContainment).then(
      (data) => mine === asked.current && setState({ status: "loaded", data }),
      // A failed reading again keeps what is shown; only a panel with nothing to show shows the failure.
      (e: unknown) => mine === asked.current && setState((now) => (now.status === "loaded" ? now : { status: "failed", message: e instanceof Error ? e.message : String(e) })),
    );
  }, [market.address]);

  const shown = state.status === "loaded" ? state.data : null;
  const contained = shown?.contained.some((m) => m.status === "contained") ?? false;
  useEffect(() => {
    if (!contained) return;
    const every = setInterval(() => void load(), CONTAINMENT_REFRESH_MS);
    return () => clearInterval(every);
  }, [contained, load]);
  // Read again a second after the earliest deadline still ahead, so the Unlock button appears when it falls due.
  const nextDeadline = shown?.contained.filter((m) => m.status === "contained" && m.deadline > shown.chain_time).reduce<number | null>((at, m) => (at === null || m.deadline < at ? m.deadline : at), null) ?? null;
  useEffect(() => {
    if (nextDeadline === null || !shown) return;
    const wait = setTimeout(() => void load(), (nextDeadline - shown.chain_time + 1) * 1000);
    return () => clearTimeout(wait);
  }, [nextDeadline, shown, load]);

  const unlocked = useCallback(() => {
    // The API reads the unlocked mint again before it answers, so the facts panel's trust flags follow once it has; the trade box's rule follows with the page.
    void load().finally(() => {
      window.dispatchEvent(new Event(FACTS_STALE_EVENT));
      router.refresh();
    });
  }, [load, router]);

  if (shown && shown.contained.length === 0) return null;
  return (
    <PanelFrame title="Containment" what="whether this market's token is contained" state={state} retry={() => void load()}>
      {(read) => read.contained.map((entry) => <ContainmentPanelBody key={entry.mint} market={market} read={read} entry={entry} onUnlocked={unlocked} />)}
    </PanelFrame>
  );
}

export function ContainmentPanelBody({ market, read, entry, onUnlocked }: { market: Market; read: MarketContainment; entry: ContainedMint; onUnlocked: () => void }) {
  const mintOf = (address: string): MarketMint | null => market.mints.find((m) => m.mint === address) ?? null;
  const token = mintOf(entry.mint);
  const quote = mintOf(entry.quote_mint);
  const quoteName = quote?.symbol ?? quote?.token?.symbol ?? "quote";
  const amount = (raw: string, mint: MarketMint | null, address: string) => (
    <span data-raw={raw}>
      <TokenAmount raw={raw} decimals={mint?.decimals ?? null} mint={address} symbol={mint?.symbol ?? null} token={mint?.token ?? null} />
    </span>
  );
  const share = goalShare(entry);
  const deadline = new Date(entry.deadline * 1000);
  const isContained = entry.status === "contained";

  return (
    <div className={styles.panel}>
      {isContained ? (
        <p className={styles.state}>
          <strong className={styles.label}>Contained</strong> {CONTAINED_RULE}
        </p>
      ) : (
        <p className={styles.state}>
          <strong className={styles.label}>Unlocked</strong> on {formatDate(new Date(entry.unlocked_at! * 1000))}
          {entry.unlocked_by === "goal" ? ", by reaching its goal." : entry.unlocked_by === "deadline" ? ", by its deadline." : "; whether by its goal or its deadline could not be read."}{" "}
          It is now an ordinary Token-2022 token, tradable anywhere that accepts it: its transfer hook is cleared, so no transfer calls it again.
        </p>
      )}

      <FactPart title={isContained ? "The unlock" : "The unlock's terms"}>
        <FactList
          facts={[
            {
              name: "Tax collected",
              value:
                entry.collected === null ? (
                  <>Not read: the market&apos;s state cannot be read as the tax AMM&apos;s, so only the deadline can unlock it.</>
                ) : (
                  <span className={styles.goal}>
                    <span>
                      {amount(entry.collected, quote, entry.quote_mint)} of the goal of {amount(entry.goal, quote, entry.quote_mint)}, {share}%
                    </span>
                    <span className={styles.track} role="progressbar" aria-label="Tax collected against the goal" aria-valuemin={0} aria-valuemax={100} aria-valuenow={share ?? 0}>
                      <span className={styles.fill} style={{ width: `${share ?? 0}%` }} />
                    </span>
                  </span>
                ),
            },
            {
              name: "Unlock deadline",
              value: (
                <>
                  <time dateTime={deadline.toISOString()}>{formatDate(deadline)}</time>
                  {isContained && <>, {timeLeft(entry.deadline, read.chain_time)}</>}
                </>
              ),
            },
          ]}
        />
        {isContained && entry.due && (
          <div className={styles.due}>
            <p>
              The unlock is due: {entry.due === "goal" ? "the goal is reached." : "the deadline has passed."} Anyone may send the unlock from their own wallet; it frees the token for good.
            </p>
            <Unlock market={market} mint={entry.mint} onUnlocked={onUnlocked} />
          </div>
        )}
      </FactPart>

      {isContained && entry.tax && (
        <FactPart title="Who could reach the goal cheaply">
          <FactList
            facts={[
              {
                name: "Tax goes to",
                value: (
                  <span className={styles.recipients}>
                    {entry.tax.recipients.map((r, i) => (
                      <span key={r.wallet}>
                        <ShortAddress address={r.wallet} />
                        {r.launcher ? ", the launcher" : ""}, {percent(r.of_tax_bps)}
                        {i === 0 ? " of every tax" : ""};{" "}
                      </span>
                    ))}
                    {entry.tax.burn_of_tax_bps > 0 && <span>burned, {percent(entry.tax.burn_of_tax_bps)}; </span>}
                    <span>the suite share, {percent(entry.tax.suite_of_tax_bps)}</span>
                  </span>
                ),
              },
              {
                name: "Tax authority",
                value:
                  entry.tax.authority.kind === "address" ? (
                    <>
                      <ShortAddress address={entry.tax.authority.address} />
                      {entry.tax.authority.launcher ? ", the launcher" : ""}: may change the rates inside their ranges and the tax recipients, or renounce.
                    </>
                  ) : entry.tax.authority.kind === "renounced" ? (
                    "Renounced: the rates and the tax recipients can never change again."
                  ) : (
                    "None: the rates and the tax recipients never change."
                  ),
              },
              entry.tax.pending && {
                name: "Changing",
                value: (
                  <>
                    To {percent(entry.tax.pending.buy_bps)} buy and {percent(entry.tax.pending.sell_bps)} sell from slot {formatInteger(entry.tax.pending.from_slot)}, in {aboutSlots(BigInt(entry.tax.pending.from_slot - read.slot))}.
                  </>
                ),
              },
            ]}
          />
          <p className={styles.note}>Whoever receives the tax gets most of it back, so they can reach the goal for a fraction of what it costs anyone else. The goal holds the token against others, not against them.</p>
        </FactPart>
      )}

      {isContained && entry.supply && (
        <FactPart title="Supply">
          <FactList
            facts={[
              {
                name: "Outside the pool",
                value: (
                  <>
                    {amount(entry.supply.outside, token, entry.mint)}, {supplyShare(entry.supply.outside, entry.supply.total)} of the supply. Its holders can sell it into the {amount(entry.supply.quote_in_pool, quote, entry.quote_mint)} buyers paid
                    into the pool.
                  </>
                ),
              },
            ]}
          />
        </FactPart>
      )}

      {isContained && (entry.weak.goal || entry.weak.deadline) && (
        <div className={styles.warning} role="note">
          <strong className={styles.label}>Weak terms</strong>
          {entry.weak.goal && (
            <p>
              The goal is under {percent(read.weak_terms.goal_of_quote_reserve_bps)} of the market&apos;s {quoteName} reserve, virtual reserve included, so forcing the unlock costs others little.
            </p>
          )}
          {entry.weak.deadline && <p>The deadline is less than {Math.round(read.weak_terms.deadline_min_seconds / 86_400)} days after the token was bound.</p>}
        </div>
      )}

      {(isContained || entry.group_extensions.length > 0) && (
      <ul className={styles.notes}>
        {isContained && <li>Containment watches token movements, not who controls a key: a program or smart wallet holding the token can change hands without a transfer.</li>}
        {entry.group_extensions.length > 0 && (
          <li>
            This mint carries Token-2022&apos;s {listed(entry.group_extensions.map(words))} {entry.group_extensions.length === 1 ? "extension" : "extensions"}, so after its unlock some venues may still not accept it.
          </li>
        )}
      </ul>
      )}

      <p className={styles.note}>
        Read from the chain at slot {formatInteger(read.slot)}. {token ? <MintLabel mint={token.mint} symbol={token.symbol} token={token.token} /> : "The token"} is bound to this market by Aviary&apos;s containment hook.
      </p>
    </div>
  );
}

/** A part of the supply in percent, to at most two decimal places: "20%". */
function supplyShare(part: string, total: string): string {
  const whole = BigInt(total);
  if (whole === 0n) return "0%";
  return `${Number((BigInt(part) * 10_000n) / whole) / 100}%`;
}
