import type { MetadataStatus } from "terminal-api/contract";
import { ShortAddress } from "./ShortAddress";
import styles from "./StrategyName.module.css";
import { AuthorText } from "./Voice";

/**
 * A strategy as every page names it (docs/spec/pipescope.md, "Listing"; PIPESCOPE-06, PIPESCOPE-65):
 * by the name its valid metadata gives, the author's words set in the author's style and always
 * beside its short address; or, without valid metadata, by its short address with "Metadata
 * unavailable", set plainly. In a table (`lines`), each is a line of its own.
 */
export function StrategyName({ program, name, metadata, lines = false }: { program: string; name: string | null; metadata: MetadataStatus["status"]; lines?: boolean }) {
  const note = metadata === "not-fetched" ? "Metadata not read yet" : "Metadata unavailable";
  if (lines) {
    return (
      <span className={styles.lines}>
        {name ? (
          <>
            <span className={styles.line}>
              <AuthorText>{name}</AuthorText>
            </span>
            <span className={styles.line}>
              <ShortAddress address={program} />
            </span>
          </>
        ) : (
          <>
            <span className={styles.line}>
              <ShortAddress address={program} />
            </span>
            <span className={`${styles.line} ${styles.note}`}>{note}</span>
          </>
        )}
      </span>
    );
  }
  return (
    <span className={styles.name}>
      {name ? (
        <>
          <AuthorText>{name}</AuthorText> <ShortAddress address={program} />
        </>
      ) : (
        <>
          <ShortAddress address={program} /> <span className={styles.note}>{note}</span>
        </>
      )}
    </span>
  );
}
