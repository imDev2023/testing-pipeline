// The lending AMM's items in the explainer's evidence (#88; docs/spec/lending-pool.md, "Aviary's panel"):
// the panel's facts of the sampled market, read at one slot with the panel's own reading, and the three
// risks of every lending AMM market; the risks alone when the market cannot be read. Making a key calls
// no model, so nothing here is a paid call.
import { TOKEN_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { eq } from "drizzle-orm";
import { createDb, explainerKeys, marketMints, markets, metadataSnapshots, mints, programVersions, strategies, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import type { EvidenceItem } from "terminal-explainer";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeExplainerKeys } from "../src/explainer";
import { LENDING_RISKS, lendingFacts } from "../src/products/lendingAmm/facts";
import { lendingView } from "../src/products/lendingAmm/view";
import { clock, LENDING_MARKET, LENDING_PROGRAM, lendingMarket, MARKET_STATE, marketState, mint, reserve, RESERVE, TOKEN, WSOL } from "./lendingAmmAccounts";

const MARKET = "6dM3mXrKjPZMTm6ZLWyGTzb8XzHn8bR1u4PqA3Sx7YhB";
const SLOT = 525_200_000;
const LP_MINT = "5Dmf1kPV9QxF6x8e5jbo7cUwmUfYsxeG8YkmJHkQLwHn";
const STATE = { lpMint: LP_MINT as never, reserves: [1_000_000_000_000n, 200_000_000n], ctokens: 800_000_000n, deposited: 800_000_000n };

describe("lendingFacts", () => {
  it("states the panel's figures in whole tokens, with the read's slot as its source", () => {
    const view = lendingView({ slot: BigInt(SLOT), marketState: MARKET_STATE, state: marketState(STATE), reserve: reserve({ lastUpdateSlot: BigInt(SLOT - 5) }), lendingMarket: lendingMarket(), clock: clock(BigInt(SLOT)), lpMint: mint(31_622_775_601n), lockAccount: null });
    const facts = lendingFacts(MARKET, view, { lent: "SOL", lentDecimals: 9, other: `token ${TOKEN}`, otherDecimals: 6 });
    expect(facts.map((f) => f.label)).toEqual(["Lent side", "Buffer and lent value", "Largest sells", "Kamino reserve", "LP shares and yield"]);
    const value = (label: string) => facts.find((f) => f.label === label)!.value;
    expect(value("Lent side")).toBe(`On market ${MARKET}, SOL (${WSOL}) is lent to Kamino reserve ${RESERVE} in lending market ${LENDING_MARKET}; the other mint, ${TOKEN}, is never lent.`);
    expect(value("Buffer and lent value")).toBe("The buffer holds 0.2 SOL and the market's cTokens are worth 0.8 SOL at Kamino's stored rate, 20.00% of the lent side in the buffer, against a band of 10.00% to 30.00% with a target of 20.00%. Withdraw mode is off.");
    expect(value("Largest sells")).toMatch(/^The largest sell the buffer pays alone is \d+(\.\d+)? token \w+, and a larger one redeems its shortfall from Kamino; with what Kamino can pay right now \(0\.8 SOL\) on top, every sell the market can take is paid\.$/);
    expect(value("Kamino reserve")).toBe("Utilisation 0.00%; freely available liquidity 100 SOL; supply rate 0.00% a year at its stored state; reserve emergency mode: off; lending market emergency mode: off; block_ctoken_usage: off; not deprecated; last refreshed 5 slots before this read.");
    expect(facts.every((f) => f.source === `the market state ${MARKET_STATE}, Kamino's reserve, its lending market and the LP mint, read at slot ${SLOT}`)).toBe(true);
  });

  it("names the spec's three risks", () => {
    expect(LENDING_RISKS.map((r) => r.label)).toEqual(["Risk: Kamino can stop redeems", "Risk: LPs bear Kamino's losses", "Risk: large sells can fail"]);
    expect(LENDING_RISKS[0]!.value).toMatch(/emergency council can stop redeems.*ETH reserve for about 16 hours/);
    expect(LENDING_RISKS[1]!.value).toMatch(/bad debt Kamino has not written off yet still counts as borrowed/);
    expect(LENDING_RISKS[2]!.value).toMatch(/more of the lent mint than the buffer plus what Kamino can pay right now fails/);
  });
});

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
let rpc: FakeRpc;

beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
  rpc = await fakeRpc();
  rpc.slot = SLOT;
  const { db } = client;
  const at = new Date("2026-11-22T10:00:00Z");
  await db.insert(strategies).values({ program: LENDING_PROGRAM, metadataUri: "https://example.org/lending.json", registeredAt: at });
  await db.insert(programVersions).values({ program: LENDING_PROGRAM, deploySlot: 524_900_000n, role: "strategy", executableSha256: "cc".repeat(32), blockTime: at, anchor: false });
  await db.insert(metadataSnapshots).values({ program: LENDING_PROGRAM, uri: "https://example.org/lending.json", status: "missing", errors: [], warnings: [], fetchedAt: at, checkedAt: at });
  await db.insert(markets).values({ address: MARKET, strategyProgram: LENDING_PROGRAM, marketState: MARKET_STATE, createdBy: TOKEN, createdAt: at, feeMint: WSOL });
  await db.insert(marketMints).values([
    { market: MARKET, position: 0, mint: TOKEN, vault: "V1".padEnd(44, "1"), vaultAmount: "1000000000000" },
    { market: MARKET, position: 1, mint: WSOL, vault: "V2".padEnd(44, "1"), vaultAmount: "200000000" },
  ]);
  await db.insert(mints).values([
    { address: TOKEN, readable: true, tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 6, supply: "1", mintAuthority: null, freezeAuthority: null, flags: [] },
    { address: WSOL, readable: true, tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 9, supply: "0", mintAuthority: null, freezeAuthority: null, flags: [] },
  ]);
  rpc.accounts.set(MARKET_STATE, { owner: LENDING_PROGRAM, data: marketState(STATE), lamports: 5_000_000 });
  rpc.accounts.set(RESERVE, { owner: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", data: reserve({ lastUpdateSlot: BigInt(SLOT - 5) }), lamports: 1 });
  rpc.accounts.set(LENDING_MARKET, { owner: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", data: lendingMarket(), lamports: 1 });
  rpc.accounts.set("SysvarC1ock11111111111111111111111111111111", { owner: "Sysvar1111111111111111111111111111111111111", data: clock(BigInt(SLOT)), lamports: 1 });
  rpc.accounts.set(LP_MINT, { owner: TOKEN_PROGRAM_ADDRESS, data: mint(31_622_775_601n), lamports: 1 });
});

afterAll(async () => {
  await client?.close();
  await rpc?.close();
  await database?.drop();
});

const evidenceOf = async () => (await client.db.select().from(explainerKeys).where(eq(explainerKeys.program, LENDING_PROGRAM)))[0]!.evidence as EvidenceItem[];

describe("a lending AMM version's evidence", () => {
  it("carries the sampled market's panel facts and the three risks as F items", async () => {
    expect((await makeExplainerKeys(client.db, { rpcUrl: rpc.url })).made).toEqual([LENDING_PROGRAM]);
    const evidence = await evidenceOf();
    const lending = evidence.filter((e) => e.group === "Lending AMM");
    expect(lending.map((e) => e.label)).toEqual(["Lent side", "Buffer and lent value", "Largest sells", "Kamino reserve", "LP shares and yield", ...LENDING_RISKS.map((r) => r.label)]);
    expect(lending.every((e) => e.id.startsWith("F"))).toBe(true);
    expect(lending.find((e) => e.label === "Buffer and lent value")!.value).toMatch(/^The buffer holds 0\.2 SOL and the market's cTokens are worth 0\.8 SOL/);
    expect(lending.find((e) => e.label === "Largest sells")!.value).toMatch(/ token AVimg/);
  });

  it("keeps the risks, and says the panel was not read, when the chain cannot be read", async () => {
    await client.db.delete(explainerKeys);
    await makeExplainerKeys(client.db, {});
    const lending = (await evidenceOf()).filter((e) => e.group === "Lending AMM");
    expect(lending.map((e) => e.label)).toEqual(["Lending AMM panel of the sampled market", ...LENDING_RISKS.map((r) => r.label)]);
  });
});
