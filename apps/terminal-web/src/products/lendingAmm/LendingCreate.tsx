"use client";

// The lending AMM's create form on the create-market page (docs/spec/lending-pool.md, "Creating a
// market" and "Creation parameters"; #88): one transaction of the router's `create_market`, its two
// fee accounts and the first deposit, which sets the price. It is pre-filled from the API, which keeps
// the defaults in one place (an LP fee of 30 bps, `lent_index` 1 since the form takes the token first
// and the lent mint second; LENDING-104), and the page writes none of them.
import { isAddress } from "@solana/kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WRAPPED_SOL } from "terminal-api/config";
import { MintFacts } from "terminal-api/contract";
import { LendingCreateForm, PreparedLendingCreate } from "terminal-api/lending-amm";
import { getFromApi, postToApi } from "@/api";
import { MintFactList } from "@/components/facts/MarketFacts";
import forms from "@/components/forms/Forms.module.css";
import { TransactionReview } from "@/components/forms/TransactionReview";
import { useReview } from "@/components/forms/useReview";
import { NewMarket } from "@/components/create/CreateMarket";
import { MintLabel } from "@/components/MintLabel";
import { PanelFrame, useLoad } from "@/components/Panel";
import { useWallet } from "@/components/wallet/WalletProvider";
import type { MintInfo } from "@/formValues";
import { formatInteger, formatPrice } from "@/format";
import { parseAmount } from "@/trade";
import styles from "./LendingAmm.module.css";
import { percent } from "./LendingPanel";

/** The create form under its panel, once the API has said what it is pre-filled with. */
export function LendingAmmCreate({ program }: { program: string }) {
  const load = useCallback((signal: AbortSignal) => getFromApi("/v1/lending-amm/create", LendingCreateForm, { signal }), []);
  const { state, retry } = useLoad(load);
  return (
    <PanelFrame title="The create form" what="the lending AMM's create form" state={state} retry={retry}>
      {(form) => <CreateForm form={form} program={program} />}
    </PanelFrame>
  );
}

type Read = { status: "loading" } | { status: "read"; facts: MintFacts } | { status: "failed"; message: string };

/** A mint typed by address, read for its facts as soon as the address is whole; loading until its answer arrives. */
function useMint(typed: string): Read | null {
  const address = typed.trim();
  const [read, setRead] = useState<{ address: string; read: Read } | null>(null);
  useEffect(() => {
    if (!isAddress(address)) return;
    const controller = new AbortController();
    getFromApi(`/v1/mints/${address}`, MintFacts, { signal: controller.signal }).then(
      (facts) => setRead({ address, read: { status: "read", facts } }),
      (e: unknown) => !controller.signal.aborted && setRead({ address, read: { status: "failed", message: e instanceof Error ? e.message : String(e) } }),
    );
    return () => controller.abort();
  }, [address]);
  if (!isAddress(address)) return null;
  return read?.address === address ? read.read : { status: "loading" };
}

export function CreateForm({ form, program }: { form: LendingCreateForm; program: string }) {
  const { account, openMenu } = useWallet();
  const trader = account?.address ?? null;
  const [token, setToken] = useState("");
  const [lentMint, setLentMint] = useState(form.lent_mints[0]?.mint ?? "");
  const [fee, setFee] = useState(String(form.lp_fee_bps));
  const [otherTyped, setOtherTyped] = useState("");
  const [lentTyped, setLentTyped] = useState("");
  const read = useMint(token);
  const lent = form.lent_mints.find((m) => m.mint === lentMint) ?? null;
  const tokenFacts = read?.status === "read" && read.facts.readable ? read.facts : null;
  const otherAmount = tokenFacts?.decimals != null ? parseAmount(otherTyped, tokenFacts.decimals) : null;
  const lentAmount = lent ? parseAmount(lentTyped, lent.decimals) : null;
  const feeBps = /^\d+$/.test(fee.trim()) ? Number(fee.trim()) : NaN;

  const missing = !isAddress(token.trim())
    ? "Enter the token's mint by its address."
    : read?.status === "loading"
      ? "Reading the token's mint…"
      : read?.status === "failed"
        ? `Could not read the token's mint. ${read.message}`
        : !tokenFacts
          ? "That address is no mint."
          : !lent
            ? "Choose the mint to lend."
            : tokenFacts.mint === lent.mint
              ? "The token and the lent mint must differ."
              : !Number.isInteger(feeBps) || feeBps > form.max_lp_fee_bps
                ? `The LP fee is a whole number of basis points from 0 to ${form.max_lp_fee_bps}.`
                : otherAmount?.kind !== "amount"
                  ? otherAmount?.kind === "invalid" ? otherAmount.reason : "Type how much of the token the first deposit puts in."
                  : lentAmount?.kind !== "amount"
                    ? lentAmount?.kind === "invalid" ? lentAmount.reason : "Type how much of the lent mint the first deposit puts in."
                    : null;
  const otherBase = otherAmount?.kind === "amount" ? String(otherAmount.value) : null;
  const lentBase = lentAmount?.kind === "amount" ? String(lentAmount.value) : null;
  const request = useMemo(
    () => (!missing && otherBase && lentBase && tokenFacts && lent ? { trader, other_mint: tokenFacts.mint, lent_mint: lent.mint, lp_fee_bps: feeBps, other_amount: otherBase, lent_amount: lentBase } : null),
    [missing, otherBase, lentBase, tokenFacts, lent, trader, feeBps],
  );
  // A review belongs to the values it was built for: any change leaves it.
  const version = useMemo(() => hashOf([token, lentMint, fee, otherTyped, lentTyped].join("|")), [token, lentMint, fee, otherTyped, lentTyped]);
  const prepare = useCallback(() => postToApi("/v1/lending-amm/markets/prepare", request, PreparedLendingCreate), [request]);
  const [created, setCreated] = useState<string | null>(null);
  const { review, start, handlers } = useReview({ prepare, about: { strategy: program }, version, trader, onConfirmed: (prepared) => setCreated(prepared.market) });
  const lentLabel = lent ? <LentName mint={lent.mint} /> : null;
  const mints: MintInfo[] = [
    ...(tokenFacts ? [{ mint: tokenFacts.mint, symbol: tokenFacts.symbol, token: tokenFacts.token, decimals: tokenFacts.decimals }] : []),
    ...form.lent_mints.map((m) => ({ mint: m.mint, symbol: m.mint === WRAPPED_SOL ? "SOL" : null, token: null, decimals: m.decimals })),
  ];
  const mintOf = (mint: string) => mints.find((m) => m.mint === mint) ?? null;
  const price = otherAmount?.kind === "amount" && lentAmount?.kind === "amount" && tokenFacts?.decimals != null && lent ? Number(lentAmount.value) / 10 ** lent.decimals / (Number(otherAmount.value) / 10 ** tokenFacts.decimals) : null;

  return (
    <div className={forms.list}>
      <p className={forms.line}>
        You sign it in your own wallet. It creates the market through Pipeline&apos;s router, opens the router&apos;s fee account for each mint, and makes the first deposit, which sets the price, all in one transaction. The program locks the first {formatInteger(BigInt(form.minimum_liquidity))} LP base units for good.
      </p>
      <fieldset className={forms.fields}>
        <legend className={forms.srOnly}>The create form&apos;s fields</legend>
        <div className={forms.field}>
          <label htmlFor="lending-token" className={forms.fieldLabel}>
            The token, by its mint&apos;s address
          </label>
          <div className={forms.control}>
            <input id="lending-token" type="text" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} />
          </div>
          {read?.status === "read" && read.facts.readable && (
            <div className={forms.facts} aria-label="The token's facts">
              <MintFactList mint={read.facts} />
            </div>
          )}
        </div>
        <fieldset className={styles.choice}>
          <legend className={forms.fieldLabel}>The mint lent to Kamino</legend>
          {form.lent_mints.map((m) => (
            <label key={m.mint}>
              <input type="radio" name="lending-lent-mint" checked={lentMint === m.mint} onChange={() => setLentMint(m.mint)} /> <LentName mint={m.mint} />
            </label>
          ))}
        </fieldset>
        <div className={forms.field}>
          <label htmlFor="lending-fee" className={forms.fieldLabel}>
            LP fee, in basis points<span className={forms.identifier}>at most {form.max_lp_fee_bps}, {percent(form.max_lp_fee_bps)}</span>
          </label>
          <div className={forms.control}>
            <input id="lending-fee" type="text" inputMode="numeric" autoComplete="off" value={fee} onChange={(e) => setFee(e.target.value)} />
          </div>
          <p className={forms.note}>Taken from every swap&apos;s input and kept in the market for its LPs. <code>lent_index</code> is {form.lent_index}, filled in: this form takes the token first and the lent mint second.</p>
        </div>
        <div className={forms.field}>
          <label htmlFor="lending-other-amount" className={forms.fieldLabel}>
            First deposit of the token
          </label>
          <div className={forms.control}>
            <input id="lending-other-amount" type="text" inputMode="decimal" autoComplete="off" value={otherTyped} onChange={(e) => setOtherTyped(e.target.value)} />
          </div>
        </div>
        <div className={forms.field}>
          <label htmlFor="lending-lent-amount" className={forms.fieldLabel}>
            First deposit of {lentLabel ?? "the lent mint"}
          </label>
          <div className={forms.control}>
            <input id="lending-lent-amount" type="text" inputMode="decimal" autoComplete="off" value={lentTyped} onChange={(e) => setLentTyped(e.target.value)} />
          </div>
          {price !== null && Number.isFinite(price) && (
            <p className={forms.note}>
              The market opens at {formatPrice(price)} {lentLabel} for one token.
            </p>
          )}
        </div>
      </fieldset>
      {review ? (
        <TransactionReview
          title="Review the new market"
          building="Building the new market with its first deposit and simulating it, exactly as it would be signed."
          review={review}
          mintOf={mintOf}
          confirmed={() => (created ? <NewMarket market={created} /> : null)}
          {...handlers}
        />
      ) : (
        <div className={forms.actions}>
          {account ? (
            <button type="button" className={forms.simulate} disabled={!request} onClick={start}>
              Simulate creating the market
            </button>
          ) : (
            <button type="button" className={forms.simulate} onClick={openMenu}>
              Connect wallet
            </button>
          )}
          {account && missing && <span className={forms.note}>{missing}</span>}
        </div>
      )}
    </div>
  );
}

const hashOf = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

/** A lent mint as the form names it: SOL by Aviary's own name, any other by its short address. */
function LentName({ mint }: { mint: string }) {
  return <MintLabel mint={mint} symbol={mint === WRAPPED_SOL ? "SOL" : null} token={null} />;
}
