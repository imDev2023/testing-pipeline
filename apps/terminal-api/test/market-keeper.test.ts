// `GET /v1/markets/{market}/keeper` (docs/spec/keeper-runner.md, How Aviary shows it; #57): the
// keeper jobs due on a market of one of our strategies, by the same due rules the keeper runner uses
// (packages/keeper-jobs), with the runner's last attempt at each from its records, so a product's
// panel shows a button exactly when the runner would act.
import { readFileSync } from "node:fs";
import { TOKEN_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { createDb, markets, recordKeeperPass, strategies, type KeeperJobRecord } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MarketKeeper } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const DEMO = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/buy-wall-demo-market.json`, "utf8")) as { market: string; market_state: { address: string; data: string }; token_mint: { address: string; data: string } };
const BUY_WALL = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const OTHER = "ETrmQd3NUmW4xh9uGRbC1F8XoDb2wEJYBGVwF6xGfx4Z";
const OTHER_MARKET = "4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c";
const OTHER_STATE = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const KEEPER = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";
const SOMEONE = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW";

/** The demo market's state with every ledger a job pays out set: retired tokens, rewards owed, idle SOL past WALL_THRESHOLD, and fee slots 0, 1 and 2. */
function stateWithEverythingDue(): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(DEMO.market_state.data, "base64"));
  const view = new DataView(bytes.buffer);
  view.setBigUint64(471, 5_000_000n, true); // retired_tokens
  view.setBigUint64(479, 750_000n, true); // rewards_owed
  view.setBigUint64(487, 12_000_000n, true); // idle_sol
  view.setBigUint64(495, 4_000_000n, true); // fees_recipient
  view.setBigUint64(511, 1_000_000n, true); // fees_suite
  return bytes;
}

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000);
const job = (at: Date, name: string, outcome: string, more: Partial<KeeperJobRecord> = {}): KeeperJobRecord => ({
  at,
  market: DEMO.market,
  product: "buy-wall-amm",
  job: name,
  slot: null,
  outcome,
  signature: null,
  cost: null,
  estimate: null,
  cap: null,
  error: null,
  attempt: null,
  ...more,
});

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let rpc: FakeRpc;
let env: ReturnType<typeof bindings>;

beforeAll(async () => {
  database = await createTestDatabase();
  rpc = await fakeRpc();
  env = bindings({ databaseUrl: database.url, rpcUrl: rpc.url, KEEPER_WALLET: KEEPER });
  const { db, close } = createDb(database.url);
  try {
    const at = new Date("2026-11-20T08:40:00Z");
    await db.insert(strategies).values([
      { program: BUY_WALL, metadataUri: "https://example.com/buy-wall.json", registeredAt: at },
      { program: OTHER, metadataUri: "https://example.com/other.json", registeredAt: at },
    ]);
    await db.insert(markets).values([
      { address: DEMO.market, strategyProgram: BUY_WALL, marketState: DEMO.market_state.address, createdBy: SOMEONE, createdAt: at },
      { address: OTHER_MARKET, strategyProgram: OTHER, marketState: OTHER_STATE, createdBy: SOMEONE, createdAt: at },
    ]);
    const pass = (at: Date, jobs: KeeperJobRecord[], wallet = KEEPER) => ({
      wallet,
      pass: "sweep",
      at,
      balance: 2_000_000_000n,
      day: at.toISOString().slice(0, 10),
      spentTotal: null,
      spentByMarket: null,
      caps: { maxTxCost: 1n, marketDailyCap: 1n, dailyCap: 1n, minBalance: 1n, lowBalance: 1n },
      settings: {},
      warnings: [],
      counts: { markets: 1, sent: 0, held: 0, parked: 0, skipped: 0, failed: 0 },
      jobs,
    });
    // settle failed two hours ago and was parked an hour later; slot 0 was paid a day ago; another runner's record is never ours.
    await recordKeeperPass(db, pass(ago(24 * 60), [job(ago(24 * 60), "sweep_fees", "sent", { slot: 0, signature: "5sweepSignature", cost: 5_000n })]));
    await recordKeeperPass(db, pass(ago(120), [job(ago(120), "settle", "failed", { error: "custom program error: 0x1771", attempt: 1 })]));
    await recordKeeperPass(db, pass(ago(60), [job(ago(60), "settle", "parked", { error: "custom program error: 0x1771", attempt: 3 })]));
    await recordKeeperPass(db, pass(ago(5), [job(ago(5), "place_wall", "sent", { signature: "5otherKeeper" })], SOMEONE));
  } finally {
    await close();
  }
  rpc.accounts.set(DEMO.market_state.address, { owner: BUY_WALL, data: stateWithEverythingDue(), lamports: 8_017_920 });
  rpc.accounts.set(DEMO.token_mint.address, { owner: TOKEN_PROGRAM_ADDRESS, data: new Uint8Array(Buffer.from(DEMO.token_mint.data, "base64")), lamports: 1_461_600 });
  rpc.accounts.set(OTHER_STATE, { owner: OTHER, data: Uint8Array.of(1, 2, 3), lamports: 1_000_000 });
});

afterAll(async () => {
  await rpc?.close();
  await database?.drop();
});

async function call(path: string): Promise<{ status: number; body: unknown }> {
  const { ctx, settle } = executionContext();
  const response = await app.request(path, {}, env, ctx);
  await settle();
  return { status: response.status, body: await response.json() };
}

describe("GET /v1/markets/{market}/keeper", () => {
  it("lists every job due on a buy wall market, by the runner's own rules, with the runner's last attempt at each", async () => {
    const { status, body } = await call(`/v1/markets/${DEMO.market}/keeper`);
    expect(status).toBe(200);
    const keeper = MarketKeeper.parse(body);
    expect(keeper.product).toBe("buy-wall-amm");
    expect(keeper.slot).toBe(rpc.slot);
    expect(keeper.records).toEqual({ ok: true, error: null });
    // Slot 1 waits while DESIGNER_RECIPIENT is unset, as the runner leaves it.
    expect(keeper.due.map((d) => d.key)).toEqual(["place_wall", "settle", "pay_rewards", "sweep_fees:0", "sweep_fees:2"]);
    const by = Object.fromEntries(keeper.due.map((d) => [d.key, d]));
    expect(by["place_wall"]).toMatchObject({ job: "place_wall", slot: null, owed: "12000000", last: null, due_since: null });
    expect(by["settle"]).toMatchObject({
      owed: "5000000",
      last: { at: ago(60).toISOString(), outcome: "parked", signature: null, error: "custom program error: 0x1771", cap: null },
      due_since: ago(120).toISOString(),
    });
    expect(by["sweep_fees:0"]).toMatchObject({ job: "sweep_fees", slot: 0, owed: "4000000", last: { outcome: "sent", signature: "5sweepSignature" }, due_since: null });
    expect(by["sweep_fees:2"]).toMatchObject({ slot: 2, owed: "1000000", last: null });
    expect(by["pay_rewards"]).toMatchObject({ owed: "750000" });
  });

  it("lists nothing for a market of a strategy that is not one of ours", async () => {
    const { status, body } = await call(`/v1/markets/${OTHER_MARKET}/keeper`);
    expect(status).toBe(200);
    expect(MarketKeeper.parse(body)).toMatchObject({ market: OTHER_MARKET, product: null, due: [] });
  });

  it("answers 404 for a market Aviary does not know, and 400 for what is no address", async () => {
    expect((await call(`/v1/markets/${SOMEONE}/keeper`)).status).toBe(404);
    expect((await call("/v1/markets/nope/keeper")).status).toBe(400);
  });
});
