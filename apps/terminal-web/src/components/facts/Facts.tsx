import type { ReactNode } from "react";
import styles from "./Facts.module.css";

export type Fact = { name: string; value: ReactNode };

/**
 * A list of facts, each its name beside its value, and one under the other at the width theme.css
 * names (docs/spec/pipescope-screens.md, "Explanation, actions and facts").
 */
export function FactList({ facts, label }: { facts: (Fact | null | false)[]; label?: string }) {
  return (
    <dl className={styles.facts} aria-label={label}>
      {facts
        .filter((f): f is Fact => !!f)
        .map(({ name, value }) => (
          <div key={name} className={styles.fact}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** A part of the facts, under its heading. */
export function FactPart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.part} aria-label={title}>
      <h3 className={styles.partTitle}>{title}</h3>
      {children}
    </section>
  );
}
