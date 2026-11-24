// Evidence (docs/spec/pipescope-explainer.md, Inputs; EXPLAINER-07): what the model is given, as
// items each with an id, a label and a value. Ids are a group's letter and a number: P (Pipeline's
// fixed rules), F (chain facts), C (Canary results), S (verified source excerpts) and A (author
// text, untrusted). Aviary also keeps each item's group and where it was read, for the facts panel;
// those are never sent to the model.

export type EvidenceGroup = "P" | "F" | "C" | "S" | "A";

export type EvidenceItem = {
  id: string;
  /** What the facts panel files it under ("Program", "Market", "Canary"...). */
  group: string;
  label: string;
  value: string;
  /** Where and when Aviary read it: shown in the facts panel, never sent to the model. */
  source: string;
};

/** An item before the assembler numbers it. */
export type Fact = Omit<EvidenceItem, "id">;

/**
 * The model's evidence, numbered: P, F, C and S items each from 1 in the order given, then the A
 * items, which come numbered (./author), since F items name them by id.
 */
export function assembleEvidence(groups: { pipeline: readonly Fact[]; facts: readonly Fact[]; canary: readonly Fact[]; source?: readonly Fact[]; author: readonly EvidenceItem[] }): EvidenceItem[] {
  const number = (letter: EvidenceGroup, items: readonly Fact[]) => items.map((item, i) => ({ id: `${letter}${i + 1}`, ...item }));
  return [...number("P", groups.pipeline), ...number("F", groups.facts), ...number("C", groups.canary), ...number("S", groups.source ?? []), ...groups.author];
}
