// Canary on the pages (docs/spec/pipescope-screens.md, Canary outcomes and What a row says about
// Canary; PIPESCOPE-66, PIPESCOPE-71; #125): an outcome is its word beside one of five ink shapes,
// never one without the other, and a row never shows a count of outcomes.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CanaryResults, CanaryRollup, type MarketCanary } from "terminal-api/contract";
import { CanaryCell } from "@/components/canary/CanaryCell";
import { CanarySaw } from "@/components/canary/CanarySaw";
import { Outcome } from "@/components/canary/Outcome";
import { VersionCanary } from "@/components/canary/VersionCanary";

const OUTCOMES = ["fail", "warn", "pass", "not run", "noted"] as const;
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").trim();

/** Every outcome mark in the markup, as its shape's markup and the text beside it. */
function marks(html: string): { shape: string; word: string }[] {
  return [...html.matchAll(/<span class="[^"]*outcome[^"]*"[^>]*>(<svg[\s\S]*?<\/svg>)([\s\S]*?)<\/span><\/span>/g)].map((m) => ({ shape: m[1]!, word: textOf(m[2]!) }));
}

describe("an outcome", () => {
  it("is always its word beside its shape", () => {
    for (const outcome of OUTCOMES) {
      const html = renderToStaticMarkup(<Outcome outcome={outcome} />);
      expect(marks(html)).toEqual([{ shape: expect.stringContaining("<svg"), word: outcome }]);
      // The shape is drawn for the eye; the word is what a screen reader reads.
      expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    }
  });

  it("has a shape of its own for each of the five, drawn in the ink of its text", () => {
    const shapes = OUTCOMES.map((o) => marks(renderToStaticMarkup(<Outcome outcome={o} />))[0]!.shape);
    expect(new Set(shapes).size).toBe(5);
    for (const shape of shapes) expect(shape).not.toMatch(/(fill|stroke)="(?!currentColor|none)/);
  });
});

const SUMMARY: MarketCanary = {
  run_at: "2026-11-23T22:47:21.000Z",
  ordinary: { return_ppm: 486_449, amount_words: "0.01 SOL", stand_in: false },
  lead: { check: "cost", outcome: "fail", phrase: "a 0.01 SOL round trip returned 48.6%" },
  stranded: null,
  refuses: null,
};

describe("a row's Canary cell", () => {
  it("shows the ordinary trade's return as a number and the one result chosen, with its word", () => {
    const html = renderToStaticMarkup(<CanaryCell canary={SUMMARY} />);
    expect(textOf(html)).toBe("48.6% back fail a 0.01 SOL round trip returned 48.6%");
    expect(marks(html).map((m) => m.word)).toEqual(["fail"]);
  });

  it("shows the number alone when no result is chosen, and says when Canary has not run the market", () => {
    expect(textOf(renderToStaticMarkup(<CanaryCell canary={{ ...SUMMARY, ordinary: { ...SUMMARY.ordinary!, return_ppm: 985_000 }, lead: null }} />))).toBe("98.5% back");
    expect(textOf(renderToStaticMarkup(<CanaryCell canary={null} />))).toBe("Not run yet");
  });

  it("shows a stranded market's fail with no number, since nothing could be traded", () => {
    const stranded = { ...SUMMARY, ordinary: null, lead: { check: "readable", outcome: "fail" as const, phrase: "the strategy's current version cannot read this market" } };
    expect(textOf(renderToStaticMarkup(<CanaryCell canary={stranded} />))).toBe("fail the strategy's current version cannot read this market");
  });

  it("never shows a count of outcomes", () => {
    for (const outcome of OUTCOMES) {
      const text = textOf(renderToStaticMarkup(<CanaryCell canary={{ ...SUMMARY, lead: { check: "exit_queue", outcome, phrase: "five buyers leaving in turn got back 49.5% together" } }} />));
      expect(text).not.toMatch(/\d+\s*(of\s+\d+|pass|warn|fail|not run|noted|checks?|results?)\b/);
    }
  });
});

// ---- What Canary saw, the facts panel's first part on a market page ----


const ANSWERS = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/canary-answers.json`, "utf8")) as Record<string, unknown>;
const answer = (label: string) => CanaryResults.parse(ANSWERS[label]);
const MINTS = [
  { mint: "TokenMint1111111111111111111111111111111111", symbol: null, token: { symbol: "CURVE", name: null, image: null } },
  { mint: "So11111111111111111111111111111111111111112", symbol: "SOL", token: null },
];
const saw = (label: string) => renderToStaticMarkup(<CanarySaw canary={answer(label)} mints={MINTS} />);

describe("What Canary saw", () => {
  it("opens with Canary's mark beside its heading and its sentence, with the day and time it ran", () => {
    const html = saw("open_curve");
    expect(html).toMatch(/<h3[^>]*>[\s\S]*data-canary="mark"[\s\S]*What Canary saw[\s\S]*<\/h3>/);
    expect(textOf(html)).toContain(
      "Canary traded a private copy of this market on 23 Nov 2026, 22:49 UTC, as a trader would, and recorded what happened. It detects; it cannot prove a market safe, and a result is no promise about a later trade or a later version.",
    );
  });

  it("puts fails first and open, then warns, then what was not run, and behind a disclosure the passes and what was only noted", () => {
    const html = saw("outside_builder");
    const order = [...html.matchAll(/data-check="([a-z_]+)"/g)].map((m) => m[1]);
    expect(order.slice(0, 2)).toEqual(["cost", "exit_queue"]);
    expect(html).toMatch(/<details[^>]*open=""[^>]*data-check="cost"/);
    const disclosure = html.indexOf("The checks that passed, and what Canary only noted");
    expect(disclosure).toBeGreaterThan(html.indexOf('data-check="token_authorities"'));
    expect(html.indexOf('data-check="readable"')).toBeGreaterThan(disclosure);
  });

  it("folds what was not run for one reason into one line", () => {
    const html = saw("refusing");
    const notRun = [...html.matchAll(/data-not-run="([^"]+)"/g)].map((m) => m[1]);
    expect(notRun.length).toBeLessThan(answer("refusing").results.filter((r) => r.outcome === "not run").length);
    expect(textOf(html)).toContain("Not run: the market refuses every trade (WrongStatus: Not allowed in the curve's current status).");
  });

  it("shows a row for each size with its bar in ink, and the refusal with who refused and the error", () => {
    const text = textOf(saw("open_curve"));
    expect(text).toContain("0.1 SOL 98.4% back");
    expect(text).toContain("1 SOL could not sell back");
    expect(text).toContain("Refused by the strategy, program ETrm...5zAb");
    expect(text).toContain("WrongStatus (6004): Not allowed in the curve's current status");
    expect(text).toContain("At the swap, thrown in bonding-curve/src/lib.rs:1298");
  });

  it("ends each result with the line naming the check, the run and the strategy version", () => {
    expect(textOf(saw("open_curve"))).toContain(
      "Check exit_sizes : buys each size and sells everything bought in the same slot. Run on 23 Nov 2026, 22:49 UTC at slot 525,585,595, on the strategy version deployed in slot 525,565,903.",
    );
  });

  it("never shows an outcome without its word", () => {
    for (const label of ["open_curve", "outside_builder", "stranded", "refusing", "tax_demo"]) {
      const html = saw(label);
      const shapes = (html.match(/<svg/g) ?? []).length;
      const found = marks(html);
      expect(found).toHaveLength(shapes);
      for (const m of found) expect(OUTCOMES).toContain(m.word);
    }
  });

  it("reads as pending after an upgrade, until the new version has its own results", () => {
    const text = textOf(saw("upgraded"));
    expect(text).toContain("Tests for this version are pending.");
    expect(text).not.toContain("Canary traded");
  });
});

// ---- What Canary saw on this version, on a strategy page ----


const rollup = (label: string) => CanaryRollup.parse(ANSWERS[label]);

describe("What Canary saw on this version", () => {
  it("opens with one sentence: when Canary ran, how many markets the version cannot read, and the range of the ordinary trade's return", () => {
    const text = textOf(renderToStaticMarkup(<VersionCanary rollup={rollup("rollup_curve")} />));
    expect(text).toContain(
      "Canary traded a private copy of each of this version's 3 markets on 23 Nov 2026, as a trader would. 1 of 3 cannot be read by this version. On the markets that trade, a 0.01 SOL buy sold straight back returned 98.3%. Canary detects; it cannot prove a strategy safe.",
    );
  });

  it("gives a line for each check in the fixed order, with how many of the version's markets got each outcome", () => {
    const html = renderToStaticMarkup(<VersionCanary rollup={rollup("rollup_curve")} />);
    const order = [...html.matchAll(/data-check="([a-z_]+)"/g)].map((m) => m[1]);
    expect(order.slice(0, 3)).toEqual(["readable", "exit_sizes", "cost"]);
    expect(order.at(-1)).toBe("custom_instructions");
    const readable = html.slice(html.indexOf('data-check="readable"'), html.indexOf('data-check="exit_sizes"'));
    expect(textOf(readable)).toMatch(/^.*Reading the market .* fail 1 of 3 pass 2 of 3/);
    const contained = html.slice(html.indexOf('data-check="contained_mint"'), html.indexOf('data-check="conformance"'));
    expect(textOf(contained)).toContain("not run all 3 markets");
    for (const m of marks(html)) expect(OUTCOMES).toContain(m.word);
    expect(marks(html)).toHaveLength((html.match(/<svg/g) ?? []).length);
  });

  it("opens a line with a fail or a warn to the markets it holds for, each linked, with its sentence", () => {
    const html = renderToStaticMarkup(<VersionCanary rollup={rollup("rollup_curve")} />);
    const sizes = html.slice(html.indexOf('data-check="exit_sizes"'), html.indexOf('data-check="cost"'));
    expect(sizes).toMatch(/^data-check="exit_sizes"[^>]*>\s*<summary/);
    expect(sizes).toContain('href="/markets/DH7QCdTHGsjHcsm7SgXYRgdQvX34VT8oMQkFWVoCe3SQ"');
    expect(textOf(sizes)).toContain("A wallet that bought 1 SOL or more could not sell back");
    const cost = html.slice(html.indexOf('data-check="cost"'), html.indexOf('data-check="exit_hold"'));
    expect(cost).not.toContain("<summary");
  });

  it("reads as pending after an upgrade", () => {
    const pending = { ...rollup("rollup_curve"), markets: 0, checks: {}, summary: null, upgrade: { deploy_slot: 200, upgraded_at: "2026-11-24T10:00:00.000Z" } };
    expect(textOf(renderToStaticMarkup(<VersionCanary rollup={pending} />))).toContain("Tests for this version are pending.");
  });
});
