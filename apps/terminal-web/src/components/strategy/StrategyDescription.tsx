import { BRAND } from "@/brand";
import { AuthorText } from "../Voice";
import page from "./Strategy.module.css";

/**
 * A strategy's description under its name, in the author's style (PIPESCOPE-120). When the
 * normaliser cut it at its cap (EXPLAINER-08), Aviary says so after it, plainly, so the reader
 * never takes a word stopped short for the author's own.
 */
export function StrategyDescription({ text, cut }: { text: string; cut: boolean }) {
  return (
    <p className={page.description}>
      <AuthorText>{text}</AuthorText>
      {cut && <span className={page.cut}>… {BRAND.name} cut the author&apos;s description at its length cap.</span>}
    </p>
  );
}
