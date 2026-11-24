// The explainer's keys and reports (docs/spec/pipescope-architecture.md, "Explainer jobs"; EXPLAINER-04,
// EXPLAINER-05, EXPLAINER-23; #126): `terminal-api` records a key once, with its evidence and its
// estimated cost; a newer key of the same strategy takes an older pending one out of the queue; the
// owner's approve command reads the queue and writes each outcome; "This is wrong" reports list
// with the keys they refer to.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/index.ts";
import { readExplainerReports, finishExplainerKey, pendingExplainerKeys, readExplainerKey, recordExplainerKey, reviveExplainerKey, type NewExplainerKey } from "../src/explainer.ts";
import { explainerReports as reportsTable } from "../src/schema.ts";
import { createTestDatabase } from "../src/testing.ts";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
});
afterAll(async () => {
  await client?.close();
  await database?.drop();
});

const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const OTHER = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const key = (id: string, program = STRATEGY, deploySlot = 100n): NewExplainerKey => ({
  key: id.repeat(64).slice(0, 64),
  program,
  deploySlot,
  authorTextSha256: "a".repeat(64),
  canaryOutcomesSha256: "c".repeat(64),
  promptVersion: "explainer-v0",
  model: "claude-haiku-5-5",
  evidence: [{ id: "F1", group: "Program", label: "Program", value: program, source: "test" }],
  representativeMarket: null,
  authorTextAddressesAi: false,
  estimatedInputTokens: 3000,
  estimatedCostUsd: 0.004712,
});

describe("explainer keys", () => {
  it("records a key once, pending, with its evidence and estimated cost", async () => {
    const { db } = client;
    expect(await recordExplainerKey(db, key("1"))).toBe(true);
    expect(await recordExplainerKey(db, key("1"))).toBe(false);
    const pending = await pendingExplainerKeys(db);
    expect(pending.map((k) => [k.key, k.status, k.estimatedCostUsd])).toEqual([["1".repeat(64), "pending", 0.004712]]);
    expect(pending[0]!.evidence).toEqual(key("1").evidence);
  });

  it("takes a strategy's older pending key out of the queue when a newer key of that strategy is recorded, and leaves other strategies' alone", async () => {
    const { db } = client;
    await recordExplainerKey(db, key("2", OTHER));
    await recordExplainerKey(db, key("3", STRATEGY, 120n));
    expect((await pendingExplainerKeys(db)).map((k) => k.key[0]).sort()).toEqual(["2", "3"]);
    expect((await readExplainerKey(db, "1".repeat(64)))!.status).toBe("superseded");
  });

  it("writes an explanation, or a failure, with what the calls read, wrote and cost", async () => {
    const { db } = client;
    const explanation = { summary: [], claims: [], unknowns: [], author_text_addresses_ai: false };
    await finishExplainerKey(db, "3".repeat(64), { status: "done", explanation, validation: { pass: true, checks: [] }, attempts: 1, inputTokens: 2800, outputTokens: 3100, costUsd: 0.00183, failure: null });
    await finishExplainerKey(db, "2".repeat(64), { status: "failed", explanation: null, validation: { pass: false, checks: [] }, attempts: 2, inputTokens: 6000, outputTokens: 7000, costUsd: 0.0041, failure: "the validator refused both answers" });
    expect(await pendingExplainerKeys(db)).toEqual([]);
    const done = (await readExplainerKey(db, "3".repeat(64)))!;
    expect([done.status, done.attempts, done.inputTokens, done.outputTokens, done.costUsd, done.explanation]).toEqual(["done", 1, 2800, 3100, 0.00183, explanation]);
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect((await readExplainerKey(db, "2".repeat(64)))!.failure).toBe("the validator refused both answers");
  });
});

describe("a key that becomes current again", () => {
  const PROGRAM = "4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD";
  it("puts a superseded key back in the queue and takes the strategy's other pending key out, as when an outcome flips back", async () => {
    const { db } = client;
    await recordExplainerKey(db, key("a", PROGRAM));
    await recordExplainerKey(db, key("b", PROGRAM));
    expect((await readExplainerKey(db, "a".repeat(64)))!.status).toBe("superseded");
    expect(await reviveExplainerKey(db, "a".repeat(64))).toBe(true);
    expect((await readExplainerKey(db, "a".repeat(64)))!.status).toBe("pending");
    expect((await readExplainerKey(db, "b".repeat(64)))!.status).toBe("superseded");
    expect(await reviveExplainerKey(db, "a".repeat(64))).toBe(false);
  });

  it("leaves a done key done, and still takes the strategy's other pending key out of the queue", async () => {
    const { db } = client;
    await finishExplainerKey(db, "a".repeat(64), { status: "done", explanation: {}, validation: {}, attempts: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, failure: null });
    await recordExplainerKey(db, key("d", PROGRAM));
    expect(await reviveExplainerKey(db, "a".repeat(64))).toBe(true);
    expect((await readExplainerKey(db, "a".repeat(64)))!.status).toBe("done");
    expect((await readExplainerKey(db, "d".repeat(64)))!.status).toBe("superseded");
  });
});

describe("explainer reports", () => {
  it("lists each report, newest first, with the key it refers to", async () => {
    const { db } = client;
    await db.insert(reportsTable).values({ key: "3".repeat(64), note: "The fee is wrong." });
    await db.insert(reportsTable).values({ key: "3".repeat(64), note: null });
    const reports = await readExplainerReports(db);
    expect(reports.map((r) => [r.note, r.key, r.program, r.deploySlot])).toEqual([
      [null, "3".repeat(64), STRATEGY, 120n],
      ["The fee is wrong.", "3".repeat(64), STRATEGY, 120n],
    ]);
  });
});
