// The keeper page's data in the end-to-end tests: a test keeper wallet whose key is known (its
// private key is 32 bytes of 129, never a real wallet's), records of its passes written to the
// database as the runner writes them, and a heartbeat it signs, as the runner posts after a pass.
// The local API is started with KEEPER_WALLET set to this wallet (playwright.config.ts).
import { createKeyPairSignerFromPrivateKeyBytes, getBase58Decoder, signBytes } from "@solana/kit";
import postgres from "postgres";
import { keeperHeartbeatMessage, type KeeperHeartbeatPayload } from "terminal-api/contract";
import { createDb, recordKeeperPass, type KeeperJobRecord, type KeeperPassRecord } from "terminal-db";
import { API } from "./target";

export const TEST_KEEPER_WALLET = "AxBAe8zXwD3GhbTkwMqQ4VX9LGt1CxGxc7keNPuBinni";
const TEST_KEEPER_KEY = new Uint8Array(32).fill(129);

/** Two of the tax AMM's devnet markets' addresses, and a transaction's signature, for the records to name. */
export const KEEPER_MARKET = "FJ1PJovxT4Njfn3fkufxcKeCF8XtsPRAFLKadZZYXgDB";
export const KEEPER_WALL_MARKET = "7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK";
export const KEEPER_SIGNATURE = "5ZqXyKmyNp2pVSf1Kd7RQ3b9Jr3p7GWfY6vUoVyB4rT2c8eXhJ5aPq9LmN1sZtWcDbGfHkQwErTyUiOpAsDf2Gh";

const CAPS = { maxTxCost: 3_000_000n, marketDailyCap: 10_000_000n, dailyCap: 100_000_000n, minBalance: 100_000_000n, lowBalance: 500_000_000n };

/** Replaces the test keeper's records with a daily pass that paid out, and a sweep that placed a wall and was held by a cap. */
export async function seedKeeperRecords(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`delete from keeper_runs where wallet = ${TEST_KEEPER_WALLET}`;
  } finally {
    await sql.end();
  }
  // Both today (UTC), so they count in today's spend: 20 and 5 minutes ago, or just after 00:00 UTC.
  const now = Date.now();
  const dayStart = now - (now % 86_400_000);
  const ago = (minutes: number, floor: number) => new Date(Math.max(now - minutes * 60_000, Math.min(dayStart + floor, now)));
  const job = (at: Date, fields: Partial<KeeperJobRecord> & Pick<KeeperJobRecord, "market" | "job" | "outcome">): KeeperJobRecord => ({
    at,
    product: fields.market === KEEPER_MARKET ? "tax-amm" : "buy-wall-amm",
    slot: null,
    signature: null,
    cost: null,
    estimate: null,
    cap: null,
    error: null,
    attempt: null,
    ...fields,
  });
  const pass = (at: Date, kind: string, jobs: KeeperJobRecord[], spent: Record<string, bigint>): KeeperPassRecord => ({
    wallet: TEST_KEEPER_WALLET,
    pass: kind,
    at,
    balance: 1_987_650_000n,
    day: at.toISOString().slice(0, 10),
    spentTotal: Object.values(spent).reduce((a, b) => a + b, 0n),
    spentByMarket: spent,
    caps: CAPS,
    settings: { SWEEP_INTERVAL: "10m" },
    warnings: [],
    counts: { markets: 2, sent: jobs.filter((j) => j.signature).length, held: jobs.filter((j) => j.outcome === "held").length, parked: 0, skipped: 0, failed: 0 },
    jobs,
  });
  const daily = ago(20, 0);
  const sweep = ago(5, 1);
  const { db, close } = createDb(url);
  try {
    await recordKeeperPass(
      db,
      pass(
        daily,
        "daily",
        [0, 1, 4, 5].map((slot) => job(daily, { market: KEEPER_MARKET, job: "distribute", slot, outcome: "sent", signature: slot === 0 ? KEEPER_SIGNATURE : `${KEEPER_SIGNATURE.slice(0, -2)}${slot}x`, cost: 5_000n })),
        { [KEEPER_MARKET]: 20_000n },
      ),
    );
    await recordKeeperPass(
      db,
      pass(
        sweep,
        "sweep",
        [
          job(sweep, { market: KEEPER_WALL_MARKET, job: "place_wall", outcome: "sent", signature: `${KEEPER_SIGNATURE.slice(0, -2)}wx`, cost: 5_000n }),
          job(sweep, { market: KEEPER_MARKET, job: "distribute", slot: 2, outcome: "held", cap: "MARKET_DAILY_CAP", estimate: 2_044_280n }),
        ],
        { [KEEPER_MARKET]: 20_000n, [KEEPER_WALL_MARKET]: 5_000n },
      ),
    );
  } finally {
    await close();
  }
}

/** Posts a heartbeat the test keeper signed, as the runner does after a pass, and checks the API kept it or had one as new. */
export async function postKeeperHeartbeat(pass: KeeperHeartbeatPayload["pass"] = "sweep"): Promise<void> {
  const signer = await createKeyPairSignerFromPrivateKeyBytes(TEST_KEEPER_KEY);
  if (signer.address !== TEST_KEEPER_WALLET) throw new Error("the test keeper's key does not give its address");
  const payload: KeeperHeartbeatPayload = {
    wallet: signer.address,
    pass,
    at: new Date().toISOString(),
    sweepIntervalMs: 600_000,
    caps: { maxTxCost: 3_000_000, marketDailyCap: 10_000_000, dailyCap: 100_000_000, minBalance: 100_000_000, lowBalance: 500_000_000 },
    warnings: [],
  };
  const text = JSON.stringify(payload);
  const signature = getBase58Decoder().decode(await signBytes(signer.keyPair.privateKey, keeperHeartbeatMessage(text)));
  const response = await fetch(`${API}/keeper/heartbeat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: text, signature }) });
  if (response.status === 403) throw new Error(`the API refused the test keeper's heartbeat: it was not started with KEEPER_WALLET=${TEST_KEEPER_WALLET} (stop the running API so Playwright starts its own)`);
  if (response.status !== 202) throw new Error(`the API answered the heartbeat with ${response.status}: ${await response.text()}`);
}
