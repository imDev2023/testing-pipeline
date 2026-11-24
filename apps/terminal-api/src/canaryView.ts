// What the pages show of Canary, read from the records the binary writes (crates/canary; #125):
// docs/spec/pipescope-screens.md, Canary outcomes, What a row says about Canary, Markets that cannot
// trade and Strategy page. Written once here, beside ./canarySentences, so the market page, the
// feed's rows, the trade box and the Telegram bot read the same summary and the same words.
//
// Nothing here judges: an outcome is the binary's, and every phrase states what a record measured.
// The order in which a page lists checks, and each check's plain name, are the screens' starting
// copy (the prototype's, PIPESCOPE-137).
import type { StoredCanaryResult } from "terminal-db";

/**
 * The checks' fixed order on the pages, with each one's plain name: what a trader most needs first
 * (the prototype's order, with `outside_supply`, added after it, beside the token authorities).
 */
export const CHECKS: readonly (readonly [check: string, name: string])[] = [
  ["readable", "Reading the market"],
  ["exit_sizes", "Buy, then sell straight back"],
  ["cost", "What a round trip costs"],
  ["exit_hold", "Buy, wait, then sell"],
  ["exit_wallets", "Fresh wallets and insiders"],
  ["exit_transferred", "Selling tokens someone sent you"],
  ["exit_queue", "Five buyers leaving in turn"],
  ["exit_late", "Arriving later"],
  ["exit_launch_clock", "The clock set back to launch"],
  ["token_authorities", "Token authorities acting"],
  ["outside_supply", "Supply held outside the pool"],
  ["quote_matches_swap", "Quote against swap"],
  ["direct_call", "Calling the strategy without the router"],
  ["transaction_accounts", "Telling a test from a real trade"],
  ["contained_mint", "Transfer hook"],
  ["conformance", "Pipeline's own conformance check"],
  ["custom_instructions", "Instructions beyond Pipeline's own"],
];

const RANK = new Map(CHECKS.map(([check], i) => [check, i]));
const NAMES = new Map(CHECKS);

/** A check's plain name, or its id for a check this list does not know yet. */
export const checkName = (check: string): string => NAMES.get(check) ?? check;
/** Where a check comes in the fixed order; a check this list does not know comes last. */
export const checkRank = (check: string): number => RANK.get(check) ?? CHECKS.length;
/** Results in the checks' fixed order. */
export const inCheckOrder = <T extends { check: string }>(results: readonly T[]): T[] => [...results].sort((a, b) => checkRank(a.check) - checkRank(b.check) || a.check.localeCompare(b.check));

// ---- The binary's records, as far as the pages read them (crates/canary/src/failure.rs, trade.rs) ----

/** A failed step as the binary records it (`Failure`). */
type RecordedFailure = {
  code: number | null;
  class: string;
  error: string | null;
  stage: string | null;
  program: string | null;
  anchor: { name: string; number: number; message: string; origin: string | null } | null;
};

/** One buy and sale (`RoundTrip`), as a size, a wait, a wallet or a buyer records it. */
type RecordedRoundTrip = {
  amount_words?: string;
  bought?: boolean;
  sold_back?: boolean;
  return_ppm?: number | null;
  buy_failure?: RecordedFailure | null;
  sale_failure?: RecordedFailure | null;
  position?: string;
  who?: string;
  fresh?: boolean;
  /** A `cost` row, which records only a return. */
  cost?: boolean;
};

const isFailure = (value: unknown): value is RecordedFailure => typeof value === "object" && value !== null && "class" in value && "stage" in value && "program" in value;
const numbersOf = (r: StoredCanaryResult) => (r.record.numbers ?? null) as Record<string, unknown> | null;

/** Who refused a step, in words, from the failure's class (crates/canary/src/failure.rs, `FailureClass`). */
const REFUSED_BY: Readonly<Record<string, string>> = {
  cannot_read_state: "the strategy, which cannot read the market's state",
  strategy_refused: "the strategy",
  router_refused: "Pipeline's router",
  token_program_refused: "the token program",
  other_program_refused: "another program",
  crash: "a program that crashed",
  out_of_compute: "a program that ran out of compute",
};

/** What a stage of a step is, in words (`Stage::describe`). */
const STAGES: Readonly<Record<string, string>> = {
  market_info: "reading the market's info",
  resolve_accounts: "resolving the trade's accounts",
  quote: "quoting",
  swap: "the swap",
  authority_action: "the authority's own instruction",
  transfer: "sending the token to another wallet",
};

/** A refused step, as a page shows it: who refused, the error's name, number and message, and the stage. */
export type Refusal = {
  by: string;
  program: string | null;
  name: string | null;
  number: number | null;
  message: string | null;
  stage: string | null;
  /** Where Anchor says it was raised ("thrown in src/lib.rs:1298"), as it logs it. */
  origin: string | null;
  /** The transaction error as the VM gave it. */
  raw: string | null;
};

const refusalOf = (f: RecordedFailure): Refusal => ({
  by: REFUSED_BY[f.class] ?? f.class.replaceAll("_", " "),
  program: f.program,
  name: f.anchor?.name ?? null,
  number: f.anchor?.number ?? f.code,
  message: f.anchor?.message ?? null,
  stage: f.stage === null ? null : (STAGES[f.stage] ?? f.stage.replaceAll("_", " ")),
  origin: f.anchor?.origin ?? null,
  raw: f.error,
});

/** "WrongStatus: Not allowed in the curve's current status", or the raw error with no Anchor name. */
export const errorWords = (r: Refusal): string => (r.name ? `${r.name}${r.message ? `: ${r.message}` : ""}` : (r.raw ?? `error ${r.number ?? "unknown"}`));

/** Every distinct failed step a record names, in the order it names them. */
export function refusalsIn(numbers: unknown): Refusal[] {
  const seen = new Set<string>();
  const found: Refusal[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value !== "object" || value === null) return;
    if (isFailure(value)) {
      const key = `${value.program}:${value.code}:${value.stage}:${value.class}:${value.anchor?.number ?? ""}:${value.error ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push(refusalOf(value));
      }
      return;
    }
    Object.values(value).forEach(walk);
  };
  walk(numbers);
  return found;
}

// ---- One market ----

/** A percentage of what was put in, to one decimal place: "49.3%". */
export const percentOf = (ppm: number): string => `${(Math.round(ppm / 1_000) / 10).toFixed(1)}%`;

/** The ordinary trade's round trip: Canary's reference size bought and sold straight back (`cost`). */
export type OrdinaryTrade = { return_ppm: number; amount_words: string; stand_in: boolean };

type CostPair = {
  returns?: { amount: number; return_ppm: number | null; amount_words: string }[];
  reference?: { amount: number; return_ppm: number } | null;
  reference_is_stand_in?: boolean;
};

/** The ordinary trade of a market's `cost` result: on a market of three or four mints, the pair that returned least. */
export function ordinaryTrade(latest: readonly StoredCanaryResult[]): OrdinaryTrade | null {
  const cost = latest.find((r) => r.check === "cost");
  const pairs = ((cost && numbersOf(cost)?.pairs) ?? []) as CostPair[];
  let worst: OrdinaryTrade | null = null;
  for (const pair of pairs) {
    const reference = pair.reference;
    if (!reference) continue;
    const words = pair.returns?.find((r) => r.amount === reference.amount)?.amount_words ?? `${reference.amount} units`;
    if (!worst || reference.return_ppm < worst.return_ppm) worst = { return_ppm: reference.return_ppm, amount_words: words, stand_in: pair.reference_is_stand_in === true };
  }
  return worst;
}

type Direction = { result?: { Ok?: unknown; Err?: RecordedFailure } };

/** A stranded market: its strategy's current version cannot read its state (`readable` fails). */
export function strandedBy(latest: readonly StoredCanaryResult[]): Refusal | null {
  const readable = latest.find((r) => r.check === "readable");
  if (!readable || readable.outcome !== "fail") return null;
  const numbers = numbersOf(readable);
  const info = numbers?.market_info;
  if (isFailure(info)) return refusalOf(info);
  const err = ((numbers?.directions ?? []) as Direction[]).map((d) => d.result?.Err).find(isFailure);
  return err ? refusalOf(err) : { by: "the strategy", program: readable.record.strategy, name: null, number: null, message: null, stage: null, origin: null, raw: null };
}

/**
 * A market that refuses every trade by its own rules: the version reads it (`readable` passes or
 * warns) and every direction's quote was refused cleanly, none crashing or running out of compute,
 * as the binary decides it (crates/canary/src/checks/readable.rs).
 */
export function refusesEveryTrade(latest: readonly StoredCanaryResult[]): Refusal | null {
  const readable = latest.find((r) => r.check === "readable");
  if (!readable || readable.outcome === "fail" || readable.outcome === "not run") return null;
  const directions = (numbersOf(readable)?.directions ?? []) as Direction[];
  if (!directions.length || directions.some((d) => d.result?.Ok !== undefined)) return null;
  const errs = directions.map((d) => d.result?.Err);
  if (!errs.every(isFailure) || errs.some((e) => e.class === "crash" || e.class === "out_of_compute")) return null;
  return refusalOf(errs[0]!);
}

/** The rows of a check that runs one round trip a step: each with its label. */
function roundTrips(r: StoredCanaryResult): { pair: number | null; rows: { label: string; trip: RecordedRoundTrip }[] }[] {
  const pairs = (numbersOf(r)?.pairs ?? []) as Record<string, unknown>[];
  return pairs.map((pair) => {
    const token = typeof pair.token === "number" ? pair.token : null;
    const list = (key: string) => (Array.isArray(pair[key]) ? (pair[key] as RecordedRoundTrip[]) : []);
    switch (r.check) {
      case "exit_sizes":
        return { pair: token, rows: list("sizes").map((trip) => ({ label: trip.amount_words ?? "a size", trip })) };
      case "exit_hold":
      case "exit_late":
      case "exit_launch_clock":
        return { pair: token, rows: list("rows").map((trip) => ({ label: trip.position ?? "a time", trip })) };
      case "exit_wallets": {
        const wallets = list("wallets");
        const fresh = wallets.filter((w) => w.fresh).length;
        let n = 0;
        return { pair: token, rows: wallets.map((trip) => ({ label: trip.fresh && fresh > 1 ? `fresh wallet ${++n}` : (trip.who ?? "a wallet"), trip })) };
      }
      case "exit_queue":
        return { pair: token, rows: list("buyers").map((trip, i) => ({ label: `buyer ${i + 1}`, trip })) };
      case "cost":
        // `cost` records only what came back: a size with no return did not round-trip, its failure named by `exit_sizes`.
        return { pair: token, rows: list("returns").map((trip) => ({ label: trip.amount_words ?? "a size", trip: { ...trip, cost: true } })) };
      default:
        return { pair: token, rows: [] };
    }
  });
}

/** One step of a result: a size, a wait, a wallet or a buyer, with what came back. */
export type Step = {
  label: string;
  /** Sold back with this much of what was put in; could not sell back what it bought; could not buy; or, in `cost`, did not round-trip. */
  state: "back" | "stuck" | "not bought" | "no round trip";
  return_ppm: number | null;
};

/** The steps of a result that runs one round trip a step, grouped by the mint traded against the money side. */
export function stepsOf(r: StoredCanaryResult): { pair: number | null; steps: Step[] }[] {
  return roundTrips(r)
    .map(({ pair, rows }) => ({
      pair,
      steps: rows.map(({ label, trip }): Step => {
        if (trip.cost) return trip.return_ppm == null ? { label, state: "no round trip", return_ppm: null } : { label, state: "back", return_ppm: trip.return_ppm };
        if (trip.bought === false) return { label, state: "not bought", return_ppm: null };
        if (trip.sold_back === false) return { label, state: "stuck", return_ppm: null };
        return { label, state: "back", return_ppm: trip.return_ppm ?? null };
      }),
    }))
    .filter((g) => g.steps.length > 0);
}

/** The phrase a row shows beside a result's outcome: what it measured, briefly. */
export function phraseOf(r: StoredCanaryResult): string {
  const groups = stepsOf(r).flatMap((g) => g.steps);
  switch (r.check) {
    case "cost": {
      const ordinary = ordinaryTrade([r]);
      if (ordinary) return `${ordinary.amount_words.endsWith(" SOL") ? `a ${ordinary.amount_words} round trip` : `a round trip of ${ordinary.amount_words}`} returned ${percentOf(ordinary.return_ppm)}`;
      break;
    }
    case "exit_sizes": {
      // Per pair, the first size that could not sell back; the pair that traps the smallest size is named.
      const stuckAt = stepsOf(r)
        .map((g) => ({ steps: g.steps, at: g.steps.findIndex((step) => step.state === "stuck") }))
        .filter((g) => g.at >= 0)
        .sort((a, b) => a.at - b.at)[0];
      if (stuckAt?.at === 0) return "a buy of the smallest size could not be sold back";
      if (stuckAt) return `buys of ${stuckAt.steps[stuckAt.at]!.label} or more could not sell back`;
      break;
    }
    case "exit_queue": {
      const trips = roundTrips(r).flatMap((g) => g.rows.map((row) => row.trip as RecordedRoundTrip & { put_in?: number; got_back?: number | null }));
      if (trips.some((t) => t.bought !== false && t.sold_back === false)) return "one of five buyers leaving in turn could not sell back";
      if (trips.some((t) => t.bought === false)) return "one of five buyers leaving in turn could not buy";
      const putIn = trips.reduce((n, t) => n + (t.put_in ?? 0), 0);
      const back = trips.reduce((n, t) => n + (t.got_back ?? 0), 0);
      if (putIn > 0) return `five buyers leaving in turn got back ${percentOf((back / putIn) * 1_000_000)} together`;
      break;
    }
    case "exit_launch_clock": {
      const atLaunch = groups.find((s) => s.label === "at the market's creation");
      const now = groups.find((s) => s.label === "now");
      if (atLaunch && now?.return_ppm != null) return `at launch a round trip returned ${atLaunch.return_ppm == null ? "nothing" : percentOf(atLaunch.return_ppm)}; now ${percentOf(now.return_ppm)}`;
      break;
    }
    case "exit_hold":
    case "exit_late": {
      const bad = groups.find((s) => s.state !== "back");
      if (bad) return `${bad.label}, ${bad.state === "stuck" ? "the tokens could not be sold back" : "the buy failed"}`;
      break;
    }
  }
  const name = checkName(r.check);
  return name[0]!.toLowerCase() + name.slice(1);
}

/** The one result a row shows, as an outcome and a short phrase. */
export type Lead = { check: string; outcome: StoredCanaryResult["outcome"]; phrase: string };

/** A market's Canary summary, from its latest results under one version. */
export type MarketSummary = {
  /** When the newest of these results ran. */
  run_at: string;
  ordinary: OrdinaryTrade | null;
  lead: Lead | null;
  stranded: Refusal | null;
  refuses: Refusal | null;
};

const EXIT_CHECKS = new Set(["exit_sizes", "exit_hold", "exit_wallets", "exit_transferred", "exit_queue", "exit_late", "exit_launch_clock"]);

/**
 * The one result a row shows, chosen in the screens' order (What a row says about Canary): a
 * stranded market; a market that refuses every trade by its own rules; the first fail in the checks'
 * fixed order; the first warn among the exit test's checks; the first other warn. Null for a market
 * with none of these, whose row shows the number alone.
 */
export function leadOf(latest: readonly StoredCanaryResult[]): Lead | null {
  if (strandedBy(latest)) return { check: "readable", outcome: "fail", phrase: "the strategy's current version cannot read this market" };
  const refuses = refusesEveryTrade(latest);
  if (refuses) return { check: "readable", outcome: "not run", phrase: `the market refuses every trade (${refuses.name ?? errorWords(refuses)})` };
  const ordered = inCheckOrder(latest);
  const pick = ordered.find((r) => r.outcome === "fail") ?? ordered.find((r) => r.outcome === "warn" && EXIT_CHECKS.has(r.check)) ?? ordered.find((r) => r.outcome === "warn");
  return pick ? { check: pick.check, outcome: pick.outcome, phrase: phraseOf(pick) } : null;
}

/** A market's summary, or null when Canary has no result for it under this version. */
export function marketSummary(latest: readonly StoredCanaryResult[]): MarketSummary | null {
  if (!latest.length) return null;
  const ranAt = latest.reduce((at, r) => (r.runAt > at ? r.runAt : at), latest[0]!.runAt);
  return { run_at: ranAt.toISOString(), ordinary: ordinaryTrade(latest), lead: leadOf(latest), stranded: strandedBy(latest), refuses: refusesEveryTrade(latest) };
}

/** Each market's latest results, by market. */
export function byMarket(results: readonly StoredCanaryResult[]): Map<string, StoredCanaryResult[]> {
  const grouped = new Map<string, StoredCanaryResult[]>();
  for (const r of results) grouped.set(r.market, [...(grouped.get(r.market) ?? []), r]);
  return grouped;
}

/** What a strategy's row says about Canary: the version's markets with results, how many it cannot read, and the ordinary trade's range on those that trade. */
export type StrategySummary = { run_at: string; markets: number; stranded: number; ordinary: { min_ppm: number; max_ppm: number; amount_words: string } | null };

/** A strategy's summary from its current version's markets' latest `readable` and `cost` results (at least), or null with none. */
export function strategySummary(results: readonly StoredCanaryResult[]): StrategySummary | null {
  if (!results.length) return null;
  const markets = byMarket(results);
  let stranded = 0;
  const trades: OrdinaryTrade[] = [];
  for (const latest of markets.values()) {
    if (strandedBy(latest)) stranded++;
    const ordinary = ordinaryTrade(latest);
    if (ordinary) trades.push(ordinary);
  }
  const ranAt = results.reduce((at, r) => (r.runAt > at ? r.runAt : at), results[0]!.runAt);
  const words = new Set(trades.map((t) => t.amount_words));
  return {
    run_at: ranAt.toISOString(),
    markets: markets.size,
    stranded,
    // One size named for the range only when every market traded the same one (0.01 SOL with wrapped SOL).
    ordinary: trades.length ? { min_ppm: Math.min(...trades.map((t) => t.return_ppm)), max_ppm: Math.max(...trades.map((t) => t.return_ppm)), amount_words: words.size === 1 ? [...words][0]! : "the reference size" } : null,
  };
}
