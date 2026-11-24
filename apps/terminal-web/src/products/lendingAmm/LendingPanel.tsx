"use client";

// The lending AMM's panel on its markets' pages (docs/spec/lending-pool.md, "Aviary's panel"; #88):
// Aviary's own reading of the market state and Kamino's reserve at one slot, set plainly, as Aviary
// shows anyone's strategy. Every figure is the API's, worked out with the program's own rules; the
// panel only names and formats them, and says nothing of whether the market is good or bad.
import type { Market, MarketMint } from "terminal-api/contract";
import type { LendingPanel as Panel } from "terminal-api/lending-amm";
import { ShortAddress } from "@/components/Address";
import { FactList, FactPart } from "@/components/facts/Facts";
import facts from "@/components/facts/Facts.module.css";
import { MintLabel } from "@/components/MintLabel";
import { PanelFrame } from "@/components/Panel";
import { useWallet } from "@/components/wallet/WalletProvider";
import { formatInteger, formatTokenAmount } from "@/format";
import { LendingHistory } from "./LendingHistory";
import styles from "./LendingAmm.module.css";
import { bandMarks } from "./math";
import { useLendingPanel } from "./usePanel";

/** About how long a slot is, for saying how old a refresh is in words a reader can use. */
const SECONDS_PER_SLOT = 0.4;

export const percent = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** A slot count as rough time: "about 38 hours". */
export function slotsAsTime(slots: number): string {
  const seconds = slots * SECONDS_PER_SLOT;
  if (seconds < 90) return `about ${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 90 * 60) return `about ${Math.round(seconds / 60)} minutes`;
  if (seconds < 48 * 3600) return `about ${Math.round(seconds / 3600)} hours`;
  return `about ${Math.round(seconds / 86_400)} days`;
}

/** The market's two mints as the panel names them, the lent one and the other. */
export function sidesOf(market: Market, panel: Panel): { lent: MarketMint; other: MarketMint } {
  const find = (mint: string) => market.mints.find((m) => m.mint === mint) ?? { mint, symbol: null, token: null, decimals: null, vault: null, liquidity: null, flags: null };
  return { lent: find(panel.lent_mint), other: find(panel.other_mint) };
}

/** An amount of a mint in its tokens, with its name; base units when its decimals are not known. */
export function Amount({ raw, mint }: { raw: string | bigint; mint: MarketMint }) {
  const value = typeof raw === "bigint" ? raw : BigInt(raw);
  return (
    <span className={styles.amount}>
      {mint.decimals === null ? `${formatInteger(value)} base units of` : formatTokenAmount(value, mint.decimals)} <MintLabel mint={mint.mint} symbol={mint.symbol} token={mint.token} />
    </span>
  );
}

/** LP shares in whole shares, "1 LP share" or "2.5 LP shares". */
export function lpShares(raw: bigint, decimals: number): string {
  const written = formatTokenAmount(raw, decimals);
  return `${written} ${written === "1" ? "LP share" : "LP shares"}`;
}

const onOff = (on: boolean | null) => (on === null ? "Not read" : on ? "On" : "Off");

/** The panel: its read under one heading, and the market's history under another. */
export function LendingAmmPanel({ market }: { market: Market }) {
  const { account } = useWallet();
  const { state, retry, refresh } = useLendingPanel(market.address, account?.address ?? null);
  return (
    <>
      <PanelFrame title="Lending AMM" what="the lending AMM's reading of this market" state={state} retry={retry}>
        {(panel) => <LendingAmmBody market={market} panel={panel} onRefresh={refresh} />}
      </PanelFrame>
      {/* The lent mint is the panel's reading; until it arrives, the market's quote mint, which is the lent one on every market but SOL against USDC. */}
      <LendingHistory market={market} lentMint={state.status === "loaded" ? state.data.lent_mint : market.quote_mint} />
    </>
  );
}

/** What the panel shows once read; exported for the tests, which render it from a fixed read. */
export function LendingAmmBody({ market, panel, onRefresh }: { market: Market; panel: Panel; onRefresh?: () => void }) {
  const { lent, other } = sidesOf(market, panel);
  const k = panel.kamino;
  const notices = noticesOf(panel);
  return (
    <div className={styles.body}>
      <p className={styles.read}>
        Read from the market state and Kamino&apos;s reserve at slot {formatInteger(panel.slot)}.{" "}
        {onRefresh && (
          <button type="button" className={styles.again} onClick={onRefresh}>
            Read again
          </button>
        )}
      </p>
      {notices.length > 0 && (
        <ul className={styles.notices} aria-label="What the reading shows now">
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}
      <div className={styles.parts}>
        <FactPart title="Lent side">
          <FactList
            label="Lent side"
            facts={[
              { name: "Lent to Kamino", value: <MintLabel mint={lent.mint} symbol={lent.symbol} token={lent.token} /> },
              { name: "Kamino reserve", value: <ShortAddress address={panel.reserve} /> },
              { name: "Lending market", value: panel.lending_market ? <ShortAddress address={panel.lending_market} /> : "Not one the program lends to" },
              { name: "cToken mint", value: <ShortAddress address={panel.collateral_mint} /> },
            ]}
          />
        </FactPart>
        <FactPart title="Buffer">
          <FactList
            label="Buffer"
            facts={[
              { name: "Buffer", value: <Amount raw={panel.buffer} mint={lent} /> },
              { name: "Lent value", value: panel.lent_value === null ? "Not read: the program refuses to read Kamino's reserve" : <Amount raw={panel.lent_value} mint={lent} /> },
              { name: "Buffer's share", value: <BufferShare panel={panel} /> },
              { name: "Withdraw mode", value: withdrawModeWords(panel) },
              { name: "Rebalance", value: rebalanceWords(panel, lent) },
            ]}
          />
        </FactPart>
        <FactPart title={`Sells for ${lent.symbol ?? "the lent mint"}`}>
          {panel.sells.refused ? (
            <p className={facts.note}>{sellsRefused(panel)}</p>
          ) : (
            <FactList
              label="Largest sells"
              facts={[
                { name: "Paid by the buffer alone", value: panel.sells.buffer_pays_all ? "Every sell the market can take" : panel.sells.buffer_alone === null ? "None: the buffer is empty" : <>Up to <Amount raw={panel.sells.buffer_alone} mint={other} /></> },
                {
                  name: "With Kamino on top",
                  value: panel.sells.with_kamino_pays_all ? (
                    "Every sell the market can take"
                  ) : panel.sells.with_kamino === null ? (
                    "None"
                  ) : (
                    <>
                      Up to <Amount raw={panel.sells.with_kamino} mint={other} />
                      <span className={facts.sub}>
                        Kamino can pay <Amount raw={k.can_pay} mint={lent} /> right now; a larger sell fails.
                      </span>
                    </>
                  ),
                },
              ]}
            />
          )}
        </FactPart>
        <FactPart title="Kamino reserve">
          {k.problem ? (
            <p className={facts.note}>{k.problem}</p>
          ) : (
            <FactList
              label="Kamino reserve"
              facts={[
                { name: "Utilisation", value: k.utilisation_bps === null ? "Not read" : percent(k.utilisation_bps) },
                { name: "Freely available", value: k.free_liquidity === null ? "Not read" : <Amount raw={k.free_liquidity} mint={lent} /> },
                { name: "Supply rate", value: k.supply_rate_bps === null ? "Not read" : <>{percent(k.supply_rate_bps)} a year<span className={facts.sub}>As Kamino&apos;s curve sets it at the reserve&apos;s stored state.</span></> },
                { name: "Reserve emergency mode", value: onOff(k.reserve_emergency) },
                { name: "Lending market emergency mode", value: onOff(k.lending_market_emergency) },
                { name: "block_ctoken_usage", value: onOff(k.block_ctoken_usage) },
                k.deprecated ? { name: "Deprecated", value: "Yes: a total write-off deprecated the reserve, and it redeems nothing" } : false,
                { name: "Last refreshed", value: k.refresh_age_slots === null ? "Not read" : `${formatInteger(k.refresh_age_slots)} slots ago (${slotsAsTime(k.refresh_age_slots)})` },
              ]}
            />
          )}
        </FactPart>
        <FactPart title="LP shares">
          <FactList
            label="LP shares"
            facts={[
              { name: "LP fee", value: `${percent(panel.lp_fee_bps)} of every swap's input, kept in the market for its LPs` },
              {
                name: "One LP share",
                value:
                  panel.lp.value_other === null || panel.lp.value_lent === null ? (
                    "Not known yet"
                  ) : (
                    <>
                      <Amount raw={panel.lp.value_other} mint={other} /> and <Amount raw={panel.lp.value_lent} mint={lent} />
                    </>
                  ),
              },
              { name: "Locked shares", value: <>{lpShares(BigInt(panel.lp.locked), panel.lp.decimals)} in the lock account<span className={facts.sub}>Besides the {formatInteger(BigInt(panel.lp.minimum_liquidity))} base units the first deposit locked, which nobody can ever withdraw.</span></> },
              { name: "Lending yield so far", value: panel.yield_so_far === null ? "Not known" : <>{panel.yield_so_far.startsWith("-") ? "-" : ""}<Amount raw={panel.yield_so_far.replace(/^-/, "")} mint={lent} /><span className={facts.sub}>The cTokens&apos; value plus what the market redeemed, less what it deposited; Kamino&apos;s rounding can leave it a few base units below zero.</span></> },
            ]}
          />
        </FactPart>
      </div>
    </div>
  );
}

/** The buffer's share of the lent side as a number and a scale with its band, its target marked. */
function BufferShare({ panel }: { panel: Panel }) {
  const marks = bandMarks(panel);
  if (marks.share === null) return <>Not known</>;
  const words = panel.band === "within" ? "inside its band" : panel.band === "below" ? "below its band" : "above its band";
  return (
    <span className={styles.share}>
      <span>
        {percent(panel.buffer_share_bps!)}, {words} of {percent(panel.band_bps.min)} to {percent(panel.band_bps.max)} (target {percent(panel.band_bps.target)})
      </span>
      <span className={styles.scale} aria-hidden="true">
        <span className={styles.band} style={{ left: `${marks.min}%`, width: `${marks.max - marks.min}%` }} />
        <span className={styles.target} style={{ left: `${marks.target}%` }} />
        <span className={styles.marker} style={{ left: `${Math.min(100, marks.share)}%` }} />
      </span>
    </span>
  );
}

function withdrawModeWords(panel: Panel): string {
  if (!panel.withdraw_mode) return "Off";
  if (panel.exit_seen) return `On. Kamino has had enough free liquidity since slot ${formatInteger(panel.exit_seen.slot)}; a rebalance from slot ${formatInteger(panel.exit_seen.leave_from)} that still sees it leaves withdraw mode.`;
  return "On: the market lends nothing and redeems what Kamino can pay, until Kamino's free liquidity is back above ten times its exposure.";
}

function rebalanceWords(panel: Panel, lent: MarketMint) {
  const r = panel.rebalance;
  const last = r.keeper_last ? ` The keeper runner's last rebalance here: ${r.keeper_last.outcome}, ${new Date(r.keeper_last.at).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "";
  if (r.due) {
    const move = r.deposit ? (
      <>
        deposit <Amount raw={r.deposit} mint={lent} /> into Kamino
      </>
    ) : r.redeem ? (
      <>
        redeem <Amount raw={r.redeem} mint={lent} /> from Kamino
      </>
    ) : (
      "record what it saw"
    );
    const mode = r.withdraw_mode_after !== null && r.withdraw_mode_after !== panel.withdraw_mode ? (r.withdraw_mode_after ? " and enter withdraw mode" : " and leave withdraw mode") : "";
    return (
      <>
        Due: it would {move}
        {mode}. Anyone may send it, under Actions.
        {last && <span className={facts.sub}>{last.trim()}</span>}
      </>
    );
  }
  const why: Record<string, string> = {
    WithinBand: "the buffer is inside its band",
    BelowMinRebalance: "what it would move is below the smallest move the program makes",
    KaminoStopped: "Kamino redeems nothing right now",
    KaminoDepositsBlocked: "Kamino takes no deposits right now (block_ctoken_usage)",
    Overflow: "the lent side is too large to compute",
  };
  return (
    <>
      Not due: {r.refusal ? (why[r.refusal] ?? r.refusal) : "the reading of Kamino is incomplete"}.{last && <span className={facts.sub}>{last.trim()}</span>}
    </>
  );
}

function sellsRefused(panel: Panel): string {
  switch (panel.sells.refused) {
    case "market-closed":
      return "No sells yet: the market has no liquidity.";
    case "reserve-unreadable":
      return "No sells now: the program refuses to read Kamino's reserve, so every quote and swap is refused.";
    case "reserve-stale":
      return "None until someone refreshes Kamino's reserve, which anyone may do under Actions.";
    default:
      return "";
  }
}

/** The states a reader should see first, each a plain sentence. */
export function noticesOf(panel: Panel): string[] {
  const k = panel.kamino;
  const out: string[] = [];
  if (k.problem) out.push(`${k.problem} Trading, adding and rebalance are refused; removing in kind still works.`);
  if (k.reserve_emergency) out.push("Kamino's reserve emergency mode is on: Kamino redeems nothing, so sells are paid from the buffer alone and LPs can remove only in kind.");
  if (k.lending_market_emergency) out.push("Kamino's lending market emergency mode is on: Kamino redeems nothing and refreshes no reserve, so sells are paid from the buffer alone until the reserve is an hour stale, adding works only while the market holds no cTokens, and LPs can remove only in kind.");
  if (k.deprecated) out.push("Kamino's reserve is deprecated after a total write-off: its cTokens redeem nothing, ever again.");
  if (panel.withdraw_mode) out.push("The market is in withdraw mode: Kamino's free liquidity fell below five times the market's exposure, so the market lends nothing and redeems what it can.");
  if (panel.sells.refused === "reserve-stale") out.push("Kamino's reserve has not been refreshed within the last 9,000 slots, so quotes and swaps are refused until someone refreshes it.");
  return out;
}
