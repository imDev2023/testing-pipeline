// The hostile metadata fixtures (docs/spec/pipescope-explainer.md, Testing): documents a hostile
// author could publish, each a valid strategy metadata document by Pipeline's validator, so Aviary
// shows its author text and the explainer would read it. The web app's tests render every one, and
// none may become a link or markup.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStrategyMetadata } from "@pipeline-sol/sdk";
import { assembleEvidence, authorEvidence, normaliseMetadata, pipelineRules, type CheckName, type Claim, type EvidenceItem, type Explanation, type Fact } from "../src/index";

export const HOSTILE_METADATA_DIR = join(import.meta.dirname, "../fixtures/hostile-metadata");

/** Each fixture by its file's name, without `.json`, as the parsed JSON a fetch would give. */
export const hostileMetadata: Record<string, unknown> = Object.fromEntries(
  readdirSync(HOSTILE_METADATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f.slice(0, -".json".length), JSON.parse(readFileSync(join(HOSTILE_METADATA_DIR, f), "utf8"))]),
);

export const SAMPLES_DIR = join(import.meta.dirname, "../fixtures/samples");

/** A recorded sample (fixtures/samples, ported from the prototype): its evidence and its recorded outputs. */
export type Sample = { sample: string; title: string; program: string; deploySlot: number; evidence: EvidenceItem[]; outputs: { pass: Explanation; fooled?: Explanation } };

/** The five recorded samples by name: the four devnet strategies and the hostile-metadata fixture. */
export const samples: Record<string, Sample> = Object.fromEntries(
  readdirSync(SAMPLES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f.slice(0, -".json".length), JSON.parse(readFileSync(join(SAMPLES_DIR, f), "utf8")) as Sample]),
);

const FIXTURES = join(import.meta.dirname, "../fixtures");
const json = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;

type HostileBase = { program: string; deploySlot: number; routerUpgradeAuthority: string; facts: Fact[]; canary: Fact[]; good: Explanation };
/** The chain facts, Canary results and a passing explanation the hostile metadata fixtures are explained with. */
export const hostileBase = json<HostileBase>(join(FIXTURES, "hostile-base.json"));

/**
 * The hostile fixture set's inputs, one per hostile metadata fixture: Pipeline's rules, the base's
 * facts and Canary results, and the author evidence the fixture gives, as `terminal-api` builds it.
 * The version's instructions are the ones the base's facts name.
 */
export const hostileInputs: Record<string, { program: string; deploySlot: number; evidence: EvidenceItem[] }> = Object.fromEntries(
  Object.entries(hostileMetadata).map(([name, raw]) => {
    const parsed = parseStrategyMetadata(raw);
    if (!parsed.ok) throw new Error(`${name}: ${parsed.errors.join("; ")}`);
    const { document, removed } = normaliseMetadata(parsed.value);
    const instructions = ["PipelineInitMarket", "PipelineMarketInfo", "PipelineResolveAccounts", "PipelineQuote", "PipelineSwap", "PipelineSeedLiquidity", "Deposit"].map((n) => ({ name: n }));
    const own = authorEvidence({ status: "valid", metadata: parsed.value, normalised: document, removed, instructions });
    const evidence = assembleEvidence({ pipeline: pipelineRules({ routerUpgradeAuthority: hostileBase.routerUpgradeAuthority }), facts: [...hostileBase.facts, ...own.facts], canary: hostileBase.canary, author: own.author });
    return [name, { program: hostileBase.program, deploySlot: hostileBase.deploySlot, evidence }];
  }),
);

/** A bad output for a hostile input: the base's explanation with one claim added, and the checks it must fail. */
export type HostileOutput = { why: string; metadata: string; claim: Claim; fails: CheckName[] };
const OUTPUTS_DIR = join(FIXTURES, "hostile-outputs");
export const hostileOutputs: Record<string, HostileOutput> = Object.fromEntries(
  readdirSync(OUTPUTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f.slice(0, -".json".length), json<HostileOutput>(join(OUTPUTS_DIR, f))]),
);

/** A bad output in full: the base's explanation with its claim added. */
export const badOutput = (output: HostileOutput): Explanation => ({ ...hostileBase.good, claims: [...hostileBase.good.claims, output.claim] });

/** The model's real answers to the eval inputs, from the owner-approved first paid run, by input name. */
export const recorded = json<{ model: string; promptVersion: string; date: string; outputs: Record<string, Explanation> }>(join(FIXTURES, "recorded/claude-haiku-5-5-2026-11-24.json"));
