import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Balances } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const TRADER = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "6DsWfiJk2zcHAgYjsMZYULGrVgzeedtnKbdy76vReMyp";
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A token account holding `amount`: mint, owner, then the u64 amount at byte 64. */
function tokenAccount(amount: bigint) {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { lamports: 2_039_280, owner: TOKEN_PROGRAM_ADDRESS, data: [b64(data), "base64"], executable: false, rentEpoch: 0, space: 165 };
}

describe("GET /v1/traders/{trader}/balances (the trade box's balance under each mint)", () => {
  it("reads the wallet's SOL for wrapped SOL, which the trade box pays as plain SOL, and its token account for any other mint", async () => {
    const [tokenAta] = await findAssociatedTokenPda({ owner: address(TRADER), mint: address(TOKEN), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const accounts: Record<string, unknown> = {
      [TRADER]: { lamports: 898_506_560, owner: "11111111111111111111111111111111", data: ["", "base64"], executable: false, rentEpoch: 0, space: 0 },
      [WSOL]: { lamports: 1, owner: TOKEN_PROGRAM_ADDRESS, data: [b64(new Uint8Array(82)), "base64"], executable: false, rentEpoch: 0, space: 82 },
      [TOKEN]: { lamports: 1, owner: TOKEN_PROGRAM_ADDRESS, data: [b64(new Uint8Array(82)), "base64"], executable: false, rentEpoch: 0, space: 82 },
      [tokenAta]: tokenAccount(86_063_877_914n),
    };
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { id, params } = JSON.parse(body) as { id: number; params: [string[]] };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value: params[0].map((a) => accounts[a] ?? null) } }));
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const env = bindings({ databaseUrl: "postgres://unused@127.0.0.1:1/unused", rpcUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` });
      const { ctx } = executionContext();
      const response = await app.request(`/v1/traders/${TRADER}/balances?mints=${WSOL},${TOKEN}`, { headers: { "cf-connecting-ip": "192.0.2.9" } }, env, ctx);
      expect(response.status).toBe(200);
      expect(Balances.parse(await response.json())).toEqual({
        trader: TRADER,
        balances: [
          { mint: WSOL, amount: "898506560" },
          { mint: TOKEN, amount: "86063877914" },
        ],
      });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  it("asks for at most a market's four mints", async () => {
    const env = bindings({ databaseUrl: "postgres://unused@127.0.0.1:1/unused", rpcUrl: "http://127.0.0.1:1/" });
    const { ctx } = executionContext();
    const response = await app.request(`/v1/traders/${TRADER}/balances?mints=${[WSOL, TOKEN, WSOL, TOKEN, WSOL].join(",")}`, { headers: { "cf-connecting-ip": "192.0.2.9" } }, env, ctx);
    expect(response.status).toBe(400);
  });
});
