// Author text on the pages (docs/spec/pipescope.md, "Custom-action and create-market forms";
// PIPESCOPE-21, PIPESCOPE-65): every hostile metadata fixture of the explainer's, as the normaliser
// leaves it and the API serves it, renders through the components the pages use as plain text in
// the author's style, beside the strategy's short address; none of it becomes a link, an element or
// Markdown, and what it says reads exactly as the author wrote it, less what the normaliser removed.
import { parseStrategyMetadata } from "@pipeline-sol/sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { normaliseMetadata } from "terminal-explainer";
import { hostileMetadata } from "terminal-explainer/fixtures";
import { describe, expect, it } from "vitest";
import { AuthorText } from "@/components/Voice";
import { StrategyName } from "@/components/StrategyName";

const PROGRAM = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";

/** The text of rendered markup, its entities read back. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");

/** Every element the markup holds, by tag name. */
const tagsOf = (html: string) => [...html.matchAll(/<([a-z][a-z0-9]*)\b/g)].map((m) => m[1]);

describe.each(Object.entries(hostileMetadata))("the hostile fixture %s", (_, json) => {
  const parsed = parseStrategyMetadata(json);
  if (!parsed.ok) throw new Error("every hostile fixture is valid metadata");
  const { document } = normaliseMetadata(parsed.value);

  it("names its strategy in the author's style, as plain text, with the short address beside it", () => {
    const html = renderToStaticMarkup(<StrategyName program={PROGRAM} name={document.name} metadata="valid" />);
    expect(tagsOf(html).every((tag) => tag === "span")).toBe(true);
    expect(html).toMatch(/^<span[^>]*><span class="[^"]*author[^"]*">/);
    expect(textOf(html)).toBe(`${document.name} J4sA...nW9t`);
  });

  it("shows its description as plain text, where markup and links stay the characters they are", () => {
    const html = renderToStaticMarkup(<AuthorText>{document.description ?? ""}</AuthorText>);
    expect(tagsOf(html)).toEqual(["span"]);
    expect(textOf(html)).toBe(document.description ?? "");
    // Past the one span, no character of markup is left unescaped.
    expect(html.replace(/^<span[^>]*>|<\/span>$/g, "")).not.toMatch(/[<>"]/);
  });
});

describe("a strategy without valid metadata", () => {
  it("is named by its short address, with \"Metadata unavailable\", set plainly", () => {
    const html = renderToStaticMarkup(<StrategyName program={PROGRAM} name={null} metadata="unreachable" />);
    expect(textOf(html)).toBe("J4sA...nW9t Metadata unavailable");
    expect(html).not.toMatch(/author/);
  });

  it("whose metadata was never fetched yet says so instead", () => {
    expect(textOf(renderToStaticMarkup(<StrategyName program={PROGRAM} name={null} metadata="not-fetched" />))).toBe("J4sA...nW9t Metadata not read yet");
  });
});
