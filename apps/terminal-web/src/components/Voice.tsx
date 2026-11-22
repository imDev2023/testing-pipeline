import type { ReactNode } from "react";
import styles from "./Voice.module.css";

// Who is speaking (PIPESCOPE-65, docs/spec/pipescope-screens.md, "Who is speaking"): what Aviary read
// or measured is set plainly; what an AI wrote, in the serif a size larger; what an author wrote, in
// purple italic and always as plain text. Nothing of Aviary's own is ever set in either of the last two.

/** Text an AI wrote from the facts (an explanation). */
export function AiText({ children }: { children: ReactNode }) {
  return <span className={styles.ai}>{children}</span>;
}

/** Text a strategy's or token's author wrote: rendered as plain text, never as markup. */
export function AuthorText({ children }: { children: string }) {
  return <span className={styles.author}>{children}</span>;
}
