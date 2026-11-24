// Explainer jobs in `terminal-api` (docs/spec/pipescope-architecture.md, "Explainer jobs";
// docs/spec/pipescope-explainer.md, "When an explanation is made" and Inputs; EXPLAINER-04,
// EXPLAINER-05, EXPLAINER-07, EXPLAINER-23): for each strategy's current version, the key; for a new
// key, the evidence the model is to read and its estimated cost, stored pending. A key that exists
// makes nothing, so a Canary re-run with the same outcomes makes no new key.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normaliseMetadata, MODEL, PROMPT_VERSION, validate, type EvidenceItem } from "terminal-explainer";
import { hostileMetadata } from "terminal-explainer/fixtures";
import { parseStrategyMetadata } from "@pipeline-sol/sdk";
import {
  createDb,
  explainerKeys,
  marketMints,
  markets,
  metadataSnapshots,
  mints,
  pendingExplainerKeys,
  programFacts,
  programVersions,
  startCanaryRun,
  storeCanaryMarket,
  strategies,
  strategyCalls,
  strategyInstructions,
  trades,
  type CanaryRecord,
  type Db,
} from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeExplainerKeys } from "../src/explainer";
import { ROUTER } from "../src/indexerCore";

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const STRATEGY = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const PLAIN = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const AUTHORITY = "Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe";
const ROUTER_AUTHORITY = "2yJJsmhvs2SBsKVtiKCG4wBJNoTH67aRNMhSwkupvUHZ";
const CREATOR = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";
const CALLER = "4gqiCkoxxD72nbXGc7XtxQx4UjBHD3KiJyXpMvEZ6u8c";
// Two markets of STRATEGY: BUSY has the most swaps; RICH has the larger SOL vault but fewer swaps.
const BUSY = "C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w";
const RICH = "ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb";
const MINT = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";
const V1 = 520_100_000n;
const V2 = 520_151_682n;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };

function record(check: string, market: string, slot: number, outcome: CanaryRecord["outcome"], reason: string): CanaryRecord {
  return {
    id: `${check}:${market}:${V2}:${slot}`,
    check,
    harness: "canary/0.3.1",
    cluster: "devnet",
    slot,
    run_at: Date.UTC(2026, 10, 24, 4, 54) / 1000 + slot - 520_700_000,
    strategy: STRATEGY,
    strategy_version: { deploy_slot: Number(V2), executable_sha256: "bb".repeat(32) },
    router_version: { deploy_slot: 100, executable_sha256: "cd".repeat(32) },
    market,
    inputs: { sizes_lamports: [10_000, 1_000_000] },
    outcome,
    reason,
    numbers: {},
  };
}

/** One Canary run of a market, as `CanaryRun` stores it. */
async function canaryRun(db: Db, market: string, records: CanaryRecord[]): Promise<void> {
  const version = { program: STRATEGY, deploySlot: V2 };
  const runId = await startCanaryRun(db, { version, trigger: "sweep", delayMs: 0, markets: [market] });
  await storeCanaryMarket(db, { runId, version, market, records, notes: [], rounds: 1, rpcRequests: 1, containerMs: 1 });
}

const keysOf = async (db: Db, program = STRATEGY) => (await db.select().from(explainerKeys)).filter((k) => k.program === program);
const item = (evidence: EvidenceItem[], label: string | RegExp) => evidence.find((e) => (typeof label === "string" ? e.label === label : label.test(e.label)));

beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
  const { db } = client;
  const lying = parseStrategyMetadata(hostileMetadata["lying-label"]);
  if (!lying.ok) throw new Error("fixture");
  const { document, removed } = normaliseMetadata(lying.value);
  await db.insert(strategies).values([
    { program: STRATEGY, metadataUri: "https://example.org/s.json", registeredAt: new Date("2026-11-07T18:30:00Z") },
    { program: PLAIN, metadataUri: "", registeredAt: new Date("2026-11-08T10:00:00Z") },
  ]);
  await db.insert(programFacts).values([
    { program: STRATEGY, upgradeAuthority: AUTHORITY, flags: ["upgradeable"] },
    { program: PLAIN, upgradeAuthority: null, flags: ["frozen"] },
    { program: ROUTER, upgradeAuthority: ROUTER_AUTHORITY, flags: ["upgradeable"] },
  ]);
  await db.insert(programVersions).values([
    { program: STRATEGY, deploySlot: V1, role: "strategy", executableSha256: "aa".repeat(32), blockTime: new Date("2026-11-07T18:30:00Z"), anchor: true },
    { program: STRATEGY, deploySlot: V2, role: "strategy", executableSha256: "bb".repeat(32), blockTime: new Date("2026-11-08T21:10:00Z"), anchor: true },
    { program: PLAIN, deploySlot: 520_000_000n, role: "strategy", executableSha256: "ee".repeat(32), blockTime: new Date("2026-11-08T09:00:00Z"), anchor: false },
  ]);
  const names = ["PipelineInitMarket", "PipelineMarketInfo", "PipelineResolveAccounts", "PipelineQuote", "PipelineSwap", "PipelineSeedLiquidity", "Deposit"];
  await db.insert(strategyInstructions).values(names.map((name, position) => ({ program: STRATEGY, deploySlot: V2, position, name, discriminator: `d${position}`.padEnd(16, "0"), pipeline: name.startsWith("Pipeline") })));
  await db.insert(strategyCalls).values([1, 2, 3].map((n) => ({ signature: `sig-deposit-${n}`, instructionIndex: 0, innerIndex: -1, program: STRATEGY, discriminator: "d6".padEnd(16, "0"), signers: [CALLER], slot: 520_200_000n + BigInt(n) })));
  await db.insert(metadataSnapshots).values([
    { program: STRATEGY, uri: "https://example.org/s.json", status: "valid", errors: [], warnings: [], sha256: "11".repeat(32), document: lying.value, normalised: document, removed, fetchedAt: new Date(), checkedAt: new Date() },
    { program: PLAIN, uri: "", status: "missing", errors: [], warnings: [], fetchedAt: new Date(), checkedAt: new Date() },
  ]);
  await db.insert(markets).values([
    { address: BUSY, strategyProgram: STRATEGY, marketState: "S1".padEnd(44, "1"), createdBy: CREATOR, createdAt: new Date("2026-11-08T11:33:00Z") },
    { address: RICH, strategyProgram: STRATEGY, marketState: "S2".padEnd(44, "1"), createdBy: CREATOR, createdAt: new Date("2026-11-08T12:00:00Z") },
  ]);
  await db.insert(marketMints).values([
    { market: BUSY, position: 0, mint: MINT, vault: "V1".padEnd(44, "1"), vaultAmount: "271021619603" },
    { market: BUSY, position: 1, mint: WSOL, vault: "V2".padEnd(44, "1"), vaultAmount: "310000000" },
    { market: RICH, position: 0, mint: MINT, vault: "V3".padEnd(44, "1"), vaultAmount: "1000000" },
    { market: RICH, position: 1, mint: WSOL, vault: "V4".padEnd(44, "1"), vaultAmount: "9000000000" },
  ]);
  await db.insert(mints).values([
    { address: MINT, readable: true, tokenProgram: TOKEN, decimals: 6, supply: "1000000000000", mintAuthority: CREATOR, freezeAuthority: null, flags: ["mint-authority"] },
    { address: WSOL, readable: true, tokenProgram: TOKEN, decimals: 9, supply: "0", mintAuthority: null, freezeAuthority: null, flags: [] },
  ]);
  const trade = (signature: string, market: string, trader: string, at: string) => ({
    signature,
    eventIndex: 0,
    slot: 520_300_000n,
    blockTime: new Date(at),
    market,
    strategy: STRATEGY,
    trader,
    inputMint: WSOL,
    outputMint: MINT,
    mode: 0,
    netSent: "10000000",
    received: "8716124",
    pipelineFee: "25000",
    feeMint: WSOL,
    integratorFee: "0",
    unixTimestamp: BigInt(Date.parse(at) / 1000),
  });
  await db.insert(trades).values([
    trade("t1", BUSY, CALLER, "2026-11-08T11:33:00Z"),
    trade("t2", BUSY, CREATOR, "2026-11-09T08:00:00Z"),
    trade("t3", RICH, CALLER, "2026-11-09T09:00:00Z"),
  ]);
  await canaryRun(db, BUSY, [record("readable", BUSY, 520_700_000, "pass", "Every direction quoted at the smallest size."), record("exit_sizes", BUSY, 520_700_000, "pass", "Sold everything back at 0.00001 SOL and 0.001 SOL; 99.39% returned at the smallest size.")]);
  await canaryRun(db, RICH, [record("readable", RICH, 520_700_001, "fail", "pipeline_market_info failed: AccountDidNotDeserialize.")]);
});

afterAll(async () => {
  await client?.close();
  await database?.drop();
});

describe("makeExplainerKeys", () => {
  it("makes one pending key for each strategy's current version, with its evidence and estimated cost", async () => {
    const { db } = client;
    const made = await makeExplainerKeys(db);
    expect(made.made.sort()).toEqual([PLAIN, STRATEGY].sort());
    const [key] = await keysOf(db);
    expect(key).toMatchObject({ program: STRATEGY, deploySlot: V2, status: "pending", promptVersion: PROMPT_VERSION, model: MODEL.id, representativeMarket: BUSY, authorTextAddressesAi: false });
    expect(Number(key!.estimatedCostUsd)).toBeGreaterThan(0);
    expect(Number(key!.estimatedCostUsd)).toBeLessThan(0.01);
    expect(key!.estimatedInputTokens).toBeGreaterThan(1000);
  });

  it("builds the evidence the spec lists, every item with an id, a label, a value and its source", async () => {
    const [key] = await keysOf(client.db);
    const evidence = key!.evidence as EvidenceItem[];
    for (const e of evidence) expect(e, e.id).toEqual({ id: expect.stringMatching(/^[PFCSA]\d+$/), group: expect.any(String), label: expect.any(String), value: expect.any(String), source: expect.any(String) });
    expect(evidence.filter((e) => e.id.startsWith("P")).map((e) => e.label)).toEqual(["Pipeline fee", "Router protections on swaps", "Custom actions", "Bypass", "Vetting", "Who controls the router"]);
    expect(item(evidence, "Who controls the router")!.value).toContain(ROUTER_AUTHORITY);
    expect(item(evidence, "Program")!.value).toBe(STRATEGY);
    expect(item(evidence, "Upgrade authority")!.value).toContain(AUTHORITY);
    expect(item(evidence, "This version")!.value).toBe(`Deployed in slot ${V2}, 2026-11-08 21:10 UTC; executable hash ${"bb".repeat(32)}`);
    expect(item(evidence, "Version history")!.value).toBe(`2 versions: slot ${V1} (2026-11-07 18:30 UTC) and slot ${V2} (2026-11-08 21:10 UTC), this one.`);
    expect(item(evidence, "Verified build")!.value).toMatch(/^None/);
    expect(item(evidence, "Instructions in the deployed program")!.value).toBe(
      "7: Pipeline's six (PipelineInitMarket, PipelineMarketInfo, PipelineResolveAccounts, PipelineQuote, PipelineSwap, PipelineSeedLiquidity) and 1 more: Deposit.",
    );
    expect(item(evidence, "Markets")!.value).toBe("2 markets registered with Pipeline, the first created 2026-11-08 11:33 UTC.");
    expect(item(evidence, "Markets this version cannot read")!.value).toBe(`1 of the 2 markets Canary has checked on this version: ${RICH}, where its readable check failed.`);
    expect(item(evidence, "Sampled market")!.value).toBe(`${BUSY}, the market with the most swaps through Pipeline (2); created 2026-11-08 11:33 UTC by ${CREATOR}.`);
    expect(item(evidence, `Token ${MINT}`)!.value).toBe(`SPL Token, 6 decimals. Mint authority: ${CREATOR}. Freeze authority: none. No extensions.`);
    expect(item(evidence, "Wrapped SOL")!.value).toBe("SPL Token, 9 decimals. Mint authority: none. Freeze authority: none. No extensions.");
    expect(item(evidence, "Vaults of the sampled market")!.value).toBe(`271021.619603 of token ${MINT} and 0.31 SOL.`);
    expect(item(evidence, "Trading on the sampled market")!.value).toBe("2 swaps through Pipeline from 2 wallets, from 2026-11-08 11:33 UTC to 2026-11-09 08:00 UTC.");
    expect(item(evidence, "Trading on all markets")!.value).toBe("3 swaps through Pipeline across its 2 markets, from 2 wallets.");
    expect(item(evidence, "Custom actions called")!.value).toBe(`Deposit: 3 calls, by 1 signer (${CALLER}: 3).`);
    const canary = evidence.filter((e) => e.id.startsWith("C"));
    expect(item(canary, "Canary check exit_sizes on the sampled market")!.value).toBe(
      'Run on 2026-11-24 04:54 UTC at slot 520700000, on this version: pass. Sold everything back at 0.00001 SOL and 0.001 SOL; 99.39% returned at the smallest size. Inputs: {"sizes_lamports":[10000,1000000]}',
    );
    expect(item(canary, "Canary across the version's markets")!.value).toBe("2 markets checked. exit_sizes: pass on 1. readable: pass on 1, fail on 1.");
    expect(item(canary, "Canary checks not run on the sampled market")!.value).toMatch(/^Not run yet: conformance, exit_hold, /);
    // The author part: A items, and F items that name them by id.
    expect(evidence.filter((e) => e.id.startsWith("A")).map((e) => e.value)[0]).toBe("Honest Market");
    expect(item(evidence, "Create form labels")!.value).toMatch(/^The label in A\d+ is on the argument withdraw_authority, of type pubkey\./);
  });

  it("gives a strategy with no metadata and no readable instruction names the facts it has", async () => {
    const [key] = await keysOf(client.db, PLAIN);
    const evidence = key!.evidence as EvidenceItem[];
    expect(item(evidence, "Upgrade authority")!.value).toMatch(/^None: the program is frozen/);
    expect(item(evidence, "Instructions in the deployed program")!.value).toBe("Aviary could not read the instruction names in this version's code.");
    expect(item(evidence, "Strategy metadata: flag metadata-missing")).toBeDefined();
    expect(item(evidence, "Markets")!.value).toBe("No markets registered with Pipeline.");
    expect(item(evidence, "Canary")!.value).toBe("Canary has not run on this version yet.");
    expect(evidence.some((e) => e.id.startsWith("A"))).toBe(false);
    expect(key!.representativeMarket).toBeNull();
  });

  it("makes nothing new when nothing changed, and nothing for a Canary re-run with the same outcomes", async () => {
    const { db } = client;
    expect((await makeExplainerKeys(db)).made).toEqual([]);
    await canaryRun(db, BUSY, [record("readable", BUSY, 520_800_000, "pass", "Every direction quoted again."), record("exit_sizes", BUSY, 520_800_000, "pass", "Sold everything back; 99.41% returned at the smallest size.")]);
    expect((await makeExplainerKeys(db)).made).toEqual([]);
    expect(await keysOf(db)).toHaveLength(1);
  });

  it("makes a new key when an outcome changes, and the older pending key leaves the queue", async () => {
    const { db } = client;
    const [before] = await keysOf(db);
    await canaryRun(db, BUSY, [record("exit_sizes", BUSY, 520_900_000, "fail", "The sale of 0.001 SOL was refused.")]);
    expect((await makeExplainerKeys(db)).made).toEqual([STRATEGY]);
    const keys = await keysOf(db);
    expect(keys.find((k) => k.key === before!.key)!.status).toBe("superseded");
    expect((await pendingExplainerKeys(db)).filter((k) => k.program === STRATEGY)).toHaveLength(1);
  });

  it("waits while a strategy's metadata link has changed and its new document is not fetched yet, then makes a key with it", async () => {
    const { db } = client;
    await db.update(strategies).set({ metadataUri: "https://example.org/new.json" }).where(eq(strategies.program, STRATEGY));
    expect((await makeExplainerKeys(db)).waiting).toEqual([STRATEGY]);
    const audited = parseStrategyMetadata(hostileMetadata["calls-itself-audited"]);
    if (!audited.ok) throw new Error("fixture");
    const { document, removed } = normaliseMetadata(audited.value);
    await db.insert(metadataSnapshots).values({ program: STRATEGY, uri: "https://example.org/new.json", status: "valid", errors: [], warnings: [], sha256: "22".repeat(32), document: audited.value, normalised: document, removed, fetchedAt: new Date(), checkedAt: new Date() });
    expect((await makeExplainerKeys(db)).made).toEqual([STRATEGY]);
    const [newest] = await pendingExplainerKeys(db).then((k) => k.filter((x) => x.program === STRATEGY));
    expect(newest!.authorTextAddressesAi).toBe(true);
  });

  it("builds evidence the recorded sample explanations' rules can be checked against: a plain output citing it passes the validator", async () => {
    const [key] = (await pendingExplainerKeys(client.db)).filter((k) => k.program === STRATEGY);
    const evidence = key!.evidence as EvidenceItem[];
    const id = (label: string) => item(evidence, label)!.id;
    const output = {
      summary: [
        { text: `The key ${AUTHORITY.slice(0, 4)}...${AUTHORITY.slice(-4)} can replace this strategy's code at any time.`, evidence: [id("Upgrade authority")] },
        { text: "In the sampled market, Canary saw a sale of 0.001 SOL refused.", evidence: [id("Canary check exit_sizes on the sampled market")] },
      ],
      claims: [{ topic: "control", basis: "confirmed", text: "This version was deployed on 2026-11-08 at 21:10 UTC.", evidence: [id("This version")] }],
      unknowns: [],
      author_text_addresses_ai: true,
    };
    expect(validate(evidence, output).checks.flatMap((c) => c.errors)).toEqual([]);
  });
});

describe("no LLM key or SDK in terminal-api (PIPESCOPE-37, EXPLAINER-06)", () => {
  it("imports no Anthropic SDK anywhere in its source, and names none in its dependencies", () => {
    const src = join(import.meta.dirname, "../src");
    const files = readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(readFileSync(join(src, file), "utf8"), file).not.toMatch(/@anthropic-ai\/|from ["']anthropic/);
    const manifest = readFileSync(join(import.meta.dirname, "../package.json"), "utf8");
    expect(manifest).not.toMatch(/anthropic/i);
  });

  it("declares no LLM key among its secrets or vars", () => {
    expect(readFileSync(join(import.meta.dirname, "../wrangler.jsonc"), "utf8")).not.toMatch(/ANTHROPIC|OPENAI|LLM_|_API_KEY/);
  });
});
