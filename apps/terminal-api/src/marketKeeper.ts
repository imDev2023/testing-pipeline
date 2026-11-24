// A product panel's due keeper jobs (docs/spec/keeper-runner.md, How Aviary shows it; #57):
// `GET /v1/markets/{market}/keeper` reads a market of one of our strategies and asks the due rules
// the keeper runner itself uses (`packages/keeper-jobs`, "One definition of due") what is due, so a
// panel shows a job's button exactly when the runner would send it; each with the runner's last
// attempt from `keeper_run_jobs`. The market's state and any account its product's rules watch
// (the lending AMM's Kamino reserve and the clock) are read in one request, at one slot. A database
// that does not answer leaves the due jobs standing.
import { address, createSolanaRpc, type Address } from "@solana/kit";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { products, type AnyKeeperProduct } from "keeper-jobs";
import { createDb, markets, readKeeperUnits, type KeeperUnitRead } from "terminal-db";
import { KEEPER_MARKET_RECORDS } from "./config";
import { MarketKeeper } from "./contract";
import type { AppEnv } from "./index";
import { addressOf } from "./trading/routes";

/** Outcomes that mean the runner's transaction landed, whatever the job then did. */
const LANDED = new Set(["sent", "nothing-to-do"]);

/** The runner's last attempt at a unit, and since when it has seen it due without landing it. */
function attemptsOf(unit: KeeperUnitRead | undefined): Pick<MarketKeeper["due"][number], "last" | "due_since"> {
  const latest = unit?.rows[0];
  if (!latest) return { last: null, due_since: null };
  const sinceLanded = unit.rows.findIndex((r) => LANDED.has(r.outcome));
  const waiting = sinceLanded === -1 ? unit.rows : unit.rows.slice(0, sinceLanded);
  return {
    last: { at: latest.at.toISOString(), outcome: latest.outcome, signature: latest.signature, error: latest.error, cap: latest.cap },
    due_since: waiting.length ? waiting.at(-1)!.at.toISOString() : null,
  };
}

const dataOf = (account: { data: readonly [string, string] } | null): Uint8Array | null => (account ? new Uint8Array(Buffer.from(account.data[0], "base64")) : null);

export function marketKeeperRoutes(app: Hono<AppEnv>) {
  app.get("/v1/markets/:market/keeper", async (c) => {
    const market = addressOf(c.req.param("market"), "market");
    const { db, close } = createDb(c.env.HYPERDRIVE.connectionString);
    try {
      const [row] = await db.select({ strategy: markets.strategyProgram, state: markets.marketState }).from(markets).where(eq(markets.address, market));
      if (!row) throw new HTTPException(404, { message: "Aviary knows no market created through Pipeline at this address." });
      const product: AnyKeeperProduct | undefined = products.find((p) => p.programAddress === row.strategy);
      if (!product) return c.json(MarketKeeper.parse({ market, product: null, slot: null, due: [], records: { ok: true, error: null } }));

      const rpc = createSolanaRpc(c.env.RPC_URL);
      const state = address(row.state);
      const read = (wanted: Address[]) => rpc.getMultipleAccounts(wanted, { encoding: "base64", commitment: "confirmed" }).send();
      let { context, value } = await read([state]);
      let data = dataOf(value[0] ?? null);
      // A product whose rules watch other accounts reads them again with the state, so its rules see one moment of the chain.
      const watched = data && product.isMarket(data) ? (product.watches?.(data) ?? []) : [];
      if (watched.length) ({ context, value } = await read([state, ...watched]));
      data = dataOf(value[0] ?? null);
      if (!data || !product.isMarket(data)) throw new HTTPException(422, { message: `This market's state is not a ${product.name} market state.` });
      const decoded = product.decode(data, new Map(watched.map((a, i) => [a, dataOf(value[i + 1] ?? null)])));
      const units = product.jobs.flatMap((job) => job.due(decoded));

      let records: KeeperUnitRead[] = [];
      let recordsRead: MarketKeeper["records"] = { ok: true, error: null };
      try {
        records = await readKeeperUnits(db, { wallet: c.env.KEEPER_WALLET, market, limit: KEEPER_MARKET_RECORDS });
      } catch (e) {
        console.error("market keeper: the database query failed", e instanceof Error ? e.name : typeof e);
        recordsRead = { ok: false, error: "the database did not answer" };
      }
      return c.json(
        MarketKeeper.parse({
          market,
          product: product.name,
          slot: Number(context.slot),
          due: units.map((unit) => ({
            job: unit.job,
            key: unit.key,
            slot: unit.slot ?? null,
            owed: unit.owed === undefined ? null : String(unit.owed),
            ...attemptsOf(records.find((r) => r.job === unit.job && r.slot === (unit.slot ?? null))),
          })),
          records: recordsRead,
        }),
      );
    } finally {
      c.executionCtx.waitUntil(close());
    }
  });
}
