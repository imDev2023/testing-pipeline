// The lending AMM's endpoints (#88; docs/spec/lending-pool.md, "Aviary's panel"):
//
// - `GET /v1/markets/{market}/lending-amm?wallet=`: the panel, worked out from one read of the chain at
//   one slot (./read), with the largest sells as typed in the trade box, the keeper runner's last
//   `rebalance` on the market, and the viewing wallet's shares with what removing them pays.
// - `GET /v1/markets/{market}/lending-amm/history?before=`: the strategy's events on the market, newest
//   first, from what the indexer stored (./history).
// - `POST /v1/lending-amm/actions/prepare`: one of the strategy's metadata actions, as
//   `POST /v1/actions/prepare` builds it, with klend's `refresh_reserve` first where the program
//   needs a reserve refreshed in the same slot (./actions).
// - `POST /v1/lending-amm/markets/prepare`: the create form's one transaction (./create).
import { address, createSolanaRpc, type Address } from "@solana/kit";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createDb, keeperRunJobs, markets, type Db } from "terminal-db";
import { LENDING_AMM } from "../../config";
import { readFormSource } from "../../forms";
import type { AppEnv } from "../../index";
import { limitTrades } from "../../rateLimits";
import { integratorFee, PIPELINE_RATE_BPS } from "../../trading/fees";
import { Refused } from "../../trading/quote";
import { prepareActionResponse } from "../../trading/actionRoutes";
import { addressOf, bodyOf, refused } from "../../trading/routes";
import { PrepareActionRequest } from "../../contract";
import { readKeeperView, refreshFirst } from "./actions";
import { refreshReserveInstruction } from "keeper-jobs/lending-amm.ts";
import { prepareTransaction } from "../../trading/action";
import { AccountRole, type Instruction } from "@solana/kit";
import { LendingCreateForm, LendingHistory, LendingPanel, PrepareLendingCreate, PreparedLendingCreate, PrepareRefresh, PreparedRefresh } from "./contract";
import { lentMints, prepareLendingCreate } from "./create";
import { MAX_LP_FEE_BPS, MINIMUM_LIQUIDITY } from "lending-amm-scripts/client/index.ts";
import { readLendingHistory } from "./history";
import { LENDING_AMM_PROGRAM, NotLendingMarket, readLending, type LendingRead } from "./read";
import { LP_DECIMALS, typedFor } from "./view";

async function withDb<T>(c: Context<AppEnv>, read: (db: Db) => Promise<T>): Promise<T> {
  const { db, close } = createDb(c.env.HYPERDRIVE.connectionString);
  try {
    return await read(db);
  } finally {
    c.executionCtx.waitUntil(close());
  }
}

/** The market's row, refused unless it is a lending AMM market Aviary has indexed. */
async function lendingMarketRow(db: Db, market: string) {
  const [row] = await db.select({ strategy: markets.strategyProgram, state: markets.marketState, feeMint: markets.feeMint, createdAt: markets.createdAt }).from(markets).where(eq(markets.address, market));
  if (!row) throw new HTTPException(404, { message: "Aviary knows no market created through Pipeline at this address." });
  if (row.strategy !== LENDING_AMM_PROGRAM) throw new HTTPException(404, { message: "This market is not a lending AMM market." });
  return row;
}

const s = (value: bigint) => value.toString();
const n = (value: bigint | null) => (value === null ? null : Number(value));
const opt = (value: bigint | null) => (value === null ? null : value.toString());

export function panelOf(market: string, row: { feeMint: string | null; createdAt: Date }, read: LendingRead, fees: { integratorAccounts: Record<string, string>; integratorBps: number }, keeperLast: LendingPanel["rebalance"]["keeper_last"], wallet: Address | null): LendingPanel {
  const { view } = read;
  const { state } = view;
  // A sale pays out the lent mint: Pipeline's fee comes out of it when it is the market's fee mint, else off the input.
  const onInputBps = row.feeMint === view.lentMint ? 0 : PIPELINE_RATE_BPS;
  const integratorBps = fees.integratorAccounts[view.otherMint] ? fees.integratorBps : 0;
  const typed = (edge: bigint | null, all: boolean) => (edge === null ? null : all ? s(edge) : s(typedFor(edge, { onInputBps, integratorBps })));
  const k = view.kamino;
  return {
    market,
    market_state: view.marketState,
    program: LENDING_AMM_PROGRAM,
    slot: Number(view.slot),
    lent_index: view.lentIndex,
    lent_mint: view.lentMint,
    other_mint: view.otherMint,
    reserve: state.reserve,
    lending_market: view.lendingMarket,
    collateral_mint: state.collateralMint,
    lp_mint: state.lpMint,
    ctoken_account: state.ctokenAccount,
    lock_account: read.lockAccount,
    vaults: [...state.vaults],
    reserve_liquidity_supply: read.reserveLiquiditySupply,
    seeder: state.seeder === "11111111111111111111111111111111" ? null : state.seeder,
    lp_fee_bps: state.lpFeeBps,
    withdraw_mode: state.withdrawMode,
    exit_seen: view.exitSeen ? { slot: Number(view.exitSeen.slot), leave_from: Number(view.exitSeen.leaveFrom) } : null,
    open: view.open,
    buffer: s(view.buffer),
    other_reserve: s(view.otherReserve),
    ctokens: s(state.ctokens),
    lent_value: opt(view.lentValue),
    lent_total: opt(view.lentTotal),
    buffer_share_bps: view.bufferShareBps,
    band: view.band,
    band_bps: view.bandBps,
    kamino: {
      problem: k.problem,
      utilisation_bps: k.utilisationBps,
      free_liquidity: opt(k.freeLiquidity),
      supply_rate_bps: k.supplyRateBps,
      borrow_rate_bps: k.borrowRateBps,
      reserve_emergency: k.reserveEmergency,
      lending_market_emergency: k.lendingMarketEmergency,
      block_ctoken_usage: k.blockCtokenUsage,
      deprecated: k.deprecated,
      redeems_stopped: k.redeemsStopped,
      last_refresh_slot: n(k.lastRefreshSlot),
      refresh_age_slots: n(k.refreshAgeSlots),
      withdrawal_cap_remaining: opt(k.withdrawalCapRemaining),
      can_pay: s(k.canPay),
    },
    sells: {
      refused: view.sells.refused,
      buffer_alone: typed(view.sells.bufferAlone, view.sells.bufferPaysAll),
      buffer_pays_all: view.sells.bufferPaysAll,
      with_kamino: typed(view.sells.withKamino, view.sells.withKaminoPaysAll),
      with_kamino_pays_all: view.sells.withKaminoPaysAll,
      into_market: { buffer_alone: opt(view.sells.bufferAlone), with_kamino: opt(view.sells.withKamino) },
    },
    lp: {
      supply: opt(view.lp.supply),
      share_count: opt(view.lp.shareCount),
      locked: s(view.lp.locked),
      minimum_liquidity: s(view.lp.minimumLiquidity),
      decimals: LP_DECIMALS,
      value_other: opt(view.lp.valueOther),
      value_lent: opt(view.lp.valueLent),
    },
    deposited: s(state.deposited),
    redeemed: s(state.redeemed),
    yield_so_far: opt(view.yieldSoFar),
    rebalance: {
      due: view.rebalance.due,
      deposit: opt(view.rebalance.deposit),
      redeem: opt(view.rebalance.redeem),
      withdraw_mode_after: view.rebalance.withdrawModeAfter,
      refusal: view.rebalance.refusal,
      keeper_last: keeperLast,
    },
    wallet:
      wallet && view.wallet && read.sharesAccount
        ? {
            wallet,
            shares_account: read.sharesAccount,
            shares: s(view.wallet.shares),
            other: s(view.wallet.other),
            buffer_part: s(view.wallet.bufferPart),
            ctoken_part: s(view.wallet.ctokenPart),
            ctoken_value: opt(view.wallet.ctokenValue),
            cash: view.wallet.cash,
            cash_max_shares: s(view.wallet.cashMaxShares),
          }
        : null,
    created_slot: Number(state.createdSlot),
    created_at: row.createdAt.toISOString(),
  };
}

/** An instruction's accounts with their roles in words, as the review lists them. */
const accountsOf = (instruction: Instruction) =>
  (instruction.accounts ?? []).map((a) => ({ address: a.address, writable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER, signer: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER }));

export function lendingAmmRoutes(app: Hono<AppEnv>) {
  app.get("/v1/markets/:market/lending-amm", async (c) => {
    const market = addressOf(c.req.param("market"), "market");
    const walletParam = c.req.query("wallet");
    const wallet = walletParam ? address(addressOf(walletParam, "wallet")) : null;
    const { row, keeperLast } = await withDb(c, async (db) => {
      const found = await lendingMarketRow(db, market);
      const [last] = await db
        .select({ at: keeperRunJobs.at, outcome: keeperRunJobs.outcome, signature: keeperRunJobs.signature })
        .from(keeperRunJobs)
        .where(and(inArray(keeperRunJobs.market, [found.state, market]), eq(keeperRunJobs.job, "rebalance")))
        .orderBy(desc(keeperRunJobs.at))
        .limit(1);
      return { row: found, keeperLast: last ? { at: last.at.toISOString(), outcome: last.outcome, signature: last.signature } : null };
    });
    const fee = integratorFee(c.env.INTEGRATOR_FEE);
    try {
      const read = await readLending(createSolanaRpc(c.env.RPC_URL), address(row.state), wallet);
      return c.json(LendingPanel.parse(panelOf(market, row, read, { integratorAccounts: fee.accounts, integratorBps: fee.bps }, keeperLast, wallet)));
    } catch (e) {
      if (e instanceof NotLendingMarket) throw new HTTPException(422, { message: e.message });
      throw e;
    }
  });

  app.get("/v1/markets/:market/lending-amm/history", async (c) => {
    const market = addressOf(c.req.param("market"), "market");
    const before = c.req.query("before") ?? null;
    if (before !== null && !/^\d+:\d+:\d+$/.test(before)) throw new HTTPException(400, { message: "before is a cursor this endpoint gave." });
    const history = await withDb(c, async (db) => {
      const row = await lendingMarketRow(db, market);
      return readLendingHistory(db, { market, marketState: row.state, before, limit: LENDING_AMM.historyPage });
    });
    return c.json(LendingHistory.parse(history));
  });

  // The lending AMM's own forms: the strategy's metadata actions, with klend's refresh first where the program needs it (./actions).
  app.post("/v1/lending-amm/actions/prepare", limitTrades, async (c) => prepareActionResponse(c, await bodyOf(c, PrepareActionRequest), { before: refreshFirst, strategyIs: LENDING_AMM_PROGRAM }));

  // klend's own refresh of the market's reserve, which anyone may send, for a reserve too stale to trade on.
  app.post("/v1/lending-amm/refresh/prepare", limitTrades, async (c) => {
    const request = await bodyOf(c, PrepareRefresh);
    addressOf(request.market, "market");
    addressOf(request.trader, "trader");
    const row = await withDb(c, (db) => lendingMarketRow(db, request.market));
    const rpc = createSolanaRpc(c.env.RPC_URL);
    const reading = await readKeeperView(rpc, address(row.state));
    if (!reading?.kamino || reading.lendingMarket === null) throw new HTTPException(422, { message: "Kamino's reserve or its lending market could not be read as the program reads them, so Aviary prepares no refresh." });
    const refresh = refreshReserveInstruction(reading.reserve, reading.lendingMarket, reading.kamino.reserve);
    try {
      const prepared = await prepareTransaction(rpc, { instructions: [refresh], trader: address(request.trader), strategy: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD", market: null, what: "This refresh" });
      return c.json(PreparedRefresh.parse({ market: request.market, accounts: accountsOf(refresh), wrapped_sol: "0", ...prepared }));
    } catch (e) {
      if (e instanceof Refused) return refused(c, e);
      throw e;
    }
  });

  // What the create form is pre-filled with (LENDING-104) and the mints it may lend, so the page writes none of them.
  app.get("/v1/lending-amm/create", async (c) => {
    const mints = await lentMints(createSolanaRpc(c.env.RPC_URL));
    return c.json(
      LendingCreateForm.parse({
        program: LENDING_AMM_PROGRAM,
        lp_fee_bps: LENDING_AMM.create.lpFeeBps,
        max_lp_fee_bps: MAX_LP_FEE_BPS,
        lent_index: LENDING_AMM.create.lentIndex,
        lent_mints: mints.map((m) => ({ mint: m.mint, decimals: m.decimals, reserve: m.reserve, collateral_mint: m.collateralMint })),
        minimum_liquidity: String(MINIMUM_LIQUIDITY),
      }),
    );
  });

  app.post("/v1/lending-amm/markets/prepare", limitTrades, async (c) => {
    const request = await bodyOf(c, PrepareLendingCreate);
    for (const name of ["trader", "other_mint", "lent_mint"] as const) addressOf(request[name], name);
    const source = await withDb(c, (db) => readFormSource(db, LENDING_AMM_PROGRAM));
    const addLiquidity = source?.actions?.result.ok ? source.actions.result.actions.find((a) => a.name === "add_liquidity") : undefined;
    if (!source?.init || !addLiquidity) throw new HTTPException(422, { message: "The lending AMM's create form is built from its metadata, which Aviary has not read with a create form and add_liquidity yet." });
    try {
      const prepared = await prepareLendingCreate(createSolanaRpc(c.env.RPC_URL), { init: source.init, addLiquidity }, request);
      return c.json(PreparedLendingCreate.parse(prepared));
    } catch (e) {
      if (e instanceof Refused) return refused(c, e);
      throw e;
    }
  });
}
