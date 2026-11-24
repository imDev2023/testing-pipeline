// The owner's explainer commands (docs/spec/pipescope-architecture.md, "Explainer jobs"; EXPLAINER-05,
// EXPLAINER-06, EXPLAINER-19): approve lists the pending keys with their cost, asks, pays for those
// approved, writes each outcome and one ledger line per batch; eval sends the five recorded samples
// and the hostile fixture set through the model and reports the pass rate, tokens and cost; reports
// lists "This is wrong" reports. Every test uses a recorded model, never the real one.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, explainerReports, pendingExplainerKeys, readExplainerKey, recordExplainerKey, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { MODEL, type ModelRequest } from "terminal-explainer";
import { hostileBase, hostileInputs, samples } from "terminal-explainer/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approve, evaluate, listReports } from "../src/commands";
import type { ModelClient, ModelResponse } from "../src/generate";

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

const ledgerFile = () => {
  const path = join(mkdtempSync(join(tmpdir(), "ledger-")), "ledger.csv");
  writeFileSync(path, "date,project,service,what,est_usd,approved_by\n");
  return path;
};
const reply = (output: unknown): ModelResponse => ({ content: [{ type: "text", text: JSON.stringify(output) }], stop_reason: "end_turn", usage: { input_tokens: 3000, output_tokens: 2000 } });
/** A recorded model that answers each input with the explanation recorded for it, or a bad one. */
const model = (answer: (request: { messages: { content: unknown }[] }) => unknown): ModelClient & { calls: number } => {
  const m = {
    calls: 0,
    create: async (request: ModelRequest) => {
      m.calls++;
      return reply(answer(request as unknown as { messages: { content: unknown }[] }));
    },
  };
  return m;
};
const quiet = () => {};

const sampleKey = (name: string, program: string) => ({
  key: name.padEnd(64, "0"),
  program,
  deploySlot: BigInt(samples[name]!.deploySlot),
  authorTextSha256: "a".repeat(64),
  canaryOutcomesSha256: "c".repeat(64),
  promptVersion: "explainer-v0",
  model: MODEL.id,
  evidence: samples[name]!.evidence,
  representativeMarket: null,
  authorTextAddressesAi: false,
  estimatedInputTokens: 3000,
  estimatedCostUsd: 0.0046,
});

describe("approve", () => {
  it("lists the pending keys with their estimated cost and pays for nothing unless the owner says yes", async () => {
    const { db } = client;
    await recordExplainerKey(db, sampleKey("iwao", "FWbhWcufRWM3CsVb6MixpwtNXWMYQbhQo3uWEfg4vrKq"));
    await recordExplainerKey(db, sampleKey("bonding-curve", "bondingCurve1111111111111111111111111111111"));
    const lines: string[] = [];
    let asked = "";
    const m = model(() => samples["iwao"]!.outputs.pass);
    const ledger = ledgerFile();
    const out = await approve({ db, model: m, ledger, approvedBy: "owner at the explainer:approve prompt", log: (l) => lines.push(l), confirm: async (q) => ((asked = q), false) });
    expect(out).toEqual({ approved: 0, done: 0, failed: 0, calls: 0, costUsd: 0 });
    expect(m.calls).toBe(0);
    expect(lines.join("\n")).toContain("2 pending keys, estimated $0.009200 in all");
    expect(asked).toMatch(/^Pay Anthropic for 2 explanations with claude-haiku-5-5, estimated \$0\.009200, at most \$0\.0\d{5}\? \[y\/N\] $/);
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("on yes, generates each approved key, writes its explanation or failure, and appends one ledger line for the batch", async () => {
    const { db } = client;
    const ledger = ledgerFile();
    // iwao's evidence gets its own recorded explanation; bonding-curve's gets one that fails twice.
    const m = model((request) => (JSON.stringify(request.messages[0]!.content).includes("FWbhWcufRWM3CsVb6MixpwtNXWMYQbhQo3uWEfg4vrKq") ? samples["iwao"]!.outputs.pass : samples["hostile"]!.outputs.fooled));
    const out = await approve({ db, model: m, ledger, approvedBy: "owner at the explainer:approve prompt", log: quiet, confirm: async () => true, today: "2026-11-24" });
    expect(out).toMatchObject({ approved: 2, done: 1, failed: 1, calls: 3 });
    expect(await pendingExplainerKeys(db)).toEqual([]);
    expect((await readExplainerKey(db, "iwao".padEnd(64, "0")))!.status).toBe("done");
    expect((await readExplainerKey(db, "bonding-curve".padEnd(64, "0")))!).toMatchObject({ status: "failed", failure: "the validator refused both answers", attempts: 2 });
    const lines = readFileSync(ledger, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`2026-11-24,testing-pipeline,Anthropic API (claude-haiku-5-5),"explainer:approve: 2 keys (1 done, 1 failed), 3 calls, 9000 input and 6000 output tokens",${out.costUsd.toFixed(6)},owner at the explainer:approve prompt`);
  });

  it("can be limited to keys named by the start of their id", async () => {
    const { db } = client;
    await recordExplainerKey(db, sampleKey("constant-product", "yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx"));
    await recordExplainerKey(db, sampleKey("pool4-port", "4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD"));
    const m = model(() => samples["constant-product"]!.outputs.pass);
    const out = await approve({ db, model: m, ledger: ledgerFile(), approvedBy: "owner at the explainer:approve prompt", log: quiet, confirm: async () => true, only: ["constant"] });
    expect(out).toMatchObject({ approved: 1, done: 1 });
    expect((await pendingExplainerKeys(db)).map((k) => k.program)).toEqual(["4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD"]);
  });
});

describe("approve when the retry's request fails", () => {
  it("leaves the key pending, and still writes the first call's spend in the ledger", async () => {
    const { db } = client;
    await recordExplainerKey(db, sampleKey("hostile", "hostileFixture111111111111111111111111111111"));
    let call = 0;
    const flaky: ModelClient = {
      create: async () => {
        call++;
        if (call === 1) return reply(samples["hostile"]!.outputs.fooled);
        throw new Error("overloaded");
      },
    };
    const ledger = ledgerFile();
    const out = await approve({ db, model: flaky, ledger, approvedBy: "owner at the explainer:approve prompt", log: quiet, confirm: async () => true, only: ["hostile"], today: "2026-11-24" });
    expect(out).toMatchObject({ approved: 1, done: 0, failed: 0, calls: 1 });
    expect((await readExplainerKey(db, "hostile".padEnd(64, "0")))!.status).toBe("pending");
    expect(readFileSync(ledger, "utf8").trim().split("\n")[1]).toContain('"explainer:approve: 0 keys (0 done, 0 failed), 1 calls, 3000 input and 2000 output tokens"');
  });
});

describe("evaluate", () => {
  it("sends the five recorded samples and the hostile fixture set, and reports the pass rate, tokens and cost, with one ledger line", async () => {
    const ledger = ledgerFile();
    const report = join(mkdtempSync(join(tmpdir(), "eval-")), "report.json");
    const names = [...Object.keys(samples), ...Object.keys(hostileInputs).map((n) => `hostile/${n}`)];
    // Each sample gets its recorded explanation; each hostile input the base's.
    const m = model((request) => {
      const text = JSON.stringify(request.messages[0]!.content);
      const sample = Object.values(samples).find((s) => text.includes(`strategy ${s.program},`));
      return sample?.sample === "hostile" || !sample ? hostileBase.good : sample.outputs.pass;
    });
    let asked = "";
    const out = await evaluate({ model: m, ledger, approvedBy: "owner, asked in the session first (--yes)", report, log: quiet, confirm: async (q) => ((asked = q), true), today: "2026-11-24" });
    expect(asked).toMatch(/^Send 12 inputs to Anthropic \(claude-haiku-5-5\), estimated \$0\.\d{6}, at most \$0\.\d{6}\? \[y\/N\] $/);
    expect(out.inputs).toBe(12);
    expect(Object.keys(JSON.parse(readFileSync(report, "utf8")).results).sort()).toEqual(names.sort());
    expect(out.passedFirstTry + out.passedOnRetry + out.failed).toBe(12);
    const line = readFileSync(ledger, "utf8").trim().split("\n")[1]!;
    expect(line).toMatch(/^2026-11-24,testing-pipeline,Anthropic API \(claude-haiku-5-5\),"explainer:eval: 12 inputs/);
    expect(line.endsWith(',"owner, asked in the session first (--yes)"')).toBe(true);
  });

  it("sends nothing when the owner says no", async () => {
    const m = model(() => hostileBase.good);
    const out = await evaluate({ model: m, ledger: ledgerFile(), approvedBy: "owner", report: join(tmpdir(), "never.json"), log: quiet, confirm: async () => false });
    expect(out.inputs).toBe(0);
    expect(m.calls).toBe(0);
  });
});

describe("reports", () => {
  it("lists each report with its key, strategy and version", async () => {
    const { db } = client;
    await db.insert(explainerReports).values({ key: "iwao".padEnd(64, "0"), note: "The fee is wrong." });
    const lines: string[] = [];
    await listReports({ db, log: (l) => lines.push(l) });
    expect(lines.join("\n")).toMatch(/iwao0+ .*FWbhWcufRWM3CsVb6MixpwtNXWMYQbhQo3uWEfg4vrKq, version 520136342\s+"The fee is wrong\."/s);
  });
});
