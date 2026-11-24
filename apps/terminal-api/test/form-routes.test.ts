// The endpoints behind the forms and the product panels (#123): a mint typed into a create form, read
// for its facts before any market holds it; a market's state with named outside accounts, read at
// one slot for a product's panel (PIPESCOPE-146); and the refusals a custom action's or a new
// market's prepare answers before anything is simulated. Building and simulating them for real is
// the local demo's (tests/terminal-e2e/demo/forms.ts).
import { readFileSync } from "node:fs";
import { TOKEN_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { getAddressEncoder, type Address } from "@solana/kit";
import { createDb, marketMints, markets, metadataSnapshots, strategies } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MARKET_READ } from "../src/config";
import { MarketRead, MintFacts, type ApiError } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const TAX_METADATA = JSON.parse(readFileSync(`${import.meta.dirname}/../../../programs/tax-amm/metadata.json`, "utf8")) as Record<string, unknown>;
const TAX = "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t";
const NO_METADATA = "ETrmQd3NUmW4xh9uGRbC1F8XoDb2wEJYBGVwF6xGfx4Z";
const MARKET = "4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c";
const DARK_MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
const STATE = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const RESERVE = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";
const ORACLE = "6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp";
const MISSING = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";
const MINT = "AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx";
const AUTHORITY = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW";
const TRADER = AUTHORITY;

/** A classic mint: its authority set, 1,000,000 base units of supply, 6 decimals, initialised, no freeze authority. */
function classicMint(): Uint8Array {
  const bytes = new Uint8Array(82);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  bytes.set(getAddressEncoder().encode(AUTHORITY as Address), 4);
  view.setBigUint64(36, 1_000_000n, true);
  bytes[44] = 6;
  bytes[45] = 1;
  return bytes;
}

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let rpc: FakeRpc;
let env: ReturnType<typeof bindings>;

beforeAll(async () => {
  database = await createTestDatabase();
  rpc = await fakeRpc();
  env = bindings({ databaseUrl: database.url, rpcUrl: rpc.url });
  const { db, close } = createDb(database.url);
  try {
    const at = new Date("2026-11-24T00:00:00Z");
    await db.insert(strategies).values([
      { program: TAX, metadataUri: "https://example.com/tax.json", registeredAt: at },
      { program: NO_METADATA, metadataUri: "https://example.com/none.json", registeredAt: at },
    ]);
    await db.insert(metadataSnapshots).values([
      { program: TAX, uri: "https://example.com/tax.json", status: "valid", errors: [], warnings: [], document: TAX_METADATA, fetchedAt: at, checkedAt: at },
      { program: NO_METADATA, uri: "https://example.com/none.json", status: "unreachable", reason: "http-status", errors: ["HTTP 404"], warnings: [], fetchedAt: at, checkedAt: at },
    ]);
    await db.insert(markets).values([
      { address: MARKET, strategyProgram: TAX, marketState: STATE, createdBy: AUTHORITY, createdAt: at },
      { address: DARK_MARKET, strategyProgram: NO_METADATA, marketState: ORACLE, createdBy: AUTHORITY, createdAt: at },
    ]);
    await db.insert(marketMints).values({ market: MARKET, position: 0, mint: MINT });
  } finally {
    await close();
  }
  rpc.accounts.set(MINT, { owner: TOKEN_PROGRAM_ADDRESS, data: classicMint(), lamports: 1_461_600 });
  rpc.accounts.set(STATE, { owner: TAX, data: Uint8Array.of(1, 2, 3, 4), lamports: 3_000_000 });
  rpc.accounts.set(RESERVE, { owner: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", data: Uint8Array.of(9, 9), lamports: 5_000_000 });
  rpc.accounts.set(ORACLE, { owner: "11111111111111111111111111111111", data: new Uint8Array(0), lamports: 890_880 });
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

describe("GET /v1/mints/{mint}", () => {
  it("reads a mint typed into a form, with its facts as the facts panel words them, before any market holds it", async () => {
    const { status, body } = await call(`/v1/mints/${MINT}`);
    expect(status).toBe(200);
    expect(MintFacts.parse(body)).toMatchObject({
      mint: MINT,
      readable: true,
      token_program: "Token",
      decimals: 6,
      supply: "1000000",
      mint_authority: AUTHORITY,
      freeze_authority: null,
      extensions: [],
      vault_amount: null,
      vault_share_percent: null,
      flags: [{ flag: "mint-authority", description: expect.any(String) }],
      read_slot: rpc.slot,
    });
  });

  it("says when the address is no mint", async () => {
    const { status, body } = await call(`/v1/mints/${STATE}`);
    expect(status).toBe(200);
    expect(MintFacts.parse(body)).toMatchObject({ mint: STATE, readable: false, token_program: null, decimals: null, flags: [{ flag: "mint-unreadable", description: expect.any(String) }] });
  });

  it("refuses what is no address", async () => {
    expect((await call("/v1/mints/not-an-address")).status).toBe(400);
  });
});

describe("GET /v1/markets/{market}/state", () => {
  it("reads the market's state and every account named with it, all at one slot", async () => {
    rpc.requests.length = 0;
    const { status, body } = await call(`/v1/markets/${MARKET}/state?accounts=${RESERVE},${ORACLE},${MISSING}`);
    expect(status).toBe(200);
    const read = MarketRead.parse(body);
    expect(read).toEqual({
      market: MARKET,
      slot: rpc.slot,
      accounts: [
        { address: STATE, role: "market_state", exists: true, owner: TAX, lamports: "3000000", executable: false, size: 4, data: Buffer.from([1, 2, 3, 4]).toString("base64") },
        { address: RESERVE, role: "named", exists: true, owner: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", lamports: "5000000", executable: false, size: 2, data: "CQk=" },
        { address: ORACLE, role: "named", exists: true, owner: "11111111111111111111111111111111", lamports: "890880", executable: false, size: 0, data: "" },
        { address: MISSING, role: "named", exists: false, owner: null, lamports: null, executable: null, size: null, data: null },
      ],
    });
    // One read of them all: the slot is the one every account was read at.
    expect(rpc.requests.filter((r) => r.method === "getMultipleAccounts")).toHaveLength(1);
  });

  it("never downloads more of an account than it returns: a larger one comes back with its size and no data", async () => {
    const BIG = "Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe";
    rpc.accounts.set(BIG, { owner: TAX, data: new Uint8Array(MARKET_READ.maxAccountBytes + 10), lamports: 9_000_000 });
    rpc.requests.length = 0;
    const read = MarketRead.parse((await call(`/v1/markets/${MARKET}/state?accounts=${BIG}`)).body);
    expect(read.accounts[1]).toEqual({ address: BIG, role: "named", exists: true, owner: TAX, lamports: "9000000", executable: false, size: MARKET_READ.maxAccountBytes + 10, data: null });
    const [asked] = rpc.requests.filter((r) => r.method === "getMultipleAccounts");
    expect(asked!.params[1]).toMatchObject({ dataSlice: { offset: 0, length: MARKET_READ.maxAccountBytes + 1 } });
  });

  it("reads the market's state alone when no account is named", async () => {
    const read = MarketRead.parse((await call(`/v1/markets/${MARKET}/state`)).body);
    expect(read.accounts.map((a) => a.role)).toEqual(["market_state"]);
  });

  it(`refuses more than ${MARKET_READ.maxAccounts} accounts, and anything that is no address`, async () => {
    const many = Array.from({ length: MARKET_READ.maxAccounts + 1 }, () => RESERVE).join(",");
    expect((await call(`/v1/markets/${MARKET}/state?accounts=${many}`)).status).toBe(400);
    expect((await call(`/v1/markets/${MARKET}/state?accounts=${RESERVE},nope`)).status).toBe(400);
  });

  it("answers 404 for an address that is no market", async () => {
    const { status, body } = await call(`/v1/markets/${MISSING}/state`);
    expect(status).toBe(404);
    expect((body as ApiError).error).toBe("Aviary knows no market created through Pipeline at this address.");
  });
});

describe("POST /v1/actions/prepare", () => {
  const request = { market: MARKET, action: "set_taxes", args: { buy_tax_bps: "600", sell_tax_bps: "900" }, inputs: {}, trader: TRADER };

  it("refuses a body it does not take", async () => {
    expect((await post("/v1/actions/prepare", { ...request, extra: 1 })).status).toBe(400);
    expect((await post("/v1/actions/prepare", { ...request, trader: "nope" })).status).toBe(400);
  });

  it("answers 404 for a market Aviary does not know, and for an action its strategy's metadata does not describe", async () => {
    expect((await post("/v1/actions/prepare", { ...request, market: MISSING })).status).toBe(404);
    const { status, body } = await post("/v1/actions/prepare", { ...request, action: "withdraw_everything" });
    expect(status).toBe(404);
    expect((body as ApiError).error).toBe("This market's strategy describes no action named withdraw_everything in its metadata.");
  });

  it("refuses an action of a strategy whose metadata is unavailable, since it has no forms", async () => {
    const { status, body } = await post("/v1/actions/prepare", { ...request, market: DARK_MARKET });
    expect(status).toBe(422);
    expect((body as ApiError).error).toBe("This market's strategy has no forms: its metadata is unavailable.");
  });
});

describe("POST /v1/markets/prepare", () => {
  it("refuses a strategy with no create form", async () => {
    const { status, body } = await post("/v1/markets/prepare", { strategy: NO_METADATA, args: {}, inputs: {}, trader: TRADER });
    expect(status).toBe(422);
    expect((body as ApiError).error).toBe("This strategy has no create form: its metadata is unavailable.");
  });

  it("answers 404 for an address that is no strategy", async () => {
    expect((await post("/v1/markets/prepare", { strategy: MISSING, args: {}, inputs: {}, trader: TRADER })).status).toBe(404);
  });

  describe("opening the new market in the same transaction (PIPESCOPE-159)", () => {
    const then = (actions: unknown[]) => ({ mints: [MINT, MISSING], vaults: [RESERVE, ORACLE], actions });

    it("answers 404 for an action the strategy's metadata does not describe, before anything is built", async () => {
      const { status, body } = await post("/v1/markets/prepare", { strategy: TAX, args: {}, inputs: {}, trader: TRADER, then: then([{ action: "launch", args: {}, inputs: {} }]) });
      expect(status).toBe(404);
      expect((body as ApiError).error).toBe("This strategy describes no action named launch in its metadata.");
    });

    it("refuses more actions than a new market may run as it opens, and an opening without its vaults", async () => {
      const seed = { action: "seed", args: {}, inputs: {} };
      expect((await post("/v1/markets/prepare", { strategy: TAX, args: {}, inputs: {}, trader: TRADER, then: then([seed, seed, seed]) })).status).toBe(400);
      expect((await post("/v1/markets/prepare", { strategy: TAX, args: {}, inputs: {}, trader: TRADER, then: { mints: [MINT, MISSING], actions: [] } })).status).toBe(400);
    });

    it("refuses to open a market whose mint has a transfer hook in the transaction that creates it, since its actions need the hook's accounts", async () => {
      const hooked = "HooKedM1nt111111111111111111111111111111111";
      const hookProgram = "aueUqJKZDZmb2vX3rJEn3ZfYQpx6DTxtfSWMccXdkjv";
      // A Token-2022 mint: the classic 82 bytes, padding to 165, the account type, then a transfer hook extension (type 14) naming its program.
      const data = new Uint8Array(166 + 4 + 64);
      data.set(classicMint(), 0);
      data[165] = 1;
      new DataView(data.buffer).setUint16(166, 14, true);
      new DataView(data.buffer).setUint16(168, 64, true);
      data.set(getAddressEncoder().encode(hookProgram as Address), 170 + 32);
      rpc.accounts.set(hooked, { owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", data });
      const { status, body } = await post("/v1/markets/prepare", { strategy: TAX, args: {}, inputs: {}, trader: TRADER, then: { mints: [hooked, MINT], vaults: [RESERVE, ORACLE], actions: [{ action: "seed", args: {}, inputs: {} }] } });
      expect(status).toBe(422);
      expect((body as ApiError).error).toBe(`The new market's mint ${hooked} has a transfer hook, ${hookProgram}, so the market cannot be opened in the transaction that creates it: create it, then run its actions in transactions of their own.`);
    });

    it("refuses an action input that is no address", async () => {
      const { status, body } = await post("/v1/markets/prepare", { strategy: TAX, args: {}, inputs: {}, trader: TRADER, then: then([{ action: "distribute", args: {}, inputs: { recipient: "nobody" } }]) });
      expect(status).toBe(400);
      expect(JSON.stringify(body)).toContain("recipient");
    });
  });
});
