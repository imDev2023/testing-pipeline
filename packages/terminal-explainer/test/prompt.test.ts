// The prompt and its output schema (docs/spec/pipescope-explainer.md, "The prompt, version
// `explainer-v0`" and "One place for every value"; EXPLAINER-10, EXPLAINER-21): the system prompt is
// rendered from the rules module, so a rule changed there changes the prompt, and this test holds
// the rendered text and the schema to the spec's, word for word.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OUTPUT_SCHEMA, systemPrompt } from "../src/index";

const spec = readFileSync(join(import.meta.dirname, "../../../docs/spec/pipescope-explainer.md"), "utf8");

/** The first fenced block of `lang` after `heading` in the spec. */
function block(heading: string, lang: string): string {
  const from = spec.indexOf(heading);
  expect(from, heading).toBeGreaterThan(-1);
  const match = spec.slice(from).match(new RegExp("```" + lang + "\\n([\\s\\S]*?)\\n```"));
  expect(match, `${lang} block after ${heading}`).not.toBeNull();
  return match![1]!;
}

describe("the system prompt", () => {
  it("rendered from the rules module, equals the text in the spec", () => {
    expect(systemPrompt()).toBe(block("System prompt, word for word:", "text"));
  });
});

describe("the output schema", () => {
  it("equals the schema in the spec", () => {
    expect(OUTPUT_SCHEMA).toEqual(JSON.parse(block("Output schema (`output_config.format`):", "json")));
  });
});
