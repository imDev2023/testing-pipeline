// The trading path's endpoints (docs/spec/pipescope-architecture.md, Trading path): the fees, a
// quote while the trader types, a swap prepared and simulated, and a trade's signature (the fast
// path). Quotes, prepares and signatures count together against the TRADES limit (PIPESCOPE-90).
import { address, createSolanaRpc } from "@solana/kit";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDb, markets } from "terminal-db";
import type { z } from "zod";
import { Fees, PrepareSwapRequest, PreparedSwap, Quote, TradeReport, TradeSignature, type Refusal } from "../contract";
import type { AppEnv } from "../index";
import { indexer } from "../index";
import { limitTrades } from "../rateLimits";
import { tradeViews } from "../views";
import { awaitTrade, provisionalTrades } from "./fastPath";
import { feesView } from "./fees";
import { readTradeMarket } from "./market";
import { prepareSwap } from "./prepare";
import { quoteTyped, Refused } from "./quote";

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const AMOUNT = /^\d{1,20}$/;
const U64_MAX = (1n << 64n) - 1n;

/** The amount typed, a whole number of base units that a u64 holds and is not zero. */
function amountOf(raw: string | undefined): bigint {
  if (!raw || !AMOUNT.test(raw) || BigInt(raw) === 0n || BigInt(raw) > U64_MAX) throw new HTTPException(400, { message: "amount is a whole number of the input mint's smallest units, above 0." });
  return BigInt(raw);
}

function addressOf(raw: string | undefined, name: string): string {
  if (!raw || !ADDRESS.test(raw)) throw new HTTPException(400, { message: `${name} is an address.` });
  return raw;
}

async function bodyOf<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: `The request is not one this endpoint takes: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}.` });
  return parsed.data;
}

/** A refusal from the strategy or the chain, as a 422 with the failure decoded. */
const refused = (c: Context<AppEnv>, e: Refused) => c.json<Refusal>({ error: e.failure.sentence, failure: e.failure }, 422);

export function tradingRoutes(app: Hono<AppEnv>) {
  app.get("/v1/fees", (c) => c.json(Fees.parse(feesView(c.env.INTEGRATOR_FEE))));

  app.get("/v1/quote", limitTrades, async (c) => {
    const market = addressOf(c.req.query("market"), "market");
    const trader = c.req.query("trader");
    const rpc = createSolanaRpc(c.env.RPC_URL);
    try {
      const { quote } = await quoteTyped(rpc, c.env.INTEGRATOR_FEE, {
        market: await readTradeMarket(rpc, market),
        inputMint: addressOf(c.req.query("input_mint"), "input_mint"),
        outputMint: addressOf(c.req.query("output_mint"), "output_mint"),
        typed: amountOf(c.req.query("amount")),
        trader: trader ? address(addressOf(trader, "trader")) : null,
      });
      return c.json(Quote.parse(quote));
    } catch (e) {
      if (e instanceof Refused) return refused(c, e);
      throw e;
    }
  });

  app.post("/v1/swaps/prepare", limitTrades, async (c) => {
    const request = await bodyOf(c, PrepareSwapRequest);
    const rpc = createSolanaRpc(c.env.RPC_URL);
    try {
      const prepared = await prepareSwap(rpc, c.env.INTEGRATOR_FEE, {
        market: await readTradeMarket(rpc, request.market),
        inputMint: request.input_mint,
        outputMint: request.output_mint,
        typed: amountOf(request.amount),
        slippageBps: request.slippage_bps,
        trader: address(request.trader),
      });
      return c.json(PreparedSwap.parse(prepared));
    } catch (e) {
      if (e instanceof Refused) return refused(c, e);
      throw e;
    }
  });

  app.post("/v1/trades", limitTrades, async (c) => {
    const { signature, market } = await bodyOf(c, TradeSignature);
    const { db, close } = createDb(c.env.HYPERDRIVE.connectionString);
    try {
      const [known] = market ? await db.select({ strategy: markets.strategyProgram }).from(markets).where(eq(markets.address, market)) : [];
      const raw = await awaitTrade(c.env.RPC_URL, signature, { strategy: known?.strategy ?? null });
      // The indexer writes it with its place in its block and tells the market's room.
      c.executionCtx.waitUntil(indexer(c.env).fastPath([signature]).catch((e: unknown) => console.error(`handing ${signature} to the indexer failed; reconciliation will index it`, e)));
      return c.json(TradeReport.parse({ signature, slot: raw.slot, trades: await tradeViews(db, provisionalTrades(raw)) }));
    } catch (e) {
      if (e instanceof Refused) return refused(c, e);
      throw e;
    } finally {
      c.executionCtx.waitUntil(close());
    }
  });
}
