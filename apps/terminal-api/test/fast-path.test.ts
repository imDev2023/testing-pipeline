import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { createDb, marketMints, markets } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Refusal, TradeReport } from "../src/contract";
import { app } from "../src/index";
import { awaitTrade } from "../src/trading/fastPath";
import { bindings, executionContext } from "./fakes";

/** A real devnet swap: a buy of the token with wrapped SOL on market 7Vh9...LcXz (packages/terminal-indexer/test/fixtures). */
const swap = JSON.parse(readFileSync(`${import.meta.dirname}/../../../packages/terminal-indexer/test/fixtures/swap.json`, "utf8")) as { slot: number; blockTime: number; transaction: { signatures: string[] } };
const SIGNATURE = swap.transaction.signatures[0]!;
const MARKET = "7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz";
const TOKEN = "5iEQzUi2ANPiQWKdcbyUU3EXnYviCiNKS6hbXzc3sSVX";
const WSOL = "So11111111111111111111111111111111111111112";

type Answers = { statuses: unknown[]; transaction: unknown };

/** An RPC that answers `getSignatureStatuses` from a list, one answer a call (the last one repeating), and `getTransaction` with the swap. */
async function rpc(answers: Answers) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      calls.push(method);
      const statuses = answers.statuses;
      const result =
        method === "getSignatureStatuses"
          ? { context: { slot: swap.slot + 2 }, value: [statuses.length > 1 ? statuses.shift() : statuses[0]] }
          : method === "getTransaction"
            ? answers.transaction
            : undefined;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result === undefined ? { jsonrpc: "2.0", id, error: { code: -32601, message: "no" } } : { jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, calls, close: () => new Promise<void>((done) => server.close(() => done())) };
}

let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  database = await createTestDatabase();
  const { db, close } = createDb(database.url);
  await db.insert(markets).values({ address: MARKET, strategyProgram: "J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t", marketState: MARKET, createdBy: MARKET, createdAt: new Date("2026-11-22T00:00:00Z") });
  await db.insert(marketMints).values([
    { market: MARKET, position: 0, mint: TOKEN },
    { market: MARKET, position: 1, mint: WSOL },
  ]);
  await close();
});
afterAll(async () => {
  await database?.drop();
});

const confirmed = { slot: swap.slot, confirmations: 0, err: null, confirmationStatus: "confirmed" };

describe("the trade fast path, POST /v1/trades (PIPESCOPE-33)", () => {
  it("waits for the signature to confirm, reads it back and answers with its trade under a provisional order key, handing it to the indexer", async () => {
    const chain = await rpc({ statuses: [null, { ...confirmed, confirmationStatus: "processed" }, confirmed], transaction: swap });
    const handed: string[][] = [];
    const indexer = { fastPath: async (s: string[]) => void handed.push(s) };
    const env = bindings({ databaseUrl: database.url, rpcUrl: chain.url, INDEXER: { idFromName: () => "router", get: () => indexer } as never });
    const { ctx, settle } = executionContext();
    try {
      const response = await app.request("/v1/trades", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.4" }, body: JSON.stringify({ signature: SIGNATURE }) }, env, ctx);
      await settle();
      expect(response.status).toBe(200);
      const report = TradeReport.parse(await response.json());
      expect(report.signature).toBe(SIGNATURE);
      expect(report.slot).toBe(swap.slot);
      expect(report.trades).toHaveLength(1);
      expect(report.trades[0]).toMatchObject({ signature: SIGNATURE, slot: swap.slot, block_index: null, market: MARKET, input_mint: WSOL, output_mint: TOKEN, quote_mint: WSOL, base_mint: TOKEN, side: "buy" });
      expect(report.trades[0]!.block_time).toBe(new Date(swap.blockTime * 1000).toISOString());
      expect(chain.calls.filter((c) => c === "getSignatureStatuses")).toHaveLength(3);
      expect(handed).toEqual([[SIGNATURE]]);
    } finally {
      await chain.close();
    }
  });

  it("answers a transaction that failed on chain with its decoded error", async () => {
    const failed = structuredClone(swap) as unknown as { meta: { err: unknown; logMessages: string[] } };
    failed.meta.err = { InstructionError: [2, { Custom: 1 }] };
    failed.meta.logMessages = ["Program log: Error: insufficient funds", "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1"];
    const chain = await rpc({ statuses: [{ ...confirmed, err: failed.meta.err }], transaction: failed });
    const env = bindings({ databaseUrl: database.url, rpcUrl: chain.url, INDEXER: { idFromName: () => "router", get: () => ({ fastPath: async () => {} }) } as never });
    const { ctx, settle } = executionContext();
    try {
      const response = await app.request("/v1/trades", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.5" }, body: JSON.stringify({ signature: SIGNATURE }) }, env, ctx);
      await settle();
      expect(response.status).toBe(422);
      expect(Refusal.parse(await response.json())).toMatchObject({ error: "The swap failed on chain: Your wallet holds too little for this swap.", failure: { class: "too_little" }, logs: failed.meta.logMessages });
    } finally {
      await chain.close();
    }
  });

  it("gives up after its wait when the signature never confirms, saying the trade joins Trades if it lands", async () => {
    const chain = await rpc({ statuses: [null], transaction: null });
    try {
      await expect(awaitTrade(chain.url, SIGNATURE, { pollMs: 10, waitMs: 100 })).rejects.toThrow(
        "The swap has not confirmed yet. If it lands, it joins Trades as soon as Aviary reads it.",
      );
    } finally {
      await chain.close();
    }
  });

  it("refuses something that is not a signature", async () => {
    const env = bindings({ databaseUrl: database.url, rpcUrl: "http://127.0.0.1:1/" });
    const { ctx } = executionContext();
    const response = await app.request("/v1/trades", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.6" }, body: JSON.stringify({ signature: "nope" }) }, env, ctx);
    expect(response.status).toBe(400);
  });
});
