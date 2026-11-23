// Strategy programs and their versions on devnet (#117; docs/spec/pipescope-architecture.md,
// Indexer; docs/spec/pipescope-canary.md, "Custom instructions are listed, not called"):
// `terminal-api` runs every indexer job under `wrangler dev` on a throwaway database, then
//
// - each strategy's instruction list holds the names the Canary spec lists for the eight
//   strategies of 2026-11-10, 34 in all, each confirmed here by its discriminator in the program's
//   bytes, read from the chain apart from the indexer; a strategy upgraded since then may list more,
//   and its version history shows that upgrade;
// - each strategy's current version is the slot and hash Pipeline's hosted devnet API reports, and
//   the router's is the verified build pinned in fixtures/pins.env;
// - who has called each of the sniper-tax strategy's instructions, and how often, is what its
//   program's transaction history, read here through RPC, says.
import { createHash } from "node:crypto";
import { programDataPda } from "@pipeline-sol/sdk";
import { address, getBase58Encoder } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpcUrl } from "./devnet";
import { everyTenMinuteJob, LocalApi } from "./localApi";

const HOSTED = "https://pipeline-devnet.up.railway.app";
const ready = Boolean(process.env.RPC_URL && process.env.TEST_DATABASE_URL);

const SNIPER_TAX = "EZwLuZ8mSiBoeKtbHwQK4kxCqqj4JuureT1kHpTK3i6b";
/** The Canary spec's 34 names, for the eight strategies on devnet on 2026-11-10. */
const NAMES_OF_2026_11_10: Record<string, string[]> = {
  yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx: ["Deposit"],
  ETrmUegraeyB7B6fXBfANmV7w9aEwM3wUEUzFHqo5zAb: ["ClaimAllocation", "ClaimCreatorFees", "ClaimLeftover", "FundCurve", "Graduate", "SetFeeRecipient"],
  "4ajWF6Y3wsxXUbvvaEu7ZcA2RosB1YfaXcqot8kguwJD": ["RebalanceWall", "SeedPool", "SettleRetired", "SweepFees"],
  "9mAV3pMKXx67poy98jHizWM6TEeKJ5g48ZeD83xFa1UF": ["Buy", "Buyback", "CreateMarket", "DeepenQuote", "DeepenToken", "InitializeFactory", "PublishManifest", "Sell", "SetMetadata", "SplitFees"],
  "2TmcmquxnCB8AHoLmLJFYxZnVQdm9pREMEsmHqByQq7G": ["ClaimFees", "ClosePack", "OpenDraw", "OpenPack"],
  "4LHmX6x7xgB2eNeuRsuF3U3huhFoyfYeddRLzsBwzvPc": ["BurnToClose", "ClaimFees", "Deploy"],
  "4scUVyL9JbLjvkppBk8PYNGRPMCQfp7ppdBFkthDYPLA": ["ClaimFees"],
  [SNIPER_TAX]: ["ClaimTax", "InitializeConfig", "Launch", "SweepProtocolFees", "UpdateConfig"],
};
const END_OF_2026_11_10 = Date.parse("2026-11-11T00:00:00Z");
/** The router as pinned in fixtures/pins.env: deployed in slot 524,761,925, its solana-verify executable hash. */
const ROUTER_PIN = { deploySlot: 524_761_925, executableSha256: "4500c2939465439279caa0555123b44b81c63293a35ff36a1932a7cf51c49803" };

const base58 = getBase58Encoder();

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(rpcUrl(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const body = (await response.json().catch(() => null)) as { result?: T; error?: { message: string } } | null;
    if (response.ok && body && !body.error) return body.result as T;
    if (attempt >= 5) throw new Error(`${method} failed: ${body?.error?.message ?? response.status}`);
    await new Promise((done) => setTimeout(done, 1_000 * (attempt + 1)));
  }
}

/** Anchor's discriminator, worked out here on its own: sha256 of "global:" and the name in snake case. */
function discriminator(name: string): Buffer {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
  return createHash("sha256").update(`global:${snake}`).digest().subarray(0, 8);
}

/** A program's code, read from its ProgramData account apart from the indexer. */
async function programCode(program: string): Promise<Buffer> {
  const { value } = await rpc<{ value: { data: [string, string] } }>("getAccountInfo", [await programDataPda(address(program)), { encoding: "base64" }]);
  return Buffer.from(value.data[0], "base64").subarray(45);
}

/** Whether the code holds the eight bytes side by side, or split over two instruction slots as a 64-bit immediate. */
function holds(code: Buffer, d: Buffer): boolean {
  if (code.indexOf(d) >= 0) return true;
  for (let i = code.indexOf(d.subarray(0, 4)); i >= 0; i = code.indexOf(d.subarray(0, 4), i + 1)) if (code.subarray(i + 8, i + 12).equals(d.subarray(4, 8))) return true;
  return false;
}

let api: LocalApi;
beforeAll(async () => {
  if (!ready) return;
  api = new LocalApi(8826);
  await api.start();
  // Every job, in a minute on which all are due: the router's backfill, every strategy's backfill, the snapshot and the watch.
  await api.runJobs({ minute: everyTenMinuteJob, wait: ["reconciledAt", "snapshotAt", "strategiesReconciledAt", "watchedAt"] });
}, 15 * 60_000);
afterAll(async () => {
  await api?.dispose();
});

describe.skipIf(!ready)("strategy versions on devnet", () => {
  it("lists the 34 names of 2026-11-10 in the eight strategies' instruction lists, each confirmed by its discriminator, and the newer strategies' besides", async () => {
    expect(Object.values(NAMES_OF_2026_11_10).flat()).toHaveLength(34);
    const strategies = await api.strategies();
    for (const { program } of strategies) {
      const list = await api.instructions(program);
      const versions = await api.versions(program);
      expect(list.deploy_slot, program).toBe(versions[0]?.deploy_slot);
      expect(list.anchor, program).toBe(true);
      const code = await programCode(program);
      for (const i of list.instructions) {
        expect(i.discriminator, `${program} ${i.name}`).toBe(discriminator(i.name).toString("hex"));
        expect(holds(code, discriminator(i.name)), `${program} ${i.name} in the code`).toBe(true);
      }
      const expected = NAMES_OF_2026_11_10[program];
      if (!expected) continue;
      const custom = list.instructions.filter((i) => !i.pipeline).map((i) => i.name).sort();
      const current = versions[0]!;
      if (Date.parse(current.deployed_at ?? current.seen_at) < END_OF_2026_11_10) {
        expect(custom, program).toEqual(expected);
      } else {
        // Upgraded since: every name of 2026-11-10 is still there, and the version of that day is in its history.
        expect(custom, program).toEqual(expect.arrayContaining(expected));
        expect(versions.some((v) => v.deployed_at && Date.parse(v.deployed_at) < END_OF_2026_11_10), `${program}'s version of 2026-11-10`).toBe(true);
        const added = custom.filter((n) => !expected.includes(n));
        if (added.length) console.log(`${program}, upgraded in slot ${current.deploy_slot} on ${current.deployed_at}, also lists ${added.join(", ")}`);
      }
    }
    expect(strategies.map((s) => s.program)).toEqual(expect.arrayContaining(Object.keys(NAMES_OF_2026_11_10)));
  });

  it("records each strategy's current version at the slot and hash Pipeline's hosted API reports, and the router's as pinned", async () => {
    const { strategies } = (await (await fetch(`${HOSTED}/v1/strategies`)).json()) as { strategies: { program_id: string; last_deploy_slot: number; executable_sha256: string }[] };
    for (const s of strategies) {
      const [current] = await api.versions(s.program_id);
      expect({ program: s.program_id, slot: current?.deploy_slot, hash: current?.executable_sha256 }).toEqual({ program: s.program_id, slot: s.last_deploy_slot, hash: s.executable_sha256 });
    }
    const { versions } = await api.router();
    expect({ slot: versions[0]?.deploy_slot, hash: versions[0]?.executable_sha256, current: versions[0]?.current }).toEqual({ slot: ROUTER_PIN.deploySlot, hash: ROUTER_PIN.executableSha256, current: true });
    // Every earlier deploy of the router is in its history, each with its transaction.
    expect(versions.length).toBeGreaterThan(1);
    expect(versions.every((v) => v.signature)).toBe(true);
  });

  it("says who has called each of the sniper-tax strategy's instructions, and how often, as its program's history read through RPC does", async () => {
    // Its whole history, newest first, then each transaction.
    const signatures: { signature: string; err: unknown }[] = [];
    for (let before: string | undefined; ; ) {
      const page = await rpc<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [SNIPER_TAX, { limit: 1000, ...(before ? { before } : {}) }]);
      signatures.push(...page);
      if (page.length < 1000) break;
      before = page.at(-1)!.signature;
    }
    type Ix = { programIdIndex: number; accounts: number[]; data: string };
    const calls = new Map<string, { calls: number; signers: Map<string, number> }>();
    for (const { signature, err } of signatures) {
      if (err !== null) continue;
      const tx = await rpc<{ transaction: { message: { accountKeys: string[]; header: { numRequiredSignatures: number }; instructions: Ix[] } }; meta: { err: unknown; innerInstructions: { instructions: Ix[] }[]; loadedAddresses?: { writable: string[]; readonly: string[] } } }>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]);
      const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])];
      for (const ix of [...tx.transaction.message.instructions, ...tx.meta.innerInstructions.flatMap((g) => g.instructions)]) {
        if (keys[ix.programIdIndex] !== SNIPER_TAX) continue;
        const d = Buffer.from(base58.encode(ix.data)).subarray(0, 8).toString("hex");
        const entry = calls.get(d) ?? { calls: 0, signers: new Map<string, number>() };
        entry.calls++;
        for (const signer of new Set(ix.accounts.filter((a) => a < tx.transaction.message.header.numRequiredSignatures).map((a) => keys[a]!))) entry.signers.set(signer, (entry.signers.get(signer) ?? 0) + 1);
        calls.set(d, entry);
      }
    }
    expect(calls.size).toBeGreaterThan(0);

    const { instructions } = await api.instructions(SNIPER_TAX);
    for (const i of instructions) {
      const fromChain = calls.get(i.discriminator);
      expect({ name: i.name, calls: i.calls, signers: Object.fromEntries(i.signers.map((s) => [s.address, s.calls])), total: i.signers_total }).toEqual({
        name: i.name,
        calls: fromChain?.calls ?? 0,
        signers: Object.fromEntries(fromChain?.signers ?? []),
        total: fromChain?.signers.size ?? 0,
      });
    }
    console.log(`sniper-tax: ${instructions.map((i) => `${i.name} ${i.calls} by ${i.signers_total}`).join(", ")}, from ${signatures.length} transactions`);
  });
});
