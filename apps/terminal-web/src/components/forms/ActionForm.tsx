"use client";

import { useCallback, useMemo } from "react";
import { PreparedAction, type Form, type Market } from "terminal-api/contract";
import { postToApi } from "@/api";
import type { MintInfo } from "@/formValues";
import { AuthorText } from "../Voice";
import { useWallet } from "../wallet/WalletProvider";
import { AccountsTable } from "./AccountsTable";
import { callsOf, CheckLine } from "./CheckLine";
import { FormFields } from "./FormFields";
import styles from "./Forms.module.css";
import { TransactionReview } from "./TransactionReview";
import { useFormFields } from "./useFormFields";
import { useReview } from "./useReview";

/**
 * One custom action's form (docs/spec/pipescope-screens.md, Explanation, actions and facts): its
 * heading, the author's label with "calls `<instruction>`" beside it; then the result line, the line
 * about signing outside the router, the fields, every account it touches, and "Simulate this action",
 * which leads to the same review as a swap.
 */
export function ActionForm({ form, market, deploySlot, open }: { form: Form; market: Market; deploySlot: number | null; open: boolean }) {
  const { account, openMenu } = useWallet();
  const trader = account?.address ?? null;
  const mints: MintInfo[] = useMemo(() => market.mints.map((m) => ({ mint: m.mint, symbol: m.symbol, token: m.token, decimals: m.decimals })), [market.mints]);
  const fields = useFormFields(form, mints);
  const { request } = fields;
  const prepare = useCallback(() => postToApi("/v1/actions/prepare", { market: market.address, action: form.name, ...request!, trader }, PreparedAction), [market.address, form.name, request, trader]);
  const { review, start, handlers } = useReview({ prepare, about: { market: market.address, strategy: market.strategy }, version: fields.version, trader });
  const mintOf = (mint: string) => mints.find((m) => m.mint === mint) ?? Object.values(fields.context.inputs).find((m) => m?.mint === mint) ?? null;

  return (
    <details className={styles.form} open={open}>
      <summary>
        <h3 className={styles.formTitle}>{form.label ? <AuthorText>{form.label}</AuthorText> : <code>{form.name}</code>}</h3>{" "}
        <span className={styles.calls}>
          calls <code>{callsOf(form)}</code>
        </span>
      </summary>
      <div className={styles.body}>
        <CheckLine form={form} program={market.strategy} deploySlot={deploySlot} />
        <p className={styles.line}>You sign this directly on the strategy. The router&apos;s swap protections (a minimum received, nothing taken beyond what you signed) do not apply to it.</p>
        {form.description && (
          <p className={styles.line}>
            <AuthorText>{form.description}</AuthorText>
          </p>
        )}
        <FormFields form={form} fields={fields} wallet={trader} />
        <AccountsTable form={form} context={fields.context} />
        {review ? (
          <TransactionReview title="Review this action" building="Building this action and simulating it, exactly as it would be signed." review={review} mintOf={mintOf} {...handlers} />
        ) : (
          <div className={styles.actions}>
            {account ? (
              <button type="button" className={styles.simulate} disabled={!request} onClick={start} aria-describedby={request ? undefined : `${form.name}-missing`}>
                Simulate this action
              </button>
            ) : (
              <button type="button" className={styles.simulate} onClick={openMenu}>
                Connect wallet
              </button>
            )}
            {account && fields.missing && (
              <span id={`${form.name}-missing`} className={styles.note}>
                {fields.missing}
              </span>
            )}
          </div>
        )}
      </div>
    </details>
  );
}
