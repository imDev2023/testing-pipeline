// "What Canary saw on this version", on a strategy page (docs/spec/pipescope-screens.md, Strategy
// page; PIPESCOPE-80; #125): one sentence first, then one line for each check in the fixed order, its
// plain name, what it does, and how many of the version's markets got each outcome ("fail, 6 of 8"),
// which says how widely one finding holds and is not a score of the strategy. A line with a fail or a
// warn opens to the markets it holds for, each linked, with its sentence. Pipeline's conformance
// report keeps the counts its checker prints, in each market's sentence.
import Link from "next/link";
import type { CanaryOutcome, CanaryRollup } from "terminal-api/contract";
import { formatDayOf, formatInteger, formatPercentPpm } from "@/format";
import { ROUTES } from "@/routes";
import { ShortAddress } from "../ShortAddress";
import { CanaryHeading } from "./CanarySaw";
import { CodeText, whatItDoes } from "./CodeText";
import { Outcome } from "./Outcome";
import styles from "./VersionCanary.module.css";

const ORDER: readonly CanaryOutcome[] = ["fail", "warn", "not run", "pass", "noted"];

/** How many of the version's markets: "6 of 8", or all of them in words. */
function share(n: number, total: number): string {
  if (n !== total) return `${formatInteger(n)} of ${formatInteger(total)}`;
  return total === 1 ? "the one market" : total === 2 ? "both markets" : `all ${formatInteger(total)} markets`;
}

/** The section's opening sentence, from the version's summary. */
function opening(rollup: CanaryRollup): string {
  const s = rollup.summary!;
  const parts = [`Canary traded a private copy of ${s.markets === 1 ? "this version's one market" : `each of this version's ${formatInteger(s.markets)} markets`} on ${formatDayOf(new Date(s.run_at))}, as a trader would.`];
  if (s.stranded > 0) parts.push(`${s.stranded === s.markets ? (s.markets === 1 ? "It" : "All of them") : `${formatInteger(s.stranded)} of ${formatInteger(s.markets)}`} cannot be read by this version.`);
  if (s.ordinary) {
    const range = s.ordinary.min_ppm === s.ordinary.max_ppm ? formatPercentPpm(s.ordinary.min_ppm) : `${formatPercentPpm(s.ordinary.min_ppm)} to ${formatPercentPpm(s.ordinary.max_ppm)}`;
    parts.push(`On the markets that trade, a ${s.ordinary.amount_words} buy sold straight back returned ${range}.`);
  } else parts.push("None of them trades.");
  parts.push("Canary detects; it cannot prove a strategy safe.");
  return parts.join(" ");
}

export function VersionCanary({ rollup }: { rollup: CanaryRollup }) {
  const lines = Object.entries(rollup.checks).sort(([, a], [, b]) => a.rank - b.rank);
  return (
    <section className={styles.section} aria-label="What Canary saw on this version">
      <CanaryHeading level={2}>What Canary saw on this version</CanaryHeading>
      {!rollup.summary ? (
        <p className={styles.about}>{rollup.upgrade ? "Tests for this version are pending. Canary runs every market of a new version once the version is recorded, and its results will be here." : "Canary has not run on this version's markets yet."}</p>
      ) : (
        <>
          <p className={styles.about}>{opening(rollup)}</p>
          <div className={styles.lines}>
            {lines.map(([check, line]) => {
              const summary = (
                <>
                  <span className={styles.what}>
                    <span className={styles.name}>{line.name}</span>
                    <span className={styles.does}>
                      <CodeText>{whatItDoes(line.about)}</CodeText>
                    </span>
                  </span>
                  <span className={styles.counts}>
                    {ORDER.filter((o) => line.outcomes[o]).map((o) => (
                      <span key={o} className={styles.count}>
                        <Outcome outcome={o} /> <span>{share(line.outcomes[o]!, rollup.markets)}</span>
                      </span>
                    ))}
                  </span>
                </>
              );
              if (!line.held.length)
                return (
                  <div key={check} className={styles.line} data-check={check}>
                    {summary}
                  </div>
                );
              return (
                <details key={check} className={styles.line} data-check={check}>
                  <summary>{summary}</summary>
                  <ul className={styles.held}>
                    {[...line.held]
                      .sort((a, b) => ORDER.indexOf(a.outcome) - ORDER.indexOf(b.outcome))
                      .map((h) => (
                        <li key={h.market}>
                          <Outcome outcome={h.outcome} />
                          <span>
                            <Link href={ROUTES.market(h.market)}>
                              Market <ShortAddress address={h.market} />
                            </Link>
                            : {h.reason}
                          </span>
                        </li>
                      ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
