import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import { Fees } from "../src/contract";
import { app } from "../src/index";
import { bindings, executionContext } from "./fakes";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const env = (overrides: Parameters<typeof bindings>[0] extends infer T ? Partial<T> : never = {}) =>
  bindings({ databaseUrl: "postgres://unused@127.0.0.1:1/unused", rpcUrl: "http://127.0.0.1:1/", ...overrides });

async function fees(e: ReturnType<typeof env>) {
  const { ctx } = executionContext();
  const response = await app.request("/v1/fees", { headers: { "cf-connecting-ip": "192.0.2.1" } }, e, ctx);
  return { status: response.status, body: await response.json() };
}

describe("GET /v1/fees (PIPESCOPE-10 to PIPESCOPE-13, PIPESCOPE-91)", () => {
  it("serves the integrator fee's rate, fee mints and fee wallet from terminal-api's vars, and Pipeline's own rate", async () => {
    const { status, body } = await fees(env());
    expect(status).toBe(200);
    expect(Fees.parse(body)).toEqual({
      pipeline_fee_bps: 25,
      integrator_fee_bps: 50,
      fee_wallet: "9QyvxvMQQcDhRJG8qbrSL7KaXtfoMnfX37ny6XFRL3Eg",
      fee_mints: [
        { mint: WSOL, symbol: "SOL", account: "2aCTxPmrJvo9b99kfnR2yk7k647oFb1m5nMWkWmAvThn" },
        { mint: USDC, symbol: "USDC", account: "6DEijYZbuMg7nQSvYD6KzFuB6jytvCGGmSbtarErySwC" },
      ],
    });
  });

  it("changes with the vars alone, so a configuration deploy changes the rate", async () => {
    const { body } = await fees(env({ INTEGRATOR_FEE: { bps: 30, wallet: "9QyvxvMQQcDhRJG8qbrSL7KaXtfoMnfX37ny6XFRL3Eg", accounts: { [WSOL]: "2aCTxPmrJvo9b99kfnR2yk7k647oFb1m5nMWkWmAvThn" } } }));
    expect(body).toMatchObject({ integrator_fee_bps: 30, fee_mints: [{ mint: WSOL }] });
  });

  it("is the same value wrangler.jsonc holds, the one place the integrator fee is set", () => {
    const config = parse(readFileSync(`${import.meta.dirname}/../wrangler.jsonc`, "utf8")) as { vars: { INTEGRATOR_FEE: unknown } };
    expect(config.vars.INTEGRATOR_FEE).toEqual(env().INTEGRATOR_FEE);
  });

  it("refuses to serve a fee setting it cannot read, rather than build swaps from it", async () => {
    const { status, body } = await fees(env({ INTEGRATOR_FEE: { bps: 20_000, wallet: "x", accounts: {} } as never }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: "Aviary's fee settings cannot be read, so it quotes and builds no swap until they are fixed." });
  });
});
