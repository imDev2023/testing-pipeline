"use client";

import { useCallback, type ReactNode } from "react";
import { StrategyForms, type Market } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { BRAND } from "@/brand";
import { formatInteger } from "@/format";
import { PanelFrame, useLoad } from "../Panel";
import { ActionForm } from "./ActionForm";
import styles from "./Forms.module.css";

/** Why a strategy's metadata gives no forms, as the unavailable state says it (docs/spec/pipescope-screens.md). */
export const UNAVAILABLE_WHY: Record<NonNullable<StrategyForms["unavailable"]>, string> = {
  "metadata-not-fetched": `${BRAND.name} has not fetched it yet`,
  "metadata-missing": "the strategy names no metadata",
  "metadata-unreachable": "the link could not be fetched",
  "metadata-invalid": "the document did not pass Pipeline's validator",
  "actions-invalid": "the actions it describes did not pass the validator",
};

/** What the deployed program holds beyond Pipeline's own instructions, as the unavailable state counts it. */
export function beyondPipeline(count: number | null): string {
  if (count === null) return `${BRAND.name} has not read the deployed program's instructions yet.`;
  if (count === 0) return "The deployed program has no instructions beyond Pipeline's own.";
  return `The deployed program has ${formatInteger(count)} ${count === 1 ? "instruction" : "instructions"} beyond Pipeline's own.`;
}

/** What the fetcher or the validator said, behind a disclosure, as plain text. */
export function SaidBehind({ forms }: { forms: StrategyForms }) {
  if (!forms.errors.length) return null;
  return (
    <details className={styles.disclosure}>
      <summary>{forms.unavailable === "metadata-unreachable" ? "What fetching the link found" : "What Pipeline's validator said"}</summary>
      <ul className={styles.errors}>
        {forms.errors.map((error, i) => (
          <li key={i}>{error}</li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Actions on the market page (docs/spec/pipescope-screens.md, Explanation, actions and facts): one form
 * for each action in the strategy's metadata, closed but the first, then a product's own forms when the
 * strategy is one of ours; or the unavailable state, saying why there are no forms, what the
 * validator said behind a disclosure, and how many instructions the program has beyond Pipeline's own.
 */
export function Actions({ market, productForms }: { market: Market; productForms: ReactNode }) {
  const load = useCallback((signal: AbortSignal) => getFromApi(`/v1/strategies/${market.strategy}/forms`, StrategyForms, { signal }), [market.strategy]);
  const { state, retry } = useLoad(load);
  return (
    <PanelFrame title="Actions" what="the strategy's forms" state={state} retry={retry} after={productForms ? <div className={styles.productForms}>{productForms}</div> : null}>
      {(forms) => <ActionsBody forms={forms} market={market} />}
    </PanelFrame>
  );
}

/** What Actions holds once the strategy's forms are read: its forms, or why it has none. */
export function ActionsBody({ forms, market }: { forms: StrategyForms; market: Market }) {
  if (forms.unavailable) {
    return (
      <div className={styles.unavailable}>
        <p>
          {forms.unavailable === "actions-invalid" ? (
            <>
              No forms. {BRAND.name} builds a strategy&apos;s forms from its metadata, and {UNAVAILABLE_WHY["actions-invalid"]}.
            </>
          ) : (
            <>
              No forms. {BRAND.name} builds a strategy&apos;s forms from its metadata, and this strategy&apos;s metadata is unavailable: {UNAVAILABLE_WHY[forms.unavailable]}.
            </>
          )}
        </p>
        <SaidBehind forms={forms} />
        <p className={styles.note}>{beyondPipeline(forms.instructions_beyond_pipeline)}</p>
      </div>
    );
  }
  if (!forms.actions.length) {
    return (
      <div className={styles.unavailable}>
        <p>No forms: this strategy&apos;s metadata describes no actions.</p>
        <p className={styles.note}>{beyondPipeline(forms.instructions_beyond_pipeline)}</p>
      </div>
    );
  }
  return (
    <div className={styles.list}>
      {forms.actions_section === "actions" && <p className={styles.note}>These forms come from the metadata&apos;s older actions section, which Pipeline no longer reads.</p>}
      {forms.actions.map((form, i) => (
        <ActionForm key={form.name} form={form} market={market} deploySlot={forms.deploy_slot} open={i === 0} />
      ))}
    </div>
  );
}
