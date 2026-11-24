// The owner's explainer commands (docs/spec/pipescope-architecture.md, "Explainer jobs"; EXPLAINER-05,
// EXPLAINER-06): run on the owner's Mac, never on a schedule, and nothing is paid for until the owner
// answers yes to the question that names the service, what it buys and its estimated cost.
//
// - approve: the pending keys with their estimated cost; for those approved, the model, the
//   validator and one retry, each outcome written to Postgres, one ledger line for the batch.
// - eval: the five recorded samples and the hostile fixture set through the model, no database, a
//   report of the pass rate, tokens and cost, and one ledger line (the first paid run's measure).
// - reports: the "This is wrong" reports with the keys they refer to.
import { appendFileSync, writeFileSync } from "node:fs";
import { finishExplainerKey, pendingExplainerKeys, readExplainerReports, type Db } from "terminal-db";
import { estimateCost, MODEL, type ExplainerInput } from "terminal-explainer";
import { hostileInputs, samples } from "terminal-explainer/fixtures";
import { generate, type Generation, type ModelClient } from "./generate";

type Io = { log: (line: string) => void; confirm: (question: string) => Promise<boolean>; ledger: string; today?: string };

const usd = (n: number) => `$${n.toFixed(6)}`;
const SERVICE = `Anthropic API (${MODEL.id})`;
const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const todayOf = (io: Io) => io.today ?? new Date().toLocaleDateString("en-CA");

/** One line in the owner's spend ledger: date, project, service, what it bought, dollars, who approved it. */
function ledgerLine(io: Io, what: string, costUsd: number, approvedBy: string): void {
  appendFileSync(io.ledger, `${[todayOf(io), "testing-pipeline", SERVICE, what, costUsd.toFixed(6), approvedBy].map(csv).join(",")}\n`);
}

type Totals = { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
function add(t: Totals, g: Generation): void {
  t.calls += g.attempts;
  t.inputTokens += g.inputTokens;
  t.outputTokens += g.outputTokens;
  t.costUsd += g.costUsd;
}
const tokens = (t: Totals) => `${t.calls} calls, ${t.inputTokens} input and ${t.outputTokens} output tokens`;
const calls = (n: number) => `${n} ${n === 1 ? "call" : "calls"}`;

export async function approve(io: Io & { db: Db; model: ModelClient; only?: string[] }): Promise<{ approved: number; done: number; failed: number; calls: number; costUsd: number }> {
  const all = await pendingExplainerKeys(io.db);
  const keys = io.only ? all.filter((k) => io.only!.some((prefix) => k.key.startsWith(prefix))) : all;
  const none = { approved: 0, done: 0, failed: 0, calls: 0, costUsd: 0 };
  if (!keys.length) {
    io.log(all.length ? "No pending key starts with what was named." : "No pending keys: nothing to pay for.");
    return none;
  }
  const estimate = keys.reduce((n, k) => n + k.estimatedCostUsd, 0);
  for (const k of keys) io.log(`${k.key.slice(0, 16)}  ${k.program}  version ${k.deploySlot}  made ${k.createdAt.toISOString()}  estimated ${usd(k.estimatedCostUsd)}${k.authorTextAddressesAi ? "  (author text addresses AI tools)" : ""}`);
  io.log(`${keys.length} pending ${keys.length === 1 ? "key" : "keys"}, estimated ${usd(estimate)} in all, each a first try and its retry.`);
  const ceiling = keys.reduce((n, k) => n + estimateCost({ program: k.program, deploySlot: k.deploySlot, evidence: k.evidence as ExplainerInput["evidence"] }).ceilingUsd, 0);
  if (!(await io.confirm(`Pay Anthropic for ${keys.length} ${keys.length === 1 ? "explanation" : "explanations"} with ${MODEL.id}, estimated ${usd(estimate)}, at most ${usd(ceiling)}? [y/N] `))) {
    io.log("Nothing was sent.");
    return none;
  }
  const totals: Totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let done = 0;
  let failed = 0;
  try {
    for (const k of keys) {
      let g: Generation;
      try {
        g = await generate(io.model, { program: k.program, deploySlot: k.deploySlot, evidence: k.evidence as ExplainerInput["evidence"] });
      } catch (e) {
        io.log(`${k.key.slice(0, 16)}  left pending: the request failed (${(e as Error).message})`);
        continue;
      }
      add(totals, g);
      await finishExplainerKey(io.db, k.key, g);
      if (g.status === "done") done++;
      else failed++;
      io.log(`${k.key.slice(0, 16)}  ${g.status}${g.failure ? ` (${g.failure})` : ""}  ${calls(g.attempts)}, ${usd(g.costUsd)}`);
    }
  } finally {
    if (totals.calls) ledgerLine(io, `explainer:approve: ${done + failed} keys (${done} done, ${failed} failed), ${tokens(totals)}`, totals.costUsd, "owner at the explainer:approve prompt");
  }
  io.log(`${done} done, ${failed} failed; ${tokens(totals)}; ${usd(totals.costUsd)} spent.`);
  return { approved: keys.length, done, failed, calls: totals.calls, costUsd: totals.costUsd };
}

/** The first paid run's inputs: the five recorded samples and the hostile fixture set. */
export function evalInputs(): Record<string, ExplainerInput> {
  return {
    ...Object.fromEntries(Object.entries(samples).map(([name, s]) => [name, { program: s.program, deploySlot: s.deploySlot, evidence: s.evidence }])),
    ...Object.fromEntries(Object.entries(hostileInputs).map(([name, input]) => [`hostile/${name}`, input])),
  };
}

type EvalSummary = { inputs: number; passedFirstTry: number; passedOnRetry: number; failed: number } & Totals;

export async function evaluate(io: Io & { model: ModelClient; report: string }): Promise<EvalSummary> {
  const inputs = evalInputs();
  const estimate = Object.values(inputs).reduce((n, input) => n + estimateCost(input).usd, 0);
  const ceiling = Object.values(inputs).reduce((n, input) => n + estimateCost(input).ceilingUsd, 0);
  const count = Object.keys(inputs).length;
  if (!(await io.confirm(`Send ${count} inputs to Anthropic (${MODEL.id}), estimated ${usd(estimate)}, at most ${usd(ceiling)}? [y/N] `))) {
    io.log("Nothing was sent.");
    return { inputs: 0, passedFirstTry: 0, passedOnRetry: 0, failed: 0, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  const totals: Totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const results: Record<string, Generation | { error: string }> = {};
  let passedFirstTry = 0;
  let passedOnRetry = 0;
  let failed = 0;
  try {
    for (const [name, input] of Object.entries(inputs)) {
      try {
        const g = await generate(io.model, input);
        add(totals, g);
        results[name] = g;
        if (g.status === "done" && g.attempts === 1) passedFirstTry++;
        else if (g.status === "done") passedOnRetry++;
        else failed++;
        const failing = g.validation.checks.filter((c) => !c.ok).map((c) => c.name);
        io.log(`${name}: ${g.status}${g.failure ? ` (${g.failure}${failing.length ? `: ${failing.join(", ")}` : ""})` : ""}, ${calls(g.attempts)}, ${g.inputTokens} in / ${g.outputTokens} out, ${usd(g.costUsd)}`);
        for (const error of g.firstErrors) io.log(`    first try: ${error}`);
      } catch (e) {
        failed++;
        results[name] = { error: (e as Error).message };
        io.log(`${name}: the request failed (${(e as Error).message})`);
      }
    }
  } finally {
    if (totals.calls) ledgerLine(io, `explainer:eval: ${count} inputs (5 samples and the hostile fixture set), ${tokens(totals)}`, totals.costUsd, "owner, asked in the session first");
  }
  const summary: EvalSummary = { inputs: count, passedFirstTry, passedOnRetry, failed, ...totals };
  writeFileSync(io.report, `${JSON.stringify({ model: MODEL.id, summary, results }, null, 2)}\n`);
  io.log(`${passedFirstTry} of ${count} passed on the first try, ${passedOnRetry} on the retry, ${failed} failed; ${tokens(totals)}; ${usd(totals.costUsd)} spent. Report: ${io.report}`);
  return summary;
}

export async function listReports(io: { db: Db; log: (line: string) => void }): Promise<void> {
  const reports = await readExplainerReports(io.db);
  if (!reports.length) return io.log("No reports.");
  for (const r of reports) io.log(`${r.createdAt.toISOString()}  key ${r.key} (${r.status}) of ${r.program}, version ${r.deploySlot}\n    ${r.note === null ? "(no note)" : JSON.stringify(r.note)}`);
}
