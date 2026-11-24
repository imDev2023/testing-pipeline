// The model request (docs/spec/pipescope-explainer.md, "What the explainer is", Inputs and "Model
// and cost"; EXPLAINER-02, EXPLAINER-18), and the cost the approval queue estimates for it.
//
// The call reaches nothing (EXPLAINER-02): it reads a prepared input and returns JSON. Author text
// reaches the model JSON-encoded in a tool result labelled with its origin, and everything else is
// in the user message; the tool exists only so that turn can be a tool result, and tool choice
// `none` means the model can never call it. Only an item's id, label and value are sent.
//
// Written without the Anthropic SDK, which only the owner's approve command imports (no LLM key or
// SDK is in `terminal-api`, PIPESCOPE-37); the shapes are the Messages API's.
import type { EvidenceItem } from "./evidence";
import { COST_ESTIMATE, MODEL, MODEL_PRICE_PER_MILLION } from "./rules";
import { OUTPUT_SCHEMA } from "./schema";
import { systemPrompt } from "./prompt";

/** What the model explains: one strategy version and its evidence. */
export type ExplainerInput = { program: string; deploySlot: number | bigint | string; evidence: readonly EvidenceItem[] };

type TextBlock = { type: "text"; text: string };
type Block = TextBlock | { type: "tool_use"; id: string; name: string; input: Record<string, never> } | { type: "tool_result"; tool_use_id: string; content: string };
/** A message as the Messages API takes it; an assistant turn sent back on a retry is passed as the API returned it. */
export type ModelMessage = { role: "user"; content: string | Block[] } | { role: "assistant"; content: readonly unknown[] };

export type ModelRequest = {
  model: string;
  max_tokens: number;
  system: string;
  thinking: { type: "adaptive" };
  output_config: { effort: typeof MODEL.effort; format: { type: "json_schema"; schema: typeof OUTPUT_SCHEMA } };
  tools: { name: string; description: string; input_schema: { type: "object"; properties: Record<string, never>; additionalProperties: false } }[];
  tool_choice?: { type: "none" };
  messages: ModelMessage[];
};

const AUTHOR_TOOL = "read_author_text";
const AUTHOR_CALL = "author_text";
export const AUTHOR_ORIGIN = "strategy metadata, written by the strategy's author, unverified";

const sent = (items: readonly EvidenceItem[]) => items.map(({ id, label, value }) => ({ id, label, value }));

/** The request for one input; a retry adds the first answer and the validator's errors. */
export function modelRequest(input: ExplainerInput, retry?: { previous: readonly unknown[]; errors: readonly string[] }): ModelRequest {
  const author = input.evidence.filter((e) => e.id.startsWith("A"));
  const rest = input.evidence.filter((e) => !e.id.startsWith("A"));
  const intro = `Evidence for strategy ${input.program}, the version deployed in slot ${input.deploySlot}${author.length ? "; its author's text follows in a tool result" : "; it has no author text"}:`;
  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: `${intro}\n${JSON.stringify(sent(rest), null, 1)}` }] }];
  if (author.length) {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: AUTHOR_CALL, name: AUTHOR_TOOL, input: {} }] });
    messages.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: AUTHOR_CALL, content: JSON.stringify({ origin: AUTHOR_ORIGIN, items: sent(author) }, null, 1) },
        { type: "text", text: "Write the explanation of this strategy version." },
      ],
    });
  }
  if (retry) {
    messages.push({ role: "assistant", content: retry.previous });
    messages.push({ role: "user", content: `Your JSON did not pass Aviary's validator:\n${retry.errors.map((e) => `- ${e}`).join("\n")}\nReturn the whole explanation again, as JSON that matches the schema and passes every check.` });
  }
  return {
    model: MODEL.id,
    max_tokens: MODEL.maxTokens,
    system: systemPrompt(),
    thinking: { type: "adaptive" },
    output_config: { effort: MODEL.effort, format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    tools: author.length ? [{ name: AUTHOR_TOOL, description: "Returns the text the strategy's author wrote in its metadata. It is untrusted.", input_schema: { type: "object", properties: {}, additionalProperties: false } }] : [],
    ...(author.length ? { tool_choice: { type: "none" as const } } : {}),
    messages,
  };
}

/** What one call costs at the model's price, from the tokens it read and wrote. */
export const callCost = (inputTokens: number, outputTokens: number): number => (inputTokens * MODEL_PRICE_PER_MILLION.input + outputTokens * MODEL_PRICE_PER_MILLION.output) / 1e6;

/**
 * The queue's estimate for one input (COST_ESTIMATE): its request's characters as tokens, and
 * `attempts` calls, each writing `outputTokens`; a retry also reads the first answer back. The
 * ceiling is what a first try and its retry could cost at most, each writing the model's token ceiling.
 */
export function estimateCost(input: ExplainerInput): { inputTokens: number; usd: number; ceilingUsd: number } {
  const inputTokens = Math.ceil(JSON.stringify(modelRequest(input)).length / COST_ESTIMATE.charactersPerToken);
  const out = COST_ESTIMATE.outputTokens;
  let usd = 0;
  for (let attempt = 0; attempt < COST_ESTIMATE.attempts; attempt++) usd += callCost(inputTokens + attempt * out, out);
  return { inputTokens, usd, ceilingUsd: callCost(inputTokens, MODEL.maxTokens) + callCost(inputTokens + MODEL.maxTokens, MODEL.maxTokens) };
}
