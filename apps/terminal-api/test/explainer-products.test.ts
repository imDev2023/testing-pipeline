// The explainer's fact table for our own products (docs/spec/pool4-for-solana.md, Aviary's panel; #57):
// a buy wall strategy's evidence carries the facts its panel shows, read from the sampled market's
// state and its token's mint at one slot, and the three risks of every buy wall market.
import { readFileSync } from "node:fs";
import { TOKEN_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { createDb, explainerKeys, marketMints, markets, metadataSnapshots, programFacts, programVersions, strategies, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import type { EvidenceItem } from "terminal-explainer";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeExplainerKeys } from "../src/explainer";

const DEMO = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/buy-wall-demo-market.json`, "utf8")) as { market: string; market_state: { address: string; data: string }; token_mint: { address: string; data: string } };
const BUY_WALL = "BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6";
const WSOL = "So11111111111111111111111111111111111111112";
const CREATOR = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";
const mintAccount = () => ({ owner: TOKEN_PROGRAM_ADDRESS, data: new Uint8Array(Buffer.from(DEMO.token_mint.data, "base64")), lamports: 1_461_600 });

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
let rpc: FakeRpc;

beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
  rpc = await fakeRpc();
  const { db } = client;
  await db.insert(strategies).values({ program: BUY_WALL, metadataUri: "", registeredAt: new Date("2026-11-20T04:13:00Z") });
  await db.insert(programFacts).values({ program: BUY_WALL, upgradeAuthority: "Gf8tq5uEsLqAtiWSkxJqUfSMXYKHCct9UeWunLEuWsPe", flags: ["upgradeable"] });
  await db.insert(programVersions).values({ program: BUY_WALL, deploySlot: 524_292_769n, role: "strategy", executableSha256: "e4".repeat(32), blockTime: new Date("2026-11-20T08:30:54Z"), anchor: false });
  await db.insert(metadataSnapshots).values({ program: BUY_WALL, uri: "", status: "missing", errors: [], warnings: [], fetchedAt: new Date(), checkedAt: new Date() });
  await db.insert(markets).values({ address: DEMO.market, strategyProgram: BUY_WALL, marketState: DEMO.market_state.address, createdBy: CREATOR, createdAt: new Date("2026-11-20T04:13:55Z") });
  await db.insert(marketMints).values([
    { market: DEMO.market, position: 0, mint: DEMO.token_mint.address, vault: "8xZyjFv9maYh227Y4yyrSbMLiruna8sHKzmuoViv6dZc", vaultAmount: "864268710755" },
    { market: DEMO.market, position: 1, mint: WSOL, vault: "AsXnGex7us8spZKJ75ygGAk5y9Ghg22dCmNAtr4fgRig", vaultAmount: "11270777495" },
  ]);
  rpc.accounts.set(DEMO.market_state.address, { owner: BUY_WALL, data: new Uint8Array(Buffer.from(DEMO.market_state.data, "base64")), lamports: 8_017_920 });
  // The Clock sysvar at the demo market's last update plus an hour: its unix_timestamp is its fifth field.
  const clock = new Uint8Array(40);
  new DataView(clock.buffer).setBigInt64(32, 1_795_228_910n + 3_600n, true);
  rpc.accounts.set(CLOCK, { owner: "Sysvar1111111111111111111111111111111111111", data: clock, lamports: 1_169_280 });
});

afterAll(async () => {
  await rpc?.close();
  await client?.close();
  await database?.drop();
});

describe("a buy wall strategy's evidence", () => {
  it("waits for a later run when the sampled market cannot be read, rather than keep evidence without the panel's facts", async () => {
    // The token's mint is not there yet: no key is made, so the next run tries again.
    const { made, unread } = await makeExplainerKeys(client.db, { rpcUrl: rpc.url });
    expect(made).toEqual([]);
    expect(unread).toEqual([BUY_WALL]);
    expect(await client.db.select().from(explainerKeys)).toHaveLength(0);
    // And with no RPC to read it with.
    expect((await makeExplainerKeys(client.db)).unread).toEqual([BUY_WALL]);
  });

  it("carries the panel's facts of the sampled market, read at one slot, and the three risks", async () => {
    rpc.accounts.set(DEMO.token_mint.address, mintAccount());
    rpc.requests.length = 0;
    const { made } = await makeExplainerKeys(client.db, { rpcUrl: rpc.url });
    expect(made).toEqual([BUY_WALL]);
    const [key] = await client.db.select().from(explainerKeys);
    const evidence = key!.evidence as EvidenceItem[];
    const product = evidence.filter((e) => e.group === "Buy wall AMM");
    expect(product.map((e) => e.label)).toEqual([
      "Price",
      "Buy wall",
      "Inventory cap",
      "Retired, owed and burned tokens",
      "Fee and its split",
      "Fee ledgers",
      "Parameters",
      "Recipients",
      "Risk: the curve thins as the cap falls",
      "Risk: the buy wall can sit well below the price",
      "Risk: the rewards recipient can trade the cap down",
    ]);
    // F items, numbered after the market's own facts, each saying the slot it was read at.
    for (const e of product) expect(e.id).toMatch(/^F\d+$/);
    expect(product[0]).toMatchObject({ value: "0.00000890267 SOL per token.", source: `the sampled market's state, read at slot ${rpc.slot}` });
    expect(rpc.requests.filter((r) => r.method === "getMultipleAccounts")).toHaveLength(1);
    // The allowance is brought up to the chain's clock read at that slot: an hour past the market's last update.
    expect(product.find((e) => e.label === "Inventory cap")!.value).toContain("59812.692236 tokens of cap decay allowance are built up.");
  });
});
