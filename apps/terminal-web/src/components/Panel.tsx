"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiFailure } from "@/api";
import styles from "./Panel.module.css";

type State<T> = { status: "loading" } | { status: "failed"; message: string } | { status: "loaded"; data: T };

/**
 * A panel that loads on its own under its heading, so a slow panel never blanks the page, and that
 * says what could not be loaded and offers to try again when it fails (docs/spec/pipescope-screens.md,
 * "On every page"). `what` names what it loads, as a sentence would: "devnet's latest slot".
 */
export function Panel<T>({ title, what, load, children }: { title: string; what: string; load: (signal: AbortSignal) => Promise<T>; children: (data: T) => ReactNode }) {
  const [state, setState] = useState<State<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).then(
      (data) => setState({ status: "loaded", data }),
      (e: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "failed", message: e instanceof ApiFailure ? e.message : "Something went wrong on this page." });
      },
    );
    return () => controller.abort();
  }, [load, attempt]);

  const heading = `panel-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
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
    </section>
  );
}
