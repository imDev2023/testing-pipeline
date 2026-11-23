// The trading path's parity checks (PIPESCOPE-93; #121): a quote from `terminal-api` equals Pipeline's
// hosted `/v1/quote` for the same market, mints, amount and integrator fee, and the swap it prepares
// carries the same router instruction as the hosted `POST /v1/swap-transaction` builds. The hosted
// API takes the amount that goes into the market, so it is asked for the market amount our quote
// worked back from the amount typed (PIPESCOPE-76). Run on Pipeline's example constant-product
// market with a SOL side (docs/toolchain.md, "Aviary's devnet tests").
import { ROUTER_INSTRUCTION_DISCRIMINATORS } from "@pipeline-sol/sdk";
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PreparedSwap, Quote } from "terminal-api/contract";
import { LocalApi } from "./localApi";

const HOSTED = "https://pipeline-devnet.up.railway.app";
const ROUTER = "PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34";
/** Pipeline's example constant-product strategy's market of SOL and a plain token (docs/DEVNET.md in Pipeline's repo). */
export const CP_MARKET = process.env.E2E_TRADE_MARKET ?? "3nWkYTqgJCcMV4S4DMrF77ZF27KA58nQSyZnNiPTZabe";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "6DsWfiJk2zcHAgYjsMZYULGrVgzeedtnKbdy76vReMyp";
/** The Playwright test wallet's devnet key's address (~/.config/testing-pipeline/devnet/e2e-trader.json), which holds SOL. */
const TRADER = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW";
const FEE_ACCOUNT_WSOL = "2aCTxPmrJvo9b99kfnR2yk7k647oFb1m5nMWkWmAvThn";
const ready = Boolean(process.env.RPC_URL && process.env.TEST_DATABASE_URL);

type HostedQuote = { net_sent: string; pipeline_fee: string; integrator_fee: string; total_spend: string; amount_out: string; strategy_amount_out: string };

async function hosted<T>(path: string, init?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${HOSTED}${path}`, init);
    if (response.status === 429 && attempt < 5) {
      await new Promise((done) => setTimeout(done, 1_000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`the hosted API answered ${response.status} to ${path}: ${await response.text()}`);
    return (await response.json()) as T;
  }
}

const SWAP = Buffer.from(ROUTER_INSTRUCTION_DISCRIMINATORS.swap).toString("hex");

/** The router's `swap` instruction of a base64 wire transaction: its accounts by address and flags, and its data. */
function routerInstruction(base64: string) {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  // Both builders make legacy transactions, whose compiled message has these parts.
  type Compiled = {
    staticAccounts: string[];
    header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
  };
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as Compiled;
  const keys = message.staticAccounts;
  const { numSignerAccounts, numReadonlySignerAccounts, numReadonlyNonSignerAccounts } = message.header;
  const writable = (i: number) => (i < numSignerAccounts ? i < numSignerAccounts - numReadonlySignerAccounts : i < keys.length - numReadonlyNonSignerAccounts);
  const routerIndex = keys.indexOf(ROUTER);
  const ix = message.instructions.find((i) => i.programAddressIndex === routerIndex && Buffer.from(i.data ?? []).toString("hex").startsWith(SWAP));
  if (!ix) throw new Error("no router swap instruction in the transaction");
  return {
    accounts: (ix.accountIndices ?? []).map((i) => ({ address: keys[i], signer: i < numSignerAccounts, writable: writable(i) })),
    data: Buffer.from(ix.data ?? []).toString("hex"),
  };
}

describe.runIf(ready)("the trading path matches Pipeline's hosted API (PIPESCOPE-93)", () => {
  const api = new LocalApi(8834);
  beforeAll(() => api.start());
  afterAll(() => api.dispose());

  const ourQuote = async (input: string, output: string, amount: bigint) => {
    const response = await fetch(`${api.url}/v1/quote?market=${CP_MARKET}&input_mint=${input}&output_mint=${output}&amount=${amount}&trader=${TRADER}`);
    if (!response.ok) throw new Error(`our quote answered ${response.status}: ${await response.text()}`);
    return Quote.parse(await response.json());
  };

  it("quotes a buy paid in SOL as the hosted API does, with the integrator fee, and 0.1 SOL typed is exactly what leaves the wallet", async () => {
    const quote = await ourQuote(WSOL, TOKEN, 100_000_000n);
    expect(quote.total_spend).toBe("100000000");
    const theirs = await hosted<HostedQuote>(`/v1/quote?market=${CP_MARKET}&input_mint=${WSOL}&output_mint=${TOKEN}&amount=${quote.net_sent}&integrator_fee_bps=${quote.integrator_fee_bps}`);
    expect({
      net_sent: quote.net_sent,
      pipeline_fee: quote.pipeline_fee,
      integrator_fee: quote.integrator_fee,
      total_spend: quote.total_spend,
      amount_out: quote.expected_out,
      strategy_amount_out: quote.strategy_amount_out,
    }).toEqual({ net_sent: theirs.net_sent, pipeline_fee: theirs.pipeline_fee, integrator_fee: theirs.integrator_fee, total_spend: theirs.total_spend, amount_out: theirs.amount_out, strategy_amount_out: theirs.strategy_amount_out });
    expect(quote.integrator_fee_bps).toBe(50);
  });

  it("quotes a sell into SOL, the market's fee mint, as the hosted API does: no integrator fee, Pipeline's taken from what arrives", async () => {
    const quote = await ourQuote(TOKEN, WSOL, 5_000_000n);
    expect(quote).toMatchObject({ fee_side: "output", integrator_fee: "0", integrator_fee_bps: 0, net_sent: "5000000" });
    const theirs = await hosted<HostedQuote>(`/v1/quote?market=${CP_MARKET}&input_mint=${TOKEN}&output_mint=${WSOL}&amount=${quote.net_sent}&integrator_fee_bps=0`);
    expect({ pipeline_fee: quote.pipeline_fee, amount_out: quote.expected_out, strategy_amount_out: quote.strategy_amount_out }).toEqual({
      pipeline_fee: theirs.pipeline_fee,
      amount_out: theirs.amount_out,
      strategy_amount_out: theirs.strategy_amount_out,
    });
  });

  it("prepares a buy whose router instruction is the one the hosted API's swap transaction carries", async () => {
    const response = await fetch(`${api.url}/v1/swaps/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ market: CP_MARKET, input_mint: WSOL, output_mint: TOKEN, amount: "100000000", slippage_bps: 100, trader: TRADER }),
    });
    if (!response.ok) throw new Error(`prepare answered ${response.status}: ${await response.text()}`);
    const prepared = PreparedSwap.parse(await response.json());
    expect(prepared.simulation.ok).toBe(true);
    // 0.1 SOL typed: exactly 0.1 SOL leaves the wallet for the swap in the simulation, and the wallet's
    // SOL falls by that, the network fee and the rent of the token account the swap creates for it.
    const sim = prepared.simulation;
    expect(sim.paid).toBe("100000000");
    expect(sim.received).toBe(prepared.quote.expected_out);
    const sol = sim.changes.find((ch) => ch.mint === null)!;
    const rent = sim.new_accounts.reduce((n, a) => n + BigInt(a.rent), 0n);
    expect(BigInt(sol.before) - BigInt(sol.after)).toBe(100_000_000n + BigInt(sim.network_fee) + rent);
    // The only account it may create and keep is the trader's for the token, on their first buy of it.
    expect(sim.new_accounts.every((a) => a.mint === TOKEN)).toBe(true);
    const theirs = await hosted<{ transaction: string }>("/v1/swap-transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        market: CP_MARKET,
        input_mint: WSOL,
        output_mint: TOKEN,
        amount: prepared.quote.net_sent,
        mode: "exact_in",
        trader: TRADER,
        slippage_bps: 100,
        integrator_fee_bps: prepared.quote.integrator_fee_bps,
        integrator_fee_account: FEE_ACCOUNT_WSOL,
      }),
    });
    expect(routerInstruction(prepared.transaction!)).toEqual(routerInstruction(theirs.transaction));
  });
});
