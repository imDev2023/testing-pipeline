import type { FlagFact } from "terminal-api/contract";
import styles from "./Flags.module.css";

/**
 * Pipeline's trust flags in a list or a row (docs/spec/pipescope-screens.md, Feed): each flag's
 * name as Pipeline's SDK writes it, with its fixed description on hover; facts, never verdicts, so
 * none is coloured.
 */
export function FlagList({ flags, descriptions }: { flags: string[]; descriptions: ReadonlyMap<string, string> }) {
  if (!flags.length) return <span className={styles.none}>none</span>;
  return (
    <ul className={styles.list} aria-label="Trust flags">
      {flags.map((flag) => (
        <li key={flag} className={styles.flag} title={descriptions.get(flag)}>
          {flag}
        </li>
      ))}
    </ul>
  );
}

/** Flags with Pipeline's fixed description beside each, as the facts show them. */
export function FlagFacts({ facts }: { facts: FlagFact[] }) {
  if (!facts.length) return <p className={styles.none}>No trust flags.</p>;
  return (
    <ul className={styles.facts}>
      {facts.map(({ flag, description }) => (
        <li key={flag}>
          <span className={styles.flag}>{flag}</span>
          <span>{description}</span>
        </li>
      ))}
    </ul>
  );
}

/** Flag descriptions by flag, for lists that show the names alone. */
export const descriptionsOf = (facts: FlagFact[]) => new Map(facts.map((f) => [f.flag, f.description]));
