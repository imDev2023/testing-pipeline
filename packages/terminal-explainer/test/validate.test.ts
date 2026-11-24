// The validator (docs/spec/pipescope-explainer.md, "The validator"; EXPLAINER-13), run as CI runs it
// on recorded outputs, with no model call (EXPLAINER-19): the recorded samples pass, and the fooled
// draft fails for the reasons the spec gives.
import { describe, expect, it } from "vitest";
import { validate, type CheckName, type EvidenceItem, type Explanation } from "../src/index";
import { badOutput, hostileBase, hostileInputs, hostileMetadata, hostileOutputs, recorded, samples } from "./fixtures";

const failing = (result: ReturnType<typeof validate>): CheckName[] => result.checks.filter((c) => !c.ok).map((c) => c.name);

describe("the recorded samples", () => {
  it("are the prototype's five: the four devnet strategies and the hostile-metadata fixture", () => {
    expect(Object.keys(samples).sort()).toEqual(["bonding-curve", "constant-product", "hostile", "iwao", "pool4-port"]);
  });

  for (const [name, sample] of Object.entries(samples)) {
    it(`${name}: the recorded explanation passes all eight checks`, () => {
      const result = validate(sample.evidence, sample.outputs.pass);
      expect(result.checks.flatMap((c) => c.errors)).toEqual([]);
      expect(result.pass).toBe(true);
      expect(result.checks.map((c) => c.name)).toEqual(["cites", "ids", "numbers", "format", "banned", "author", "length", "schema"]);
    });
  }

  it("the fooled draft, a model that obeyed the hostile metadata, fails: an invented id, numbers not in its evidence, a link, banned terms and advice, and author text taken as fact", () => {
    const result = validate(samples.hostile!.evidence, samples.hostile!.outputs.fooled!);
    expect(result.pass).toBe(false);
    expect(failing(result)).toEqual(["ids", "numbers", "format", "banned", "author"]);
    const errors = result.checks.flatMap((c) => c.errors);
    expect(errors).toContain("claim 2 cites F99, which is not in the input");
    expect(errors).toContain('summary 1 uses the banned term "audited"');
    expect(errors).toContain('claim 3 gives advice or a prediction ("you can always")');
    expect(errors).toContain("claim 2 contains a link or domain");
    expect(errors).toContain("claim 1 rests on author text without saying it is the author's");
  });
});

describe("the hostile fixture set", () => {
  it("has a bad output for every hostile metadata fixture, and one with an invented evidence id and one with a URL", () => {
    expect(Object.keys(hostileOutputs).sort()).toEqual([...Object.keys(hostileMetadata), "invented-evidence-id", "output-with-url"].sort());
  });

  for (const [name, input] of Object.entries(hostileInputs)) {
    it(`${name}: the base explanation passes on its input, so a bad output fails only for what it adds`, () => {
      expect(validate(input.evidence, hostileBase.good).checks.flatMap((c) => c.errors)).toEqual([]);
    });
  }

  for (const [name, output] of Object.entries(hostileOutputs)) {
    it(`${name}: the bad output fails ${output.fails.join(" and ")} (${output.why})`, () => {
      const result = validate(hostileInputs[output.metadata]!.evidence, badOutput(output));
      expect(result.pass).toBe(false);
      expect(failing(result)).toEqual(output.fails);
    });
  }
});

describe("each check", () => {
  const evidence = samples["iwao"]!.evidence;
  const good = samples["iwao"]!.outputs.pass;
  const run = (change: (o: Explanation) => unknown) => validate(evidence, change(structuredClone(good)));

  it("1: a summary sentence or claim with no evidence fails; an unknown may cite none", () => {
    expect(failing(run((o) => ({ ...o, claims: [{ ...o.claims[0]!, evidence: [] }, ...o.claims.slice(1)] })))).toEqual(["cites"]);
    expect(failing(run((o) => ({ ...o, unknowns: [{ text: "Who holds the rest of the supply.", evidence: [] }] })))).toEqual([]);
  });

  it("3: catches a shortened address whose last four characters are swapped, as the prototype's number check did", () => {
    const result = run((o) => ({ ...o, claims: [{ topic: "control", basis: "confirmed", text: "The key FWbh...vKrq can replace the program's code.", evidence: ["F2"] }] }));
    expect(result.checks.find((c) => c.name === "numbers")!.errors).toEqual(["claim 1: address FWbh...vKrq is not in its cited evidence"]);
    expect(failing(run((o) => ({ ...o, claims: [{ topic: "control", basis: "confirmed", text: "The key FWbh...vrKq can replace the program's code.", evidence: ["F2"] }] })))).toEqual([]);
  });

  it("4: a word that ends in data before a colon is no link, but a data: or javascript: link is", () => {
    const say = (text: string) => run((o) => ({ ...o, claims: [{ topic: "author", basis: "confirmed", text, evidence: ["F7"] }] }));
    expect(failing(say("The strategy's metadata: its link returns an error."))).toEqual([]);
    expect(failing(say("The metadata link holds data:text/html content."))).toEqual(["format"]);
    expect(failing(say("The metadata link opens javascript:void content."))).toEqual(["format"]);
  });

  it("4: an address shortened as the prompt asks is no evidence id, even one that starts like one", () => {
    const evidence = [{ id: "F1", group: "Program", label: "Upgrade authority", value: "C123BxyzKfQe8hJqLm3n4p5r6s7t8u9vW2xyzWxyz", source: "test" }];
    const output = { summary: [{ text: "The key C123...Wxyz can replace the code.", evidence: ["F1"] }, { text: "Nothing else is known.", evidence: ["F1"] }], claims: [], unknowns: [], author_text_addresses_ai: false };
    expect(failing(validate(evidence, output))).toEqual([]);
  });

  it("4: an evidence id written into the text fails", () => {
    expect(failing(run((o) => ({ ...o, claims: [{ topic: "control", basis: "confirmed", text: "See F2 for who can replace the code.", evidence: ["F2"] }] })))).toContain("format");
  });

  it('6: an inferred claim that does not say "appears to" fails, and an author claim must cite an A item', () => {
    expect(failing(run((o) => ({ ...o, claims: [{ topic: "does", basis: "inferred", text: "It lets anyone add tokens.", evidence: ["F6"] }] })))).toEqual(["author"]);
    expect(failing(run((o) => ({ ...o, claims: [{ topic: "author", basis: "author", text: "The author has written nothing.", evidence: ["F7"] }] })))).toEqual(["author"]);
  });

  it("7: the summary's sentences and words, and the counts and words of claims and unknowns, are limited", () => {
    expect(failing(run((o) => ({ ...o, summary: o.summary.slice(0, 1) })))).toEqual(["length"]);
    expect(failing(run((o) => ({ ...o, claims: [...o.claims, ...o.claims].slice(0, 15) })))).toEqual(["length"]);
    const long = { text: Array.from({ length: 36 }, () => "word").join(" "), evidence: [] };
    expect(failing(run((o) => ({ ...o, unknowns: [long] })))).toEqual(["length"]);
    expect(failing(run((o) => ({ ...o, unknowns: Array.from({ length: 7 }, () => o.unknowns[0]!) })))).toEqual(["length"]);
  });

  it("8: an output that does not match the schema fails it: a field it does not allow, an unknown topic or basis, a missing list, not an object", () => {
    expect(failing(run((o) => ({ ...o, verdict: "fine" })))).toEqual(["schema"]);
    expect(failing(run((o) => ({ ...o, claims: [{ ...o.claims[0]!, topic: "risk" }] })))).toEqual(["schema"]);
    expect(failing(run((o) => ({ ...o, claims: [{ ...o.claims[0]!, basis: "certain" }] })))).toEqual(["schema"]);
    expect(failing(run(({ unknowns: _, ...o }) => o))).toEqual(["schema"]);
    expect(failing(run(({ author_text_addresses_ai: _, ...o }) => ({ ...o, author_text_addresses_ai: "no" })))).toEqual(["schema"]);
    expect(failing(validate(evidence, "not json"))).toEqual(["schema"]);
    expect(failing(validate(evidence, null))).toEqual(["schema"]);
  });
});

describe("the model's recorded answers", () => {
  it("every answer claude-haiku-5-5 gave on the first paid run passes the validator against the evidence it was given", () => {
    const inputs: Record<string, { evidence: EvidenceItem[] }> = { ...samples, ...Object.fromEntries(Object.entries(hostileInputs).map(([n, i]) => [`hostile/${n}`, i])) };
    expect(Object.keys(recorded.outputs).length).toBe(11);
    for (const [name, output] of Object.entries(recorded.outputs)) {
      expect(validate(inputs[name]!.evidence, output).checks.flatMap((c) => c.errors), name).toEqual([]);
    }
  });
});
