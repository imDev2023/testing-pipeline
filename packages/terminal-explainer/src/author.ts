// The author part of the evidence (docs/spec/pipescope-explainer.md, Inputs; EXPLAINER-08,
// EXPLAINER-14): the strategy author's text as A items, untrusted, and F items for what code
// checked of it. Author text never moves into an F item: an F item that speaks of a label names
// it by its A item's id.
//
// Pipeline's metadata standard (SDK 0.3) has no custom actions any more, so the sections checked
// against the version's instructions are the two that call one: the create form (`init`), which
// builds the call to `PipelineInitMarket`, and seeding (`seed`), which `PipelineSeedLiquidity` runs
// (EXPLAINER-24). The indexer keeps an instruction's name only when its discriminator is in the
// code, so a name found in the list is a discriminator found in the code.
import { FLAG_DESCRIPTIONS, type StrategyMetadata } from "@pipeline-sol/sdk";
import type { EvidenceItem, Fact } from "./evidence";
import type { NormalisedMetadata, Removed } from "./normalise";
import { AI_ADDRESSED_PATTERNS, AUTHOR_TEXT_CAPS } from "./rules";

/** Pipeline's metadata status, as the fetcher stores it. */
export type MetadataStatus = "missing" | "unreachable" | "invalid" | "valid";

export type AuthorInput = {
  status: MetadataStatus;
  /** The document as Pipeline's validator accepted it, when valid. */
  metadata: StrategyMetadata | null;
  /** Its author text as the normaliser left it, and what it removed. */
  normalised: NormalisedMetadata | null;
  removed: Removed | null;
  /** The version's instruction names, or null when its bytes named none Aviary could confirm. */
  instructions: readonly { name: string }[] | null;
};

export type AuthorEvidence = { author: EvidenceItem[]; facts: Fact[]; addressesAi: boolean };

const AUTHOR_SOURCE = "metadata JSON, written by the strategy's author, unverified";
const STATUS_FLAG = { missing: "metadata-missing", unreachable: "metadata-unreachable", invalid: "metadata-invalid" } as const;

/** Whether any of `texts` addresses AI tools, by Aviary's own patterns (EXPLAINER-14). */
export const addressesAi = (texts: readonly string[]): boolean => texts.some((t) => AI_ADDRESSED_PATTERNS.some((p) => p.test(t)));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Aviary removed 3 control ... and did not pass on 1 image and 2 links." */
function handling(removed: Removed): string | null {
  const parts: string[] = [];
  if (removed.characters) parts.push(`removed ${plural(removed.characters, "control or text-direction character")} from the author text`);
  const capOf = (path: string) => (/(^|\.)name$/.test(path) ? AUTHOR_TEXT_CAPS.name : /description$/.test(path) ? AUTHOR_TEXT_CAPS.description : AUTHOR_TEXT_CAPS.label);
  const fieldOf = (path: string) => path.replace(/\[(\d+)\]/g, (_, i) => ` ${Number(i) + 1}`).replace(/\./g, " ").replace(/^init /, "create form ").replace(/args/g, "argument").replace(/security audits/, "outside review");
  for (const path of removed.truncated) parts.push(`cut the ${fieldOf(path)} at its cap of ${capOf(path)} characters`);
  const dropped = [removed.images ? plural(removed.images, "image") : null, removed.links ? plural(removed.links, "link") : null].filter(Boolean);
  if (dropped.length) parts.push(`did not pass on ${dropped.join(" and ")}`);
  if (!parts.length) return null;
  const last = parts.pop()!;
  return `Aviary ${parts.length ? `${parts.join(", ")}, and ${last}` : last}.`;
}

export function authorEvidence(input: AuthorInput): AuthorEvidence {
  const facts: Fact[] = [];
  if (input.status !== "valid" || !input.normalised) {
    const flag = STATUS_FLAG[input.status === "valid" ? "invalid" : input.status];
    facts.push({ group: "Program", label: `Strategy metadata: flag ${flag}`, value: FLAG_DESCRIPTIONS[flag], source: "Aviary's metadata fetcher, with Pipeline's flag and its description" });
    return { author: [], facts, addressesAi: false };
  }

  const doc = input.normalised;
  const author: EvidenceItem[] = [];
  const add = (label: string, value: string | null) => {
    if (!value) return null;
    const id = `A${author.length + 1}`;
    author.push({ id, group: "Author", label: `${label}, from strategy metadata`, value, source: AUTHOR_SOURCE });
    return id;
  };
  add("name", doc.name);
  add("description", doc.description);
  add("category", doc.category);
  for (const tag of doc.tags) add("tag", tag);
  if (doc.init) {
    add("create form: description", doc.init.description);
    for (const arg of doc.init.args) {
      add(`create form: label of the argument ${arg.name}`, arg.label);
      add(`create form: description of the argument ${arg.name}`, arg.description);
    }
  }
  for (const audit of doc.audits) add("outside review the author lists", `by ${audit.by}${audit.date ? `, dated ${audit.date}` : ""}`);

  const fromCode = "computed by Aviary from the metadata and the version's instruction list";
  const removed = input.removed && handling(input.removed);
  if (removed) facts.push({ group: "Program", label: "Metadata handling", value: removed, source: "Aviary's author-text normaliser" });

  const names = input.instructions ? new Set(input.instructions.map((i) => i.name)) : null;
  const check = (section: string, instruction: string) =>
    names === null
      ? `Aviary could not read this version's instruction names, so it could not check the ${section} in the author's metadata against them.`
      : names.has(instruction)
        ? `The ${section} in the author's metadata builds the call to ${instruction}, which this version's code contains: Aviary found its name and its discriminator in the code.`
        : `The ${section} in the author's metadata builds the call to ${instruction}, which this version's code does not contain.`;
  if (input.metadata?.init) facts.push({ group: "Program", label: "Create form check", value: check("create form", "PipelineInitMarket"), source: fromCode });
  if (input.metadata?.seed) facts.push({ group: "Program", label: "Seeding check", value: check("seeding section", "PipelineSeedLiquidity").replace("builds the call to", "is run by"), source: fromCode });

  const labelled = (doc.init?.args ?? []).flatMap((arg) => {
    const item = author.find((a) => a.label === `create form: label of the argument ${arg.name}, from strategy metadata`);
    return item ? [`The label in ${item.id} is on the argument ${arg.name}, of type ${arg.type}.`] : [];
  });
  if (labelled.length) facts.push({ group: "Program", label: "Create form labels", value: `${labelled.join(" ")} What an argument does is not checked by code.`, source: fromCode });

  const ai = addressesAi(author.map((a) => a.value));
  facts.push({ group: "Program", label: "Aviary's check of the author text", value: ai ? "Aviary's own check found author text addressed to AI tools." : "Aviary's own check found no author text addressed to AI tools.", source: "Aviary's detector for text addressed to AI tools" });
  return { author, facts, addressesAi: ai };
}
