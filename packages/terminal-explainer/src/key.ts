// The key (docs/spec/pipescope-explainer.md, "When an explanation is made"; EXPLAINER-04): one
// explanation per program, strategy version (its deploy slot), hash of the normalised author text,
// hash of the Canary outcomes (results only, never run times), prompt version and model. Any one
// changing makes a new key; a Canary re-run with the same outcomes makes the same one.
import { MODEL, PROMPT_VERSION } from "./rules";

export type ExplainerKey = {
  /** The SHA-256 of the other parts, in hex: the key's id. */
  id: string;
  program: string;
  deploySlot: bigint;
  authorTextSha256: string;
  canaryOutcomesSha256: string;
  promptVersion: string;
  model: string;
};

/** One Canary result's outcome: which market, which check, what it found. */
export type CanaryOutcomeOf = { market: string; check: string; outcome: string };

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A JSON value with its object keys sorted, so the same content always hashes the same. */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));

/**
 * The key of a strategy version's explanation, from its normalised author text (null when it has
 * no usable metadata) and the outcome of each latest Canary result of the version.
 */
export async function explainerKey(parts: { program: string; deploySlot: bigint; author: unknown; canary: readonly CanaryOutcomeOf[] }): Promise<ExplainerKey> {
  const authorTextSha256 = await sha256(canonical(parts.author));
  const lines = parts.canary.map((c) => `${c.market} ${c.check} ${c.outcome}`).sort();
  const canaryOutcomesSha256 = await sha256(lines.join("\n"));
  const fields = { program: parts.program, deploySlot: parts.deploySlot, authorTextSha256, canaryOutcomesSha256, promptVersion: PROMPT_VERSION, model: MODEL.id };
  const id = await sha256([fields.program, String(fields.deploySlot), authorTextSha256, canaryOutcomesSha256, fields.promptVersion, fields.model].join("\n"));
  return { id, ...fields };
}
