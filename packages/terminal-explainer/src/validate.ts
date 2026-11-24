// The validator (docs/spec/pipescope-explainer.md, "The validator"; EXPLAINER-13), ported from the
// prototype's `logic.js` on `prototype/explainer-samples`: eight checks in code on every output
// before anyone sees it, against the evidence the model was given. Its terms and limits are the
// rules module's (EXPLAINER-21), the same ones the prompt is rendered from.
//
// A number, date or address is checked against the label and value of the items a sentence cites,
// which is what the model read; where Aviary read an item (its source) is never sent to the model,
// so it is no evidence for the model's words.
import type { EvidenceItem } from "./evidence";
import { ADVICE_PHRASES, BANNED_TERMS, LIMITS } from "./rules";
import { BASES, TOPICS, type Explanation } from "./schema";

/** The eight checks, by name, in the spec's order. */
export const CHECKS = {
  cites: "Every summary sentence and claim cites evidence",
  ids: "Every cited id exists in the input",
  numbers: "Numbers, dates, times and addresses appear in the cited evidence",
  format: "Plain text: no links, domain names, Markdown, HTML or evidence ids",
  banned: "No banned term, advice or prediction",
  author: 'Author text only in attributed claims; inferred claims say "appears to"',
  length: "Within the length limits",
  schema: "Matches the schema",
} as const;

export type CheckName = keyof typeof CHECKS;
export type CheckResult = { name: CheckName; title: string; ok: boolean; errors: string[] };
export type Validation = { pass: boolean; checks: CheckResult[] };

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const SHORT_ADDRESS = new RegExp(`\\b${B58}{4}\\.\\.\\.${B58}{4}\\b`, "g");
const FULL_ADDRESS = new RegExp(`\\b${B58}{32,44}\\b`, "g");
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const TIME = /\b\d{1,2}:\d{2}\b/g;
const LINK = /https?:\/\/|www\.|(?<![\w-])(?:javascript|data|vbscript|file):|\b[a-z0-9-]+\.(?:com|io|xyz|fun|app|net|org|dev|so|ai|co|gg|me|finance|exchange)\b/i;
const MARKUP = /[<>`]|\*\*|__|\]\(|^\s*(?:#|[-+*]\s)/m;
const EVIDENCE_ID = /\b[PFCSA]\d+\b/;
const BANNED = BANNED_TERMS.flat().map((term) => ({ term, pattern: new RegExp(`(?<![\\w-])${term.replace(/-/g, "\\-")}(?![\\w-])`, "i") }));
const AUTHOR = /\bauthor\b/i;
const APPEARS = /\bappears? to\b/i;

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
/** Thousands separators dropped, so "271,021.6" and "271021.6" are the same number. */
const plain = (s: string) => s.replace(/(\d),(?=\d{3}\b)/g, "$1");

/** Every number-like token in a sentence: addresses first, then dates, times and plain numbers. */
function tokens(text: string) {
  let t = plain(text);
  const addresses = [...(t.match(SHORT_ADDRESS) ?? []), ...(t.match(FULL_ADDRESS) ?? [])];
  t = t.replace(SHORT_ADDRESS, " ").replace(FULL_ADDRESS, " ");
  const dates = t.match(DATE) ?? [];
  t = t.replace(DATE, " ");
  const times = t.match(TIME) ?? [];
  t = t.replace(TIME, " ");
  const numbers = t.match(/\d+(?:\.\d+)?/g) ?? [];
  return { addresses, dates, times, numbers };
}

const numberIn = (n: string, hay: string) => new RegExp(`(?<![\\d.])${n.replace(".", "\\.")}(?!\\d|\\.\\d)`).test(hay);

function addressIn(address: string, hay: string): boolean {
  if (!address.includes("...")) return hay.includes(address);
  const [head, tail] = address.split("...") as [string, string];
  return (hay.match(FULL_ADDRESS) ?? []).some((full) => full.startsWith(head) && full.endsWith(tail)) || hay.includes(address);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Check 8: the output's shape, as the schema states it. */
function schemaErrors(output: unknown): string[] {
  if (!isObject(output)) return ["the output is not a JSON object"];
  const errors: string[] = [];
  const keys = ["summary", "claims", "unknowns", "author_text_addresses_ai"];
  for (const key of Object.keys(output)) if (!keys.includes(key)) errors.push(`the output has a field the schema does not allow: ${key}`);
  for (const key of keys) if (!(key in output)) errors.push(`the output has no ${key}`);
  if ("author_text_addresses_ai" in output && typeof output.author_text_addresses_ai !== "boolean") errors.push("author_text_addresses_ai is not true or false");
  const list = (key: "summary" | "claims" | "unknowns", fields: string[]) => {
    const value = output[key];
    if (value === undefined) return;
    if (!Array.isArray(value)) return void errors.push(`${key} is not a list`);
    value.forEach((entry: unknown, i) => {
      const where = `${key === "summary" ? "summary" : key.slice(0, -1)} ${i + 1}`;
      if (!isObject(entry)) return void errors.push(`${where} is not an object`);
      for (const field of Object.keys(entry)) if (!fields.includes(field)) errors.push(`${where} has a field the schema does not allow: ${field}`);
      if (typeof entry.text !== "string") errors.push(`${where} has no text`);
      if (!isStringArray(entry.evidence)) errors.push(`${where} has no list of evidence ids`);
      if (key === "claims") {
        if (!(TOPICS as readonly unknown[]).includes(entry.topic)) errors.push(`${where} has an unknown topic: ${String(entry.topic)}`);
        if (!(BASES as readonly unknown[]).includes(entry.basis)) errors.push(`${where} has an unknown basis: ${String(entry.basis)}`);
      }
    });
  };
  list("summary", ["text", "evidence"]);
  list("claims", ["topic", "basis", "text", "evidence"]);
  list("unknowns", ["text", "evidence"]);
  return errors;
}

type Item = { where: string; kind: "summary" | "claim" | "unknown"; text: string; evidence: string[]; basis?: unknown };

/** The sentences of an output whatever its shape, for the checks that read them; check 8 reports the shape. */
function sentences(output: unknown): Item[] {
  if (!isObject(output)) return [];
  const read = (key: string, kind: Item["kind"]): Item[] => {
    const value = output[key];
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown, i): Item[] =>
      isObject(entry) && typeof entry.text === "string" ? [{ where: `${kind} ${i + 1}`, kind, text: entry.text, evidence: isStringArray(entry.evidence) ? entry.evidence : [], basis: entry.basis }] : [],
    );
  };
  return [...read("summary", "summary"), ...read("claims", "claim"), ...read("unknowns", "unknown")];
}

/** Runs the eight checks on `output` (as parsed from the model's JSON) against the `evidence` it was given. */
export function validate(evidence: readonly EvidenceItem[], output: Explanation | unknown): Validation {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const problems: Record<CheckName, string[]> = { cites: [], ids: [], numbers: [], format: [], banned: [], author: [], length: [], schema: schemaErrors(output) };
  const items = sentences(output);

  for (const item of items) {
    const { where, kind, text } = item;
    if (kind !== "unknown" && item.evidence.length === 0) problems.cites.push(`${where} cites no evidence`);
    for (const id of item.evidence) if (!byId.has(id)) problems.ids.push(`${where} cites ${id}, which is not in the input`);

    const hay = item.evidence
      .map((id) => byId.get(id))
      .filter((e): e is EvidenceItem => e !== undefined)
      .map((e) => plain(`${e.label} ${e.value}`))
      .join(" \n ");
    const found = tokens(text);
    for (const a of found.addresses) if (!addressIn(a, hay)) problems.numbers.push(`${where}: address ${a} is not in its cited evidence`);
    for (const d of found.dates) if (!hay.includes(d)) problems.numbers.push(`${where}: date ${d} is not in its cited evidence`);
    for (const t of found.times) if (!hay.includes(t)) problems.numbers.push(`${where}: time ${t} is not in its cited evidence`);
    for (const n of found.numbers) if (!numberIn(n, hay)) problems.numbers.push(`${where}: number ${n} is not in its cited evidence`);

    if (LINK.test(text)) problems.format.push(`${where} contains a link or domain`);
    if (MARKUP.test(text)) problems.format.push(`${where} contains Markdown or HTML characters`);
    // An address shortened as the prompt asks ("C123...Wxyz") is no evidence id, so addresses are set aside first.
    if (EVIDENCE_ID.test(text.replace(SHORT_ADDRESS, " ").replace(FULL_ADDRESS, " "))) problems.format.push(`${where} writes an evidence id into its text`);

    for (const { term, pattern } of BANNED) if (pattern.test(text)) problems.banned.push(`${where} uses the banned term "${term}"`);
    for (const phrase of ADVICE_PHRASES) {
      const match = text.match(phrase);
      if (match) problems.banned.push(`${where} gives advice or a prediction ("${match[0]}")`);
    }

    const citesAuthor = item.evidence.some((id) => id.startsWith("A"));
    if (kind === "claim" && item.basis === "author") {
      if (!citesAuthor) problems.author.push(`${where} has basis author but cites no author text`);
      if (!AUTHOR.test(text)) problems.author.push(`${where} does not say the text is the author's`);
    } else if (citesAuthor && !AUTHOR.test(text)) {
      problems.author.push(`${where} rests on author text without saying it is the author's`);
    }
    if (kind === "claim" && item.basis === "inferred" && !APPEARS.test(text)) problems.author.push(`${where} is inferred but does not say "appears to"`);

    const cap = kind === "claim" ? LIMITS.claimWords : kind === "unknown" ? LIMITS.unknownWords : null;
    if (cap !== null && words(text) > cap) problems.length.push(`${where} has ${words(text)} words (at most ${cap})`);
  }

  if (isObject(output)) {
    const summary = items.filter((i) => i.kind === "summary");
    const { min, max } = LIMITS.summarySentences;
    if (Array.isArray(output.summary) && (output.summary.length < min || output.summary.length > max)) problems.length.push(`the summary has ${output.summary.length} sentences (${min} to ${max})`);
    const summaryWords = summary.reduce((n, s) => n + words(s.text), 0);
    if (summaryWords > LIMITS.summaryWords) problems.length.push(`the summary has ${summaryWords} words (at most ${LIMITS.summaryWords})`);
    if (Array.isArray(output.claims) && output.claims.length > LIMITS.claims) problems.length.push(`${output.claims.length} claims (at most ${LIMITS.claims})`);
    if (Array.isArray(output.unknowns) && output.unknowns.length > LIMITS.unknowns) problems.length.push(`${output.unknowns.length} unknowns (at most ${LIMITS.unknowns})`);
  }

  const checks = (Object.keys(CHECKS) as CheckName[]).map((name) => ({ name, title: CHECKS[name], ok: problems[name].length === 0, errors: problems[name] }));
  return { pass: checks.every((c) => c.ok), checks };
}

/** The errors of a failed validation, one per line, as the retry sends them back to the model. */
export const validationErrors = (validation: Validation): string[] => validation.checks.flatMap((c) => c.errors);
