// The wallet page's endpoints (docs/spec/pipescope-screens.md, Wallet page; docs/spec/pipescope-architecture.md,
// API: a wallet's balances "read through RPC"; #122). A wallet's swaps are the feed's trader page
// (./feed); here are what it holds, its wrapped SOL unwrapped, and a signature waited on.
//
// - Holdings: the wallet's SOL and every token account it owns under both token programs, read through
//   RPC; each token a Pipeline market trades is listed with those markets, from Postgres, and the rest
//   are only counted. Wrapped SOL is not listed with them: the page offers to unwrap it (PIPESCOPE-137).
// - Unwrap: the wrapped-SOL accounts the wallet owns closed into it, as many as one transaction the
//   wallet pays for holds, simulated exactly as it is returned, as a swap is (docs/spec/pipescope-architecture.md,
//   Simulation before every signature); the wallet signs it, and nothing here signs anything.
// - Confirmations: the page posts the signature its wallet sent, and the API waits on it as the fast path does.
import { NATIVE_MINT_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { getCloseAccountInstruction } from "@solana-program/token";
import { address, createNoopSigner, createSolanaRpc, getBase64Decoder, isAddress, type Address, type Rpc, type SolanaRpcApi, type TransactionMessageBytesBase64 } from "@solana/kit";
import { desc, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { marketMints, markets } from "terminal-db";
import type { z } from "zod";
import { Confirmation, ConfirmationRequest, Holdings, PreparedUnwrap, PrepareUnwrapRequest, type Refusal } from "./contract";
import { marketPair } from "./pairs";
import { limitTrades } from "./rateLimits";
import { dbOf, requestDb, type DbEnv } from "./requestDb";
import { decodeFailure } from "./trading/failure";
import { awaitConfirmation } from "./trading/fastPath";
import { fitTransaction, TooLarge } from "./trading/prepare";
import { COMMITMENT, Refused } from "./trading/quote";
import { mintNames } from "./views";

export const walletRoutes = new Hono<DbEnv>();
walletRoutes.use("/v1/traders/:trader/holdings", requestDb);

const traderOf = (raw: string | undefined): Address => {
  if (!raw || !isAddress(raw)) throw new HTTPException(400, { message: "trader is an address." });
  return address(raw);
};

async function bodyOf<T extends z.ZodType>(c: Context<DbEnv>, schema: T): Promise<z.infer<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new HTTPException(400, { message: `The request is not one this endpoint takes: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ")}.` });
  return parsed.data;
}

const refused = (c: Context<DbEnv>, e: Refused) => c.json<Refusal>({ error: e.failure.sentence, failure: e.failure, logs: [...e.logs] }, 422);

type Owned = { account: Address; mint: Address; amount: bigint; decimals: number; lamports: bigint };

type ParsedTokenAccount = { pubkey: Address; account: { lamports: bigint; data: { parsed: { info: { mint: Address; tokenAmount: { amount: string; decimals: number } } } } } };

/** Every token account `owner` holds, by `filter` (a token program, or one mint), as the RPC parses them. */
async function tokenAccounts(rpc: Rpc<SolanaRpcApi>, owner: Address, filter: { programId: Address } | { mint: Address }): Promise<Owned[]> {
  const { value } = await rpc.getTokenAccountsByOwner(owner, filter, { encoding: "jsonParsed", commitment: COMMITMENT }).send();
  return (value as unknown as ParsedTokenAccount[]).map(({ pubkey, account }) => ({
    account: pubkey,
    mint: account.data.parsed.info.mint,
    amount: BigInt(account.data.parsed.info.tokenAmount.amount),
    decimals: account.data.parsed.info.tokenAmount.decimals,
    lamports: BigInt(account.lamports),
  }));
}

walletRoutes.get("/v1/traders/:trader/holdings", async (c) => {
  const trader = traderOf(c.req.param("trader"));
  const rpc = createSolanaRpc(c.env.RPC_URL);
  const [{ value: sol }, classic, extended] = await Promise.all([
    rpc.getBalance(trader, { commitment: COMMITMENT }).send(),
    tokenAccounts(rpc, trader, { programId: TOKEN_PROGRAM_ADDRESS }),
    tokenAccounts(rpc, trader, { programId: TOKEN_2022_PROGRAM_ADDRESS }),
  ]);
  const owned = [...classic, ...extended];
  const wrapped = owned.filter((o) => o.mint === NATIVE_MINT_ADDRESS);
  const wrappedAmount = wrapped.reduce((n, o) => n + o.amount, 0n);

  // What the wallet holds of each other token: its accounts' amounts summed, tokens it holds none of left out.
  const held = new Map<Address, { amount: bigint; decimals: number }>();
  for (const o of owned) {
    if (o.mint === NATIVE_MINT_ADDRESS || o.amount === 0n) continue;
    held.set(o.mint, { amount: (held.get(o.mint)?.amount ?? 0n) + o.amount, decimals: o.decimals });
  }

  const db = dbOf(c);
  const trading = held.size
    ? await db
        .select({ mint: marketMints.mint, market: marketMints.market })
        .from(marketMints)
        .innerJoin(markets, eq(markets.address, marketMints.market))
        .where(inArray(marketMints.mint, [...held.keys()]))
        .orderBy(desc(markets.createdAt), marketMints.market)
    : [];
  const marketAddresses = [...new Set(trading.map((t) => t.market))];
  const marketMintRows = marketAddresses.length
    ? await db.select({ market: marketMints.market, mint: marketMints.mint }).from(marketMints).where(inArray(marketMints.market, marketAddresses)).orderBy(marketMints.market, marketMints.position)
    : [];
  const pairs = marketAddresses.map((market) => {
    const { base, quote } = marketPair(marketMintRows.filter((r) => r.market === market).map((r) => r.mint));
    return { address: market, base_mint: base, quote_mint: quote };
  });
  const names = await mintNames(db, [...trading.map((t) => t.mint), ...pairs.flatMap((p) => [p.base_mint, p.quote_mint])]);
  const nameOf = (mint: string) => names.find((n) => n.mint === mint)!;
  const shown = (mint: string) => {
    const n = nameOf(mint);
    return (n.symbol ?? n.token?.symbol ?? n.token?.name ?? mint).toLowerCase();
  };
  const listed = [...new Set(trading.map((t) => t.mint as Address))].sort((a, b) => shown(a).localeCompare(shown(b)) || a.localeCompare(b));

  return c.json(
    Holdings.parse({
      trader,
      sol: String(sol),
      // Empty wrapped-SOL accounts are offered too: closing them gives back their rent.
      wrapped_sol: wrapped.length ? { amount: String(wrappedAmount), accounts: wrapped.map((o) => o.account) } : null,
      holdings: listed.map((mint) => ({ ...nameOf(mint), decimals: held.get(mint)!.decimals, amount: String(held.get(mint)!.amount), markets: trading.filter((t) => t.mint === mint).map((t) => t.market) })),
      markets: pairs,
      mints: names,
      not_listed: held.size - listed.length,
    }),
  );
});

/**
 * Closes the wrapped-SOL accounts `trader` owns into it, as many as one transaction it pays for holds
 * (the rest are `left` for another), and simulates exactly that transaction.
 */
export async function prepareUnwrap(rpc: Rpc<SolanaRpcApi>, trader: Address): Promise<PreparedUnwrap> {
  const owned = await tokenAccounts(rpc, trader, { mint: NATIVE_MINT_ADDRESS });
  if (!owned.length) throw new HTTPException(404, { message: "This wallet holds no wrapped SOL to unwrap." });
  const signer = createNoopSigner(trader);
  const { value: lifetime } = await rpc.getLatestBlockhash({ commitment: COMMITMENT }).send();
  // The most accounts one transaction closes: one fewer each time it does not fit.
  let wrapped = owned;
  let fitted: ReturnType<typeof fitTransaction> | null = null;
  while (!fitted && wrapped.length) {
    try {
      fitted = fitTransaction(wrapped.map((o) => getCloseAccountInstruction({ account: o.account, destination: trader, owner: signer })), trader, lifetime, null);
    } catch (e) {
      if (!(e instanceof TooLarge)) throw e;
      wrapped = wrapped.slice(0, -1);
    }
  }
  if (!fitted) throw new Refused({ class: "too_large", sentence: "Not even one wrapped-SOL account can be closed in a transaction.", name: null, number: null, message: null, program: null, raw: "too large" });
  const { wire, messageBytes } = fitted;
  let answers;
  try {
    answers = await Promise.all([
      rpc.simulateTransaction(wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: COMMITMENT, accounts: { addresses: [trader, ...wrapped.map((o) => o.account)], encoding: "base64" } }).send(),
      rpc.getFeeForMessage(getBase64Decoder().decode(messageBytes) as TransactionMessageBytesBase64, { commitment: COMMITMENT }).send(),
    ]);
  } catch (e) {
    const raw = (e instanceof Error ? e.message : String(e)).replace(/https?:\/\/\S+/g, "the RPC");
    throw new Refused({ class: "unavailable", sentence: "The unwrap could not be simulated, so there is nothing to sign. Try again in a moment.", name: null, number: null, message: null, program: null, raw });
  }
  const [{ value }, fee] = answers;
  const logs = [...(value.logs ?? [])];
  const ok = value.err === null;
  return {
    trader,
    accounts: wrapped.map((o) => o.account),
    wrapped: String(wrapped.reduce((n, o) => n + o.amount, 0n)),
    left: owned.length - wrapped.length,
    transaction: ok ? wire : null,
    simulation: {
      ok,
      failure: ok ? null : decodeFailure(value.err, logs, { strategy: "", act: "transaction" }),
      logs,
      compute_units: value.unitsConsumed === undefined ? null : Number(value.unitsConsumed),
      network_fee: String(fee.value ?? 0n),
      // Closing an account hands its every lamport to the wallet: the wrapped SOL and its rent.
      returned: ok ? String(wrapped.reduce((n, o) => n + o.lamports, 0n)) : null,
    },
  };
}

walletRoutes.post("/v1/unwrap/prepare", limitTrades, async (c) => {
  const { trader } = await bodyOf(c, PrepareUnwrapRequest);
  try {
    return c.json(PreparedUnwrap.parse(await prepareUnwrap(createSolanaRpc(c.env.RPC_URL), address(trader))));
  } catch (e) {
    if (e instanceof Refused) return refused(c, e);
    throw e;
  }
});

walletRoutes.post("/v1/confirmations", limitTrades, async (c) => {
  const { signature } = await bodyOf(c, ConfirmationRequest);
  try {
    return c.json(Confirmation.parse(await awaitConfirmation(c.env.RPC_URL, signature)));
  } catch (e) {
    if (e instanceof Refused) return refused(c, e);
    throw e;
  }
});
