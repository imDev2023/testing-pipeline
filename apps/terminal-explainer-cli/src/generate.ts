// One explanation (docs/spec/pipescope-explainer.md, The validator; docs/spec/pipescope-architecture.md,
// "Explainer jobs"; EXPLAINER-13, EXPLAINER-18): the model called with the request terminal-explainer
// builds, its JSON validated against the evidence, one retry with the validator's errors, and a
// refusal or a second failure marked failed. Claude Haiku 5.5 has no server-side refusal fallback,
// so a refusal goes straight to failed.
import { callCost, modelRequest, validate, validationErrors, type ExplainerInput, type ModelRequest, type Validation } from "terminal-explainer";

/** What the approve and eval commands need of a model response (the Messages API's `Message`). */
export type ModelResponse = { content: readonly unknown[]; stop_reason: string | null; usage: { input_tokens: number; output_tokens: number } };
/** The model, as the Anthropic SDK's `messages.create` or a recorded one in the tests. */
export type ModelClient = { create: (request: ModelRequest) => Promise<ModelResponse> };

export type Generation = {
  status: "done" | "failed";
  explanation: unknown;
  validation: Validation;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  failure: string | null;
  /** What the validator found wrong with the first answer when it was retried, for the report. */
  firstErrors: string[];
};

/**
 * The retry's request failed (the network, or the API refusing the request): nothing about the key
 * is known, so it stays pending, and the first call's spend is carried here for the ledger.
 */
export class RetryRequestFailed extends Error {
  constructor(
    readonly cause: unknown,
    readonly spent: { calls: number; inputTokens: number; outputTokens: number; costUsd: number },
  ) {
    super(`the retry's request failed: ${(cause as Error)?.message ?? String(cause)}`);
  }
}

const textOf = (content: readonly unknown[]) =>
  content
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && (b as { type?: unknown }).type === "text")
    .map((b) => b.text)
    .join("");

/** The answer parsed and validated; an answer that is not JSON fails the schema check with what was wrong. */
function check(input: ExplainerInput, response: ModelResponse): { output: unknown; validation: Validation } {
  const text = textOf(response.content);
  let output: unknown;
  try {
    output = JSON.parse(text);
  } catch (e) {
    const why = response.stop_reason === "max_tokens" ? "it was cut off at the token ceiling" : (e as Error).message;
    const validation = validate(input.evidence, output);
    const schema = validation.checks.find((c) => c.name === "schema")!;
    schema.errors = [`the answer is not JSON (${why})`];
    return { output: null, validation };
  }
  return { output, validation: validate(input.evidence, output) };
}

export async function generate(model: ModelClient, input: ExplainerInput): Promise<Generation> {
  let inputTokens = 0;
  let outputTokens = 0;
  const spent = (r: ModelResponse) => {
    inputTokens += r.usage.input_tokens;
    outputTokens += r.usage.output_tokens;
  };
  let firstErrors: string[] = [];
  const result = (attempts: number, rest: Pick<Generation, "status" | "explanation" | "validation" | "failure">): Generation => ({ ...rest, attempts, inputTokens, outputTokens, costUsd: callCost(inputTokens, outputTokens), firstErrors });

  const first = await model.create(modelRequest(input));
  spent(first);
  const firstCheck = check(input, first);
  if (first.stop_reason === "refusal") return result(1, { status: "failed", explanation: null, validation: firstCheck.validation, failure: "the model refused" });
  if (firstCheck.validation.pass) return result(1, { status: "done", explanation: firstCheck.output, validation: firstCheck.validation, failure: null });

  firstErrors = validationErrors(firstCheck.validation);
  let second: ModelResponse;
  try {
    second = await model.create(modelRequest(input, { previous: first.content, errors: firstErrors }));
  } catch (e) {
    throw new RetryRequestFailed(e, { calls: 1, inputTokens, outputTokens, costUsd: callCost(inputTokens, outputTokens) });
  }
  spent(second);
  const secondCheck = check(input, second);
  if (second.stop_reason === "refusal") return result(2, { status: "failed", explanation: null, validation: secondCheck.validation, failure: "the model refused" });
  if (secondCheck.validation.pass) return result(2, { status: "done", explanation: secondCheck.output, validation: secondCheck.validation, failure: null });
  return result(2, { status: "failed", explanation: null, validation: secondCheck.validation, failure: "the validator refused both answers" });
}
