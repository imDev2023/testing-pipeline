// Recording program versions (docs/spec/pipescope-architecture.md, Indexer, "ProgramData watch"):
// the version the watch sees, with its hash and instruction list, the earlier ones backfilled from
// the ProgramData account's history, and an event in the outbox for each upgrade seen happen.
import { createHash } from "node:crypto";
import { programDataPda } from "@pipeline-sol/sdk";
import { address } from "@solana/kit";
import { asc, eq } from "drizzle-orm";
import { createDb, programVersions, readOutbox, strategyInstructions, type Db } from "terminal-db";
import { createTestDatabase } from "terminal-db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordVersion } from "../src/index";
import { fakeRpc, type FakeRpc } from "./fakeRpc";
import { programAddress, programDataAccount, upgradeTransaction } from "./programs";

const disc = (snake: string) => createHash("sha256").update(`global:${snake}`).digest().subarray(0, 8);
const text = (s: string) => new TextEncoder().encode(s);
/** A strategy's code naming its instructions as Anchor compiles them, with their discriminators. */
const code = (...names: [string, string][]) => Buffer.concat([Buffer.alloc(16, 0x5a), ...names.flatMap(([camel, snake]) => [Buffer.from(text(`Instruction: ${camel}`)), Buffer.alloc(8, 0x5a), disc(snake)]), Buffer.alloc(8, 0x5a)]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let client: { db: Db; close: () => Promise<void> };
let rpc: FakeRpc;
let strategy: string;
let router: string;
beforeAll(async () => {
  database = await createTestDatabase();
  client = createDb(database.url);
  strategy = await programAddress(10);
  router = await programAddress(11);
});
beforeEach(async () => {
  rpc = await fakeRpc();
});
afterAll(async () => {
  await rpc?.close();
  await client?.close();
  await database?.drop();
});

const versions = (program: string) => client.db.select().from(programVersions).where(eq(programVersions.program, program)).orderBy(asc(programVersions.deploySlot));

describe("recordVersion", () => {
  it("on first sight records the version in force with its hash and instructions, backfills the earlier ones from the deploy history, and writes no event", async () => {
    const programData = await programDataPda(address(strategy));
    const v2 = code(["Deposit", "deposit"], ["PipelineSwap", "pipeline_swap"]);
    rpc.accounts.set(programData, programDataAccount(430n, v2));
    rpc.history.push(
      upgradeTransaction({ kind: "deploy", program: strategy, programData, slot: 400, signature: "deploy-sig" }),
      upgradeTransaction({ kind: "upgrade", program: strategy, programData, slot: 430, signature: "upgrade-sig" }),
    );

    const outcome = await recordVersion(client.db, rpc.url, { program: strategy, role: "strategy", programData, previousSlot: null });
    expect(outcome).toEqual({ deploySlot: 430n, programDataSlot: 430n, signed: true, event: false, settled: true });
    expect((await versions(strategy)).map((v) => [v.deploySlot, v.backfilled, v.executableSha256, v.signature, v.blockTime?.toISOString(), v.anchor, v.flagged])).toEqual([
      [400n, true, null, "deploy-sig", new Date(400_000).toISOString(), null, false],
      [430n, false, sha(v2), "upgrade-sig", new Date(430_000).toISOString(), true, false],
    ]);
    expect((await client.db.select().from(strategyInstructions).orderBy(asc(strategyInstructions.position))).map((i) => [i.deploySlot, i.position, i.name, i.pipeline])).toEqual([
      [430n, 0, "Deposit", false],
      [430n, 1, "PipelineSwap", true],
    ]);
    expect(await readOutbox(client.db, "test")).toEqual([]);
  });

  it("records an upgrade the watch saw with its own instruction list, backfills one in between it missed, and writes the strategy_version event", async () => {
    const programData = await programDataPda(address(strategy));
    const v4 = code(["Deposit", "deposit"], ["Withdraw", "withdraw"]);
    rpc.accounts.set(programData, programDataAccount(470n, v4));
    rpc.history.push(
      upgradeTransaction({ kind: "deploy", program: strategy, programData, slot: 400, signature: "deploy-sig" }),
      upgradeTransaction({ kind: "upgrade", program: strategy, programData, slot: 430, signature: "upgrade-sig" }),
      upgradeTransaction({ kind: "upgrade", program: strategy, programData, slot: 455, signature: "missed-sig" }),
      upgradeTransaction({ kind: "upgrade", program: strategy, programData, slot: 470, signature: "newest-sig" }),
    );

    expect(await recordVersion(client.db, rpc.url, { program: strategy, role: "strategy", programData, previousSlot: 430n })).toMatchObject({ deploySlot: 470n, signed: true, event: true });
    expect((await versions(strategy)).map((v) => [v.deploySlot, v.backfilled, v.signature, v.executableSha256 === null])).toEqual([
      [400n, true, "deploy-sig", true],
      [430n, false, "upgrade-sig", false],
      [455n, true, "missed-sig", true],
      [470n, false, "newest-sig", false],
    ]);
    expect((await client.db.select().from(strategyInstructions)).filter((i) => i.deploySlot === 470n).map((i) => i.name)).toEqual(["Deposit", "Withdraw"]);
    const [event] = await readOutbox(client.db, "test");
    expect(event).toMatchObject({ kind: "strategy_version", subject: strategy, slot: 470n, payload: { deploySlot: "470", executableSha256: sha(v4), previousSlot: "430" } });
  });

  it("takes an extension, which moves the ProgramData slot and changes no code, for no new version", async () => {
    const extended = await programAddress(13);
    const programData = await programDataPda(address(extended));
    const bytes = code(["Deposit", "deposit"]);
    rpc.accounts.set(programData, programDataAccount(1_000n, bytes));
    rpc.history.push(upgradeTransaction({ kind: "deploy", program: extended, programData, slot: 1_000, signature: "first-deploy" }));
    await recordVersion(client.db, rpc.url, { program: extended, role: "strategy", programData, previousSlot: null });

    // The deploy tool makes room first, and the watch can read the slot between the two.
    rpc.accounts.set(programData, programDataAccount(1_040n, bytes));
    rpc.history.push(upgradeTransaction({ kind: "extend", program: extended, programData, slot: 1_040, signature: "extend-sig" }));
    expect(await recordVersion(client.db, rpc.url, { program: extended, role: "strategy", programData, previousSlot: 1_000n })).toMatchObject({ deploySlot: 1_000n, signed: true, event: false });
    expect((await versions(extended)).map((v) => v.deploySlot)).toEqual([1_000n]);

    rpc.accounts.set(programData, programDataAccount(1_060n, code(["Deposit", "deposit"], ["Withdraw", "withdraw"])));
    rpc.history.push(upgradeTransaction({ kind: "upgrade", program: extended, programData, slot: 1_060, signature: "real-upgrade" }));
    expect(await recordVersion(client.db, rpc.url, { program: extended, role: "strategy", programData, previousSlot: 1_000n })).toMatchObject({ deploySlot: 1_060n, signed: true, event: true });
    expect((await versions(extended)).map((v) => [v.deploySlot, v.signature])).toEqual([
      [1_000n, "first-deploy"],
      [1_060n, "real-upgrade"],
    ]);
  });

  it("takes an extension and an upgrade in one slot for the upgrade", async () => {
    const both = await programAddress(14);
    const programData = await programDataPda(address(both));
    rpc.accounts.set(programData, programDataAccount(2_000n, code(["Deposit", "deposit"])));
    rpc.history.push(upgradeTransaction({ kind: "deploy", program: both, programData, slot: 2_000, signature: "deploy-2000" }));
    await recordVersion(client.db, rpc.url, { program: both, role: "strategy", programData, previousSlot: null });
    rpc.accounts.set(programData, programDataAccount(2_050n, code(["Deposit", "deposit"], ["Withdraw", "withdraw"])));
    rpc.history.push(
      upgradeTransaction({ kind: "extend", program: both, programData, slot: 2_050, signature: "extend-2050", blockIndex: 0 }),
      upgradeTransaction({ kind: "upgrade", program: both, programData, slot: 2_050, signature: "upgrade-2050", blockIndex: 1 }),
    );
    expect(await recordVersion(client.db, rpc.url, { program: both, role: "strategy", programData, previousSlot: 2_000n })).toMatchObject({ deploySlot: 2_050n, signed: true, event: true, settled: true });
    expect((await versions(both)).map((v) => [v.deploySlot, v.signature])).toEqual([
      [2_000n, "deploy-2000"],
      [2_050n, "upgrade-2050"],
    ]);
  });

  it("leaves a slot moved with the same code as before unsettled while its transaction is not served, so neither an extension nor an upgrade is guessed", async () => {
    const lagging = await programAddress(15);
    const programData = await programDataPda(address(lagging));
    const bytes = code(["Deposit", "deposit"]);
    rpc.accounts.set(programData, programDataAccount(3_000n, bytes));
    rpc.history.push(upgradeTransaction({ kind: "deploy", program: lagging, programData, slot: 3_000, signature: "deploy-3000" }));
    await recordVersion(client.db, rpc.url, { program: lagging, role: "strategy", programData, previousSlot: null });
    rpc.accounts.set(programData, programDataAccount(3_040n, bytes));
    expect(await recordVersion(client.db, rpc.url, { program: lagging, role: "strategy", programData, previousSlot: 3_000n })).toMatchObject({ deploySlot: 3_000n, event: false, settled: false });
    expect((await versions(lagging)).map((v) => v.deploySlot)).toEqual([3_000n]);
    expect(await readOutbox(client.db, "lagging")).not.toContainEqual(expect.objectContaining({ subject: lagging }));
  });

  it("says when the upgrade's transaction is not served yet, so the watch can look for it again", async () => {
    const other = await programAddress(12);
    const programData = await programDataPda(address(other));
    rpc.accounts.set(programData, programDataAccount(900n, code(["Deposit", "deposit"])));
    expect(await recordVersion(client.db, rpc.url, { program: other, role: "strategy", programData, previousSlot: 800n })).toMatchObject({ deploySlot: 900n, signed: false, event: true });
    rpc.history.push(upgradeTransaction({ kind: "upgrade", program: other, programData, slot: 900, signature: "late-sig" }));
    expect(await recordVersion(client.db, rpc.url, { program: other, role: "strategy", programData, previousSlot: 800n })).toMatchObject({ deploySlot: 900n, signed: true, event: false });
    expect((await versions(other)).map((v) => v.signature)).toEqual(["late-sig"]);
  });

  it("records a router upgrade flagged, with its hash and no instruction list, and writes the router_upgraded event", async () => {
    const programData = await programDataPda(address(router));
    const bytes = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 9, 9]);
    rpc.accounts.set(programData, programDataAccount(600n, bytes));
    await recordVersion(client.db, rpc.url, { program: router, role: "router", programData, previousSlot: null });
    rpc.accounts.set(programData, programDataAccount(650n, bytes));
    rpc.history.push(upgradeTransaction({ kind: "upgrade", program: router, programData, slot: 650, signature: "router-upgrade" }));
    expect(await recordVersion(client.db, rpc.url, { program: router, role: "router", programData, previousSlot: 600n })).toMatchObject({ deploySlot: 650n, signed: true, event: true });
    expect((await versions(router)).map((v) => [v.deploySlot, v.role, v.flagged, v.anchor, v.executableSha256])).toEqual([
      [600n, "router", false, null, sha(bytes)],
      [650n, "router", true, null, sha(bytes)],
    ]);
    expect((await readOutbox(client.db, "test")).at(-1)).toMatchObject({ kind: "router_upgraded", subject: router, payload: { deploySlot: "650", previousSlot: "600" } });
  });
});
