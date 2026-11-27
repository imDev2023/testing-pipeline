// The containment hook's endpoints (docs/spec/containment-hook.md, "In Aviary"; #76): a home market's
// containment read at one slot, for the panel and the trade box, and `unlock` prepared and simulated
// for the wallet that sends it, as every transaction Aviary builds is.
import { AccountRole, address, createSolanaRpc, type Instruction } from "@solana/kit";
import { CONTAINMENT_HOOK_PROGRAM_ADDRESS } from "containment-hook-scripts/client/index.ts";
import { TAX_AMM_PROGRAM_ADDRESS } from "tax-amm-scripts/client/index.ts";
import { asc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDb, marketMints, markets, mints } from "terminal-db";
import { rereadMints } from "terminal-indexer";
import type { AppEnv } from "../../index";
import { limitTrades } from "../../rateLimits";
import { prepareTransaction } from "../../trading/action";
import { Refused } from "../../trading/quote";
import { addressOf, bodyOf, refused } from "../../trading/routes";
import { MarketContainment, PreparedUnlock, PrepareUnlockRequest } from "./contract";
import { readContainment } from "./read";
import { unlockOf } from "./unlock";

/** An instruction's accounts with their roles in words, as the review lists them. */
const accountsOf = (instruction: Instruction) =>
  (instruction.accounts ?? []).map((a) => ({
    address: a.address,
    writable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
    signer: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
  }));

/** The hook's two trust flags, which an unlock clears (docs/spec/containment-hook.md, "In Aviary"). */
const HOOK_FLAGS = ["transfer-hook", "transfer-hook-authority"];

/**
 * Reads again, before answering, each unlocked mint whose stored trust flags still name its hook, so
 * the facts panel drops both flags as soon as the panel has seen the unlock rather than at the next
 * hourly read of every mint.
 */
async function refreshUnlockedMints(env: AppEnv["Bindings"], unlocked: string[]) {
  if (!unlocked.length) return;
  const { db, close } = createDb(env.HYPERDRIVE.connectionString);
  try {
    const stale = (await db.select({ address: mints.address, flags: mints.flags }).from(mints).where(inArray(mints.address, unlocked))).filter((m) => m.flags?.some((f) => HOOK_FLAGS.includes(f)));
    if (stale.length) await rereadMints(db, env.RPC_URL, stale.map((m) => m.address));
  } finally {
    await close();
  }
}

export function containmentRoutes(app: Hono<AppEnv>) {
  app.post("/v1/containment/unlock/prepare", limitTrades, async (c) => {
    const request = await bodyOf(c, PrepareUnlockRequest);
    const mint = addressOf(request.mint, "mint");
    const trader = address(addressOf(request.trader, "trader"));
    const rpc = createSolanaRpc(c.env.RPC_URL);
    try {
      const { instruction, market } = await unlockOf(rpc, mint);
      // A refusal is the hook's, which the failure names as the token's transfer hook (CONTAINMENT_HOOK_PROGRAM_ADDRESS).
      const prepared = await prepareTransaction(rpc, { instructions: [instruction], trader, strategy: TAX_AMM_PROGRAM_ADDRESS, market: null, what: "This unlock", hooks: [CONTAINMENT_HOOK_PROGRAM_ADDRESS] });
      return c.json(PreparedUnlock.parse({ mint, market, accounts: accountsOf(instruction), wrapped_sol: "0", ...prepared }));
    } catch (e) {
      if (e instanceof Refused) return refused(c, e);
      throw e;
    }
  });

  app.get("/v1/markets/:market/containment", async (c) => {
    const market = addressOf(c.req.param("market"), "market");
    const { db, close } = createDb(c.env.HYPERDRIVE.connectionString);
    const home = await (async () => {
      try {
        const [row] = await db.select({ strategy: markets.strategyProgram, marketState: markets.marketState, createdBy: markets.createdBy }).from(markets).where(eq(markets.address, market));
        if (!row) return null;
        const held = await db.select({ mint: marketMints.mint }).from(marketMints).where(eq(marketMints.market, market)).orderBy(asc(marketMints.position));
        return { address: market, ...row, mints: held.map((m) => m.mint) };
      } finally {
        c.executionCtx.waitUntil(close());
      }
    })();
    if (!home) throw new HTTPException(404, { message: "Aviary knows no market created through Pipeline at this address." });
    const read = await readContainment(createSolanaRpc(c.env.RPC_URL), home);
    // Awaited, so the facts panel reads the refreshed flags once this answers (HOOK-56), but never the
    // panel's failure: the containment was read, and the next read tries the refresh again.
    await refreshUnlockedMints(c.env, read.contained.filter((m) => m.status === "unlocked").map((m) => m.mint)).catch((e: unknown) =>
      console.error("containment: refreshing an unlocked mint's stored facts failed; the next read tries again", e instanceof Error ? e.name : typeof e),
    );
    return c.json(MarketContainment.parse(read));
  });
}
