// One explanation (docs/spec/pipescope-explainer.md, The validator; EXPLAINER-13, EXPLAINER-18): the
// model called once, its JSON validated, one retry with the validator's errors, and a refusal or a
// second failure marked failed; with a recorded model, never the real one.
import { callCost } from "terminal-explainer";
import { samples } from "terminal-explainer/fixtures";
import { describe, expect, it } from "vitest";
import { generate, RetryRequestFailed, type ModelClient, type ModelResponse } from "../src/generate";

const sample = samples["constant-product"]!;
const good = sample.outputs.pass;
const bad = samples["hostile"]!.outputs.fooled!;

const answer = (output: unknown, over: Partial<ModelResponse> = {}): ModelResponse => ({
  content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
  stop_reason: "end_turn",
  usage: { input_tokens: 2700, output_tokens: 3000 },
  ...over,
});

/** A recorded model: answers in turn, keeping each request it was sent. */
function recorded(...answers: (ModelResponse | Error)[]): ModelClient & { requests: unknown[] } {
  const requests: unknown[] = [];
  return {
    requests,
    create: async (request) => {
      requests.push(request);
      const next = answers.shift();
      if (!next) throw new Error("no more recorded answers");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

describe("generate", () => {
  it("keeps an answer that passes the validator on the first try", async () => {
    const model = recorded(answer(good));
    const result = await generate(model, sample);
    expect(result).toMatchObject({ status: "done", explanation: good, attempts: 1, inputTokens: 2700, outputTokens: 3000, failure: null, firstErrors: [] });
    expect(result.costUsd).toBeCloseTo(callCost(2700, 3000), 12);
    expect(result.validation.pass).toBe(true);
  });

  it("retries once with the validator's errors, and keeps a retry that passes", async () => {
    const model = recorded(answer(bad), answer(good, { usage: { input_tokens: 6000, output_tokens: 2500 } }));
    const result = await generate(model, sample);
    expect(result).toMatchObject({ status: "done", attempts: 2, inputTokens: 8700, outputTokens: 5500 });
    const retry = model.requests[1] as { messages: { role: string; content: unknown }[] };
    expect(retry.messages.at(-2)).toEqual({ role: "assistant", content: answer(bad).content });
    expect(retry.messages.at(-1)!.content).toContain("cites F99, which is not in the input");
    expect(result.firstErrors).toContain("claim 2 cites F99, which is not in the input");
  });

  it("marks the key failed when the retry fails too", async () => {
    const result = await generate(recorded(answer(bad), answer(bad)), sample);
    expect(result).toMatchObject({ status: "failed", attempts: 2, explanation: null, failure: "the validator refused both answers" });
    expect(result.validation.pass).toBe(false);
  });

  it("sends a refusal straight to failed, with no retry", async () => {
    const model = recorded(answer("", { stop_reason: "refusal" }));
    const result = await generate(model, sample);
    expect(result).toMatchObject({ status: "failed", attempts: 1, failure: "the model refused" });
    expect(model.requests).toHaveLength(1);
  });

  it("treats an answer cut off at the token ceiling, or one that is not JSON, as failing the schema check", async () => {
    const result = await generate(recorded(answer('{"summary": [', { stop_reason: "max_tokens" }), answer("not json")), sample);
    expect(result).toMatchObject({ status: "failed", attempts: 2 });
    expect(result.validation.checks.find((c) => c.name === "schema")!.errors[0]).toMatch(/^the answer is not JSON/);
  });

  it("throws when the retry's request fails, so the key stays pending, carrying the first call's spend for the ledger", async () => {
    const failed = await generate(recorded(answer(bad), new Error("overloaded")), sample).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(RetryRequestFailed);
    expect((failed as RetryRequestFailed).message).toBe("the retry's request failed: overloaded");
    expect((failed as RetryRequestFailed).spent).toEqual({ calls: 1, inputTokens: 2700, outputTokens: 3000, costUsd: callCost(2700, 3000) });
  });

  it("lets a first request that fails throw, so the key stays pending", async () => {
    await expect(generate(recorded(new Error("connection refused")), sample)).rejects.toThrow("connection refused");
  });
});
