// A Canary outcome (docs/spec/pipescope-screens.md, Canary outcomes; PIPESCOPE-66): its word beside
// one of five small ink shapes that get heavier the more a trader needs to look. The shape is never
// shown without the word, and neither is ever coloured: both are drawn in the ink of the text.
import type { CanaryOutcome } from "terminal-api/contract";
import styles from "./Canary.module.css";

const SVG = { width: 12, height: 12, viewBox: "0 0 12 12", "aria-hidden": true, focusable: false } as const;

/** The five shapes: a solid disc, a ring with its lower half filled, a ring, a dashed ring and a short dash. */
function Shape({ outcome }: { outcome: CanaryOutcome }) {
  switch (outcome) {
    case "fail":
      return (
        <svg {...SVG} className={styles.shape}>
          <circle cx="6" cy="6" r="5" fill="currentColor" />
        </svg>
      );
    case "warn":
      return (
        <svg {...SVG} className={styles.shape}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M1.75 6a4.25 4.25 0 0 0 8.5 0z" fill="currentColor" />
        </svg>
      );
    case "pass":
      return (
        <svg {...SVG} className={styles.shape}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "not run":
      return (
        <svg {...SVG} className={styles.shape}>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2.25" />
        </svg>
      );
    case "noted":
      return (
        <svg {...SVG} className={styles.shape}>
          <rect x="2.5" y="5.25" width="7" height="1.5" fill="currentColor" />
        </svg>
      );
  }
}

const WEIGHT: Record<CanaryOutcome, string | undefined> = { fail: styles.fail, warn: styles.warn, pass: undefined, "not run": styles.quiet, noted: styles.quiet };

export function Outcome({ outcome }: { outcome: CanaryOutcome }) {
  return (
    <span className={[styles.outcome, WEIGHT[outcome]].filter(Boolean).join(" ")} data-outcome={outcome}>
      <Shape outcome={outcome} />
      <span className={styles.word}>{outcome}</span>
    </span>
  );
}

/** Canary's mark, in canary yellow, beside the heading of Canary's results and nowhere else (PIPESCOPE-67). */
export function CanaryMark() {
  return <span className={styles.mark} aria-hidden="true" data-canary="mark" />;
}
