// What a row says about Canary (docs/spec/pipescope-screens.md, What a row says about Canary;
// PIPESCOPE-71): the ordinary trade's return as a number, "98.5% back", and beside it at most one
// result, the one a trader most needs, as an outcome and a short phrase, both chosen by the API. A row
// never shows a count of outcomes, because a count reads as a score.
import type { MarketCanary, StrategyCanary } from "terminal-api/contract";
import { formatPercentPpm } from "@/format";
import { Outcome } from "./Outcome";
import styles from "./Canary.module.css";

export function CanaryCell({ canary }: { canary: MarketCanary | null }) {
  if (!canary) return <span className={styles.none}>Not run yet</span>;
  return (
    <span className={styles.cell}>
      {canary.ordinary && <span className={styles.back}>{formatPercentPpm(canary.ordinary.return_ppm)} back</span>}
      {canary.lead && (
        <span className={styles.lead}>
          <Outcome outcome={canary.lead.outcome} /> <span className={styles.phrase}>{canary.lead.phrase}</span>
        </span>
      )}
    </span>
  );
}

/**
 * What a strategy's row says about Canary (docs/spec/pipescope-screens.md, Feed): the range of the
 * ordinary trade's return over its current version's markets that trade, and how many of its markets
 * that version cannot read. A count of markets, never of outcomes.
 */
export function StrategyCanaryCell({ canary }: { canary: StrategyCanary | null }) {
  if (!canary) return <span className={styles.none}>Not run yet</span>;
  const { ordinary, stranded, markets } = canary;
  const range = ordinary && (ordinary.min_ppm === ordinary.max_ppm ? formatPercentPpm(ordinary.min_ppm) : `${formatPercentPpm(ordinary.min_ppm)} to ${formatPercentPpm(ordinary.max_ppm)}`);
  return (
    <span className={styles.cell}>
      {range ? <span className={styles.back}>{range} back</span> : <span className={styles.none}>No market trades</span>}
      {stranded > 0 && (
        <span className={styles.lead}>
          {stranded === markets ? (markets === 1 ? "Its one market" : `All ${markets} markets`) : `${stranded} of ${markets} markets`} cannot be read by this version
        </span>
      )}
    </span>
  );
}
