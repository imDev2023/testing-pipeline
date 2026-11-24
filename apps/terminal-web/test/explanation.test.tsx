// The explanation on the strategy and market pages (docs/spec/pipescope-explainer.md, Presentation;
// docs/spec/pipescope-screens.md, Who is speaking and "Explanation, actions and facts"; EXPLAINER-14,
// EXPLAINER-15, EXPLAINER-16, EXPLAINER-20, PIPESCOPE-65; #127), rendered as the pages render it:
// presentation A, every model sentence a text node in the serif, chips that point at the evidence
// rows, the claims grouped by topic, and the fixed lines Aviary writes itself.
import { renderToStaticMarkup } from "react-dom/server";
import type { StrategyExplanation } from "terminal-api/contract";
import { badOutput, hostileInputs, hostileOutputs, samples } from "terminal-explainer/fixtures";
import { describe, expect, it } from "vitest";
import { UpgradeNotice } from "@/components/canary/MarketCanary";
import { StrategyDescription } from "@/components/strategy/StrategyDescription";
import { evidenceRowId, ExplanationView, MARKET_LINE, NO_EXPLANATION, NO_EXPLANATION_LINE, TOPIC_TITLES } from "@/components/explanation/Explanation";

const PROGRAM = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const LABEL = "Written by an AI on 24 Nov 2026 from on-chain data and Canary results for this strategy version (deployed in slot 520,151,682). It can be wrong. It is not an audit, a safety rating or advice.";

/** An explanation as the API serves it, from a recorded output and the evidence it was written from. */
function served(output: ReturnType<typeof badOutput>, evidence: { id: string; label: string; value: string; source: string }[], aiNotice: string | null = null): StrategyExplanation {
  return {
    program: PROGRAM,
    deploy_slot: 520_151_682,
    ai_notice: aiNotice,
    explanation: {
      key: "ab".repeat(32),
      deploy_slot: 520_151_682,
      written_at: "2026-11-24T09:15:00.000Z",
      label: LABEL,
      summary: output.summary,
      claims: output.claims,
      unknowns: output.unknowns,
      evidence: evidence.map((e) => ({ ...e, author: e.id.startsWith("A") })),
    },
  };
}

/** The text of rendered markup, its entities read back. */
const textOf = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

describe("a recorded hostile output with markup", () => {
  const hostile = hostileOutputs["html-and-markdown"]!;
  const html = renderToStaticMarkup(<ExplanationView data={served(badOutput(hostile), hostileInputs[hostile.metadata]!.evidence)} />);

  it("renders as text: its markup and Markdown are the characters they are, and make no element", () => {
    expect(html).not.toMatch(/<script|<strong|<b>|<em>/);
    expect(textOf(html)).toContain(hostile.claim.text);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;**Bold**");
  });
});

/** Every span of AI-written text, by its text. */
const aiTexts = (html: string) => [...html.matchAll(/<span class="_ai_[^"]*">([^<]*)<\/span>/g)].map((m) => textOf(m[1]!));
/** Each chip's evidence id, with the row it points at. */
const chipsOf = (html: string) => [...html.matchAll(/<button[^>]*aria-controls="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map((m) => ({ controls: m[1]!, id: m[2]! }));

describe("a recorded sample explanation", () => {
  const sample = samples["constant-product"]!;
  const output = sample.outputs.pass;
  const data = served(output, sample.evidence);
  const html = renderToStaticMarkup(<ExplanationView data={data} />);

  it("starts with the label the API wrote, plainly, before the summary", () => {
    expect(html.indexOf(LABEL)).toBeGreaterThan(-1);
    expect(html.indexOf(LABEL)).toBeLessThan(html.indexOf(output.summary[0]!.text.replaceAll("'", "&#x27;").replaceAll('"', "&quot;")));
    expect(html).not.toMatch(new RegExp(`<span class="_ai_[^"]*">${LABEL.slice(0, 20)}`));
  });

  it("sets every sentence the model wrote in the AI's style, each a text node of its own, and nothing else in it", () => {
    const sentences = [...output.summary, ...output.unknowns, ...output.claims].map((s) => s.text);
    expect(aiTexts(html).sort()).toEqual(sentences.sort());
  });

  it("follows each sentence with a chip for each item it cites, each pointing at that item's row in the evidence", () => {
    const chips = chipsOf(html);
    const cited = [...output.summary, ...output.unknowns, ...output.claims].flatMap((s) => s.evidence);
    expect(chips.map((c) => c.id)).toEqual(cited);
    for (const chip of chips) {
      expect(chip.controls).toBe(evidenceRowId(chip.id));
      expect(html).toContain(`id="${evidenceRowId(chip.id)}"`);
    }
  });

  it("keeps the unknowns open under their heading, and the full explanation closed under its count", () => {
    const unknowns = html.indexOf("What the evidence does not settle");
    const full = html.indexOf(`Read the full explanation (${output.claims.length} points)`);
    expect(unknowns).toBeGreaterThan(-1);
    expect(full).toBeGreaterThan(unknowns);
    // The unknowns come before any disclosure, so they are always visible; no disclosure starts open.
    expect(html.indexOf("<details")).toBeGreaterThan(html.search(/<ul class="_unknowns_[^"]*">.*?<\/ul>/));
    expect(html.search(/<details[^>]*>(?:(?!<\/details>).)*_unknowns_/)).toBe(-1);
    expect(html).not.toMatch(/<details[^>]* open/);
  });

  it("groups the points under their topics in the spec's order, an inferred point hollow and an author point in the author's style", () => {
    const titles = ["What it does", "Who can change it", "What Canary saw", "What protects your trade", "What its author says"].filter((t) => output.claims.some((c) => TOPIC_TITLES[c.topic] === t));
    const at = titles.map((t) => html.search(new RegExp(`<h4 class="_topicTitle_[^"]*">${t}</h4>`)));
    expect(at.every((n) => n > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    for (const basis of ["confirmed", "inferred", "author"] as const) {
      const count = output.claims.filter((c) => c.basis === basis).length;
      expect([...html.matchAll(new RegExp(`<li class="_claim_[^"]* _${basis}_[^"]*" data-basis="${basis}">`, "g"))]).toHaveLength(count);
    }
  });

  it("lists every item of the evidence it was given, author text in the author's style", () => {
    for (const e of sample.evidence) expect(html).toContain(`id="${evidenceRowId(e.id)}"`);
    const authorValues = [...html.matchAll(/<span class="_author_[^"]*">([^<]*)<\/span>/g)].map((m) => textOf(m[1]!));
    expect(authorValues.sort()).toEqual(sample.evidence.filter((e) => e.id.startsWith("A")).map((e) => e.value).sort());
  });

  it("offers \"This is wrong\" under it", () => {
    expect(textOf(html)).toMatch(/This is wrong$/);
  });

  it("says on a market page that it describes the strategy version, and only there", () => {
    expect(textOf(html)).not.toContain(MARKET_LINE);
    const market = renderToStaticMarkup(<ExplanationView data={data} onMarket />);
    const text = textOf(market);
    expect(text.indexOf(MARKET_LINE)).toBeGreaterThan(text.indexOf(output.summary.at(-1)!.text));
    expect(text.indexOf(MARKET_LINE)).toBeLessThan(text.indexOf("What the evidence does not settle"));
  });
});

describe("a version with no explanation", () => {
  const none: StrategyExplanation = { program: PROGRAM, deploy_slot: 520_151_682, ai_notice: null, explanation: null };

  it("says so, with the line on when one is written, and offers no report", () => {
    const text = textOf(renderToStaticMarkup(<ExplanationView data={none} />));
    expect(text).toBe(`Explanation${NO_EXPLANATION}${NO_EXPLANATION_LINE}`);
  });

  it("still shows the fixed notice about text addressed to AI tools", () => {
    const text = textOf(renderToStaticMarkup(<ExplanationView data={{ ...none, ai_notice: "This strategy's metadata contains text addressed to AI tools." }} />));
    expect(text).toBe(`ExplanationThis strategy's metadata contains text addressed to AI tools.${NO_EXPLANATION}${NO_EXPLANATION_LINE}`);
  });
});

describe("the upgrade notice beside an explanation", () => {
  const upgrade = { deploy_slot: 524_292_769, upgraded_at: "2026-11-20T08:30:00.000Z" };

  it("says only the tests are pending once the new version has its explanation", () => {
    expect(textOf(renderToStaticMarkup(<UpgradeNotice upgrade={upgrade} explained />))).toBe("Upgraded on 20 Nov 2026; tests for this version are pending.");
  });

  it("says the explanation is pending too while it has none", () => {
    expect(textOf(renderToStaticMarkup(<UpgradeNotice upgrade={upgrade} explained={false} />))).toBe("Upgraded on 20 Nov 2026; tests and explanation for this version are pending.");
  });
});

describe("a strategy's description cut at its cap", () => {
  it("ends with Aviary's plain note that it was cut, outside the author's words", () => {
    const html = renderToStaticMarkup(<StrategyDescription text="A launchpad graduating a token can create and seed a market in one call thr" cut />);
    expect(textOf(html)).toBe("A launchpad graduating a token can create and seed a market in one call thr… Aviary cut the author's description at its length cap.");
    expect(html).toMatch(/<span class="_author_[^"]*">A launchpad[^<]*thr<\/span>/);
  });

  it("is the author's words alone when nothing was cut", () => {
    expect(textOf(renderToStaticMarkup(<StrategyDescription text="A whole description." cut={false} />))).toBe("A whole description.");
  });
});

describe("an explanation of one point and one item of evidence", () => {
  const sample = samples["constant-product"]!;
  const output = { ...sample.outputs.pass, claims: sample.outputs.pass.claims.slice(0, 1) };
  const html = renderToStaticMarkup(<ExplanationView data={served(output, sample.evidence.slice(0, 1))} />);

  it("counts them in the singular", () => {
    expect(textOf(html)).toContain("Read the full explanation (1 point)");
    expect(textOf(html)).toContain("The evidence it was given (1 item)");
  });

  it("gives every element a class it has, never \"undefined\"", () => {
    expect(html).not.toMatch(/class="[^"]*undefined/);
  });

  it("labels its unknowns by an id no other panel on the page shares", () => {
    const two = renderToStaticMarkup(
      <>
        <ExplanationView data={served(output, sample.evidence)} />
        <ExplanationView data={served(output, sample.evidence)} />
      </>,
    );
    const labels = [...two.matchAll(/aria-labelledby="([^"]+)"[^>]*><h3 id="\1"/g)].map((m) => m[1]);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
  });
});
