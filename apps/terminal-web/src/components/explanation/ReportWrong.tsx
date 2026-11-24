"use client";

// "This is wrong" (docs/spec/pipescope-explainer.md, Presentation; EXPLAINER-15; #127): under every
// explanation, a report against its key, with an optional note, which reaches the owner through
// `pnpm explainer:reports`. The API limits reports per address and says how long to wait.
import { useId, useState, type FormEvent } from "react";
import { ExplanationReportReceived, REPORT_NOTE_MAX } from "terminal-api/contract";
import { ApiFailure, postToApi } from "@/api";
import { BRAND } from "@/brand";
import styles from "./Explanation.module.css";

export const REPORT_SENT = `Report sent. It reaches ${BRAND.name}'s owner with this explanation's key, which names the strategy version, the prompt and the model it came from.`;

type State = { step: "closed" } | { step: "open"; failure: string | null } | { step: "sending" } | { step: "sent" };

export function ReportWrong({ explanationKey }: { explanationKey: string }) {
  const [state, setState] = useState<State>({ step: "closed" });
  const [note, setNote] = useState("");
  const field = useId();

  if (state.step === "closed") {
    return (
      <div className={styles.wrong}>
        <button type="button" onClick={() => setState({ step: "open", failure: null })}>
          This is wrong
        </button>
      </div>
    );
  }
  if (state.step === "sent") {
    return (
      <p className={`${styles.wrong} ${styles.sent}`} role="status">
        {REPORT_SENT}
      </p>
    );
  }

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setState({ step: "sending" });
    try {
      await postToApi(`/v1/explanations/${encodeURIComponent(explanationKey)}/reports`, note.trim() ? { note: note.trim() } : {}, ExplanationReportReceived);
      setState({ step: "sent" });
    } catch (err) {
      setState({ step: "open", failure: err instanceof ApiFailure ? err.message : "The report could not be sent." });
    }
  };
  return (
    <form className={styles.wrong} onSubmit={send} aria-label="Report this explanation">
      <label htmlFor={field}>What is wrong with this explanation? (optional)</label>
      <textarea id={field} rows={3} maxLength={REPORT_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
      {state.step === "open" && state.failure && (
        <p role="alert" className={styles.failure}>
          Could not send the report. {state.failure}
        </p>
      )}
      <div className={styles.wrongActions}>
        <button type="button" onClick={() => setState({ step: "closed" })} disabled={state.step === "sending"}>
          Cancel
        </button>
        <button type="submit" className={styles.primary} disabled={state.step === "sending"}>
          {state.step === "sending" ? "Sending…" : "Send report"}
        </button>
      </div>
    </form>
  );
}
