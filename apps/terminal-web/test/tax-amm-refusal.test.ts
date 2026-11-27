// The launch form's refusal of a mint the tax AMM's mint rules refuse, before any signature
// (docs/spec/tax-amm.md, "Mint rules"; #75): the simulation's decoded failure names the program's
// rule, and the form adds which mint breaks it and, for an extension, which one, by Token-2022's name.
import type { Failure } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { mintRuleRefusal } from "@/products/taxAmm/refusal";

const TOKEN = "AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx";
const failure = (name: string, message: string): Failure => ({ class: "strategy_refused", sentence: `The strategy refused it: ${name}.`, name, number: 6005, message, program: "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t", raw: "{}" });
const tokenNamed = (mint: string) => (mint === TOKEN ? "AVIMG" : null);

describe("mintRuleRefusal", () => {
  it("names the refused extension and the mint that carries it", () => {
    const said = mintRuleRefusal(failure("MintExtensionNotAllowed", "The mint carries an extension the mint rules refuse"), [`Program log: Mint ${TOKEN} carries refused extension 12`], tokenNamed);
    expect(said).toBe("AVIMG breaks the tax AMM's mint rules: it carries Token-2022's permanent delegate extension (number 12), and the mint carries an extension the mint rules refuse.");
  });

  it("names a transfer hook the market refuses, and an authority the seed refuses", () => {
    expect(mintRuleRefusal(failure("TransferHookNotAllowed", "A mint's transfer hook must be cleared, or be the containment hook with the mint's unlock PDA as its authority"), [`Program log: Mint ${TOKEN} has a transfer hook a market refuses`], tokenNamed)).toBe(
      "AVIMG breaks the tax AMM's mint rules: a mint's transfer hook must be cleared, or be the containment hook with the mint's unlock PDA as its authority.",
    );
    expect(mintRuleRefusal(failure("MintAuthoritySet", "A mint other than a quote mint must have no mint authority when its market is seeded"), [], tokenNamed)).toBe(
      "The token breaks the tax AMM's mint rules: a mint other than a quote mint must have no mint authority when its market is seeded.",
    );
  });

  it("says nothing of any other failure", () => {
    expect(mintRuleRefusal(failure("TaxOutOfRange", "A tax rate is outside its range"), [], tokenNamed)).toBeNull();
    expect(mintRuleRefusal(null, [], tokenNamed)).toBeNull();
  });
});
