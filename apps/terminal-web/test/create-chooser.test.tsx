// Create market's strategy chooser (docs/spec/pipescope-screens.md, Create market; PIPESCOPE-142):
// every registered strategy with its markets and who can upgrade it, one whose metadata is valid
// offering its create form and one without saying why; and the line above the list only while no
// strategy has valid metadata, as on devnet on 2026-11-10.
import { renderToStaticMarkup } from "react-dom/server";
import type { Strategy } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { StrategyChooser } from "@/components/create/CreateMarket";

const strategy = (program: string, status: Strategy["metadata"]["status"], name: string | null, over: Partial<Strategy> = {}): Strategy => ({
  program,
  metadata_uri: `https://example.com/${program}.json`,
  fee_paid: null,
  registered_at: "2026-11-20T00:00:00.000Z",
  registered_signature: null,
  market_count: 3,
  name,
  description: null,
  create_form: status === "valid",
  metadata: { status, uri: `https://example.com/${program}.json`, url: null, fetched_at: null, checked_at: null, errors: [], warnings: [], sha256: null, removed: null },
  flags: ["upgradeable"],
  upgrade_authority: "Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe",
  current_version: null,
  verified_build: null,
  canary: null,
  ...over,
});
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replace(/\s+/g, " ").replace(/ ([.,;:)])/g, "$1").trim();
const LINE = "No strategy on devnet has valid metadata today, so none offers a create form here. Their markets were created from their authors' own tools.";

describe("the strategy chooser", () => {
  it("says above the list that no strategy offers a create form while none has valid metadata, and why each has none", () => {
    const text = textOf(renderToStaticMarkup(<StrategyChooser strategies={[strategy("ETrmQd3NUmW4xh9uGRbC1F8XoDb2wEJYBGVwF6xGfx4Z", "unreachable", null), strategy("2TmcwB8MpxxFYbbqdHmyzN9W3wR4ZVv6s6KKaMbAKv7D", "invalid", null, { market_count: 1, upgrade_authority: null, flags: ["frozen"] })]} chosen={null} onChoose={() => {}} />));
    expect(text.startsWith(LINE)).toBe(true);
    expect(text).toContain("ETrm...fx4Z Metadata unavailable 3 markets; upgradeable by Gf8t...WsPe No create form: its metadata is unavailable (the link could not be fetched).");
    expect(text).toContain("2Tmc...Kv7D Metadata unavailable 1 market; frozen: nobody can upgrade it No create form: its metadata is unavailable (the document did not pass Pipeline's validator).");
    expect(text).not.toContain("Open its create form");
  });

  it("offers the create form of a strategy with valid metadata, and drops the line", () => {
    const html = renderToStaticMarkup(
      <StrategyChooser
        strategies={[strategy("J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t", "valid", "Aviary Tax AMM"), strategy("ETrmQd3NUmW4xh9uGRbC1F8XoDb2wEJYBGVwF6xGfx4Z", "not-fetched", null), strategy("4iXya1F7TozDVKnBCCjUL1pHe1xgneC2qqhVjW4rEFNo", "valid", "PipeUp Launchpad", { create_form: false })]}
        chosen="J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t"
        onChoose={() => {}}
      />,
    );
    const text = textOf(html);
    expect(text).not.toContain(LINE);
    expect(text).toContain("Aviary Tax AMM J4sA...nW9t 3 markets; upgradeable by Gf8t...WsPe Its create form is below");
    expect(text).toContain("No create form: its metadata is unavailable (Aviary has not fetched it yet).");
    expect(text).toContain("PipeUp Launchpad 4iXy...EFNo 3 markets; upgradeable by Gf8t...WsPe No create form: its metadata describes none.");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"/);
  });
});
