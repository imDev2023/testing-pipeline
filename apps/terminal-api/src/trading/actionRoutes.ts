// The endpoints of the forms and the products' panels (docs/spec/pipescope-architecture.md, API and
// Trading path; #123): a custom action and a new market, each prepared and simulated as a swap is;
// their signatures waited on until they confirm; a mint typed into a create form, read for its facts;
// and a market's state with named outside accounts read at one slot, for a product's panel. Prepares
// and signatures count with quotes against the TRADES limit (PIPESCOPE-90); the reads are reads.
import { PIPELINE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { AccountRole, address, createSolanaRpc, isAddress, type Address, type Instruction } from "@solana/kit";
import type { AviaryAction } from "strategy-actions";
import { eq } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDb, markets, type Db } from "terminal-db";
import { readMintRows } from "terminal-indexer";
import { CREATE_MARKET_MAX_CREATOR_LAMPORTS, MARKET_READ } from "../config";
import { MarketRead, MintFacts, PrepareActionRequest, PreparedAction, PreparedMarket, PrepareMarketRequest, TransactionReport, TransactionSignature } from "../contract";
import { mintFactOf } from "../facts";
import { actionDiscriminator, checkForm, initDiscriminator, readFormSource } from "../forms";
import type { AppEnv } from "../index";
import { indexer } from "../index";
import { limitTrades } from "../rateLimits";
import { keptImages } from "../tokenImages";
import { actionTransaction, createMarketTransaction, prepareTransaction, walletWrappedSol } from "./action";
import { awaitTrade, TRANSACTION_WORDS } from "./fastPath";
import { actionHookAccounts } from "./hooks";
import { readMarketOnChain } from "./market";
import { Refused } from "./quote";
import { addressOf, bodyOf, refused } from "./routes";

/** The database, opened only around its reads and never held while the chain is asked or waited on. */
async function withDb<T>(c: Context<AppEnv>, read: (db: Db) => Promise<T>): Promise<T> {
  const { db, close } = createDb(c.env.HYPERDRIVE.connectionString);
  try {
    return await read(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

/** Every address a form was filled with, checked before the chain is asked anything. */
function checkedInputs(inputs: Record<string, string>): Record<string, Address> {
  for (const [name, value] of Object.entries(inputs)) if (!isAddress(value)) throw new HTTPException(400, { message: `inputs.${name} is an address.` });
  return inputs as Record<string, Address>;
}

/** An instruction's accounts with their roles in words, as the review lists them. */
const accountsOf = (instruction: Instruction) =>
  (instruction.accounts ?? []).map((a) => ({
    address: a.address,
    writable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
    signer: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
  }));

const unprocessable = (message: string) => new HTTPException(422, { message });

/**
 * What `before` adds ahead of an action in its transaction, given the market read on chain, such as
 * klend's `refresh_reserve` ahead of a lending AMM deposit (#88); none for any other strategy.
 */
export type BeforeAction = (input: { rpc: ReturnType<typeof createSolanaRpc>; market: Awaited<ReturnType<typeof readMarketOnChain>>; action: AviaryAction }) => Promise<Instruction[]>;

/**
 * A custom action of a market's strategy, from its metadata, built, simulated and answered as
 * `POST /v1/actions/prepare` answers it; a product's own endpoint passes `before` (./products).
 */
export async function prepareActionResponse(c: Context<AppEnv>, request: PrepareActionRequest, { before, strategyIs }: { before?: BeforeAction; strategyIs?: string } = {}) {
  for (const [name, value] of [["market", request.market], ["trader", request.trader]] as const) addressOf(value, name);
  const inputs = checkedInputs(request.inputs);
  const { strategy, source } = await withDb(c, async (db) => {
    const [row] = await db.select({ strategy: markets.strategyProgram }).from(markets).where(eq(markets.address, request.market));
    if (!row) throw new HTTPException(404, { message: "Aviary knows no market created through Pipeline at this address." });
    if (strategyIs && row.strategy !== strategyIs) throw new HTTPException(404, { message: "This market is not one of this product's markets." });
    return { strategy: row.strategy, source: await readFormSource(db, row.strategy) };
  });
  if (!source?.actions) throw unprocessable("This market's strategy has no forms: its metadata is unavailable.");
  if (!source.actions.result.ok) throw unprocessable("This market's strategy has no action forms: the actions its metadata describes failed their validator.");
  const action = source.actions.result.actions.find((a) => a.name === request.action);
  if (!action) throw new HTTPException(404, { message: `This market's strategy describes no action named ${request.action} in its metadata.` });

  const rpc = createSolanaRpc(c.env.RPC_URL);
  try {
    const market = await readMarketOnChain(rpc, request.market);
    if (market.view.strategyProgram !== strategy) throw unprocessable("This market's strategy on chain is not the one Aviary recorded for it.");
    const trader = address(request.trader);
    const tokenPrograms = Object.fromEntries(market.mints.map((m) => [m.address, m.tokenProgram]));
    const built = await actionTransaction({ action, market: market.view, trader, args: request.args, inputs, tokenPrograms, rpc, walletWrappedSol: await walletWrappedSol(rpc, trader) });
    // A hooked mint's transfers carry its hook's accounts, after the action's own (PIPESCOPE-154).
    const hooks = await actionHookAccounts(rpc, { market, trader, action: built.action });
    const instruction = hooks.length ? { ...built.action, accounts: [...(built.action.accounts ?? []), ...hooks] } : built.action;
    const instructions = [...(before ? await before({ rpc, market, action }) : []), ...built.instructions.map((i) => (i === built.action ? instruction : i))];
    const hookPrograms = market.mints.flatMap((m) => (m.transferHook ? [m.transferHook] : []));
    const prepared = await prepareTransaction(rpc, { instructions, trader, strategy, market: market.address, what: "This action", hooks: hookPrograms });
    return c.json(
      PreparedAction.parse({
        market: request.market,
        action: action.name,
        check: checkForm(await actionDiscriminator(action), source.list),
        accounts: accountsOf(instruction),
        wrapped_sol: String(built.wrapped),
        ...prepared,
      }),
    );
  } catch (e) {
    if (e instanceof Refused) return refused(c, e);
    throw e;
  }
}

export function actionRoutes(app: Hono<AppEnv>) {
  app.post("/v1/actions/prepare", limitTrades, async (c) => prepareActionResponse(c, await bodyOf(c, PrepareActionRequest)));

  app.post("/v1/markets/prepare", limitTrades, async (c) => {
    const request = await bodyOf(c, PrepareMarketRequest);
    for (const [name, value] of [["strategy", request.strategy], ["trader", request.trader]] as const) addressOf(value, name);
    if (request.market_state !== undefined) addressOf(request.market_state, "market_state");
    const inputs = checkedInputs(request.inputs);
    const source = await withDb(c, (db) => readFormSource(db, request.strategy));
    if (!source) throw new HTTPException(404, { message: "Aviary knows no strategy registered with Pipeline at this address." });
    if (!source.document) throw unprocessable("This strategy has no create form: its metadata is unavailable.");
    if (!source.init) throw unprocessable("This strategy has no create form: its metadata describes none.");

    const rpc = createSolanaRpc(c.env.RPC_URL);
    try {
      const trader = address(request.trader);
      const strategy = address(request.strategy);
      const built = await createMarketTransaction({
        init: source.init,
        strategy,
        trader,
        marketState: request.market_state ? address(request.market_state) : undefined,
        args: request.args,
        inputs,
        rpc,
        walletWrappedSol: await walletWrappedSol(rpc, trader),
        maxCreatorLamports: CREATE_MARKET_MAX_CREATOR_LAMPORTS,
      });
      const prepared = await prepareTransaction(rpc, { instructions: built.instructions, trader, strategy, market: null, what: "Creating this market" });
      const create = built.instructions.find((i) => i.programAddress === PIPELINE_PROGRAM_ADDRESS)!;
      return c.json(
        PreparedMarket.parse({
          strategy,
          market: built.market,
          market_state: built.marketState,
          market_state_signs: built.marketStateSigns,
          check: checkForm(await initDiscriminator(), source.list),
          accounts: accountsOf(create),
          wrapped_sol: String(built.wrapped),
          max_creator_lamports: String(CREATE_MARKET_MAX_CREATOR_LAMPORTS),
          ...prepared,
        }),
      );
    } catch (e) {
      if (e instanceof Refused) return refused(c, e);
      throw e;
    }
  });

  app.post("/v1/transactions", limitTrades, async (c) => {
    const { signature, market, strategy } = await bodyOf(c, TransactionSignature);
    try {
      // A failure is decoded against the market's strategy as Aviary recorded it, as the trade fast path does; a new market, which no row names yet, against the strategy the page made it from.
      const [known] = market ? await withDb(c, (db) => db.select({ strategy: markets.strategyProgram }).from(markets).where(eq(markets.address, market))) : [];
      const raw = await awaitTrade(c.env.RPC_URL, signature, { strategy: known?.strategy ?? strategy ?? null, words: TRANSACTION_WORDS });
      // The indexer reads it as the live socket's are, so a new market is listed without waiting for reconciliation.
      c.executionCtx.waitUntil(indexer(c.env).fastPath([signature]).catch((e: unknown) => console.error(`handing ${signature} to the indexer failed; reconciliation will index it`, e)));
      return c.json(TransactionReport.parse({ signature, slot: raw.slot }));
    } catch (e) {
      if (e instanceof Refused) return refused(c, e);
      throw e;
    }
  });

  app.get("/v1/mints/:mint", async (c) => {
    const mint = addressOf(c.req.param("mint"), "mint");
    const [row] = await readMintRows(c.env.RPC_URL, [mint]);
    const images = await withDb(c, (db) => keptImages(db, [row?.tokenUri ?? null]));
    return c.json(MintFacts.parse(mintFactOf(mint, row ?? null, images, null)));
  });

  app.get("/v1/markets/:market/state", async (c) => {
    const market = addressOf(c.req.param("market"), "market");
    const named = (c.req.query("accounts") ?? "").split(",").filter(Boolean);
    if (named.length > MARKET_READ.maxAccounts) throw new HTTPException(400, { message: `accounts names at most ${MARKET_READ.maxAccounts} accounts besides the market's state.` });
    named.forEach((a, i) => addressOf(a, `accounts[${i}]`));
    const [row] = await withDb(c, (db) => db.select({ state: markets.marketState }).from(markets).where(eq(markets.address, market)));
    if (!row) throw new HTTPException(404, { message: "Aviary knows no market created through Pipeline at this address." });
    const wanted = [row.state, ...named].map((a) => address(a));
    // No more of an account is downloaded than the read can return: its first bytes past the cap say it is too large, and its size comes from the RPC.
    const { context, value } = await createSolanaRpc(c.env.RPC_URL)
      .getMultipleAccounts(wanted, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: MARKET_READ.maxAccountBytes + 1 } })
      .send();
    const accounts = value.map((account, i) => {
      const base = { address: wanted[i]!, role: i === 0 ? ("market_state" as const) : ("named" as const) };
      if (!account) return { ...base, exists: false, owner: null, lamports: null, executable: null, size: null, data: null };
      const size = Number(account.space);
      return { ...base, exists: true, owner: account.owner, lamports: String(account.lamports), executable: account.executable, size, data: size > MARKET_READ.maxAccountBytes ? null : account.data[0] };
    });
    return c.json(MarketRead.parse({ market, slot: Number(context.slot), accounts }));
  });
}
