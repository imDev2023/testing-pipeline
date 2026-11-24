// The snapshot CanaryRun posts into the container (docs/spec/pipescope-architecture.md, "Canary
// runner", Snapshot; CANARY-25, CANARY-30): read through the RPC, since the container has no
// network, and filled in with what the binary names as missing.
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeRpc, type FakeRpc } from "terminal-indexer/testing";
import { addMissing, firstSnapshot, rpcAccountReader, snapshotBody } from "../src/canarySnapshot";
import { putMarket } from "./canaryChain";

let rpc: FakeRpc;
beforeEach(async () => (rpc = await fakeRpc()));
afterEach(async () => rpc.close());

describe("a market's snapshot", () => {
  it("holds, in its first round, the copy's accounts: programs with their ProgramData, the router's config, the market, its state, mints, vaults, fee accounts and transfer hooks", async () => {
    const chain = await putMarket(rpc);
    const reader = rpcAccountReader(rpc.url);
    const { snapshot, strategyExecutableSha256 } = await firstSnapshot(reader, chain.market);

    expect(snapshot.market).toBe(chain.market);
    expect(snapshot.round).toBe(1);
    expect(snapshot.seed).toBeUndefined();
    expect(snapshot.cluster).toEqual({ slot: rpc.slot, epoch: rpc.epoch, unix_timestamp: rpc.blockTime, genesis_hash: rpc.genesisHash });
    expect(new Set(Object.keys(snapshot.accounts))).toEqual(new Set(chain.firstRound.keys()));
    for (const [at, exists] of chain.firstRound) {
      const account = snapshot.accounts[at];
      if (!exists) expect(account, at).toBeNull();
      else {
        const onChain = rpc.accounts.get(at)!;
        expect(account, at).toEqual({ lamports: 1, owner: onChain.owner, executable: onChain.executable ?? false, rent_epoch: 0n, data: Buffer.from(onChain.data).toString("base64") });
      }
    }
    expect(strategyExecutableSha256).toBe(createHash("sha256").update(chain.executable).digest("hex"));
    // The clock's four calls and one read per layer of the copy, however many accounts each holds.
    expect(reader.requests()).toBeLessThanOrEqual(8);
  });

  it("adds what the binary names as missing, null where the cluster has nothing, and keeps the seed it answered with", async () => {
    const chain = await putMarket(rpc);
    const reader = rpcAccountReader(rpc.url);
    const { snapshot } = await firstSnapshot(reader, chain.market);
    const gone = "Gone111111111111111111111111111111111111111";
    const next = await addMissing(reader, snapshot, { round: 1, addresses: [chain.resolved, gone], seed: "ab".repeat(32) });
    expect(next.round).toBe(2);
    expect(next.seed).toBe("ab".repeat(32));
    expect(next.accounts[chain.resolved]?.owner).toBe(chain.strategy);
    expect(next.accounts[gone]).toBeNull();
    expect(Object.keys(next.accounts)).toHaveLength(Object.keys(snapshot.accounts).length + 2);
  });

  it("carries a rent-exempt account's rent epoch, u64's largest value, whole into the body it posts", async () => {
    const chain = await putMarket(rpc);
    rpc.rentEpoch = 18_446_744_073_709_551_615n;
    const { snapshot } = await firstSnapshot(rpcAccountReader(rpc.url), chain.market);
    const held = Object.values(snapshot.accounts).filter((a) => a !== null).length;
    expect(snapshotBody(snapshot).split('"rent_epoch":18446744073709551615,')).toHaveLength(held + 1);
  });

  it("falls back to the local clock when the RPC has no block time for the slot yet, as pipeline-check does", async () => {
    const chain = await putMarket(rpc);
    rpc.blockTime = null;
    const before = Math.floor(Date.now() / 1000);
    const { snapshot } = await firstSnapshot(rpcAccountReader(rpc.url), chain.market);
    expect(snapshot.cluster.unix_timestamp).toBeGreaterThanOrEqual(before);
  });

  it("refuses an address that is no Pipeline market, naming it", async () => {
    await putMarket(rpc);
    await expect(firstSnapshot(rpcAccountReader(rpc.url), "Nope111111111111111111111111111111111111111")).rejects.toThrow(/Nope1111.* is not a Pipeline market/);
  });
});
