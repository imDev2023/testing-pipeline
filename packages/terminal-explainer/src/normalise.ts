// The author-text normaliser (docs/spec/pipescope-explainer.md, Inputs; EXPLAINER-08): what a
// strategy's author wrote in its metadata is untrusted, so before Aviary stores, shows or explains
// it, control and text-direction characters are stripped, each field is capped (AUTHOR_TEXT_CAPS),
// the image is dropped and no link is kept, since none is ever shown as a link, passed to the model
// or fetched. What it removed is reported, for the facts panel and the explainer's F items.
//
// It runs on a document Pipeline's validator (`parseStrategyMetadata`) has accepted, and keeps only
// the fields Aviary reads: unknown keys, the source and the conformance report (leads, never evidence)
// and the security contact are left out. Markup and Markdown are kept as the characters they are:
// the page shows them as plain text, so `<b>` reads as those three characters.
import type { StrategyMetadata } from "@pipeline-sol/sdk";
import { AUTHOR_TEXT_CAPS } from "./rules";

/**
 * Characters stripped from author text: every control character (line breaks and tabs become a
 * space first) and every format character, which takes in each text-direction mark, embedding,
 * override and isolate, which can make text read differently from what it is, and every zero-width
 * character and the byte-order mark, which hide in it.
 */
const STRIPPED = /[\p{Cc}\p{Cf}]/gu;
const BREAKS = /[\t\n\r]/g;

export type AuthorText = { text: string; removedCharacters: number; truncated: boolean };

/** One field of author text, normalised and capped at `cap` characters. */
export function authorText(value: string, cap: number): AuthorText {
  let removedCharacters = 0;
  const stripped = value.replace(BREAKS, " ").replace(STRIPPED, () => {
    removedCharacters++;
    return "";
  });
  const characters = [...stripped.replace(/ {2,}/g, " ").trim()];
  const truncated = characters.length > cap;
  return { text: characters.slice(0, cap).join("").trimEnd(), removedCharacters, truncated };
}

export type NormalisedArg = { name: string; type: string; label: string | null; description: string | null };

/** A strategy's metadata as Aviary keeps it to show and explain: author text only, normalised. */
export type NormalisedMetadata = {
  name: string;
  description: string | null;
  category: string | null;
  tags: string[];
  /** The create form: its description, and each argument's name and type (identifiers) with its author's label and description. */
  init: { description: string | null; args: NormalisedArg[] } | null;
  /** Reviews the author lists, by whom and when: unverified author text, never evidence of an audit. */
  audits: { by: string; date: string | null }[];
};

/** What the normaliser removed: characters stripped, fields cut to their cap (by path), the image and links left out. */
export type Removed = { characters: number; truncated: string[]; images: number; links: number };

export function normaliseMetadata(metadata: StrategyMetadata): { document: NormalisedMetadata; removed: Removed } {
  const removed: Removed = { characters: 0, truncated: [], images: 0, links: 0 };
  const text = (value: string, cap: number, path: string): string => {
    const out = authorText(value, cap);
    removed.characters += out.removedCharacters;
    if (out.truncated) removed.truncated.push(path);
    return out.text;
  };
  const optional = (value: unknown, cap: number, path: string): string | null => (typeof value === "string" ? text(value, cap, path) || null : null);
  const { label, description } = AUTHOR_TEXT_CAPS;

  if (metadata.image !== undefined) removed.images++;
  removed.links += Object.values(metadata.links ?? {}).filter((v) => typeof v === "string").length;
  if (metadata.source?.repository) removed.links++;
  if (metadata.conformance?.report) removed.links++;
  if (metadata.security?.policy) removed.links++;
  removed.links += (metadata.security?.audits ?? []).filter((a) => typeof a.url === "string").length;

  const init = metadata.init
    ? {
        description: optional(metadata.init.description, description, "init.description"),
        args: (metadata.init.args ?? []).map((arg, i) => ({
          name: arg.name,
          type: arg.type,
          label: optional(arg.label, label, `init.args[${i}].label`),
          description: optional(arg.description, description, `init.args[${i}].description`),
        })),
      }
    : null;

  return {
    document: {
      name: text(metadata.name, AUTHOR_TEXT_CAPS.name, "name"),
      description: optional(metadata.description, description, "description"),
      category: metadata.category ?? null,
      tags: (metadata.tags ?? []).map((tag, i) => text(tag, label, `tags[${i}]`)).filter(Boolean),
      init,
      audits: (metadata.security?.audits ?? []).map((a, i) => ({ by: text(a.by, label, `security.audits[${i}].by`), date: typeof a.date === "string" ? a.date : null })),
    },
    removed,
  };
}
