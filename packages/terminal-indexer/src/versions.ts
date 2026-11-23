// Recording program versions (docs/spec/pipescope-architecture.md, Indexer, "ProgramData watch" and
// "Instruction lists"): when the watch sees a program for the first time, or sees its deploy slot
// change, `terminal-api` reads the program's bytes once, hashes them and, for a strategy, works out
// its instruction list (PIPESCOPE-92), and records the version with its deploy transaction. Earlier
// deploys in the ProgramData account's history are backfilled without bytes, since those are gone.
// A change seen happen writes an event to the outbox, flagged as well for the router, since a
// router upgrade can change event layouts (CANARY-22).
import { and, eq, isNull, sql } from "drizzle-orm";
import { appendOutbox, lockOutbox, programVersions, strategyInstructions, type Db } from "terminal-db";
import { instructionList } from "./instructions";
import type { HistorySource } from "./history";
import { deployHistory, programDataHistory, readExecutable } from "./programs";

/** Where versions are read from: the RPC, for accounts, and the indexer's history source, for ProgramData accounts' transactions. */
export type ProgramReader = { rpcUrl: string; source: HistorySource };

export type ProgramRole = "strategy" | "router";

export type VersionToRecord = {
  program: string;
  role: ProgramRole;
  programData: string;
  /** The deploy slot recorded before, or null when the program is seen for the first time. */
  previousSlot: bigint | null;
};

export type RecordedVersion = {
  /** The version in force: the slot of the latest deploy or upgrade, which an extension since does not move. */
  deploySlot: bigint;
  /** The ProgramData slot read, which an extension moves past the version's slot. */
  programDataSlot: bigint;
  /** Whether the version's deploy transaction was found; when not yet served, the watch looks again. */
  signed: boolean;
  /** Whether this call wrote the upgrade's event (an upgrade is written once, however often it is recorded). */
  event: boolean;
  /**
   * False when the ProgramData slot moved, its transaction is not served yet and the code is the
   * version's before: an extension and an upgrade to the same bytes cannot be told apart, so nothing
   * was written and the watch asks again.
   */
  settled: boolean;
};

/**
 * Records the version in force of a program, with every earlier deploy its ProgramData account's
 * history holds. Safe to call again for the same version: it fills in what it lacked (a
 * transaction served late) and writes nothing twice. Null when the account is no longer ProgramData.
 */
export async function recordVersion(db: Db, { rpcUrl, source }: ProgramReader, { program, role, programData, previousSlot }: VersionToRecord): Promise<RecordedVersion | null> {
  const executable = await readExecutable(rpcUrl, programData);
  if (!executable) return null;
  const { executableSha256, code, deploySlot: programDataSlot } = executable;
  const writes = await programDataHistory(source, programData);
  const deploys = writes.filter((w) => w.kind === "deploy");
  // The version in force is the code of the latest deploy at or before the ProgramData slot: an
  // extension since moved the slot and kept the code. A deploy in the slot itself wins over an
  // extension in it, since a deploy tool sends the two together.
  const atSlot = writes.filter((w) => w.deploySlot === programDataSlot);
  const own = atSlot.find((w) => w.kind === "deploy") ?? (atSlot.length ? deploys.findLast((d) => d.deploySlot < programDataSlot) : undefined);
  if (!atSlot.length && previousSlot !== null && previousSlot !== programDataSlot) {
    const [before] = await db
      .select({ executableSha256: programVersions.executableSha256 })
      .from(programVersions)
      .where(and(eq(programVersions.program, program), eq(programVersions.deploySlot, previousSlot)));
    if (before?.executableSha256 === executableSha256) return { deploySlot: previousSlot, programDataSlot, signed: true, event: false, settled: false };
  }
  // Until the RPC serves the write, a new version is keyed by the ProgramData slot.
  const deploySlot = own?.deploySlot ?? programDataSlot;
  const list = role === "strategy" ? await instructionList(code) : null;
  const upgraded = previousSlot !== null && previousSlot !== deploySlot;

  return db.transaction(async (tx) => {
    // An upgrade writes its event, so the transaction holds the outbox's lock from its first write.
    if (upgraded) await lockOutbox(tx as unknown as Db);
    await tx
      .insert(programVersions)
      .values({ program, deploySlot, role, executableSha256, signature: own?.signature ?? null, blockTime: own?.blockTime ?? null, backfilled: false, flagged: role === "router" && upgraded, anchor: list?.anchor ?? null, programDataSlot })
      .onConflictDoUpdate({
        target: [programVersions.program, programVersions.deploySlot],
        set: {
          executableSha256,
          anchor: list?.anchor ?? null,
          backfilled: false,
          programDataSlot,
          signature: sql`coalesce(${programVersions.signature}, excluded.signature)`,
          blockTime: sql`coalesce(${programVersions.blockTime}, excluded.block_time)`,
          flagged: sql`${programVersions.flagged} or excluded.flagged`,
        },
      });
    if (list?.instructions.length) {
      await tx
        .insert(strategyInstructions)
        .values(list.instructions.map((i, position) => ({ program, deploySlot, position, name: i.name, discriminator: i.discriminator, pipeline: i.pipeline })))
        .onConflictDoNothing();
    }
    const earlier = deploys.filter((d) => d.deploySlot !== deploySlot).map(({ kind: _, ...d }) => d);
    if (earlier.length) {
      await tx
        .insert(programVersions)
        .values(earlier.map((d) => ({ program, deploySlot: d.deploySlot, role, signature: d.signature, blockTime: d.blockTime, backfilled: true })))
        .onConflictDoUpdate({
          target: [programVersions.program, programVersions.deploySlot],
          set: { signature: sql`coalesce(${programVersions.signature}, excluded.signature)`, blockTime: sql`coalesce(${programVersions.blockTime}, excluded.block_time)` },
        });
    }
    let event = false;
    if (upgraded) {
      const payload = { deploySlot: String(deploySlot), executableSha256, previousSlot: String(previousSlot) };
      event = await appendOutbox(tx as unknown as Db, role === "router" ? { kind: "router_upgraded", subject: program, slot: deploySlot, payload } : { kind: "strategy_version", subject: program, slot: deploySlot, payload });
    }
    return { deploySlot, programDataSlot, signed: own !== undefined, event, settled: true };
  });
}

/**
 * Looks again for a recorded version's deploy transaction that the RPC had not served when the
 * version was recorded, without reading the program's bytes again; says whether it is found.
 */
export async function signVersion(db: Db, source: HistorySource, { program, programData, deploySlot }: { program: string; programData: string; deploySlot: bigint }): Promise<boolean> {
  const own = (await deployHistory(source, programData)).find((d) => d.deploySlot === deploySlot);
  if (!own) return false;
  await db
    .update(programVersions)
    .set({ signature: own.signature, blockTime: own.blockTime })
    .where(and(eq(programVersions.program, program), eq(programVersions.deploySlot, deploySlot), isNull(programVersions.signature)));
  return true;
}
