// The containment hook in Aviary (docs/spec/containment-hook.md, "In Aviary"; #76): a home market's
// containment, read at one slot through `GET /v1/markets/{market}/containment`. A contained token is
// one whose transfer hook program is ours, whose hook authority is its unlock PDA and whose config
// exists; once unlocked it is shown with when and by which of the goal and the deadline.
import { TOKEN_2022_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { AccountRole, address, type Address } from "@solana/kit";
import { CONTAINMENT_HOOK_PROGRAM_ADDRESS, findConfigPda, findUnlockPda, getConfigDecoder } from "containment-hook-scripts/client/index.ts";
import { TAX_AMM_PROGRAM_ADDRESS } from "tax-amm-scripts/client/index.ts";
import { eq } from "drizzle-orm";
import { createDb, marketMints, markets, mints, strategies } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MarketContainment } from "../src/products/containment/contract";
import { unlockInstruction } from "../src/products/containment/unlock";
import type { ApiError } from "../src/contract";
import { app } from "../src/index";
import { clock, config, token2022Mint, taxMarket, transferHook, ZERO } from "./containmentAccounts";
import { bindings, executionContext } from "./fakes";

const HOOK = CONTAINMENT_HOOK_PROGRAM_ADDRESS;
const TAX = TAX_AMM_PROGRAM_ADDRESS;
const WSOL = address("So11111111111111111111111111111111111111112");
const TOKEN = address("CnTd1QhbTzyCLTVCQXrVBmy1xKkRjqF1Gw5k1y2nEaHw");
const MARKET = address("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
const MARKET_STATE = address("4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c");
const OTHER_MARKET = address("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const LAUNCHER = address("E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW");
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const SLOT = 526_100_000;
const NOW = 1_800_000_000n;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let rpc: FakeRpc;
let env: ReturnType<typeof bindings>;
let configAddress: Address;
let unlockAddress: Address;

async function get(path: string) {
  const { ctx, settle } = executionContext();
  const response = await app.request(path, {}, env, ctx);
  await settle();
  return response;
}

async function containment(market: string = MARKET) {
  const response = await get(`/v1/markets/${market}/containment`);
  expect(response.status).toBe(200);
  return MarketContainment.parse(await response.json());
}

/** The chain as a contained token's home market leaves it, with the overrides given. */
function chain({ hook = transferHook(unlockAddress, HOOK), cfg = {}, state = {} }: { hook?: ReturnType<typeof transferHook>; cfg?: Partial<Parameters<typeof config>[0]> | null; state?: Partial<Parameters<typeof taxMarket>[0]> } = {}) {
  rpc.accounts.clear();
  rpc.accounts.set(TOKEN, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: token2022Mint(1_000_000_000_000_000n, [hook]) });
  rpc.accounts.set(MARKET_STATE, { owner: TAX, data: taxMarket({ mints: [TOKEN, WSOL], taxCollected: 40_000_000n, ...state }) });
  if (cfg !== null) rpc.accounts.set(configAddress, { owner: HOOK, data: config({ mint: TOKEN, market: MARKET, marketState: MARKET_STATE, quoteMint: WSOL, ...cfg }) });
  rpc.accounts.set(CLOCK, { owner: "Sysvar1111111111111111111111111111111111111", data: clock(BigInt(SLOT), NOW) });
}

beforeAll(async () => {
  database = await createTestDatabase();
  rpc = await fakeRpc();
  rpc.slot = SLOT;
  env = bindings({ databaseUrl: database.url, rpcUrl: rpc.url });
  [configAddress] = await findConfigPda({ mint: TOKEN });
  [unlockAddress] = await findUnlockPda({ mint: TOKEN });
  const at = new Date("2026-11-27T00:00:00Z");
  const { db, close } = createDb(database.url);
  try {
    await db.insert(strategies).values({ program: TAX, metadataUri: "https://example.com/tax.json", registeredAt: at });
    await db.insert(markets).values([
      { address: MARKET, strategyProgram: TAX, marketState: MARKET_STATE, createdBy: LAUNCHER, createdAt: at },
      { address: OTHER_MARKET, strategyProgram: "BmXEmoN2GuQJ4hLDwSxkrh3BuSzTBaCmEdfSbRNw5Yzk", marketState: ZERO, createdBy: LAUNCHER, createdAt: at },
    ]);
    await db.insert(marketMints).values([
      { market: MARKET, position: 0, mint: TOKEN },
      { market: MARKET, position: 1, mint: WSOL },
    ]);
    await db.insert(mints).values({ address: TOKEN, readable: true, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, decimals: 9, flags: ["transfer-hook", "transfer-hook-authority"] });
  } finally {
    await close();
  }
});

afterAll(async () => {
  await rpc?.close();
  await database?.drop();
});

beforeEach(() => chain());

describe("GET /v1/markets/{market}/containment", () => {
  it("shows a contained token on its home market: the goal against the tax collected, and the deadline", async () => {
    const read = await containment();
    expect(read.slot).toBe(SLOT);
    expect(read.chain_time).toBe(Number(NOW));
    expect(read.contained).toHaveLength(1);
    expect(read.contained[0]).toMatchObject({ mint: TOKEN, status: "contained", quote_mint: WSOL, goal: "100000000", collected: "40000000", deadline: 1_800_086_400, unlocked_at: null, unlocked_by: null, due: null });
  });

  it("does not show as contained a mint whose hook is ours but whose hook authority is not its unlock PDA", async () => {
    chain({ hook: transferHook(LAUNCHER, HOOK) });
    expect((await containment()).contained).toEqual([]);
  });

  it("does not show as contained a mint whose hook is ours but that has no config", async () => {
    chain({ cfg: null });
    expect((await containment()).contained).toEqual([]);
  });

  it("does not show as contained a mint whose hook is another program, though its authority is the PDA and a config exists", async () => {
    chain({ hook: transferHook(unlockAddress, TAX) });
    expect((await containment()).contained).toEqual([]);
  });

  it("shows nothing on a market that is not the token's home market", async () => {
    chain({ cfg: { market: OTHER_MARKET } });
    expect((await containment()).contained).toEqual([]);
  });

  it("shows nothing on a market of any other strategy, and asks the chain only for the clock", async () => {
    const before = rpc.requests.length;
    expect((await containment(OTHER_MARKET)).contained).toEqual([]);
    const asked = rpc.requests.slice(before).flatMap((r) => (r.method === "getMultipleAccounts" ? (r.params[0] as string[]) : []));
    expect(asked).toEqual([CLOCK]);
  });

  it("is due by the goal once the tax collected reaches it, before the deadline", async () => {
    chain({ state: { taxCollected: 100_000_000n } });
    expect((await containment()).contained[0]).toMatchObject({ status: "contained", due: "goal" });
  });

  it("is due by the deadline once the cluster's clock reaches it, with the goal short", async () => {
    chain({ cfg: { unlockDeadline: NOW } });
    expect((await containment()).contained[0]).toMatchObject({ status: "contained", due: "deadline" });
  });

  it("is due by the goal when both hold, as the hook decides", async () => {
    chain({ cfg: { unlockDeadline: NOW - 1n }, state: { taxCollected: 100_000_000n } });
    expect((await containment()).contained[0]!.due).toBe("goal");
  });

  it("is due by the deadline when the market state can no longer be read as the tax AMM's, its tax collected unknown", async () => {
    chain({ cfg: { unlockDeadline: NOW - 1n } });
    rpc.accounts.set(MARKET_STATE, { owner: TAX, data: taxMarket({ mints: [TOKEN, WSOL], version: 2 }) });
    expect((await containment()).contained[0]).toMatchObject({ collected: null, due: "deadline" });
  });

  describe("what a sole recipient, outside supply and weak terms mean for it", () => {
    const OTHER = address("8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2");

    it("says who receives the tax, the launcher's part of it, whether the tax authority is live and any pending change of rates", async () => {
      chain({ state: { recipients: [LAUNCHER, OTHER, ZERO, ZERO], shares: [7_500, 2_500, 0, 0], taxAuthority: LAUNCHER, pendingBuyTaxBps: 100, pendingSellTaxBps: 200, pendingFromSlot: BigInt(SLOT + 50) } });
      expect((await containment()).contained[0]!.tax).toEqual({
        recipients: [
          { wallet: LAUNCHER, of_tax_bps: 6_750, launcher: true },
          { wallet: OTHER, of_tax_bps: 2_250, launcher: false },
        ],
        burn_of_tax_bps: 0,
        suite_of_tax_bps: 1_000,
        launcher_of_tax_bps: 6_750,
        authority: { kind: "address", address: LAUNCHER, launcher: true },
        pending: { buy_bps: 100, sell_bps: 200, from_slot: SLOT + 50 },
      });
    });

    it("says when the tax authority renounced, and leaves out a change of rates already due", async () => {
      chain({ state: { recipients: [OTHER, ZERO, ZERO, ZERO], shares: [10_000, 0, 0, 0], taxAuthority: LAUNCHER, taxAuthorityRenounced: true, pendingBuyTaxBps: 100, pendingSellTaxBps: 200, pendingFromSlot: BigInt(SLOT) } });
      expect((await containment()).contained[0]!.tax).toMatchObject({ launcher_of_tax_bps: 0, authority: { kind: "renounced" }, pending: null });
    });

    it("says how much of the supply is outside the pool, and the real quote it could be sold into", async () => {
      chain({ state: { reserves: [800_000_000_000_000n, 2_500_000_000n] } });
      expect((await containment()).contained[0]!.supply).toEqual({ total: "1000000000000000", in_pool: "800000000000000", outside: "200000000000000", quote_in_pool: "2500000000" });
    });

    it("calls a goal under a tenth of the quote reserve, virtual reserve included, weak, and a deadline under a week after the binding", async () => {
      // 0.1 SOL against 30 SOL virtual and 2.5 SOL real; the deadline 12.6 days after the binding.
      chain({ state: { reserves: [800_000_000_000_000n, 2_500_000_000n] } });
      expect((await containment()).contained[0]!.weak).toEqual({ goal: true, deadline: false });
      chain({ cfg: { unlockGoal: 3_250_000_000n, unlockDeadline: 1_799_000_000n + 604_799n }, state: { reserves: [800_000_000_000_000n, 2_500_000_000n] } });
      expect((await containment()).contained[0]!.weak).toEqual({ goal: false, deadline: true });
    });

    it("names the group extensions a mint carries", async () => {
      chain({ hook: transferHook(unlockAddress, HOOK) });
      rpc.accounts.set(TOKEN, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: token2022Mint(1_000_000_000_000_000n, [transferHook(unlockAddress, HOOK), { type: 20, value: new Uint8Array(64) }, { type: 22, value: new Uint8Array(64) }]) });
      expect((await containment()).contained[0]!.group_extensions).toEqual(["GroupPointer", "GroupMemberPointer"]);
    });
  });

  describe("once unlocked", () => {
    const UNLOCK_SIGNATURE = "5UnLock9qQx2yJXrM7kA3mWfK8sV1eD6hR4tN2cB7gL9pZ3wY5uT8oI1aS4dF6gH8jK2lM4nB6vC8xZ1qW3eR5tY7";
    const cleared = transferHook(null, null);
    // The unlock's block time is the clock the hook wrote into the config's `unlocked_at`.
    const UNLOCKED_AT = 1_799_600_010;
    const unlockedTransaction = (line: string) => ({
      slot: SLOT - 10_000,
      blockTime: UNLOCKED_AT,
      transactionIndex: 3,
      transaction: { signatures: [UNLOCK_SIGNATURE], message: { accountKeys: [LAUNCHER, TOKEN, configAddress, unlockAddress, MARKET_STATE, TOKEN_2022_PROGRAM_ADDRESS, HOOK] } },
      meta: { err: null, logMessages: [`Program ${HOOK} invoke [1]`, "Program log: Instruction: Unlock", `Program log: ${line}`, `Program ${HOOK} success`] },
    });

    beforeEach(() => {
      rpc.history.length = 0;
    });

    it("shows when, and by the goal when it came before the deadline, asking the chain for no transaction", async () => {
      chain({ hook: cleared, cfg: { unlockedAt: 1_799_500_000n }, state: { taxCollected: 120_000_000n } });
      const before = rpc.requests.length;
      expect((await containment()).contained[0]).toMatchObject({ status: "unlocked", unlocked_at: 1_799_500_000, unlocked_by: "goal", due: null });
      expect(rpc.requests.slice(before).map((r) => r.method)).not.toContain("getSignaturesForAddress");
    });

    it("shows by the deadline when it came at the deadline with the goal still short", async () => {
      chain({ hook: cleared, cfg: { unlockDeadline: 1_799_600_000n, unlockedAt: 1_799_600_010n } });
      expect((await containment()).contained[0]).toMatchObject({ status: "unlocked", unlocked_by: "deadline" });
    });

    it("reads the unlock's own log when the deadline had passed and the goal is reached now, since tax collected after the unlock counts too", async () => {
      rpc.history.push(unlockedTransaction("Unlocked by the deadline 1799600000"));
      chain({ hook: cleared, cfg: { unlockDeadline: 1_799_600_000n, unlockedAt: 1_799_600_010n }, state: { taxCollected: 300_000_000n } });
      expect((await containment()).contained[0]!.unlocked_by).toBe("deadline");
      rpc.history[0] = unlockedTransaction("Unlocked by the goal: 100000001 of 100000000 collected");
      expect((await containment()).contained[0]!.unlocked_by).toBe("goal");
    });

    /** A transaction of someone else's that names the unlock PDA, as anyone may send, `n` of them apart. */
    const naming = (n: number, blockTime: number, slot: number) => ({
      slot,
      blockTime,
      transactionIndex: n % 1_000,
      transaction: { signatures: [`${"5".repeat(80)}${String(n + 1).padStart(8, "1").replaceAll("0", "z")}`], message: { accountKeys: [LAUNCHER, unlockAddress] } },
      meta: { err: null, logMessages: [] },
    });

    it("finds the unlock's log by its block time behind any number of later transactions that name the unlock PDA, reading only the unlock", async () => {
      rpc.history.push(naming(0, UNLOCKED_AT - 86_400, SLOT - 20_000), unlockedTransaction("Unlocked by the deadline 1799600000"));
      for (let n = 1; n <= 1_005; n++) rpc.history.push(naming(n, UNLOCKED_AT + 60 + n, SLOT - 9_000 + Math.floor(n / 1_000)));
      chain({ hook: cleared, cfg: { unlockDeadline: 1_799_600_000n, unlockedAt: BigInt(UNLOCKED_AT) }, state: { taxCollected: 300_000_000n } });
      const before = rpc.requests.length;
      expect((await containment()).contained[0]!.unlocked_by).toBe("deadline");
      const asked = rpc.requests.slice(before);
      expect(asked.filter((r) => r.method === "getSignaturesForAddress")).toHaveLength(2);
      expect(asked.filter((r) => r.method === "getTransaction").map((r) => r.params[0])).toEqual([UNLOCK_SIGNATURE]);
    });

    it("stops at the first transaction older than the unlock, reading none, when no transaction in the unlock's second says", async () => {
      rpc.history.push(naming(0, UNLOCKED_AT - 86_400, SLOT - 20_000));
      chain({ hook: cleared, cfg: { unlockDeadline: 1_799_600_000n, unlockedAt: BigInt(UNLOCKED_AT) }, state: { taxCollected: 300_000_000n } });
      const before = rpc.requests.length;
      expect((await containment()).contained[0]!.unlocked_by).toBeNull();
      expect(rpc.requests.slice(before).map((r) => r.method)).not.toContain("getTransaction");
    });

    it("answers the containment read though refreshing the unlocked mint's stored facts fails, and refreshes them on a later read", async () => {
      chain({ hook: cleared, cfg: { unlockedAt: 1_799_500_000n } });
      const stored = async () => {
        const { db, close } = createDb(database.url);
        try {
          return (await db.select({ flags: mints.flags }).from(mints).where(eq(mints.address, TOKEN)))[0]!.flags;
        } finally {
          await close();
        }
      };
      {
        const { db, close } = createDb(database.url);
        try {
          await db.update(mints).set({ flags: ["transfer-hook", "transfer-hook-authority"] }).where(eq(mints.address, TOKEN));
        } finally {
          await close();
        }
      }
      rpc.refuse.add("getEpochInfo");
      try {
        expect((await containment()).contained[0]).toMatchObject({ status: "unlocked", unlocked_by: "goal" });
        expect(await stored()).toContain("transfer-hook");
      } finally {
        rpc.refuse.delete("getEpochInfo");
      }
      await containment();
      expect(await stored()).not.toContain("transfer-hook");
    });

    it("leaves which of the two unknown when the unlock's transaction cannot be found", async () => {
      chain({ hook: cleared, cfg: { unlockDeadline: 1_799_600_000n, unlockedAt: 1_799_600_010n }, state: { taxCollected: 300_000_000n } });
      expect((await containment()).contained[0]).toMatchObject({ status: "unlocked", unlocked_by: null });
    });

    it("reads the mint again for the facts panel when its stored trust flags still name the hook", async () => {
      chain({ hook: cleared, cfg: { unlockedAt: 1_799_500_000n } });
      await containment();
      const { db, close } = createDb(database.url);
      try {
        const [row] = await db.select({ flags: mints.flags }).from(mints).where(eq(mints.address, TOKEN));
        expect(row!.flags).not.toContain("transfer-hook");
        expect(row!.flags).not.toContain("transfer-hook-authority");
      } finally {
        await close();
      }
    });
  });

  it("answers 404 for a market Aviary does not know", async () => {
    const response = await get(`/v1/markets/${address("3uETnqjVKyNXAnRxyZhkNXQXbyjzCRvyhTibmjZtLEJz")}/containment`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiError).error).toMatch(/no market/);
  });
});

describe("POST /v1/containment/unlock/prepare", () => {
  async function prepare(body: unknown) {
    const { ctx, settle } = executionContext();
    const response = await app.request("/v1/containment/unlock/prepare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env, ctx);
    await settle();
    return response;
  }

  it("refuses a mint that is not contained, before building anything", async () => {
    chain({ hook: transferHook(LAUNCHER, HOOK) });
    const response = await prepare({ mint: TOKEN, trader: LAUNCHER });
    expect(response.status).toBe(422);
    expect(((await response.json()) as ApiError).error).toBe("This mint is not a contained token, so there is nothing to unlock.");
  });

  it("refuses a token already unlocked, saying when", async () => {
    chain({ hook: transferHook(null, null), cfg: { unlockedAt: 1_799_500_000n } });
    const response = await prepare({ mint: TOKEN, trader: LAUNCHER });
    expect(response.status).toBe(422);
    expect(((await response.json()) as ApiError).error).toBe("This token was already unlocked, on 9 Jan 2027 at 13:06 UTC.");
  });

  it("builds unlock on the config's own accounts: the mint and its config written, the unlock PDA and the market state read, no signer but the wallet that pays", async () => {
    const decoded = config({ mint: TOKEN, market: MARKET, marketState: MARKET_STATE, quoteMint: WSOL });
    const instruction = await unlockInstruction(TOKEN, getConfigDecoder().decode(decoded));
    expect(instruction.programAddress).toBe(HOOK);
    expect(instruction.accounts).toEqual([
      { address: TOKEN, role: AccountRole.WRITABLE },
      { address: configAddress, role: AccountRole.WRITABLE },
      { address: unlockAddress, role: AccountRole.READONLY },
      { address: MARKET_STATE, role: AccountRole.READONLY },
      { address: TOKEN_2022_PROGRAM_ADDRESS, role: AccountRole.READONLY },
    ]);
  });
});
