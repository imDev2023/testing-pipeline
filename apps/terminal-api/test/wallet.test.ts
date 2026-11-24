// The wallet page's endpoints (docs/spec/pipescope-screens.md, Wallet page; pipescope-architecture.md,
// API; #122): what a wallet holds that trades on Pipeline, read through RPC, with each token's markets
// from Postgres and the count of tokens no market trades; and its wrapped SOL, unwrapped by a
// transaction built and simulated here, signed in the wallet.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { getAddressDecoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { eq } from "drizzle-orm";
import { createDb, marketMints, mints } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { indexTransactions, pipelineHandler, type RawTransaction } from "terminal-indexer";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Holdings, PreparedUnwrap, type ApiError } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const fixture = (name: string) => JSON.parse(readFileSync(`${import.meta.dirname}/../../../packages/terminal-indexer/test/fixtures/${name}.json`, "utf8")) as RawTransaction;
const [registered, created] = ["registered", "marketCreated"].map(fixture) as [RawTransaction, RawTransaction];

const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const TOKEN = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";
const WSOL = "So11111111111111111111111111111111111111112";
const WALLET = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW";
/** A token no Pipeline market trades, and one the wallet holds none of. */
const UNLISTED = "6DsWfiJk2zcHAgYjsMZYULGrVgzeedtnKbdy76vReMyp";
const EMPTIED = "3YSYe6jQ7DKfZT2bNi8ZCwV5sBfn5WU2P3Rb46PPtQXR";
const TOKEN_ACCOUNT = "2yLyoJtMyVYu7G1uMCr8mJKzVZj53fFHrJ8Fzb5iT6st";
const WRAPPED_ACCOUNT = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";
const RENT = 2_039_280n;

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
  const { db, close } = createDb(database.url);
  try {
    await indexTransactions(db, pipelineHandler({ candleSeconds: [] }), [registered, created]);
    await db.insert(mints).values([
      { address: TOKEN, readable: true, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, decimals: 6, supply: "1000000000000000", symbol: "PE2E", name: "Pipescope E2E" },
      { address: WSOL, readable: true, tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 9, supply: "0" },
    ]).onConflictDoNothing();
    await db.update(marketMints).set({ vault: TOKEN_ACCOUNT }).where(eq(marketMints.mint, TOKEN));
  } finally {
    await close();
  }
});
afterAll(async () => {
  await database?.drop();
});

let server: Server | null = null;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

type Answer = (params: unknown[]) => unknown;

/** A fake RPC answering each method from `answers`; every request is kept, method and parameters. */
async function rpc(answers: Record<string, Answer>) {
  const asked: { method: string; params: unknown[] }[] = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      asked.push({ method, params });
      const answer = answers[method];
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer ? { jsonrpc: "2.0", id, result: answer(params) } : { jsonrpc: "2.0", id, error: { code: -32601, message: `no ${method}` } }));
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}/`, asked };
}

/** A token account as `getTokenAccountsByOwner` answers it in `jsonParsed`. */
const parsed = (pubkey: string, mint: string, amount: bigint, decimals: number, program: string, lamports = RENT) => ({
  pubkey,
  account: {
    lamports: Number(lamports),
    owner: program,
    executable: false,
    rentEpoch: 0,
    space: 165,
    data: { program: "spl-token", space: 165, parsed: { type: "account", info: { mint, owner: WALLET, state: "initialized", isNative: mint === WSOL, tokenAmount: { amount: String(amount), decimals, uiAmount: 0, uiAmountString: "0" } } } },
  },
});

const ownedBy = (byProgram: Record<string, unknown[]>): Answer => (params) => ({ context: { slot: 1 }, value: byProgram[(params[1] as { programId?: string; mint?: string }).programId ?? ""] ?? [] });

async function call(url: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const env = bindings({ databaseUrl: database.url, rpcUrl: url });
  const { ctx, settle } = executionContext();
  const response = await app.request(path, { ...init, headers: { "cf-connecting-ip": "192.0.2.12", "content-type": "application/json", ...init.headers } }, env, ctx);
  await settle();
  return { status: response.status, body: await response.json() };
}

describe("GET /v1/traders/{trader}/holdings", () => {
  it("lists what the wallet holds that a Pipeline market trades, with those markets, and counts the tokens no market trades", async () => {
    const { url } = await rpc({
      getBalance: () => ({ context: { slot: 1 }, value: 1_250_000_000 }),
      getTokenAccountsByOwner: ownedBy({
        [TOKEN_PROGRAM_ADDRESS]: [parsed(WRAPPED_ACCOUNT, WSOL, 40_000_000n, 9, TOKEN_PROGRAM_ADDRESS), parsed("GTWLNWCmPiZUApG9tY3UvmYEXtdrvafAJDZJpe2q6CpR", UNLISTED, 5_000_000n, 6, TOKEN_PROGRAM_ADDRESS), parsed("STuNJsT31NppprsJaYrk9V3y8Jk8NgJw9Sgtwow62ZP", EMPTIED, 0n, 6, TOKEN_PROGRAM_ADDRESS)],
        [TOKEN_2022_PROGRAM_ADDRESS]: [parsed("6texCytj6rTHDLyo8nPo9zbaHPeBheV6C1J3HQWySVSy", TOKEN, 123_456_789n, 6, TOKEN_2022_PROGRAM_ADDRESS)],
      }),
    });
    const { status, body } = await call(url, `/v1/traders/${WALLET}/holdings`);
    expect(status).toBe(200);
    expect(Holdings.parse(body)).toEqual({
      trader: WALLET,
      sol: "1250000000",
      wrapped_sol: { amount: "40000000", accounts: [WRAPPED_ACCOUNT] },
      holdings: [{ mint: TOKEN, symbol: null, token: { symbol: "PE2E", name: "Pipescope E2E", image: null }, decimals: 6, amount: "123456789", markets: [MARKET] }],
      markets: [{ address: MARKET, base_mint: TOKEN, quote_mint: WSOL }],
      mints: [
        { mint: TOKEN, symbol: null, token: { symbol: "PE2E", name: "Pipescope E2E", image: null }, decimals: 6 },
        { mint: WSOL, symbol: "SOL", token: null, decimals: 9 },
      ],
      not_listed: 1,
    });
  });

  it("offers to unwrap wrapped-SOL accounts that hold nothing, whose rent comes back", async () => {
    const { url } = await rpc({
      getBalance: () => ({ context: { slot: 1 }, value: 5 }),
      getTokenAccountsByOwner: ownedBy({ [TOKEN_PROGRAM_ADDRESS]: [parsed(WRAPPED_ACCOUNT, WSOL, 0n, 9, TOKEN_PROGRAM_ADDRESS)] }),
    });
    expect(Holdings.parse((await call(url, `/v1/traders/${WALLET}/holdings`)).body).wrapped_sol).toEqual({ amount: "0", accounts: [WRAPPED_ACCOUNT] });
  });

  it("answers a wallet that holds nothing with no wrapped SOL, no holdings and nothing unlisted", async () => {
    const { url } = await rpc({ getBalance: () => ({ context: { slot: 1 }, value: 0 }), getTokenAccountsByOwner: ownedBy({}) });
    expect(Holdings.parse((await call(url, `/v1/traders/${WALLET}/holdings`)).body)).toEqual({ trader: WALLET, sol: "0", wrapped_sol: null, holdings: [], markets: [], mints: [], not_listed: 0 });
  });

  it("refuses an address that is none", async () => {
    const { url, asked } = await rpc({});
    const { status, body } = await call(url, "/v1/traders/not-an-address/holdings");
    expect(status).toBe(400);
    expect((body as ApiError).error).toBe("trader is an address.");
    expect(asked).toEqual([]);
  });
});

describe("POST /v1/unwrap/prepare", () => {
  const blockhash = { context: { slot: 1 }, value: { blockhash: "85wnSLSYPdHaM8ad4F4MS7JpmrkaYcaSntKMVpiFAG4N", lastValidBlockHeight: 100 } };
  const wrapped = ownedBy({}) as Answer;
  const wrappedAccounts: Answer = (params) => ((params[1] as { mint?: string }).mint === WSOL ? { context: { slot: 1 }, value: [parsed(WRAPPED_ACCOUNT, WSOL, 40_000_000n, 9, TOKEN_PROGRAM_ADDRESS, 40_000_000n + RENT)] } : wrapped(params));
  const before = 1_250_000_000n;

  it("closes the wallet's wrapped SOL into it, simulated first, and says how much SOL comes back after the network fee", async () => {
    const { url, asked } = await rpc({
      getTokenAccountsByOwner: wrappedAccounts,
      getBalance: () => ({ context: { slot: 1 }, value: Number(before) }),
      getLatestBlockhash: () => blockhash,
      getFeeForMessage: () => ({ context: { slot: 1 }, value: 5000 }),
      simulateTransaction: () => ({
        context: { slot: 1 },
        value: { err: null, logs: ["Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [1]", "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success"], unitsConsumed: 2_950, accounts: [{ lamports: Number(before + 40_000_000n + RENT - 5000n), owner: "11111111111111111111111111111111", data: ["", "base64"], executable: false, rentEpoch: 0, space: 0 }, null] },
      }),
    });
    const { status, body } = await call(url, "/v1/unwrap/prepare", { method: "POST", body: JSON.stringify({ trader: WALLET }) });
    expect(status).toBe(200);
    const prepared = PreparedUnwrap.parse(body);
    expect(prepared).toMatchObject({
      trader: WALLET,
      accounts: [WRAPPED_ACCOUNT],
      wrapped: "40000000",
      left: 0,
      simulation: { ok: true, failure: null, compute_units: 2_950, network_fee: "5000", returned: String(40_000_000n + RENT) },
    });
    // What was simulated is what is returned to sign: the wallet pays, and one instruction closes the account into it.
    const simulated = asked.find((a) => a.method === "simulateTransaction")!;
    expect(simulated.params[0]).toBe(prepared.transaction);
    expect(simulated.params[1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true, accounts: { addresses: [WALLET, WRAPPED_ACCOUNT] } });
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction!)).messageBytes);
    if (message.version !== "legacy") throw new Error(`the unwrap is a version ${message.version} transaction`);
    expect(message.staticAccounts[0]).toBe(WALLET);
    expect(message.instructions).toHaveLength(1);
    expect(message.staticAccounts[message.instructions[0]!.programAddressIndex]).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(message.instructions[0]!.data![0]).toBe(9);
  });

  it("offers nothing to sign when the simulation fails, with the failure decoded", async () => {
    const { url } = await rpc({
      getTokenAccountsByOwner: wrappedAccounts,
      getBalance: () => ({ context: { slot: 1 }, value: 0 }),
      getLatestBlockhash: () => blockhash,
      getFeeForMessage: () => ({ context: { slot: 1 }, value: 5000 }),
      simulateTransaction: () => ({ context: { slot: 1 }, value: { err: "AccountNotFound", logs: [], unitsConsumed: 0, accounts: null } }),
    });
    const prepared = PreparedUnwrap.parse((await call(url, "/v1/unwrap/prepare", { method: "POST", body: JSON.stringify({ trader: WALLET }) })).body);
    expect(prepared.transaction).toBeNull();
    expect(prepared.simulation).toMatchObject({ ok: false, failure: { class: "too_little", sentence: "Your wallet holds too little for this transaction: it has never held SOL, so it cannot pay the network fee." }, returned: null });
  });

  it("closes as many wrapped-SOL accounts as one transaction holds, and says how many are left for another", async () => {
    const many = Array.from({ length: 40 }, (_, i) => parsed(getAddressDecoder().decode(new Uint8Array(32).fill(7).fill(i + 1, 0, 1)), WSOL, 1_000n, 9, TOKEN_PROGRAM_ADDRESS, 1_000n + RENT));
    const { url } = await rpc({
      getTokenAccountsByOwner: () => ({ context: { slot: 1 }, value: many }),
      getLatestBlockhash: () => blockhash,
      getFeeForMessage: () => ({ context: { slot: 1 }, value: 5000 }),
      simulateTransaction: (params) => ({ context: { slot: 1 }, value: { err: null, logs: [], unitsConsumed: 9_000, accounts: (params[1] as { accounts: { addresses: string[] } }).accounts.addresses.map(() => null) } }),
    });
    const prepared = PreparedUnwrap.parse((await call(url, "/v1/unwrap/prepare", { method: "POST", body: JSON.stringify({ trader: WALLET }) })).body);
    expect(prepared.accounts.length).toBeGreaterThan(10);
    expect(prepared.accounts.length).toBeLessThan(40);
    expect(prepared.left).toBe(40 - prepared.accounts.length);
    expect(prepared.simulation.returned).toBe(String(BigInt(prepared.accounts.length) * (1_000n + RENT)));
    expect(getBase64Encoder().encode(prepared.transaction!).length).toBeLessThanOrEqual(1232);
  });

  it("says so when the wallet holds no wrapped SOL", async () => {
    const { url } = await rpc({ getTokenAccountsByOwner: ownedBy({}) });
    const { status, body } = await call(url, "/v1/unwrap/prepare", { method: "POST", body: JSON.stringify({ trader: WALLET }) });
    expect(status).toBe(404);
    expect((body as ApiError).error).toBe("This wallet holds no wrapped SOL to unwrap.");
  });
});
