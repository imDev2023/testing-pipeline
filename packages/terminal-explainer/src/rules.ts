// The explainer's rules module (EXPLAINER-21; docs/spec/pipescope-explainer.md, "One place for every
// value"): the one place its values live. The system prompt is rendered from them (./prompt), the
// validator checks against them (./validate), and `terminal-api`'s evidence builder and key, the
// owner's approve command and the tests import them; nothing else writes a model id, a term or a
// limit. A change here that changes the rendered prompt is a new prompt version (`PROMPT_VERSION`),
// which is part of every key and so makes new explanations.

/**
 * The most characters (Unicode code points) of each kind of author text Aviary keeps, after
 * control and text-direction characters are stripped (EXPLAINER-08): a strategy's or a token's name;
 * a description, which caps the strategy's own and every other description in it (the create form's,
 * an argument's); a label, which caps every label and tag; and a token's symbol (PIPESCOPE-122),
 * short enough to sit beside its short address in a table row.
 */
export const AUTHOR_TEXT_CAPS = { name: 64, description: 600, label: 64, symbol: 16 } as const;

/** The prompt's version (EXPLAINER-10): part of every key, so a new one makes new explanations. */
export const PROMPT_VERSION = "explainer-v0";

/**
 * The model that writes explanations and how it is called (EXPLAINER-18): structured outputs,
 * adaptive thinking at effort `high`, and `maxTokens` as the hard ceiling on what one call can
 * write (thinking and the JSON together). The model's id is part of every key.
 */
export const MODEL = { id: "claude-haiku-5-5", effort: "high", maxTokens: 16_000 } as const;

/**
 * The model's price per million tokens, for prompts up to 100,000 tokens (Anthropic's pricing page,
 * read on 2026-11-24), which every cost the queue estimates and the approve command
 * reports is worked out from.
 */
export const MODEL_PRICE_PER_MILLION = { input: 0.1, output: 0.5 } as const;

/**
 * How a pending key's cost is estimated before any call (the queue's estimate; the approve command
 * reports what was spent): its input's characters at `charactersPerToken`, `outputTokens` written
 * per call (the JSON and the thinking before it), and `attempts` calls, a first try and its retry.
 * `charactersPerToken` is the request's JSON as the free token-counting endpoint counted it for the
 * twelve eval inputs on 2026-11-24 (`pnpm explainer:count`: 2.35 to 2.46, 2.41 in all), and
 * `outputTokens` rounds up what the owner-approved first paid run measured that day (142,124 output
 * tokens in 19 calls, about 7,480 a call).
 */
export const COST_ESTIMATE = { charactersPerToken: 2.4, outputTokens: 8_000, attempts: 2 } as const;

/**
 * The banned terms (EXPLAINER-11): each group is one term the prompt names (its first word) and the
 * variants the validator also refuses. No explanation may contain any of them.
 */
export const BANNED_TERMS: readonly (readonly string[])[] = [
  ["safe", "safely", "safer", "safest", "safety", "unsafe"],
  ["secure", "secured", "securely"],
  ["security"],
  ["audit", "audits", "auditor", "auditors", "auditing"],
  ["audited"],
  ["trustworthy", "trustworthiness"],
  ["trusted"],
  ["legit", "legitimate"],
  ["scam", "scams", "scammer", "scammers", "scammy"],
  ["rug", "rugs", "rugged", "rugpull", "rugpulls", "rug-pull", "rug-pulls"],
  ["honeypot", "honeypots"],
  ["risk-free", "riskless"],
  ["guarantee", "guarantees"],
  ["guaranteed"],
  ["recommend", "recommends", "recommended", "recommendation", "recommendations"],
  ["certified", "certify", "certification"],
  ["vetted"],
  ["approved"],
];

/** Advice and prediction phrases the validator refuses (EXPLAINER-11), beyond the banned terms. */
export const ADVICE_PHRASES: readonly RegExp[] = [
  /\bshould (?:you )?(?:buy|sell|hold)\b/i,
  /\b(?:buy|sell|hold) (?:now|today)\b/i,
  /\bprice (?:will|could|should|may|might) (?:rise|fall|go|moon|pump|dump|climb|drop)\b/i,
  /\bexpected (?:return|returns|profit|profits|yield|gain|gains)\b/i,
  /\bnothing (?:can|will|could) go wrong\b/i,
  /\byou can always\b/i,
  /\bgood (?:investment|buy)\b/i,
];

/**
 * The length limits (EXPLAINER-12): a summary of 2 to 3 sentences and at most 70 words, at most 14
 * claims of at most 45 words each, and at most 6 unknowns of at most 35 words each.
 */
export const LIMITS = { summarySentences: { min: 2, max: 3 }, summaryWords: 70, claims: 14, claimWords: 45, unknowns: 6, unknownWords: 35 } as const;

/**
 * Aviary's own detector for author text addressed to AI tools (EXPLAINER-14): any of these in any
 * author text raises the fixed notice, whatever the model's own flag says.
 */
export const AI_ADDRESSED_PATTERNS: readonly RegExp[] = [
  /\bignore (?:all |any |the )?(?:previous|prior|above|earlier|preceding|other) (?:instructions?|rules|prompts?)\b/i,
  /\b(?:note|message|instructions?) (?:to|for) (?:the )?(?:ai|a\.i\.|llms?|assistants?|language models?|chatbots?|bots?|gpts?|models?)\b/i,
  /\byou are (?:an? |the )?(?:ai|assistant|language model|llm|chatbot|model)\b/i,
  /\b(?:ai|llm|assistant|language model|chatbot|gpt|claude|chatgpt|gemini)s?\b[^.!?\n]{0,80}\b(?:must|should|shall|will|need to|have to|say|state|describe|tell|call|mention|write|report)\b/i,
  /\b(?:describe|present|call|label|rate|report) (?:this|the|our|it) (?:strategy|program|market|token|protocol|project)?\s*(?:as|to be)\b/i,
  /\b(?:do not|don't|never) (?:mention|say|state|report|reveal|disclose|show)\b/i,
  /\bsystem prompt\b/i,
  /\bdisregard\b/i,
  /\bnew instructions\b/i,
  /\bjailbreak\b/i,
];

/**
 * How much of what Aviary holds goes into one item of evidence (EXPLAINER-28): a Canary record's
 * inputs, written as JSON, are cut at `canaryInputsCharacters`, and each custom action names its
 * `signersShown` most frequent callers.
 */
export const EVIDENCE_LIMITS = { canaryInputsCharacters: 400, signersShown: 3 } as const;

/** The notice Aviary shows, in its own words, when author text addresses AI tools (EXPLAINER-14). */
export const AI_ADDRESSED_NOTICE = "This strategy's metadata contains text addressed to AI tools.";
