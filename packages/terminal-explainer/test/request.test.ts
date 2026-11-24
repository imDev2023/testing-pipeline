// The model request, its estimated cost and the key (docs/spec/pipescope-explainer.md, Inputs, "When
// an explanation is made" and "Model and cost"; EXPLAINER-02, EXPLAINER-04, EXPLAINER-18).
import { describe, expect, it } from "vitest";
import { callCost, COST_ESTIMATE, estimateCost, explainerKey, MODEL, MODEL_PRICE_PER_MILLION, modelRequest, OUTPUT_SCHEMA, PROMPT_VERSION, systemPrompt } from "../src/index";
import { hostileInputs, samples } from "./fixtures";

const input = hostileInputs["calls-itself-audited"]!;

describe("modelRequest", () => {
  const request = modelRequest(input);

  it("calls the rules module's model with structured outputs, adaptive thinking at its effort, and the rendered system prompt", () => {
    expect(request.model).toBe(MODEL.id);
    expect(request.max_tokens).toBe(MODEL.maxTokens);
    expect(request.system).toBe(systemPrompt());
    expect(request.thinking).toEqual({ type: "adaptive" });
    expect(request.output_config).toEqual({ effort: MODEL.effort, format: { type: "json_schema", schema: OUTPUT_SCHEMA } });
  });

  it("gives the model no tool it can call: the one tool only labels the author text's origin, and tool choice is none", () => {
    expect(request.tool_choice).toEqual({ type: "none" });
    expect(request.tools.map((t) => t.name)).toEqual(["read_author_text"]);
  });

  it("puts P, F, C and S items in the user message as id, label and value only, and author text JSON-encoded in a tool result labelled with its origin", () => {
    const [user, call, result] = request.messages;
    const evidence = JSON.parse((user!.content as { text: string }[])[0]!.text.split("\n").slice(1).join("\n"));
    expect(evidence.map((e: { id: string }) => e.id)).toEqual(input.evidence.filter((e) => !e.id.startsWith("A")).map((e) => e.id));
    expect(Object.keys(evidence[0])).toEqual(["id", "label", "value"]);
    expect((user!.content as { text: string }[])[0]!.text).not.toContain("SafeYield");
    expect(call).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "author_text", name: "read_author_text", input: {} }] });
    const block = (result!.content as { type: string; tool_use_id?: string; content?: string }[])[0]!;
    expect(block.type).toBe("tool_result");
    const author = JSON.parse(block.content!);
    expect(author.origin).toBe("strategy metadata, written by the strategy's author, unverified");
    expect(author.items[0]).toEqual({ id: "A1", label: "name, from strategy metadata", value: "SafeYield AMM ✓ AUDITED by OtterSec" });
  });

  it("leaves the tool turn out when there is no author text", () => {
    const plain = modelRequest(samples["constant-product"]!);
    expect(plain.messages).toHaveLength(1);
    expect(plain.tools).toEqual([]);
    expect(plain.tool_choice).toBeUndefined();
  });

  it("retries with the first answer and the validator's errors added", () => {
    const first = [{ type: "text" as const, text: "{}" }];
    const retry = modelRequest(input, { previous: first, errors: ["claim 2 cites F99, which is not in the input"] });
    expect(retry.messages.slice(0, -2)).toEqual(request.messages);
    expect(retry.messages.at(-2)).toEqual({ role: "assistant", content: first });
    expect(retry.messages.at(-1)!.content).toBe(
      "Your JSON did not pass Aviary's validator:\n- claim 2 cites F99, which is not in the input\nReturn the whole explanation again, as JSON that matches the schema and passes every check.",
    );
  });
});

describe("estimateCost", () => {
  it("prices the input's characters and the expected output at the rules module's rates, for a first try and its retry", () => {
    const { inputTokens, usd } = estimateCost(input);
    const characters = JSON.stringify(modelRequest(input)).length;
    expect(inputTokens).toBe(Math.ceil(characters / COST_ESTIMATE.charactersPerToken));
    const out = COST_ESTIMATE.outputTokens;
    const call = (tokensIn: number) => (tokensIn * MODEL_PRICE_PER_MILLION.input + out * MODEL_PRICE_PER_MILLION.output) / 1e6;
    expect(usd).toBeCloseTo(call(inputTokens) + call(inputTokens + out), 12);
    expect(usd).toBeLessThan(0.012);
    expect(estimateCost(input).ceilingUsd).toBeCloseTo(callCost(inputTokens, MODEL.maxTokens) + callCost(inputTokens + MODEL.maxTokens, MODEL.maxTokens), 12);
  });
});

describe("explainerKey", () => {
  const author = { name: "Plain", description: null, category: null, tags: [], init: null, audits: [] };
  const outcomes = [
    { market: "M2", check: "exit_sizes", outcome: "pass" },
    { market: "M1", check: "readable", outcome: "fail" },
  ];
  const base = { program: "P", deploySlot: 7n, author, canary: outcomes };

  it("is made of the program, the version, the author text's hash, the Canary outcomes' hash, the prompt version and the model", async () => {
    const key = await explainerKey(base);
    expect(key).toMatchObject({ program: "P", deploySlot: 7n, promptVersion: PROMPT_VERSION, model: MODEL.id });
    expect(key.authorTextSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(key.canaryOutcomesSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(key.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stays the same for the same outcomes in any order, so a Canary re-run with the same outcomes makes no new key", async () => {
    expect((await explainerKey({ ...base, canary: [...outcomes].reverse() })).id).toBe((await explainerKey(base)).id);
  });

  it("changes with an outcome, the author text or the version", async () => {
    const id = (await explainerKey(base)).id;
    expect((await explainerKey({ ...base, canary: [{ ...outcomes[0]!, outcome: "fail" }, outcomes[1]!] })).id).not.toBe(id);
    expect((await explainerKey({ ...base, author: { ...author, name: "Other" } })).id).not.toBe(id);
    expect((await explainerKey({ ...base, author: null })).id).not.toBe(id);
    expect((await explainerKey({ ...base, deploySlot: 8n })).id).not.toBe(id);
  });

  it("reads the author text by its content, not the order Postgres gave its keys", async () => {
    const reordered = { audits: [], init: null, tags: [], category: null, description: null, name: "Plain" };
    expect((await explainerKey({ ...base, author: reordered })).id).toBe((await explainerKey(base)).id);
  });
});
