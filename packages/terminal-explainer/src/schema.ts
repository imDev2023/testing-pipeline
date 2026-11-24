// The output schema (docs/spec/pipescope-explainer.md, "The prompt"; EXPLAINER-10), sent as
// `output_config.format` and checked again by the validator (./validate, check 8), with the types
// of an explanation as the model returns it.

/** What a claim is about, which groups it on the page. */
export const TOPICS = ["does", "control", "canary", "protection", "author"] as const;
/** What a claim rests on: the evidence directly, an inference from it, or author text. */
export const BASES = ["confirmed", "inferred", "author"] as const;

export type Topic = (typeof TOPICS)[number];
export type Basis = (typeof BASES)[number];
export type Sentence = { text: string; evidence: string[] };
export type Claim = { topic: Topic; basis: Basis; text: string; evidence: string[] };
export type Explanation = { summary: Sentence[]; claims: Claim[]; unknowns: Sentence[]; author_text_addresses_ai: boolean };

const sentence = { type: "object", additionalProperties: false, required: ["text", "evidence"], properties: { text: { type: "string" }, evidence: { type: "array", items: { type: "string" } } } } as const;

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "claims", "unknowns", "author_text_addresses_ai"],
  properties: {
    summary: { type: "array", items: { $ref: "#/$defs/sentence" } },
    claims: { type: "array", items: { $ref: "#/$defs/claim" } },
    unknowns: { type: "array", items: { $ref: "#/$defs/sentence" } },
    author_text_addresses_ai: { type: "boolean" },
  },
  $defs: {
    sentence,
    claim: {
      type: "object",
      additionalProperties: false,
      required: ["topic", "basis", "text", "evidence"],
      properties: {
        topic: { type: "string", enum: [...TOPICS] },
        basis: { type: "string", enum: [...BASES] },
        text: { type: "string" },
        evidence: { type: "array", items: { type: "string" } },
      },
    },
  },
} as const;
