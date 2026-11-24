import styles from "./Forms.module.css";

/**
 * An outcome as its word beside its ink shape (docs/spec/pipescope-screens.md, Canary outcomes): a ring
 * for a pass, a ring with its lower half filled for a warn; the shape is never shown without the
 * word, and neither is ever coloured.
 */
export function Outcome({ outcome }: { outcome: "pass" | "warn" }) {
  return (
    <span className={styles.outcome}>
      <span className={styles.shape} data-outcome={outcome} aria-hidden="true" />
      {outcome}
    </span>
  );
}
