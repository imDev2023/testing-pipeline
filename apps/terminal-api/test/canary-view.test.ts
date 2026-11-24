// What the pages say of a Canary result, read from its record (./src/canaryView; #125): a step that
// never came back is never "sold back", a buyer who could not buy never "could not sell back", and a
// market of several pairs is described by its worst one. The records are real ones from devnet's sweep
// of 2026-11-23 (test/fixtures/canary-records.json), changed only where a case needs a step that failed.
import { readFileSync } from "node:fs";
import type { CanaryRecord, StoredCanaryResult } from "terminal-db";
import { describe, expect, it } from "vitest";
import { phraseOf, refusalsIn, stepsOf } from "../src/canaryView";
import { couldNotSellBack } from "../src/canarySentences";

const RECORDS = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/canary-records.json`, "utf8")) as Record<string, CanaryRecord[]>;
const recordOf = (label: string, check: string) => structuredClone(RECORDS[label]!.find((r) => r.check === check)!);
const stored = (record: CanaryRecord): StoredCanaryResult => ({
  id: record.id,
  runId: 1n,
  program: record.strategy!,
  deploySlot: BigInt(record.strategy_version.deploy_slot!),
  market: record.market,
  check: record.check,
  outcome: record.outcome,
  slot: record.slot,
  runAt: new Date(record.run_at * 1000),
  latest: true,
  record,
});
type Numbers = { pairs: Record<string, unknown>[] };
const FAILURE = { code: 6004, class: "strategy_refused", error: "InstructionError(1, Custom(6004))", panic: null, stage: "swap", anchor: { name: "WrongStatus", number: 6004, origin: null, message: "Not allowed" }, program: "ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb", compute_units: 1 };

describe("a result's steps", () => {
  it("never shows a cost size that did not round-trip as sold back", () => {
    const record = recordOf("tax_demo", "cost");
    const returns = (record.numbers as Numbers).pairs[0]!.returns as { return_ppm: number | null }[];
    returns[5]!.return_ppm = null;
    const steps = stepsOf(stored(record))[0]!.steps;
    expect(steps[5]).toEqual({ label: "10 SOL", state: "no round trip", return_ppm: null });
    expect(steps[0]!.state).toBe("back");
  });
});

describe("a row's phrase", () => {
  it("says a buyer could not buy, never that they could not sell back, in the queue", () => {
    const record = recordOf("tax_demo", "exit_queue");
    const buyers = (record.numbers as Numbers).pairs[0]!.buyers as Record<string, unknown>[];
    Object.assign(buyers[3]!, { bought: false, sold_back: false, got_back: null, return_ppm: null, buy_failure: FAILURE });
    expect(phraseOf(stored(record))).toBe("one of five buyers leaving in turn could not buy");
    Object.assign(buyers[3]!, { bought: true, sold_back: false, buy_failure: null, sale_failure: FAILURE });
    expect(phraseOf(stored(record))).toBe("one of five buyers leaving in turn could not sell back");
  });

  it("says a buy failed after a wait, never that its tokens could not be sold back", () => {
    const record = recordOf("tax_demo", "exit_hold");
    const rows = (record.numbers as Numbers).pairs[0]!.rows as Record<string, unknown>[];
    Object.assign(rows[2]!, { bought: false, sold_back: false, got_back: null, return_ppm: null });
    expect(phraseOf(stored(record))).toBe("after 10 seconds, the buy failed");
    Object.assign(rows[2]!, { bought: true });
    expect(phraseOf(stored(record))).toBe("after 10 seconds, the tokens could not be sold back");
  });

  it("names the pair that traps the smallest buy on a market of several pairs", () => {
    const record = recordOf("open_curve", "exit_sizes");
    const pairs = (record.numbers as Numbers).pairs;
    const second = structuredClone(pairs[0]!);
    second.token = 2;
    for (const size of second.sizes as Record<string, unknown>[]) Object.assign(size, { sold_back: false, return_ppm: null, got_back: null, sale_failure: FAILURE });
    pairs.push(second);
    expect(phraseOf(stored(record))).toBe("a buy of the smallest size could not be sold back");
  });
});

describe("a result's refusals", () => {
  it("keeps two different errors of one program at one stage apart", () => {
    const crash = (error: string) => ({ ...FAILURE, code: null, class: "crash", error, anchor: null });
    expect(refusalsIn([crash("ProgramFailedToComplete: a"), crash("ProgramFailedToComplete: b")])).toHaveLength(2);
  });
});

describe("the trade box's notice", () => {
  it("carries a pair's prefix on after the day in lower case", () => {
    const record = recordOf("open_curve", "exit_sizes");
    record.reason = `Buying mint 2: ${record.reason}`;
    expect(couldNotSellBack([stored(record)])[0]!.sentence).toMatch(/^In Canary's test on 23 Nov 2026, buying mint 2: A wallet that bought/);
  });
});
