// The trading path's endpoints (docs/spec/pipescope-architecture.md, Trading path): the fees, a
// quote while the trader types, a swap prepared and simulated, and a trade's signature (the fast
// path). Quotes, prepares and signatures count together against the TRADES limit (PIPESCOPE-90).
import { address, createSolanaRpc, isAddress } from "@solana/kit";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDb, markets } from "terminal-db";
import type { z } from "zod";
import { Balances, Fees, PrepareSwapRequest, PreparedSwap, Quote, TradeReport, TradeSignature, type Refusal } from "../contract";
import type { AppEnv } from "../index";
import { indexer } from "../index";
import { limitTrades } from "../rateLimits";
import { tradeViews } from "../views";
import { parseMints, readBalances } from "./balances";
import { awaitTrade, provisionalTrades } from "./fastPath";
import { feesView } from "./fees";
import { readTradeMarket } from "./market";
import { prepareSwap } from "./prepare";
import { quoteTyped, Refused } from "./quote";

const AMOUNT = /^\d{1,20}$/;
const U64_MAX = (1n << 64n) - 1n;

/** The amount typed, a whole number of base units that a u64 holds and is not zero. */
function amountOf(raw: string | undefined): bigint {
  if (!raw || !AMOUNT.test(raw) || BigInt(raw) === 0n || BigInt(raw) > U64_MAX) throw new HTTPException(400, { message: "amount is a whole number of the input mint's smallest units, above 0." });
  return BigInt(raw);
}

/** A query parameter or body field that must be an address: 32 bytes in base58, which Kit checks. */
function addressOf(raw: string | undefined, name: string): string {
  if (!raw || !isAddress(raw)) throw new HTTPException(400, { message: `${name} is an address.` });
  return raw;
}

async function bodyOf<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: `The request is not one this endpoint takes: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}.` });
  return parsed.data;
}

/** A refusal from the strategy or the chain, as a 422 with the failure decoded. */
const refused = (c: Context<AppEnv>, e: Refused) => c.json<Refusal>({ error: e.failure.sentence, failure: e.failure, logs: [...e.logs] }, 422);

export function tradingRoutes(app: Hono<AppEnv>) {
  app.get("/v1/fees", (c) => c.json(Fees.parse(feesView(c.env.INTEGRATOR_FEE))));

  app.get("/v1/traders/:trader/balances", async (c) => {
    const trader = address(addressOf(c.req.param("trader"), "trader"));
    const mints = parseMints(c.req.query("mints"));
    if (!mints) throw new HTTPException(400, { message: "mints is a comma-separated list of one to four mint addresses." });
    return c.json(Balances.parse(await readBalances(createSolanaRpc(c.env.RPC_URL), trader, mints)));
  });

  app.get("/v1/quote", limitTrades, async (c) => {
    // Every parameter is checked before the RPC is asked anything.
    const market = addressOf(c.req.query("market"), "market");
    const inputMint = addressOf(c.req.query("input_mint"), "input_mint");
    const outputMint = addressOf(c.req.query("output_mint"), "output_mint");
    const typed = amountOf(c.req.query("amount"));
    const traderQuery = c.req.query("trader");
    const trader = traderQuery ? address(addressOf(traderQuery, "trader")) : null;
    const rpc = createSolanaRpc(c.env.RPC_URL);
    try {
      const { quote } = await quoteTyped(rpc, c.env.INTEGRATOR_FEE, { market: await readTradeMarket(rpc, market), inputMint, outputMint, typed, trader });
      return c.json(Quote.parse(quote));
    } catch (e) {
      if (e instanceof Refused) return refused(c, e);
      throw e;
    }
  });

  app.post("/v1/swaps/prepare", limitTrades, async (c) => {
    const request = await bodyOf(c, PrepareSwapRequest);
    for (const [name, value] of [["market", request.market], ["input_mint", request.input_mint], ["output_mint", request.output_mint], ["trader", request.trader]] as const) addressOf(value, name);
    const typed = amountOf(request.amount);
    const rpc = createSolanaRpc(c.env.RPC_URL);
    try {
      const prepared = await prepareSwap(rpc, c.env.INTEGRATOR_FEE, {
        market: await readTradeMarket(rpc, request.market),
        inputMint: request.input_mint,
        outputMint: request.output_mint,
        typed,
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
    // The database is opened only around its reads, never held while the chain is waited on.
    const withDb = async <T>(read: (db: ReturnType<typeof createDb>["db"]) => Promise<T>): Promise<T> => {
      const { db, close } = createDb(c.env.HYPERDRIVE.connectionString);
      try {
        return await read(db);
      } finally {
        c.executionCtx.waitUntil(close());
      }
    };
    try {
      const [known] = market ? await withDb((db) => db.select({ strategy: markets.strategyProgram }).from(markets).where(eq(markets.address, market))) : [];
      const raw = await awaitTrade(c.env.RPC_URL, signature, { strategy: known?.strategy ?? null });
      // The indexer writes it with its place in its block and tells the market's room.
      c.executionCtx.waitUntil(indexer(c.env).fastPath([signature]).catch((e: unknown) => console.error(`handing ${signature} to the indexer failed; reconciliation will index it`, e)));
      return c.json(TradeReport.parse({ signature, slot: raw.slot, trades: await withDb((db) => tradeViews(db, provisionalTrades(raw))) }));
    } catch (e) {
      if (e instanceof Refused) return refused(c, e);
      throw e;
    }
  });
}
