"use client";

// Create market (docs/spec/pipescope-screens.md, Create market): "Choose a strategy", every registered
// strategy by name and short address with how many markets it has and who can upgrade it, one with a
// create form opening it and one without saying why; the create form, built like an action form, with
// each mint entered by address and its facts beneath; then simulate, review and sign; and a link to the
// new market's page once Aviary has read it. When no strategy has valid metadata, the page says so
// above the list.
import { generateKeyPairSigner, getTransactionDecoder, getTransactionEncoder, partiallySignTransaction, type KeyPairSigner } from "@solana/kit";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Market, PreparedMarket, StrategiesList, StrategyForms, type Form, type Strategy } from "terminal-api/contract";
import { getFromApi, postToApi } from "@/api";
import { BRAND } from "@/brand";
import { CLUSTER, NEW_MARKET_ASK_EVERY_MS, NEW_MARKET_WAIT_MS } from "@/config";
import { formatInteger, formatTokenAmount } from "@/format";
import { ROUTES } from "@/routes";
import { PanelFrame, useLoad } from "../Panel";
import { ShortAddress } from "../ShortAddress";
import { StrategyName } from "../StrategyName";
import { AuthorText } from "../Voice";
import { useWallet } from "../wallet/WalletProvider";
import { SaidBehind, UNAVAILABLE_WHY } from "../forms/Actions";
import { AccountsTable } from "../forms/AccountsTable";
import { CheckLine } from "../forms/CheckLine";
import { FormFields } from "../forms/FormFields";
import forms from "../forms/Forms.module.css";
import { TransactionReview } from "../forms/TransactionReview";
import { useFormFields } from "../forms/useFormFields";
import { useReview } from "../forms/useReview";
import styles from "./Create.module.css";

/** Why a strategy offers no create form, from its listed metadata status, or null when its forms may hold one. */
function noCreateForm(strategy: Strategy): string | null {
  if (strategy.metadata.status === "valid") return null;
  return `No create form: its metadata is unavailable (${UNAVAILABLE_WHY[`metadata-${strategy.metadata.status}`]}).`;
}

export function CreateMarket() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const chosen = params.get("strategy");
  const load = useCallback((signal: AbortSignal) => getFromApi("/v1/strategies", StrategiesList, { signal }), []);
  const { state, retry } = useLoad(load);
  const choose = (program: string) => router.replace(`${pathname}?strategy=${encodeURIComponent(program)}`, { scroll: false });

  return (
    <>
      <PanelFrame title="Choose a strategy" what="the registered strategies" state={state} retry={retry}>
        {({ strategies }) => <StrategyChooser strategies={strategies} chosen={chosen} onChoose={choose} />}
      </PanelFrame>
      {chosen && state.status === "loaded" && state.data.strategies.some((s) => s.program === chosen && s.metadata.status === "valid") && <CreateFormPanel key={chosen} program={chosen} />}
    </>
  );
}

/**
 * "Choose a strategy": every registered strategy by name and short address, how many markets it has and
 * who can upgrade it; one whose metadata may hold a create form offers to open it, one without says
 * why; and when no strategy has valid metadata, the line saying so above the list.
 */
export function StrategyChooser({ strategies, chosen, onChoose }: { strategies: Strategy[]; chosen: string | null; onChoose: (program: string) => void }) {
  return (
    <>
      {!strategies.some((s) => s.metadata.status === "valid") && (
        <p className={styles.notice}>No strategy on {CLUSTER} has valid metadata today, so none offers a create form here. Their markets were created from their authors&apos; own tools.</p>
      )}
      <ul className={styles.choices}>
        {strategies.map((strategy) => {
          const why = noCreateForm(strategy);
          return (
            <li key={strategy.program} className={styles.choice} data-chosen={chosen === strategy.program || undefined}>
              <span className={styles.who}>
                <StrategyName program={strategy.program} name={strategy.name} metadata={strategy.metadata.status} />
                <span className={styles.meta}>
                  {formatInteger(strategy.market_count)} {strategy.market_count === 1 ? "market" : "markets"};{" "}
                  {strategy.upgrade_authority ? (
                    <>
                      upgradeable by <ShortAddress address={strategy.upgrade_authority} />
                    </>
                  ) : strategy.flags.includes("frozen") ? (
                    "frozen: nobody can upgrade it"
                  ) : (
                    "who can upgrade it is not read yet"
                  )}
                </span>
              </span>
              {why ? (
                <span className={styles.why}>{why}</span>
              ) : (
                <button type="button" aria-pressed={chosen === strategy.program} onClick={() => onChoose(strategy.program)}>
                  {chosen === strategy.program ? "Its create form is below" : "Open its create form"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function CreateFormPanel({ program }: { program: string }) {
  const load = useCallback((signal: AbortSignal) => getFromApi(`/v1/strategies/${program}/forms`, StrategyForms, { signal }), [program]);
  const { state, retry } = useLoad(load);
  return (
    <PanelFrame title="The create form" what="its create form" state={state} retry={retry}>
      {(view) =>
        view.init ? (
          <CreateForm form={view.init} view={view} />
        ) : (
          <div className={forms.unavailable}>
            <p>{view.unavailable && view.unavailable !== "actions-invalid" ? `No create form: its metadata is unavailable (${UNAVAILABLE_WHY[view.unavailable]}).` : "No create form: its metadata describes none."}</p>
            <SaidBehind forms={view} />
          </div>
        )
      }
    </PanelFrame>
  );
}

function CreateForm({ form, view }: { form: Form; view: StrategyForms }) {
  const { account, openMenu } = useWallet();
  const trader = account?.address ?? null;
  const fields = useFormFields(form, NO_MINTS);
  const { request } = fields;
  // A new market state's keypair, made in the page for each review and never sent anywhere (PIPESCOPE-144).
  const state = useRef<KeyPairSigner | null>(null);
  const prepare = useCallback(async () => {
    state.current = form.market_state === "new_keypair" ? await generateKeyPairSigner() : null;
    return postToApi("/v1/markets/prepare", { strategy: view.program, ...request!, ...(state.current ? { market_state: state.current.address } : {}), trader }, PreparedMarket);
  }, [form.market_state, view.program, request, trader]);
  const presign = useCallback(async (bytes: Uint8Array) => {
    if (!state.current) return bytes;
    const signed = await partiallySignTransaction([state.current.keyPair], getTransactionDecoder().decode(bytes));
    return new Uint8Array(getTransactionEncoder().encode(signed));
  }, []);
  const [created, setCreated] = useState<string | null>(null);
  const { review, start, handlers } = useReview({ prepare, about: { strategy: view.program }, version: fields.version, trader, onConfirmed: (prepared) => setCreated(prepared.market) });
  const mintOf = (mint: string) => Object.values(fields.context.inputs).find((m) => m?.mint === mint) ?? null;

  return (
    <div className={styles.form}>
      <CheckLine form={form} program={view.program} deploySlot={view.deploy_slot} via="router" />
      <p className={forms.line}>You sign it in your own wallet. The market is made through Pipeline&apos;s router, which calls the strategy&apos;s own create instruction with what you fill in below.</p>
      {form.description && (
        <p className={forms.line}>
          <AuthorText>{form.description}</AuthorText>
        </p>
      )}
      <FormFields form={form} fields={fields} wallet={trader} />
      <AccountsTable form={form} context={fields.context} />
      {review ? (
        <TransactionReview
          title="Review the new market"
          building="Building the new market and simulating it, exactly as it would be signed."
          review={review}
          mintOf={mintOf}
          presign={presign}
          confirmed={() => (created ? <NewMarket market={created} /> : null)}
          {...handlers}
        />
      ) : (
        <div className={forms.actions}>
          {account ? (
            <button type="button" disabled={!request} onClick={start}>
              Simulate creating the market
            </button>
          ) : (
            <button type="button" onClick={openMenu}>
              Connect wallet
            </button>
          )}
          {account && fields.missing && <span className={forms.note}>{fields.missing}</span>}
        </div>
      )}
      {review?.status === "ready" && (
        <p className={forms.note}>
          The router lets the strategy&apos;s setup take at most {formatTokenAmount(BigInt(review.prepared.max_creator_lamports), SOL_DECIMALS)} SOL from your wallet; the simulation above shows what it takes.
        </p>
      )}
    </div>
  );
}

const NO_MINTS: never[] = [];
const SOL_DECIMALS = 9;

/** The new market's page, linked once Aviary has read the market, or after the wait in any case. */
function NewMarket({ market }: { market: string }) {
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
