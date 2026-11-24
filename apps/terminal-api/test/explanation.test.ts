// The explanation on the pages, as the API serves it (docs/spec/pipescope-explainer.md, Presentation
// and The validator; docs/spec/pipescope-screens.md, "Explanation, actions and facts" and Strategy
// page; EXPLAINER-14, EXPLAINER-15, EXPLAINER-16, EXPLAINER-20; #127): a strategy's current version's
// explanation, only for its own key and only once the approve command wrote it, with the code-written
// label and the evidence it was given; the fixed notice about text addressed to AI tools, even when
// no explanation is shown; and "This is wrong" reports against the key, rate-limited.
import { parseStrategyMetadata } from "@pipeline-sol/sdk";
import { BASES, normaliseMetadata, TOPICS, type EvidenceItem, type Explanation } from "terminal-explainer";
import { hostileMetadata } from "terminal-explainer/fixtures";
import { createDb, explainerKeys, finishExplainerKey, metadataSnapshots, programFacts, programVersions, readExplainerReports, startCanaryRun, storeCanaryMarket, strategies, markets, marketMints, type CanaryRecord, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExplanationClaim, StrategyExplanation } from "../src/contract";
import { makeExplainerKeys } from "../src/explainer";
import { app } from "../src/index";
import { ROUTER } from "../src/indexerCore";
import { bindings, rateLimiter } from "./fakes";

// EXPLAINED gets an approved explanation; PENDING has a key and none; ADDRESSED's metadata addresses AI tools.
const EXPLAINED = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const PENDING = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const ADDRESSED = "Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG";
const UNKNOWN = "aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv";
const MARKET = "C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w";
const WSOL = "So11111111111111111111111111111111111111112";
const SLOT = 520_151_682n;
const WRITTEN_AT = new Date("2026-11-24T09:15:00Z");

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

const env = (overrides: Parameters<typeof bindings>[0] extends infer B ? Partial<B> : never = {}) => bindings({ databaseUrl: database.url, rpcUrl: "http://127.0.0.1:9/never", ...overrides });
const get = async (path: string) => app.request(path, {}, env(), ctx);
const explanationOf = async (program: string) => {
  const response = await get(`/v1/strategies/${program}/explanation`);
  expect(response.status).toBe(200);
  return StrategyExplanation.parse(await response.json());
};
const keyOf = async (program: string) => (await client.db.select().from(explainerKeys).where(eq(explainerKeys.program, program))).find((k) => k.status !== "superseded")!;

/** An explanation that cites the key's own evidence, as the approve command writes one that passed the validator. */
const explanationFor = (evidence: EvidenceItem[], flag = false): Explanation => {
  const [p, f] = [evidence.find((e) => e.id.startsWith("P"))!.id, evidence.find((e) => e.id.startsWith("F"))!.id];
  return {
    summary: [
      { text: "Pipeline routes your swap to this strategy, which sets its own prices.", evidence: [p] },
      { text: "The upgrade authority can replace this program's code.", evidence: [f] },
    ],
    claims: [
      { topic: "control", basis: "confirmed", text: "The upgrade authority can replace this program's code.", evidence: [f] },
      { topic: "does", basis: "inferred", text: "It appears to trade from its own vaults.", evidence: [f, p] },
    ],
    unknowns: [{ text: "No verified source shows how prices are computed.", evidence: [f] }],
    author_text_addresses_ai: flag,
  };
};

async function approve(program: string, explanation: (evidence: EvidenceItem[]) => Explanation) {
  const key = await keyOf(program);
  await finishExplainerKey(client.db, key.key, { status: "done", explanation: explanation(key.evidence as EvidenceItem[]), validation: { pass: true, checks: [] }, attempts: 1, inputTokens: 3000, outputTokens: 7000, costUsd: 0.0038, failure: null });
  await client.db.update(explainerKeys).set({ finishedAt: WRITTEN_AT }).where(eq(explainerKeys.key, key.key));
  return key.key;
}

beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
  const { db } = client;
  const addressed = parseStrategyMetadata(hostileMetadata["calls-itself-audited"]);
  if (!addressed.ok) throw new Error("fixture");
  const { document, removed } = normaliseMetadata(addressed.value);
  await db.insert(strategies).values([EXPLAINED, PENDING, ADDRESSED].map((program) => ({ program, metadataUri: program === ADDRESSED ? "https://example.org/a.json" : "", registeredAt: new Date("2026-11-08T10:00:00Z") })));
  await db.insert(programFacts).values([
    ...[EXPLAINED, PENDING, ADDRESSED].map((program) => ({ program, upgradeAuthority: "Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe", flags: ["upgradeable"] })),
    { program: ROUTER, upgradeAuthority: "2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ", flags: ["upgradeable"] },
  ]);
  await db.insert(programVersions).values([EXPLAINED, PENDING, ADDRESSED].map((program) => ({ program, deploySlot: SLOT, role: "strategy", executableSha256: "bb".repeat(32), blockTime: new Date("2026-11-08T21:10:00Z"), anchor: false })));
  await db.insert(metadataSnapshots).values([
    ...[EXPLAINED, PENDING].map((program) => ({ program, uri: "", status: "missing", errors: [], warnings: [], fetchedAt: new Date(), checkedAt: new Date() })),
    { program: ADDRESSED, uri: "https://example.org/a.json", status: "valid", errors: [], warnings: [], sha256: "11".repeat(32), document: addressed.value, normalised: document, removed, fetchedAt: new Date(), checkedAt: new Date() },
  ]);
  await db.insert(markets).values({ address: MARKET, strategyProgram: EXPLAINED, marketState: "S1".padEnd(44, "1"), createdBy: ROUTER, createdAt: new Date("2026-11-08T11:33:00Z") });
  await db.insert(marketMints).values({ market: MARKET, position: 0, mint: WSOL, vault: null, vaultAmount: "1000" });
  await makeExplainerKeys(db);
});

afterAll(async () => {
  await client?.close();
  await database?.drop();
});

describe("the contract", () => {
  it("names the topics and bases the explainer's output schema names", () => {
    expect(ExplanationClaim.shape.topic.options).toEqual([...TOPICS]);
    expect(ExplanationClaim.shape.basis.options).toEqual([...BASES]);
  });
});

describe("GET /v1/strategies/{program}/explanation", () => {
  it("shows no explanation for a version whose key has none yet, and no notice when no author text addresses AI tools", async () => {
    expect(await explanationOf(PENDING)).toEqual({ program: PENDING, deploy_slot: Number(SLOT), ai_notice: null, explanation: null });
  });

  it("serves the current key's explanation once the approve command wrote it, under the code-written label, with the evidence it was given", async () => {
    const key = await approve(EXPLAINED, (evidence) => explanationFor(evidence));
    const row = await keyOf(EXPLAINED);
    const evidence = row.evidence as EvidenceItem[];
    const served = await explanationOf(EXPLAINED);
    expect(served.ai_notice).toBeNull();
    expect(served.explanation).toEqual({
      key,
      deploy_slot: Number(SLOT),
      written_at: WRITTEN_AT.toISOString(),
      label: "Written by an AI on 24 Nov 2026 from on-chain data and Canary results for this strategy version (deployed in slot 520,151,682). It can be wrong. It is not an audit, a safety rating or advice.",
      ...(({ author_text_addresses_ai: _, ...rest }) => rest)(explanationFor(evidence)),
      evidence: evidence.map((e) => ({ id: e.id, label: e.label, value: e.value, source: e.source, author: e.id.startsWith("A") })),
    });
  });

  it("shows the fixed notice when Aviary's detector finds author text addressed to AI tools, with no explanation shown", async () => {
    const served = await explanationOf(ADDRESSED);
    expect(served).toMatchObject({ explanation: null, ai_notice: "This strategy's metadata contains text addressed to AI tools." });
  });

  it("shows the notice too when only the model's own flag fires", async () => {
    await approve(PENDING, (evidence) => explanationFor(evidence, true));
    expect((await explanationOf(PENDING)).ai_notice).toBe("This strategy's metadata contains text addressed to AI tools.");
  });

  it("knows no explanation of a strategy that is not registered", async () => {
    expect((await get(`/v1/strategies/${UNKNOWN}/explanation`)).status).toBe(404);
  });

  it("never shows an explanation for a key the version no longer has: new Canary outcomes wait for their own", async () => {
    const version = { program: EXPLAINED, deploySlot: SLOT };
    const runId = await startCanaryRun(client.db, { version, trigger: "sweep", delayMs: 0, markets: [MARKET] });
    const record: CanaryRecord = {
      id: `readable:${MARKET}:${SLOT}:520700000`,
      check: "readable",
      harness: "canary/0.3.1",
      cluster: "devnet",
      slot: 520_700_000,
      run_at: Date.UTC(2026, 10, 24, 10) / 1000,
      strategy: EXPLAINED,
      strategy_version: { deploy_slot: Number(SLOT), executable_sha256: "bb".repeat(32) },
      router_version: { deploy_slot: 100, executable_sha256: "cd".repeat(32) },
      market: MARKET,
      inputs: {},
      outcome: "fail",
      reason: "pipeline_market_info failed: AccountDidNotDeserialize.",
      numbers: {},
    };
    await storeCanaryMarket(client.db, { runId, version, market: MARKET, records: [record], notes: [], rounds: 1, rpcRequests: 1, containerMs: 1 });
    expect((await explanationOf(EXPLAINED)).explanation).toBeNull();
  });
});

describe("POST /v1/explanations/{key}/reports", () => {
  const post = (key: string, body: unknown, overrides = {}) =>
    app.request(`/v1/explanations/${key}/reports`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.18.1.1" }, body: typeof body === "string" ? body : JSON.stringify(body) }, env(overrides), ctx);

  it("files a report against the key, which the owner's reports list shows with the key", async () => {
    const { key } = await keyOf(PENDING);
    const response = await post(key, { note: "  The second sentence names the wrong authority.  " });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: expect.stringMatching(/^\d+$/), key });
    const listed = (await readExplainerReports(client.db)).find((r) => r.key === key);
    expect(listed).toMatchObject({ key, program: PENDING, deploySlot: SLOT, note: "The second sentence names the wrong authority." });
  });

  it("takes a report with no note", async () => {
    const { key } = await keyOf(PENDING);
    expect((await post(key, "")).status).toBe(201);
    expect((await readExplainerReports(client.db)).filter((r) => r.key === key).map((r) => r.note)).toContain(null);
  });

  it("refuses a key with no explanation, an unknown key, and a note past its limit", async () => {
    const pending = (await client.db.select().from(explainerKeys).where(eq(explainerKeys.program, ADDRESSED)))[0]!.key;
    expect((await post(pending, {})).status).toBe(404);
    expect((await post("f".repeat(64), {})).status).toBe(404);
    const { key } = await keyOf(PENDING);
    expect((await post(key, { note: "x".repeat(601) })).status).toBe(400);
    expect((await post(key, { note: 7 })).status).toBe(400);
    expect((await post(key, "not json")).status).toBe(400);
  });

  it("is limited per address, and says how long to wait", async () => {
    const { key } = await keyOf(PENDING);
    const REPORTS = rateLimiter(2);
    expect((await post(key, {}, { REPORTS })).status).toBe(201);
    expect((await post(key, {}, { REPORTS })).status).toBe(201);
    const refused = await post(key, {}, { REPORTS });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("60");
  });
});
