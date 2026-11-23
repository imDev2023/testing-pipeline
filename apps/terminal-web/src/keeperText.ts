// The keeper page's sentences (docs/spec/keeper-runner.md, "How Aviary shows it"; PIPESCOPE-104),
// written once by code from what the API read and the runner recorded, so the page never words the
// same fact two ways.
import type { Keeper, KeeperJob, KeeperPassKind } from "terminal-api/contract";
import { BRAND } from "./brand";
import { formatAge, formatAmount } from "./format";

const LAMPORTS_PER_SOL = 1_000_000_000;

/** Lamports as SOL, to four significant figures: "0.000005 SOL". */
export function formatSol(lamports: number): string {
  return `${formatAmount(lamports / LAMPORTS_PER_SOL)} SOL`;
}

/** Each kind of pass, as a table row names it, and as a sentence does. */
export const PASS_LABELS: Record<KeeperPassKind, { label: string; inSentence: string }> = {
  start: { label: "On start", inSentence: "the pass on start" },
  once: { label: "One-off run", inSentence: "a one-off run" },
  sweep: { label: "Sweep", inSentence: "a sweep" },
  hourly: { label: "Hourly", inSentence: "the hourly pass" },
  daily: { label: "Daily", inSentence: "the daily pass" },
  transaction: { label: "After a transaction", inSentence: "a pass after a transaction" },
  retry: { label: "Retry", inSentence: "a retry" },
};

/** Whether the runner is running, in a word and a sentence. */
export function livenessSentence(liveness: Keeper["liveness"], now: Date = new Date()): { headline: string; detail: string } {
  const { state, lastPass, stoppedAfterMs } = liveness;
  if (state === "no-heartbeat" || !lastPass) {
    return { headline: "No heartbeat", detail: `No heartbeat has reached ${BRAND.name} from the runner, so whether it is running cannot be told.` };
  }
  const last = `Its last pass, ${PASS_LABELS[lastPass.pass].inSentence}, ended ${formatAge(new Date(lastPass.at), now)}`;
  if (state === "running") return { headline: "Running", detail: `${last}.` };
  const pace = liveness.sweepIntervalMs ? `, and it sweeps every ${every(liveness.sweepIntervalMs)}` : stoppedAfterMs ? `, over ${every(stoppedAfterMs)} ago` : "";
  return { headline: "Looks stopped", detail: `${last}${pace}. Due jobs wait meanwhile, and anyone may send them.` };
}

/** An interval as a sentence says it: "minute", "10 minutes", "90 seconds", "hour". */
function every(ms: number): string {
  for (const [unit, size] of [
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1_000],
  ] as const) {
    if (ms % size === 0) return ms === size ? unit : `${ms / size} ${unit}s`;
  }
  return `${ms} milliseconds`;
}

/** A job and its slot, if it has one: "distribute, slot 2". */
export function jobName(job: Pick<KeeperJob, "job" | "slot">): string {
  return job.slot === null ? job.job : `${job.job}, slot ${job.slot}`;
}

/** Why a held or parked job waits. */
export function waitingReason(job: Pick<KeeperJob, "outcome" | "cap" | "error">): string {
  if (job.outcome === "held") return `Held by ${job.cap ?? "a cap"}`;
  return `Parked after its last retry${job.error ? `: ${job.error}` : ""}`;
}

/** The products the runner keeps, by the name a keeper job's product carries, as people call them. */
const PRODUCTS: Record<string, string> = { "tax-amm": "Tax AMM", "buy-wall-amm": "Buy wall AMM", "lending-amm": "Lending AMM" };

/** A product as people call it; one this page does not know yet keeps the runner's name for it. */
export function productName(product: string): string {
  return PRODUCTS[product] ?? product;
}

/** What a job whose transaction landed did. */
const LANDED: Record<string, string> = {
  sent: "Sent",
  failed: "Landed refused",
  "later-slot": "Landed too early, sent again",
  "nothing-to-do": "Landed with nothing to do",
};

/** What happened to a job that sent nothing. */
const UNSENT: Record<string, string> = {
  failed: "Failed in simulation",
  "later-slot": "Refused until a later slot",
  "nothing-to-do": "Nothing to do",
  "chain-error": "The RPC could not be asked",
  "not-yet": "Ran too recently",
  held: "Held",
  parked: "Parked",
  unparked: "Unparked, its market changed",
  "no-longer-due": "No longer due",
};

/** What a recorded job did. */
export function outcomeText(job: Pick<KeeperJob, "outcome" | "signature">): string {
  return (job.signature ? LANDED[job.outcome] : UNSENT[job.outcome]) ?? job.outcome;
}

/** What a recorded pass did: "sent 4", "sent 1, held 2", or how many jobs it recorded. */
export function passSummary(counts: { sent: number; held: number; parked: number; failed: number; jobs: number }): string {
  const parts = [
    counts.sent && `sent ${counts.sent}`,
    counts.held && `held ${counts.held}`,
    counts.parked && `parked ${counts.parked}`,
    counts.failed && `failed ${counts.failed}`,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : `recorded ${counts.jobs} ${counts.jobs === 1 ? "job" : "jobs"}`;
}
