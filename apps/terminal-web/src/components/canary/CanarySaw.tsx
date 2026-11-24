// "What Canary saw", the facts panel's first part on a market page (docs/spec/pipescope-screens.md,
// Explanation, actions and facts; PIPESCOPE-17, PIPESCOPE-66, PIPESCOPE-67; #125): Canary's mark in
// canary yellow beside its heading, its opening sentence, then the fails, open, then the warns, then
// what was not run with like reasons folded into one line, and last, behind a disclosure, the checks
// that passed and what Canary only noted. Each result is its outcome, its plain name and the sentence
// code wrote for it; opened, a row per size, wait, wallet or buyer with its bar in ink, each refusal
// with who refused and the error, and a last line naming the check, the run and the strategy version.
// Every word is the API's (./canaryView in terminal-api), so the page and the bot say the same.
import type { CanaryRefusal, CanaryResult, CanaryResults, MarketMint } from "terminal-api/contract";
import { formatDate, formatPercentPpm } from "@/format";
import { MintLabel } from "../MintLabel";
import { ShortAddress } from "../ShortAddress";
import { CanaryMark, Outcome } from "./Outcome";
import { CodeText } from "./CodeText";
import styles from "./CanarySaw.module.css";

type Mint = Pick<MarketMint, "mint" | "symbol" | "token">;

/** Canary's heading, with its mark: the one place on a page besides the trade box's notice where canary yellow appears. */
export function CanaryHeading({ level = 3, children }: { level?: 2 | 3; children: string }) {
  const Tag = level === 2 ? "h2" : "h3";
  return (
    <Tag className={level === 2 ? `${styles.heading} ${styles.panelHeading}` : styles.heading}>
      <CanaryMark />
      {children}
    </Tag>
  );
}

export function CanarySaw({ canary, mints }: { canary: CanaryResults; mints: readonly Mint[] }) {
  const { summary, results } = canary;
  return (
    <section className={styles.saw} aria-label="What Canary saw">
      <CanaryHeading>What Canary saw</CanaryHeading>
      {!summary ? (
        <p className={styles.about}>{canary.upgrade ? "Tests for this version are pending. Canary runs every market of a new version once the version is recorded, and its results will be here." : "Canary has not run on this market yet."}</p>
      ) : (
        <>
          <p className={styles.about}>
            Canary traded a private copy of this market on {formatDate(new Date(summary.run_at))}, as a trader would, and recorded what happened. It detects; it cannot prove a market safe, and a result is no promise about a later
            trade or a later version.
          </p>
          <Results results={results} mints={mints} />
        </>
      )}
    </section>
  );
}

function Results({ results, mints }: { results: readonly CanaryResult[]; mints: readonly Mint[] }) {
  const fails = results.filter((r) => r.outcome === "fail");
  const warns = results.filter((r) => r.outcome === "warn");
  const rest = results.filter((r) => r.outcome === "pass" || r.outcome === "noted");
  // What was not run, folded by its reason, in the order the first of each appears.
  const notRun = new Map<string, CanaryResult[]>();
  for (const r of results.filter((r) => r.outcome === "not run")) notRun.set(r.reason, [...(notRun.get(r.reason) ?? []), r]);
  return (
    <div className={styles.results}>
      {fails.map((r) => (
        <Result key={r.check} result={r} mints={mints} open />
      ))}
      {warns.map((r) => (
        <Result key={r.check} result={r} mints={mints} />
      ))}
      {[...notRun].map(([reason, list]) =>
        list.length === 1 ? (
          <Result key={reason} result={list[0]!} mints={mints} />
        ) : (
          <div key={reason} className={styles.folded} data-not-run={reason}>
            <span className={styles.outcomeCell}>
              <Outcome outcome="not run" />
            </span>
            <span className={styles.body}>
              <span className={styles.name}>{list.map((r) => r.name).join(", ")}</span>
              <span className={styles.reason}>{reason}</span>
            </span>
          </div>
        ),
      )}
      {rest.length > 0 && (
        <details className={styles.more}>
          <summary>The checks that passed, and what Canary only noted</summary>
          {rest.map((r) => (
            <Result key={r.check} result={r} mints={mints} />
          ))}
        </details>
      )}
    </div>
  );
}

function Result({ result: r, mints, open = false }: { result: CanaryResult; mints: readonly Mint[]; open?: boolean }) {
  return (
    <details className={styles.result} open={open} data-check={r.check} {...(r.outcome === "not run" ? { "data-not-run": r.reason } : {})}>
      <summary>
        <span className={styles.outcomeCell}>
          <Outcome outcome={r.outcome} />
        </span>
        <span className={styles.body}>
          <span className={styles.name}>{r.name}</span>
          <span className={styles.reason}>{r.reason}</span>
        </span>
      </summary>
      <div className={styles.detail}>
        {r.steps.map((group, i) => (
          <Steps key={i} group={group} mints={mints} pairs={r.steps.length} />
        ))}
        {r.refusals.map((refusal, i) => (
          <Refusal key={i} refusal={refusal} />
        ))}
        <p className={styles.meta}>
          <CodeText>{r.about}</CodeText> {r.ran}
        </p>
      </div>
    </details>
  );
}

/** A row per step, as its label, a bar in ink and what came back: the chart and its own table. */
function Steps({ group, mints, pairs }: { group: CanaryResult["steps"][number]; mints: readonly Mint[]; pairs: number }) {
  const against = group.pair === null ? undefined : mints[group.pair];
  return (
    <table className={styles.bars}>
      {pairs > 1 && against && (
        <caption>
          Against <MintLabel mint={against.mint} symbol={against.symbol} token={against.token} />
        </caption>
      )}
      <tbody>
        {group.steps.map((step, i) => (
          <tr key={i} data-state={step.state}>
            <th scope="row">{step.label}</th>
            <td className={styles.barCell}>
              <span className={step.state === "back" ? styles.track : `${styles.track} ${styles.hatched}`}>
                {step.return_ppm !== null && <span className={styles.fill} style={{ width: `${Math.max(0, Math.min(100, step.return_ppm / 10_000))}%` }} />}
              </span>
            </td>
            <td className={step.state === "back" ? styles.value : `${styles.value} ${styles.stuck}`}>
              {step.state === "back"
                ? step.return_ppm === null
                  ? "sold back"
                  : `${formatPercentPpm(step.return_ppm)} back`
                : step.state === "stuck"
                  ? "could not sell back"
                  : step.state === "not bought"
                    ? "could not be bought"
                    : "did not round-trip"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Who refused a step, the error's name, number and message, and where it was raised. */
function Refusal({ refusal: f }: { refusal: CanaryRefusal }) {
  const error = f.name ? `${f.name}${f.number === null ? "" : ` (${f.number})`}${f.message ? `: ${f.message}` : ""}` : (f.raw ?? (f.number === null ? "unknown" : `error ${f.number}`));
  return (
    <dl className={styles.refusal}>
      <div>
        <dt>Refused by</dt>
        <dd>
          {f.by}
          {f.program && (
            <>
              , program <ShortAddress address={f.program} />
            </>
          )}
        </dd>
      </div>
      <div>
        <dt>Its error</dt>
        <dd>
          <code>{error}</code>
        </dd>
      </div>
      {(f.stage || f.origin) && (
        <div>
          <dt>Where</dt>
          <dd>{[f.stage && `At ${f.stage}`, f.origin].filter(Boolean).join(", ")}</dd>
        </div>
      )}
    </dl>
  );
}
