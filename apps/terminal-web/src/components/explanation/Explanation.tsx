"use client";

// The explanation (docs/spec/pipescope-explainer.md, Presentation; docs/spec/pipescope-screens.md,
// Who is speaking, "Explanation, actions and facts" and Strategy page; EXPLAINER-14, EXPLAINER-15,
// EXPLAINER-16, EXPLAINER-20, PIPESCOPE-65; #127): presentation A, short first, beside the facts
// panel on the strategy page and on each market page.
//
// Above the text, the label the API writes; the summary, each sentence followed by its evidence
// chips; on a market page, the line saying it describes the strategy version; "What the evidence does
// not settle", always open; "Read the full explanation (N points)", closed, the points grouped by
// topic, an inferred point with a hollow bullet and an author point in the author's colour; the
// evidence it was given, whose row a chip opens and marks; and "This is wrong". Every sentence the
// model wrote is a text node in the serif, never markup. With no explanation for the version, one
// line says so; the notice about text addressed to AI tools shows either way.
import { useCallback, useId, useRef, useState, type ReactNode } from "react";
import { StrategyExplanation, type ExplanationClaim, type ExplanationSentence } from "terminal-api/contract";
import { getFromApi } from "@/api";
import { PanelFrame, useLoad } from "../Panel";
import { AiText, AuthorText } from "../Voice";
import styles from "./Explanation.module.css";
import { ReportWrong } from "./ReportWrong";

type Shown = NonNullable<StrategyExplanation["explanation"]>;

export const NO_EXPLANATION = "No explanation for this version yet.";
export const NO_EXPLANATION_LINE = "An explanation is written once for each strategy version, from the chain's facts and Canary's results, and only after its cost is approved. Opening a page never makes one.";
export const MARKET_LINE =
  'It describes the strategy version, not this market: where it says "the sampled market", it means the strategy\'s busiest one. This market\'s own facts are in the facts panel.';

/** The points' topics, in the order the full explanation lists them, each under its heading. */
export const TOPIC_TITLES: Readonly<Record<ExplanationClaim["topic"], string>> = {
  does: "What it does",
  control: "Who can change it",
  canary: "What Canary saw",
  protection: "What protects your trade",
  author: "What its author says",
};

/** "1 point", "5 points". */
const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The id of an evidence row on the page, which a chip points at. */
export const evidenceRowId = (id: string) => `explanation-evidence-${id}`;

/**
 * The explanation of a strategy's current version: as the page read it on the server, or, when that
 * read failed, loading on its own under its heading, with Try again.
 */
export function Explanation({ program, onMarket = false, read }: { program: string; onMarket?: boolean; read?: { ok: true; value: StrategyExplanation } | { ok: false; message: string } }) {
  if (read?.ok) return <ExplanationView data={read.value} onMarket={onMarket} />;
  return <LoadedExplanation program={program} onMarket={onMarket} />;
}

function LoadedExplanation({ program, onMarket }: { program: string; onMarket: boolean }) {
  const load = useCallback((signal: AbortSignal) => getFromApi(`/v1/strategies/${encodeURIComponent(program)}/explanation`, StrategyExplanation, { signal }), [program]);
  const { state, retry } = useLoad(load);
  return (
    <PanelFrame title="Explanation" what="the explanation" state={state} retry={retry}>
      {(data) => <ExplanationBody data={data} onMarket={onMarket} />}
    </PanelFrame>
  );
}

/** The explanation as a panel, from what the API served (the pages load it through `Explanation`). */
export function ExplanationView({ data, onMarket = false }: { data: StrategyExplanation; onMarket?: boolean }) {
  return (
    <PanelFrame title="Explanation" what="the explanation" state={{ status: "loaded", data }} retry={() => {}}>
      {(loaded) => <ExplanationBody data={loaded} onMarket={onMarket} />}
    </PanelFrame>
  );
}

function ExplanationBody({ data, onMarket }: { data: StrategyExplanation; onMarket: boolean }) {
  const notice = data.ai_notice && (
    <p className={styles.notice} role="note">
      {data.ai_notice}
    </p>
  );
  if (!data.explanation) {
    return (
      <>
        {notice}
        <p className={styles.none}>{NO_EXPLANATION}</p>
        <p className={styles.note}>{NO_EXPLANATION_LINE}</p>
      </>
    );
  }
  return <Shown explanation={data.explanation} notice={notice} onMarket={onMarket} />;
}

function Shown({ explanation, notice, onMarket }: { explanation: Shown; notice: ReactNode; onMarket: boolean }) {
  const [marked, setMarked] = useState<string | null>(null);
  const unknownsHeading = useId();
  const evidence = useRef<HTMLDetailsElement>(null);
  const known = new Set(explanation.evidence.map((e) => e.id));

  /**
   * A chip: opens the evidence, marks the row it cites, and brings it into view with the focus on it.
   * The page jumps rather than glides: on a long phone page a smooth scroll is cut short by the
   * panels around it settling, and stops with the row still out of sight; a jump also moves nothing
   * for a reader who asked for reduced motion.
   */
  const show = useCallback((id: string) => {
    setMarked(id);
    if (evidence.current) evidence.current.open = true;
    requestAnimationFrame(() => {
      const row = document.getElementById(evidenceRowId(id));
      if (!row) return;
      row.scrollIntoView({ block: "center", behavior: "instant" });
      row.focus({ preventScroll: true });
    });
  }, []);

  const chips = (ids: readonly string[]) => <Chips ids={ids.filter((id) => known.has(id))} onShow={show} />;
  const topics = (Object.keys(TOPIC_TITLES) as ExplanationClaim["topic"][]).map((topic) => ({ topic, claims: explanation.claims.filter((c) => c.topic === topic) })).filter((t) => t.claims.length);

  return (
    <>
      <p className={styles.label}>{explanation.label}</p>
      {notice}
      <p className={styles.summary}>
        {explanation.summary.map((s, i) => (
          <span key={i}>
            {i > 0 && " "}
            <AiText>{s.text}</AiText> {chips(s.evidence)}
          </span>
        ))}
      </p>
      {onMarket && <p className={styles.note}>{MARKET_LINE}</p>}
      <section className={styles.part} aria-labelledby={unknownsHeading}>
        <h3 id={unknownsHeading} className={styles.partTitle}>
          What the evidence does not settle
        </h3>
        {explanation.unknowns.length ? (
          <Sentences items={explanation.unknowns} className={styles.unknowns} chips={chips} />
        ) : (
          <p className={styles.note}>The explanation lists nothing the evidence leaves open.</p>
        )}
      </section>
      <details className={styles.more}>
        <summary>Read the full explanation ({count(explanation.claims.length, "point")})</summary>
        <p className={styles.key} aria-hidden="true">
          <span className={`${styles.keyItem} ${styles.confirmed}`}>stated by the evidence</span>
          <span className={`${styles.keyItem} ${styles.inferred}`}>inferred from it</span>
          <span className={`${styles.keyItem} ${styles.author}`}>the author&apos;s own words, unverified</span>
        </p>
        {topics.map(({ topic, claims }) => (
          <section key={topic} className={styles.topic} aria-label={TOPIC_TITLES[topic]}>
            <h4 className={styles.topicTitle}>{TOPIC_TITLES[topic]}</h4>
            <ul className={styles.claims}>
              {claims.map((c, i) => (
                <li key={i} className={`${styles.claim} ${styles[c.basis]}`} data-basis={c.basis}>
                  <AiText>{c.text}</AiText> {chips(c.evidence)}
                  {c.basis !== "confirmed" && <span className={styles.basis}>{c.basis === "inferred" ? "inferred" : "the author's words"}</span>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </details>
      <details className={styles.more} ref={evidence}>
        <summary>The evidence it was given ({count(explanation.evidence.length, "item")})</summary>
        <p className={styles.note}>What the model read, each item under the id its sentences cite, with where Aviary read it. Author text is set in the author&apos;s style and is not verified.</p>
        <div className={styles.evidence} role="list" aria-label="The evidence it was given">
          {explanation.evidence.map((e) => (
            <div key={e.id} id={evidenceRowId(e.id)} role="listitem" tabIndex={-1} className={styles.row} data-marked={marked === e.id || undefined}>
              <code className={styles.id}>{e.id}</code>
              <span className={styles.rowLabel}>{e.label}</span>
              <span className={styles.value}>
                {e.author ? <AuthorText>{e.value}</AuthorText> : e.value}
                <span className={styles.source}>{e.source}</span>
              </span>
            </div>
          ))}
        </div>
      </details>
      <ReportWrong explanationKey={explanation.key} />
    </>
  );
}

function Sentences({ items, className, chips }: { items: ExplanationSentence[]; className: string | undefined; chips: (ids: readonly string[]) => ReactNode }) {
  return (
    <ul className={className}>
      {items.map((s, i) => (
        <li key={i}>
          <AiText>{s.text}</AiText> {chips(s.evidence)}
        </li>
      ))}
    </ul>
  );
}

/** A sentence's evidence chips: each names an item and shows its row. */
function Chips({ ids, onShow }: { ids: readonly string[]; onShow: (id: string) => void }) {
  return (
    <span className={styles.chips}>
      {ids.map((id) => (
        <button key={id} type="button" className={styles.chip} aria-controls={evidenceRowId(id)} aria-label={`Show evidence ${id}`} title="Show the evidence this sentence cites" onClick={() => onShow(id)}>
          {id}
        </button>
      ))}
    </span>
  );
}
