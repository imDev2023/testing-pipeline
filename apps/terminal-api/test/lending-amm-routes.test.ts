// The lending AMM's endpoints (#88): the panel read at one slot, with the largest sells as the trade
// box takes them and the viewing wallet's shares; the market's history from the strategy's stored
// events, newest first and paged; and the refusals the create form's prepare answers before anything
// is built. Building and simulating the create for real is the devnet run's.
import { readFileSync } from "node:fs";
import { TOKEN_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { findAssociatedTokenPda } from "@solana-program/token";
import { createSolanaRpc, type Address } from "@solana/kit";
import { findAuthorityPda, findLpSharesPda, getLiquidityAddedEventEncoder, getRebalancedEventEncoder, getSharesLockedEventEncoder } from "lending-amm-scripts/client/index.ts";
import { createDb, keeperRunJobs, keeperRuns, markets, metadataSnapshots, strategies, strategyEvents } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshFirst } from "../src/products/lendingAmm/actions";
import { LendingHistory, LendingPanel } from "../src/products/lendingAmm/contract";
import { exactIn, typedFor } from "../src/products/lendingAmm/view";
import type { ApiError } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";
import { clock, LENDING_PROGRAM, lendingMarket, LENDING_MARKET, MARKET_STATE, marketState, mint, reserve, RESERVE, TOKEN, tokenAccount, WSOL } from "./lendingAmmAccounts";

const METADATA = JSON.parse(readFileSync(`${import.meta.dirname}/../../../programs/lending-amm/metadata.json`, "utf8")) as Record<string, unknown>;
const MARKET = "6dM3mXrKjPZMTm6ZLWyGTzb8XzHn8bR1u4PqA3Sx7YhB";
const TAX = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const TAX_MARKET = "4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c";
const LP_MINT = "5Dmf1kPV9QxF6x8e5jbo7cUwmUfYsxeG8YkmJHkQLwHn" as Address;
const WALLET = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW" as Address;
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const SLOT = 525_200_000;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let rpc: FakeRpc;
let env: ReturnType<typeof bindings>;
let lockAccount: Address;
let sharesAccount: Address;

const event = (encoded: ArrayLike<number>) => Buffer.from(Uint8Array.from(encoded)).toString("base64");

beforeAll(async () => {
  database = await createTestDatabase();
  rpc = await fakeRpc();
  env = bindings({ databaseUrl: database.url, rpcUrl: rpc.url });
  const at = new Date("2026-11-24T00:00:00Z");
  const { db, close } = createDb(database.url);
  try {
    await db.insert(strategies).values([
      { program: LENDING_PROGRAM, metadataUri: "https://example.com/lending.json", registeredAt: at },
      { program: TAX, metadataUri: "https://example.com/tax.json", registeredAt: at },
    ]);
    await db.insert(metadataSnapshots).values({ program: LENDING_PROGRAM, uri: "https://example.com/lending.json", status: "valid", errors: [], warnings: [], document: METADATA, fetchedAt: at, checkedAt: at });
    await db.insert(markets).values([
      { address: MARKET, strategyProgram: LENDING_PROGRAM, marketState: MARKET_STATE, createdBy: WALLET, createdAt: at, feeMint: WSOL },
      { address: TAX_MARKET, strategyProgram: TAX, marketState: "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz", createdBy: WALLET, createdAt: at },
    ]);
    const [run] = await db
      .insert(keeperRuns)
      .values({ wallet: "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2", pass: "transaction", at, day: "2026-11-24", balance: 1n, spentTotal: 0n, spentByMarket: {}, caps: { maxTxCost: "1", marketDailyCap: "1", dailyCap: "1", minBalance: "1", lowBalance: "1" }, settings: {}, warnings: [], markets: 1, sent: 1, held: 0, parked: 0, skipped: 0, failed: 0 })
      .returning({ id: keeperRuns.id });
    await db.insert(keeperRunJobs).values({ runId: run!.id, at, market: MARKET_STATE, product: "lending-amm", job: "rebalance", outcome: "sent", signature: "keeper-rebalance-1" });
    const added = getLiquidityAddedEventEncoder().encode({ marketState: MARKET_STATE, lp: WALLET, amounts: [1_000_000_000_000n, 1_000_000_000n], shares: 31_622_775_601n, shareCount: 31_622_776_601n, first: true });
    const rebalanced = getRebalancedEventEncoder().encode({ marketState: MARKET_STATE, direction: 0, liquidity: 800_000_000n, ctokens: 800_000_000n, buffer: 200_000_000n, ctokensHeld: 800_000_000n, deposited: 800_000_000n, redeemed: 0n });
    const locked = getSharesLockedEventEncoder().encode({ marketState: MARKET_STATE, lp: WALLET, amount: 5n, locked: 5n, shareCount: 31_622_776_601n });
    const otherMarket = getSharesLockedEventEncoder().encode({ marketState: "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz" as Address, lp: WALLET, amount: 1n, locked: 1n, shareCount: 1n });
    const row = (signature: string, slot: number, position: number, data: string, subject: string = MARKET_STATE) => ({ signature, position, program: LENDING_PROGRAM, discriminator: Buffer.from(data, "base64").subarray(0, 8).toString("hex"), subject, data, slot: BigInt(slot), blockIndex: 1, blockTime: new Date(1_795_600_000_000 + slot) });
    await db.insert(strategyEvents).values([
      row("added-1", 100, 0, event(added)),
      row("rebalanced-1", 200, 0, event(rebalanced)),
      row("locked-1", 300, 0, event(locked)),
      // Another market's event under this subject cannot pass as this market's: the event's own state decides.
      row("forged-1", 400, 0, event(otherMarket)),
      row("unknown-1", 500, 0, Buffer.alloc(40, 9).toString("base64")),
    ]);
  } finally {
    await close();
  }
  const [authority] = await findAuthorityPda({ marketState: MARKET_STATE });
  [lockAccount] = await findAssociatedTokenPda({ owner: authority, mint: LP_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  [sharesAccount] = await findLpSharesPda({ marketState: MARKET_STATE, lp: WALLET });
  rpc.slot = SLOT;
  rpc.accounts.set(MARKET_STATE, { owner: LENDING_PROGRAM, data: marketState({ lpMint: LP_MINT, reserves: [1_000_000_000_000n, 200_000_000n], ctokens: 800_000_000n, deposited: 800_000_000n }), lamports: 5_000_000 });
  rpc.accounts.set(RESERVE, { owner: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", data: reserve({ lastUpdateSlot: BigInt(SLOT - 100), available: 300_000_000n, borrowed: 99_700_000_000n }), lamports: 60_000_000 });
  rpc.accounts.set(LENDING_MARKET, { owner: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", data: lendingMarket(), lamports: 30_000_000 });
  rpc.accounts.set(CLOCK, { owner: "Sysvar1111111111111111111111111111111111111", data: clock(BigInt(SLOT)), lamports: 1_169_280 });
  rpc.accounts.set(LP_MINT, { owner: TOKEN_PROGRAM_ADDRESS, data: mint(31_622_775_601n), lamports: 1_461_600 });
  rpc.accounts.set(lockAccount, { owner: TOKEN_PROGRAM_ADDRESS, data: tokenAccount(5n), lamports: 2_039_280 });
  rpc.accounts.set(sharesAccount, { owner: TOKEN_PROGRAM_ADDRESS, data: tokenAccount(1_000_000_000n, WALLET, LP_MINT), lamports: 2_039_280 });
  rpc.accounts.set(TOKEN, { owner: TOKEN_PROGRAM_ADDRESS, data: mint(1n), lamports: 1_461_600 });
});

afterAll(async () => {
  await rpc?.close();
  await database?.drop();
});

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const { ctx, settle } = executionContext();
  const response = await app.request(path, init, env, ctx);
  await settle();
  return { status: response.status, body: await response.json() };
}
const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("GET /v1/markets/{market}/lending-amm", () => {
  it("works the panel out from one read at one slot, with the keeper's last rebalance", async () => {
    const { status, body } = await call(`/v1/markets/${MARKET}/lending-amm`);
    expect(status).toBe(200);
    const panel = LendingPanel.parse(body);
    expect(panel).toMatchObject({
      market: MARKET,
      market_state: MARKET_STATE,
      program: LENDING_PROGRAM,
      slot: SLOT,
      lent_index: 1,
      lent_mint: WSOL,
      other_mint: TOKEN,
      reserve: RESERVE,
      lending_market: LENDING_MARKET,
      lock_account: lockAccount,
      buffer: "200000000",
      lent_value: "800000000",
      lent_total: "1000000000",
      buffer_share_bps: 2000,
      band: "within",
      lp: { locked: "5", share_count: "31622776601", decimals: 9 },
      yield_so_far: "0",
      // 0.3 SOL free is below five times the 0.8 SOL lent, so rebalance would enter withdraw mode and redeem what Kamino can pay.
      rebalance: { due: true, refusal: null, withdraw_mode_after: true, redeem: "299700000", deposit: null, keeper_last: { outcome: "sent", signature: "keeper-rebalance-1" } },
      wallet: null,
    });
    expect(panel.kamino).toMatchObject({ free_liquidity: "300000000", can_pay: "299700000", redeems_stopped: false, refresh_age_slots: 100 });
    // Sold into WSOL, the market's fee mint: Pipeline's fee comes out of the output, and Aviary charges none on a token, so what is typed goes into the market.
    expect(panel.sells.buffer_alone).toBe(panel.sells.into_market.buffer_alone);
    const out = (a: string) => exactIn(1_000_000_000_000n, 1_000_000_000n, BigInt(a), 30)!;
    expect(out(panel.sells.buffer_alone!)).toBeLessThanOrEqual(200_000_000n);
    expect(out(String(BigInt(panel.sells.buffer_alone!) + 1n))).toBeGreaterThan(200_000_000n);
    expect(out(panel.sells.with_kamino!)).toBeLessThanOrEqual(499_700_000n);
    expect(out(String(BigInt(panel.sells.with_kamino!) + 1n))).toBeGreaterThan(499_700_000n);
    // Every account the panel uses came from one getMultipleAccounts, the market state among them, after a read of the market state alone.
    const reads = rpc.requests.filter((r) => r.method === "getMultipleAccounts" || r.method === "getAccountInfo").slice(-2);
    expect(reads.map((r) => r.method)).toEqual(["getAccountInfo", "getMultipleAccounts"]);
    expect((reads[1]!.params as [string[]])[0]).toEqual([MARKET_STATE, RESERVE, LENDING_MARKET, CLOCK, LP_MINT, lockAccount]);
  });

  it("adds the viewing wallet's shares and what removing them pays", async () => {
    const { body } = await call(`/v1/markets/${MARKET}/lending-amm?wallet=${WALLET}`);
    expect(LendingPanel.parse(body).wallet).toMatchObject({ wallet: WALLET, shares_account: sharesAccount, shares: "1000000000", cash: "yes" });
  });

  it("refuses a market that is not a lending AMM market, and a wallet that is no address", async () => {
    expect(await call(`/v1/markets/${TAX_MARKET}/lending-amm`)).toEqual({ status: 404, body: { error: "This market is not a lending AMM market." } satisfies ApiError });
    expect((await call(`/v1/markets/${MARKET}/lending-amm?wallet=nope`)).status).toBe(400);
  });
});

describe("the typed amount of a sale", () => {
  it("counts the fees taken on the input, so the largest typed amount puts exactly the edge into the market", () => {
    expect(typedFor(1_000n, { onInputBps: 0, integratorBps: 0 })).toBe(1_000n);
    // 25 bps and 50 bps on top, each rounded up: 1,001 into the market spends 1,001 + 3 + 6 = 1,010, so 1,009 typed puts in 1,000.
    expect(typedFor(1_000n, { onInputBps: 25, integratorBps: 50 })).toBe(1_009n);
  });
});

describe("GET /v1/markets/{market}/lending-amm/history", () => {
  it("lists the strategy's events on the market newest first, decoded, and pages them", async () => {
    const first = LendingHistory.parse((await call(`/v1/markets/${MARKET}/lending-amm/history`)).body);
    expect(first.events.map((e) => [e.signature, e.kind])).toEqual([
      ["locked-1", "shares-locked"],
      ["rebalanced-1", "rebalanced"],
      ["added-1", "liquidity-added"],
    ]);
    expect(first.events[0]).toMatchObject({ account: WALLET, fields: { amount: "5", locked: "5" } });
    expect(first.events[1]).toMatchObject({ fields: { direction: "deposit", liquidity: "800000000" } });
    expect(first.next_before).toBeNull();
  });

  it("refuses a cursor it did not give", async () => {
    expect((await call(`/v1/markets/${MARKET}/lending-amm/history?before=x`)).status).toBe(400);
  });
});

describe("POST /v1/lending-amm/markets/prepare", () => {
  const request = { trader: WALLET, other_mint: TOKEN, lent_mint: WSOL, lp_fee_bps: 30, other_amount: "1000000000", lent_amount: "1000000000" };

  it("refuses a first deposit too small to mint a share above the locked minimum, and the same mint twice", async () => {
    const small = await post("/v1/lending-amm/markets/prepare", { ...request, other_amount: "1000", lent_amount: "1000" });
    expect(small.status).toBe(422);
    expect((small.body as ApiError).error).toMatch(/first deposit is too small/);
    const same = await post("/v1/lending-amm/markets/prepare", { ...request, other_mint: WSOL });
    expect((same.body as ApiError).error).toBe("The two mints must differ.");
  });

  it("refuses a lent mint the program does not lend", async () => {
    const { status, body } = await post("/v1/lending-amm/markets/prepare", { ...request, lent_mint: TOKEN, other_mint: WSOL });
    expect(status).toBe(422);
    expect((body as ApiError).error).toMatch(/lends only the mints on its list/);
  });
});

describe("klend's refresh ahead of a lending AMM action", () => {
  const market = { view: { marketState: MARKET_STATE } } as Parameters<typeof refreshFirst>[0]["market"];
  const named = (name: string) => ({ name, label: name }) as Parameters<typeof refreshFirst>[0]["action"];

  it("goes first for a deposit into a market holding cTokens, and for rebalance, and for nothing else", async () => {
    const rpcClient = createSolanaRpc(rpc.url);
    const [refresh] = await refreshFirst({ rpc: rpcClient, market, action: named("add_liquidity") });
    expect(refresh).toMatchObject({ programAddress: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", accounts: [{ address: RESERVE }, { address: LENDING_MARKET }, {}, {}, {}, {}] });
    expect(await refreshFirst({ rpc: rpcClient, market, action: named("rebalance") })).toHaveLength(1);
    expect(await refreshFirst({ rpc: rpcClient, market, action: named("lock_lp") })).toEqual([]);
    expect(await refreshFirst({ rpc: rpcClient, market, action: named("remove_liquidity") })).toEqual([]);
  });

  it("is left out while the lending market's emergency mode is on, when klend refuses it", async () => {
    rpc.accounts.set(LENDING_MARKET, { owner: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", data: lendingMarket({ emergencyMode: true }), lamports: 30_000_000 });
    try {
      const rpcClient = createSolanaRpc(rpc.url);
      expect(await refreshFirst({ rpc: rpcClient, market, action: named("add_liquidity") })).toEqual([]);
      expect(await refreshFirst({ rpc: rpcClient, market, action: named("rebalance") })).toEqual([]);
    } finally {
      rpc.accounts.set(LENDING_MARKET, { owner: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", data: lendingMarket(), lamports: 30_000_000 });
    }
  });
});
