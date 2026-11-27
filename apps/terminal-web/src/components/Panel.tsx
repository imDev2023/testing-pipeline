"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiFailure } from "@/api";
import styles from "./Panel.module.css";

export type Loaded<T> = { status: "loading" } | { status: "failed"; message: string } | { status: "loaded"; data: T };

/**
 * Loads once per mount and again on `retry`, keeping what a panel needs to say: still loading, what
 * failed, or the data; `refresh` loads again behind what is shown, which stays if that load fails.
 * Several panels fed by one answer share one of these.
 */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>): { state: Loaded<T>; retry: () => void; refresh: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState({ n: 0, quiet: false });
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt(({ n }) => ({ n: n + 1, quiet: false }));
  }, []);
  const refresh = useCallback(() => setAttempt(({ n }) => ({ n: n + 1, quiet: true })), []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => setState({ status: "loaded", data }),
      (e: unknown) => {
        if (controller.signal.aborted) return;
        const failed = { status: "failed", message: e instanceof ApiFailure ? e.message : "Something went wrong on this page." } as const;
        setState((now) => (attempt.quiet && now.status === "loaded" ? now : failed));
      },
    );
    return () => controller.abort();
  }, [load, attempt]);

  return { state, retry, refresh };
}

/**
 * A panel under its heading that shows its own loading and failure, so a slow panel never blanks the
 * page, and that says what could not be loaded and offers to try again when it fails
 * (docs/spec/pipescope-screens.md, "On every page"). `what` names what it loads, as a sentence
 * would: "devnet's latest slot".
 */
const headingOf = (title: string) => `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

/** A panel under its heading whose content is already in hand, so it neither loads nor fails as a whole. */
export function StaticPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.panel} aria-labelledby={headingOf(title)}>
      <h2 id={headingOf(title)} className={styles.title}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** `after` is shown under the panel's own content whatever its state, as content that does not wait for it. */
export function PanelFrame<T>({ title, what, state, retry, children, after }: { title: string; what: string; state: Loaded<T>; retry: () => void; children: (data: T) => ReactNode; after?: ReactNode }) {
  const heading = headingOf(title);
  return (
    <section className={styles.panel} aria-labelledby={heading} aria-busy={state.status === "loading"}>
      <h2 id={heading} className={styles.title}>
        {title}
      </h2>
      {state.status === "loading" && <p className={styles.note}>Loading {what}…</p>}
      {state.status === "failed" && (
        <div className={styles.failed} role="alert">
          <p>
            Could not load {what}. {state.message}
          </p>
          <button type="button" onClick={retry}>
            Try again
          </button>
        </div>
      )}
      {state.status === "loaded" && children(state.data)}
      {after}
    </section>
  );
}

/** A panel that loads its own data. */
export function Panel<T>({ title, what, load, children }: { title: string; what: string; load: (signal: AbortSignal) => Promise<T>; children: (data: T) => ReactNode }) {
  const { state, retry } = useLoad(load);
  return (
    <PanelFrame title={title} what={what} state={state} retry={retry}>
      {children}
    </PanelFrame>
  );
}
