"use client";

// The lending AMM's forms under Actions (docs/spec/lending-pool.md, "Custom actions and metadata" and
// "Aviary's panel"; #88): `add_liquidity`, `remove_liquidity` in cash or in kind, `lock_lp` and
// `rebalance`, each the strategy's own metadata action, filled in from the panel's one-slot read and
// built, simulated and reviewed as Aviary builds every action, with the wallet's balance changes shown
// before anything is signed. A removal offers in kind whenever one in cash would fail; `rebalance` is
// a button anyone may press; and while Kamino's reserve is too stale to trade, anyone may refresh it.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { Market, MarketMint } from "terminal-api/contract";
import { PreparedAction } from "terminal-api/contract";
import { PreparedRefresh, type LendingPanel as Panel } from "terminal-api/lending-amm";
import { postToApi } from "@/api";
import { DEFAULT_SLIPPAGE_PERCENT } from "@/config";
import type { MintInfo } from "@/formValues";
import { formatTokenAmount } from "@/format";
import { parseAmount, writeAmount } from "@/trade";
import forms from "@/components/forms/Forms.module.css";
import { TransactionReview, type Prepared } from "@/components/forms/TransactionReview";
import { useReview } from "@/components/forms/useReview";
import { MintLabel } from "@/components/MintLabel";
import { useWallet } from "@/components/wallet/WalletProvider";
import styles from "./LendingAmm.module.css";
import { Amount, sidesOf } from "./LendingPanel";
import { cashRefusalForForm, deposit, removal } from "./math";
import { useLendingPanel } from "./usePanel";

/** The metadata forms these replace in the strategy's list, since these fill them in. */
export const LENDING_FORMS = ["add_liquidity", "remove_liquidity", "remove_liquidity_in_kind", "lock_lp", "rebalance"] as const;

const SLIPPAGE_BPS = Math.round(DEFAULT_SLIPPAGE_PERCENT * 100);
const LP_DECIMALS = 9;
const lpShares = (raw: bigint) => {
  const written = formatTokenAmount(raw, LP_DECIMALS);
  return `${written} ${written === "1" ? "LP share" : "LP shares"}`;
};

type Request = { action: string; args: Record<string, string | boolean>; inputs: Record<string, string> };

/** The forms, once the panel is read for the connected wallet. */
export function LendingAmmForms({ market }: { market: Market }) {
  const { account } = useWallet();
  const { state, refresh } = useLendingPanel(market.address, account?.address ?? null);
  if (state.status !== "loaded") return null;
  return <LendingFormsBody market={market} panel={state.data} onDone={refresh} />;
}

export function LendingFormsBody({ market, panel, onDone }: { market: Market; panel: Panel; onDone: () => void }) {
  const { lent, other } = sidesOf(market, panel);
  const stale = panel.kamino.refresh_age_slots !== null && panel.kamino.refresh_age_slots > 4_500 && !panel.kamino.lending_market_emergency && !panel.kamino.deprecated && panel.kamino.problem === null;
  return (
    <div className={forms.list} aria-label="The lending AMM's forms">
      <p className={forms.note}>Aviary fills these in from the strategy&apos;s metadata and the panel&apos;s reading, with {DEFAULT_SLIPPAGE_PERCENT}% of room for the price moving before your transaction lands.</p>
      {stale && <RefreshForm market={market} panel={panel} onDone={onDone} />}
      <AddForm market={market} panel={panel} lent={lent} other={other} onDone={onDone} />
      <RemoveForm market={market} panel={panel} lent={lent} other={other} onDone={onDone} />
      <LockForm market={market} panel={panel} onDone={onDone} />
      <RebalanceForm market={market} panel={panel} lent={lent} onDone={onDone} />
    </div>
  );
}

/** One form: its heading, what it does, its fields, then simulate, review and sign. */
function ProductForm({ title, calls, market, panel, request, missing, version, prepare, onDone, children, open = false }: { title: string; calls: string; market: Market; panel: Panel; request: Request | null; missing: string | null; version: string; prepare?: () => Promise<Prepared>; onDone: () => void; children: ReactNode; open?: boolean }) {
  const { account, openMenu } = useWallet();
  const trader = account?.address ?? null;
  const send = useCallback(
    () => (prepare ? prepare() : postToApi("/v1/lending-amm/actions/prepare", { market: market.address, ...request!, trader }, PreparedAction)),
    [prepare, market.address, request, trader],
  );
  const { review, start, handlers } = useReview({ prepare: send, about: { market: market.address, strategy: market.strategy }, version: hash(version), trader, onConfirmed: onDone });
  const mints: MintInfo[] = useMemo(() => market.mints.map((m) => ({ mint: m.mint, symbol: m.symbol, token: m.token, decimals: m.decimals })), [market.mints]);
  const mintOf = (mint: string) => mints.find((m) => m.mint === mint) ?? (mint === panel.lp_mint ? { mint, symbol: "LP shares", token: null, decimals: LP_DECIMALS } : null);
  const id = `lending-${calls}`;
  return (
    <details className={forms.form} open={open}>
      <summary>
        <h3 className={forms.formTitle}>{title}</h3>{" "}
        <span className={forms.calls}>
          calls <code>{calls}</code>
        </span>
      </summary>
      <div className={forms.body}>
        {children}
        {review ? (
          <TransactionReview
            title="Review this action"
            building="Building this action and simulating it, exactly as it would be signed."
            review={review}
            mintOf={mintOf}
            {...handlers}
          />
        ) : (
          <div className={forms.actions}>
            {account ? (
              <button type="button" className={forms.simulate} disabled={!prepare && !request} onClick={start} aria-describedby={missing ? `${id}-missing` : undefined}>
                Simulate {title.toLowerCase()}
              </button>
            ) : (
              <button type="button" className={forms.simulate} onClick={openMenu}>
                Connect wallet
              </button>
            )}
            {account && missing && (
              <span id={`${id}-missing`} className={forms.note}>
                {missing}
              </span>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);

/** An amount field in a mint's tokens. */
function AmountField({ id, label, value, onChange, after }: { id: string; label: ReactNode; value: string; onChange: (value: string) => void; after?: ReactNode }) {
  return (
    <div className={forms.field}>
      <label htmlFor={id} className={forms.fieldLabel}>
        {label}
      </label>
      <div className={forms.control}>
        <input id={id} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value)} />
        {after}
      </div>
    </div>
  );
}

function AddForm({ market, panel, lent, other, onDone }: { market: Market; panel: Panel; lent: MarketMint; other: MarketMint; onDone: () => void }) {
  const [side, setSide] = useState<"lent" | "other">("lent");
  const [typed, setTyped] = useState("");
  const mint = side === "lent" ? lent : other;
  const parsed = mint.decimals === null ? null : parseAmount(typed, mint.decimals);
  const quote = parsed?.kind === "amount" ? deposit(panel, side, parsed.value, SLIPPAGE_BPS) : null;
  const k = panel.kamino;
  const blocked =
    k.problem !== null
      ? "The program refuses to read Kamino's reserve, so it refuses deposits."
      : k.deprecated
        ? "Kamino's reserve is deprecated, so the program refuses deposits."
        : k.lending_market_emergency && panel.ctokens !== "0"
          ? "Kamino's lending market emergency mode is on and this market holds cTokens, so the program refuses deposits until Kamino lifts it."
          : !panel.open
            ? "The market has no liquidity yet; its first deposit is made with the create form."
            : null;
  const missing = blocked ?? (parsed?.kind === "invalid" ? parsed.reason : !quote ? "Type how much to add." : null);
  const request: Request | null =
    !blocked && quote ? { action: "add_liquidity", args: { max_0: String(quote.max[0]), max_1: String(quote.max[1]), min_lp: String(quote.minLp) }, inputs: { reserve: panel.reserve } } : null;
  return (
    <ProductForm title="Add liquidity" calls="add_liquidity" market={market} panel={panel} request={request} missing={missing} version={`${side}:${typed}`} onDone={onDone} open>
      <p className={forms.line}>Adds both tokens at the market&apos;s current ratio, for LP shares. Your {lent.symbol ?? "lent token"} joins the buffer; the market lends it to Kamino at its next rebalance.</p>
      <fieldset className={styles.choice}>
        <legend className={forms.srOnly}>Which token you type an amount of</legend>
        {(["lent", "other"] as const).map((s) => (
          <label key={s}>
            <input type="radio" name={`add-side-${market.address}`} checked={side === s} onChange={() => setSide(s)} /> In <MintLabel mint={(s === "lent" ? lent : other).mint} symbol={(s === "lent" ? lent : other).symbol} token={(s === "lent" ? lent : other).token} />
          </label>
        ))}
      </fieldset>
      <AmountField id={`add-${market.address}`} label={<>How much {side === "lent" ? "of the lent token" : "of the other token"} to add</>} value={typed} onChange={setTyped} />
      {quote && (
        <p className={forms.line}>
          It takes <Amount raw={quote.other} mint={other} /> and <Amount raw={quote.lent} mint={lent} /> for {lpShares(quote.shares)}; it may take at most <Amount raw={panel.lent_index === 1 ? quote.max[0] : quote.max[1]} mint={other} /> and{" "}
          <Amount raw={panel.lent_index === 1 ? quote.max[1] : quote.max[0]} mint={lent} />, and fails below {lpShares(quote.minLp)}.
          {lent.symbol === "SOL" && " Your SOL is wrapped in the same transaction, and what it does not take comes back as SOL."}
        </p>
      )}
      {panel.ctokens !== "0" && <p className={forms.note}>Kamino&apos;s reserve is refreshed first in the same transaction, since the program values its cTokens only at a rate refreshed in that slot.</p>}
    </ProductForm>
  );
}

function RemoveForm({ market, panel, lent, other, onDone }: { market: Market; panel: Panel; lent: MarketMint; other: MarketMint; onDone: () => void }) {
  const held = panel.wallet ? BigInt(panel.wallet.shares) : 0n;
  const [typed, setTyped] = useState("");
  const [chosen, setChosen] = useState<"cash" | "kind">("cash");
  const parsed = parseAmount(typed, LP_DECIMALS);
  const lp = parsed.kind === "amount" ? parsed.value : 0n;
  const cashFails = cashRefusalForForm(panel, lp);
  // In kind is offered whenever cash would fail, and then chosen for the reader.
  const inKind = chosen === "kind" || cashFails !== null;
  const parts = removal(panel, lp, inKind, SLIPPAGE_BPS);
  const missing = !panel.wallet ? "Connect your wallet to see your LP shares." : held === 0n ? "Your wallet holds no LP shares of this market." : parsed.kind === "invalid" ? parsed.reason : lp === 0n ? "Type how many LP shares to remove." : lp > held ? `Your wallet holds ${lpShares(held)}.` : null;
  const kamino = { reserve: panel.reserve, lending_market: panel.lending_market ?? "", reserve_liquidity_supply: panel.reserve_liquidity_supply ?? "" };
  const request: Request | null =
    !missing && parts
      ? inKind
        ? { action: "remove_liquidity_in_kind", args: { lp: String(lp), min_other: String(parts.minOther), min_lent: String(parts.minLent), in_kind: true }, inputs: { collateral_mint: panel.collateral_mint } }
        : { action: "remove_liquidity", args: { lp: String(lp), min_other: String(parts.minOther), min_lent: String(parts.minLent), in_kind: false }, inputs: { collateral_mint: panel.collateral_mint, ...kamino } }
      : null;
  return (
    <ProductForm title="Remove liquidity" calls={inKind ? "remove_liquidity (in kind)" : "remove_liquidity"} market={market} panel={panel} request={request} missing={missing} version={`${typed}:${chosen}`} onDone={onDone}>
      <p className={forms.line}>Burns LP shares for their part of the market: the other token, the buffer&apos;s {lent.symbol ?? "lent token"}, and the market&apos;s cTokens, redeemed from Kamino in cash or paid as cTokens in kind.</p>
      <AmountField
        id={`remove-${market.address}`}
        label="LP shares to remove"
        value={typed}
        onChange={setTyped}
        after={
          held > 0n ? (
            <button type="button" onClick={() => setTyped(writeAmount(held, LP_DECIMALS))}>
              All {formatTokenAmount(held, LP_DECIMALS)}
            </button>
          ) : null
        }
      />
      <fieldset className={styles.choice}>
        <legend className={forms.srOnly}>How the cTokens&apos; part is paid</legend>
        <label>
          <input type="radio" name={`remove-how-${market.address}`} checked={!inKind} disabled={cashFails !== null} onChange={() => setChosen("cash")} /> In cash: Kamino redeems the cTokens&apos; part
        </label>
        <label>
          <input type="radio" name={`remove-how-${market.address}`} checked={inKind} onChange={() => setChosen("kind")} /> In kind: the cTokens&apos; part as Kamino cTokens
        </label>
      </fieldset>
      {cashFails && (
        <p className={forms.line} role="status">
          {cashFails} In kind works whatever state Kamino is in; you can redeem the cTokens at Kamino yourself later.
        </p>
      )}
      {parts && lp > 0n && (
        <p className={forms.line}>
          You receive <Amount raw={parts.other} mint={other} /> and <Amount raw={inKind ? parts.bufferPart : parts.bufferPart + parts.ctokenValue} mint={lent} />
          {inKind && parts.ctokenPart > 0n ? <> and {formatTokenAmount(parts.ctokenPart, lent.decimals ?? 0)} cTokens worth <Amount raw={parts.ctokenValue} mint={lent} /></> : null}, at least <Amount raw={parts.minOther} mint={other} /> and <Amount raw={parts.minLent} mint={lent} />.
          {!inKind && lent.symbol === "SOL" && " The SOL is unwrapped in the same transaction when your wallet holds no wrapped SOL account of its own."}
        </p>
      )}
    </ProductForm>
  );
}

function LockForm({ market, panel, onDone }: { market: Market; panel: Panel; onDone: () => void }) {
  const held = panel.wallet ? BigInt(panel.wallet.shares) : 0n;
  const [typed, setTyped] = useState("");
  const parsed = parseAmount(typed, LP_DECIMALS);
  const amount = parsed.kind === "amount" ? parsed.value : 0n;
  const missing = !panel.wallet ? "Connect your wallet to see your LP shares." : held === 0n ? "Your wallet holds no LP shares of this market." : parsed.kind === "invalid" ? parsed.reason : amount === 0n ? "Type how many LP shares to lock." : amount > held ? `Your wallet holds ${lpShares(held)}.` : null;
  const request: Request | null = missing ? null : { action: "lock_lp", args: { amount: String(amount) }, inputs: { lock_account: panel.lock_account } };
  return (
    <ProductForm title="Lock LP shares" calls="lock_lp" market={market} panel={panel} request={request} missing={missing} version={typed} onDone={onDone}>
      <p className={forms.line}>Moves LP shares into the market&apos;s lock account, which no instruction ever moves them out of. Locked shares keep earning the LP fee and the lending yield, which stay in the market as depth for traders.</p>
      <AmountField id={`lock-${market.address}`} label="LP shares to lock, for good" value={typed} onChange={setTyped} />
    </ProductForm>
  );
}

function RebalanceForm({ market, panel, lent, onDone }: { market: Market; panel: Panel; lent: MarketMint; onDone: () => void }) {
  const r = panel.rebalance;
  const request: Request | null =
    panel.lending_market && panel.reserve_liquidity_supply
      ? { action: "rebalance", args: {}, inputs: { lent_mint: panel.lent_mint, reserve: panel.reserve, lending_market: panel.lending_market, reserve_liquidity_supply: panel.reserve_liquidity_supply, collateral_mint: panel.collateral_mint } }
      : null;
  return (
    <ProductForm title="Rebalance" calls="rebalance" market={market} panel={panel} request={request} missing={request ? null : "The program refuses to read Kamino's reserve, so it refuses rebalance."} version="" onDone={onDone}>
      <p className={forms.line}>
        Moves the buffer back to its target when it is outside its band: a deposit into Kamino above it, a redeem below it, and in withdraw mode a redeem of what Kamino can pay. Anyone may send it; it creates nothing and pays no tip. Our keeper runner sends it when it is due.
      </p>
      <p className={forms.line} role="status">
        {r.due ? (
          <>
            <strong>Due now</strong>: it would {r.deposit ? <>deposit <Amount raw={r.deposit} mint={lent} /></> : r.redeem ? <>redeem <Amount raw={r.redeem} mint={lent} /></> : "record what it saw of Kamino"}
            {r.withdraw_mode_after !== null && r.withdraw_mode_after !== panel.withdraw_mode ? (r.withdraw_mode_after ? ", entering withdraw mode" : ", leaving withdraw mode") : ""}.
          </>
        ) : (
          "Not due now, so its simulation will show the program's refusal and nobody pays for it."
        )}
      </p>
    </ProductForm>
  );
}

function RefreshForm({ market, panel, onDone }: { market: Market; panel: Panel; onDone: () => void }) {
  const { account } = useWallet();
  const trader = account?.address ?? null;
  const prepare = useCallback(() => postToApi("/v1/lending-amm/refresh/prepare", { market: market.address, trader }, PreparedRefresh), [market.address, trader]);
  return (
    <ProductForm title="Refresh Kamino's reserve" calls="klend refresh_reserve" market={market} panel={panel} request={null} missing={null} version="" prepare={prepare} onDone={onDone} open>
      <p className={forms.line}>
        Kamino&apos;s reserve was last refreshed {panel.kamino.refresh_age_slots?.toLocaleString("en-US")} slots ago. Quotes and swaps of a market holding cTokens take a reserve refreshed within the last 9,000 slots, so this market trades again once anyone refreshes it. This is Kamino&apos;s own instruction, which anyone may send for the network fee.
      </p>
    </ProductForm>
  );
}
