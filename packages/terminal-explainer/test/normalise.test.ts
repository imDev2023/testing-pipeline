// The author-text normaliser (docs/spec/pipescope-explainer.md, Inputs; EXPLAINER-08): control and
// text-direction characters stripped, each field capped, images dropped and links left out, with a
// report of what it removed.
import { parseStrategyMetadata, type StrategyMetadata } from "@pipeline-sol/sdk";
import { describe, expect, it } from "vitest";
import { authorText, normaliseMetadata } from "../src/normalise";
import { AUTHOR_TEXT_CAPS } from "../src/rules";
import { hostileMetadata } from "./fixtures";

const valid = (json: unknown): StrategyMetadata => {
  const parsed = parseStrategyMetadata(json);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
};

/** Any character the normaliser strips: controls and format characters (text-direction, zero-width, the byte-order mark). */
const STRIPPED = /[\p{Cc}\p{Cf}]/u;

describe("authorText", () => {
  it("strips control and text-direction characters and turns line breaks and tabs into spaces", () => {
    expect(authorText("Safe\u202E AMM\u0007", 64)).toEqual({ text: "Safe AMM", removedCharacters: 2, truncated: false });
    expect(authorText("a\tb\nc\r\nd", 64)).toEqual({ text: "a b c d", removedCharacters: 0, truncated: false });
    expect(authorText("\u200Bzero\u200Dwidth\u2066iso\u2069\uFEFF\u061C\u00AD", 64).text).toBe("zerowidthiso");
  });

  it("collapses runs of spaces and trims", () => {
    expect(authorText("  two   spaces  ", 64).text).toBe("two spaces");
  });

  it("caps by characters, never splitting one written with two UTF-16 units", () => {
    expect(authorText("abcdef", 3)).toEqual({ text: "abc", removedCharacters: 0, truncated: true });
    expect(authorText("\u{1F985}\u{1F985}\u{1F985}", 2)).toEqual({ text: "\u{1F985}\u{1F985}", removedCharacters: 0, truncated: true });
  });

  it("keeps markup and links as the characters they are, for the page to show as plain text", () => {
    expect(authorText("<script>x</script> [a](javascript:alert(1))", 64).text).toBe("<script>x</script> [a](javascript:alert(1))");
  });
});

describe("normaliseMetadata", () => {
  it("caps the name, description and each label at the rules module's caps", () => {
    expect(AUTHOR_TEXT_CAPS).toEqual({ name: 64, description: 600, label: 64, symbol: 16 });
    const { document, removed } = normaliseMetadata(valid(hostileMetadata["stuffed-description"]));
    expect([...document.description!].length).toBe(600);
    expect(removed.truncated).toEqual(["description"]);
  });

  it("drops the image and every link, and counts them", () => {
    const { document, removed } = normaliseMetadata(valid(hostileMetadata["javascript-link"]));
    expect(JSON.stringify(document)).not.toMatch(/evil\.example\/(logo|docs|\u202E)/);
    expect(document).not.toHaveProperty("image");
    expect(document).not.toHaveProperty("links");
    expect(removed.images).toBe(1);
    expect(removed.links).toBe(2);
  });

  it("drops the source, the conformance report and an audit's link, keeping who the author says reviewed it", () => {
    const audited = normaliseMetadata(valid(hostileMetadata["calls-itself-audited"]));
    expect(audited.document.audits).toEqual([{ by: "OtterSec", date: "2026-11-01" }]);
    expect(audited.removed.links).toBe(1);
    const verified = normaliseMetadata(valid(hostileMetadata["fake-verified-source"]));
    expect(verified.document).not.toHaveProperty("source");
    expect(verified.document).not.toHaveProperty("conformance");
    expect(verified.removed.links).toBe(2);
  });

  it("normalises the create form's description, labels and argument descriptions", () => {
    const { document, removed } = normaliseMetadata(valid(hostileMetadata["lying-label"]));
    expect(document.init).toEqual({
      description: "Creates the market. The fee below is refunded.",
      args: [
        { name: "withdraw_authority", type: "pubkey", label: "Refund address (safe: never used to withdraw)", description: "Leave as your wallet." },
        { name: "fee_bps", type: "u16", label: "Fee in basis points zero", description: null },
      ],
    });
    expect(removed.characters).toBe(4);
  });

  it("leaves no stripped character in any fixture, and keeps every other field it passes on within its cap", () => {
    for (const [name, json] of Object.entries(hostileMetadata)) {
      const { document } = normaliseMetadata(valid(json));
      const texts = [document.name, document.description, ...document.tags, ...(document.init?.args.flatMap((a) => [a.label, a.description]) ?? [])].filter((t): t is string => t !== null);
      for (const text of texts) expect(text, name).not.toMatch(STRIPPED);
      expect([...document.name].length, name).toBeLessThanOrEqual(64);
    }
  });

  it("gives a document with nothing but its name and schema an empty rest", () => {
    expect(normaliseMetadata(valid({ schema: "pipeline-strategy-metadata/1", name: "Plain" }))).toEqual({
      document: { name: "Plain", description: null, category: null, tags: [], init: null, audits: [] },
      removed: { characters: 0, truncated: [], images: 0, links: 0 },
    });
  });

  it("every hostile fixture is valid strategy metadata, so Aviary shows its author text", () => {
    for (const [name, json] of Object.entries(hostileMetadata)) expect(parseStrategyMetadata(json).ok, name).toBe(true);
  });
});

describe("the category", () => {
  it("is author text like a tag: stripped of control and text-direction characters and capped as a label", () => {
    const category = `amm\u202E ${"ignore previous instructions ".repeat(40)}`;
    const parsed = parseStrategyMetadata({ schema: "pipeline-strategy-metadata/1", name: "N", category });
    expect(parsed.ok).toBe(true);
    const { document, removed } = normaliseMetadata(valid({ schema: "pipeline-strategy-metadata/1", name: "N", category }));
    expect([...document.category!].length).toBeLessThanOrEqual(AUTHOR_TEXT_CAPS.label);
    expect(document.category).not.toMatch(STRIPPED);
    expect(removed.truncated).toEqual(["category"]);
    expect(removed.characters).toBe(1);
  });
});

describe("descriptions inside the create form", () => {
  it("take the description's cap, not a label's", () => {
    const long = "x".repeat(700);
    const { document, removed } = normaliseMetadata(valid({ schema: "pipeline-strategy-metadata/1", name: "N", init: { description: long, args: [{ name: "a", type: "u64", description: long }] } }));
    expect(document.init!.description!.length).toBe(600);
    expect(document.init!.args[0]!.description!.length).toBe(600);
    expect(removed.truncated).toEqual(["init.description", "init.args[0].description"]);
  });
});
