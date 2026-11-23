// Programs and their deploys (docs/spec/pipescope-architecture.md, Indexer, "ProgramData watch").
// A program the upgradeable loader deployed keeps its code in a ProgramData account at the PDA of
// the program's address, whose first 45 bytes are the loader's header: a u32 tag (3), the u64 slot
// of the last deploy, and the upgrade authority as an `Option<Pubkey>`. Reading only that header for
// 100 programs at once is the watch; a changed slot is a new version, whose whole executable is then
// read once, and whose transaction is found in the ProgramData account's history.
import { BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS, inspectProgram, PROGRAMDATA_METADATA_LEN, programDataPda, type Flag } from "@pipeline-sol/sdk";
import { address, createSolanaRpc, getAddressDecoder, getBase58Encoder } from "@solana/kit";
import { accountKeysOf, type CompiledInstruction, type RawTransaction } from "./decode";
import type { Cursor, HistorySource } from "./history";
import { rpcCall } from "./rpc";

/** The most accounts one `getMultipleAccounts` reads. */
const PROGRAMS_PER_CALL = 100;
/** `UpgradeableLoaderState::ProgramData`'s tag. */
const PROGRAMDATA_TAG = 3;
/**
 * The loader's instructions that write a ProgramData account's slot. `DeployWithMaxDataLen` (2) and
 * `Upgrade` (3) put new code there, each a new version; `ExtendProgram` (6) and
 * `ExtendProgramChecked` (9) only make room, keeping the code, and come just before an upgrade that
 * needs it.
 */
const DEPLOYING_INSTRUCTIONS = new Set([2, 3]);
const EXTENDING_INSTRUCTIONS = new Set([6, 9]);

type AccountInfo = { owner: string; data: [string, "base64"] } | null;

/** Where a program's code is, the slot it was last deployed in, and who can upgrade it (null: frozen). */
export type DeploySlot = { programData: string; deploySlot: bigint; upgradeAuthority: string | null };

/** A program's facts as Pipeline's SDK words them: its upgrade authority, and `upgradeable`, `frozen` or `program-missing`. */
export type ProgramFacts = { upgradeAuthority: string | null; flags: Flag[] };

const bytesOf = (info: AccountInfo) => (info ? Uint8Array.from(Buffer.from(info.data[0], "base64")) : null);

/** The slot in a ProgramData account's header, or null when the bytes are no ProgramData. */
function slotOf(info: AccountInfo): bigint | null {
  const data = bytesOf(info);
  if (!info || !data || info.owner !== BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS || data.length < 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return view.getUint32(0, true) === PROGRAMDATA_TAG ? view.getBigUint64(4, true) : null;
}

const addressDecoder = getAddressDecoder();

/** The upgrade authority in a ProgramData header, an `Option<Pubkey>` at byte 12, or null when there is none. */
function authorityOf(info: AccountInfo): string | null {
  const data = bytesOf(info);
  return data && data.length >= PROGRAMDATA_METADATA_LEN && data[12] === 1 ? addressDecoder.decode(data.subarray(13, 45)) : null;
}

/**
 * Each program's last-deploy slot, from its ProgramData account's header alone: one
 * `getMultipleAccounts` with a 45-byte `dataSlice` per 100 programs. A program with no ProgramData
 * account (one not deployed by the upgradeable loader, or closed) is null.
 */
export async function readDeploySlots(rpcUrl: string, programs: string[]): Promise<Map<string, DeploySlot | null>> {
  const wanted = [...new Set(programs)].sort();
  const programData = await Promise.all(wanted.map((p) => programDataPda(address(p))));
  const slots = new Map<string, DeploySlot | null>();
  for (let i = 0; i < wanted.length; i += PROGRAMS_PER_CALL) {
    const chunk = programData.slice(i, i + PROGRAMS_PER_CALL);
    const answer = await rpcCall<{ value: AccountInfo[] }>(rpcUrl, "getMultipleAccounts", [
      chunk,
      { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: PROGRAMDATA_METADATA_LEN } },
    ]);
    chunk.forEach((pd, j) => {
      const info = answer.value[j] ?? null;
      const deploySlot = slotOf(info);
      slots.set(wanted[i + j]!, deploySlot === null ? null : { programData: pd, deploySlot, upgradeAuthority: authorityOf(info) });
    });
  }
  return slots;
}

/**
 * Each program's facts as Pipeline's SDK's `inspectProgram` gives them. A program the upgradeable
 * loader deployed (every Pipeline strategy so far) is told from the header the watch already read:
 * upgradeable while it has an upgrade authority, frozen once it has none. Any other (closed, or
 * another loader's) is asked of the SDK itself, which reads its account.
 */
export async function readProgramFacts(rpcUrl: string, slots: Map<string, DeploySlot | null>): Promise<Map<string, ProgramFacts>> {
  const facts = new Map<string, ProgramFacts>();
  for (const [program, slot] of slots) {
    if (slot) {
      facts.set(program, { upgradeAuthority: slot.upgradeAuthority, flags: [slot.upgradeAuthority ? "upgradeable" : "frozen"] });
      continue;
    }
    // One program the RPC will not answer for is left out, keeping its facts as they were; it never stops the others or the watch.
    try {
      const inspected = await inspectProgram(createSolanaRpc(rpcUrl), address(program), { hashExecutable: false });
      facts.set(program, { upgradeAuthority: inspected.upgradeAuthority, flags: inspected.flags });
    } catch (e) {
      console.error(`reading ${program}'s program account failed; its facts stay as they were`, e);
    }
  }
  return facts;
}

/** A version's executable: its code, and its hash as Pipeline's SDK and `solana-verify get-program-hash` compute it. */
export type Executable = { deploySlot: bigint; executableSha256: string; code: Uint8Array };

/** The code after the 45-byte header, without trailing zero bytes, as `solana-verify` hashes it. */
function trimmed(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

/** Reads a ProgramData account whole, once per version: its slot, its code and the code's hash; null when it is no ProgramData. */
export async function readExecutable(rpcUrl: string, programData: string): Promise<Executable | null> {
  const answer = await rpcCall<{ value: AccountInfo }>(rpcUrl, "getAccountInfo", [programData, { encoding: "base64", commitment: "confirmed" }]);
  const deploySlot = slotOf(answer.value);
  const data = bytesOf(answer.value);
  if (deploySlot === null || !data || data.length < PROGRAMDATA_METADATA_LEN) return null;
  const code = trimmed(data.subarray(PROGRAMDATA_METADATA_LEN));
  const digest = await crypto.subtle.digest("SHA-256", code as Uint8Array<ArrayBuffer>);
  return { deploySlot, executableSha256: Buffer.from(digest).toString("hex"), code };
}

/** One deploy of a program, found in its ProgramData account's history. */
export type Deploy = { deploySlot: bigint; signature: string; blockTime: Date | null };

/** A transaction that wrote a ProgramData account's slot: a deploy (new code) or an extension (room only). */
export type ProgramDataWrite = Deploy & { kind: "deploy" | "extend" };

const base58 = getBase58Encoder();

/** The loader's instruction tag, when the instruction is the loader's on this ProgramData account. */
function loaderTag(instruction: CompiledInstruction, keys: string[], programData: string): number | null {
  if (keys[instruction.programIdIndex] !== BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS) return null;
  if (!(instruction.accounts ?? []).some((i) => keys[i] === programData)) return null;
  const data = base58.encode(instruction.data);
  return data.length >= 4 ? data[0]! | (data[1]! << 8) | (data[2]! << 16) | (data[3]! << 24) : null;
}

/**
 * What a successful transaction did to the program's code, at its top level or through another
 * program (a multisig's upgrade): deployed it, only extended it, or neither.
 */
export function programDataWriteOf(raw: RawTransaction, programData: string): ProgramDataWrite["kind"] | null {
  if (raw.meta === null || raw.meta.err !== null) return null;
  const keys = accountKeysOf(raw);
  const tags = [...(raw.transaction.message.instructions ?? []), ...(raw.meta.innerInstructions ?? []).flatMap((g) => g.instructions)].map((ix) => loaderTag(ix, keys, programData));
  if (tags.some((t) => t !== null && DEPLOYING_INSTRUCTIONS.has(t))) return "deploy";
  if (tags.some((t) => t !== null && EXTENDING_INSTRUCTIONS.has(t))) return "extend";
  return null;
}

/** Every write of a program's ProgramData slot, oldest first, from the account's whole history, which holds only the loader's transactions and is short. */
export async function programDataHistory(source: HistorySource, programData: string): Promise<ProgramDataWrite[]> {
  const found: ProgramDataWrite[] = [];
  let cursor: Cursor | null = null;
  for (;;) {
    const { transactions, more } = await source.after(programData, cursor, 100);
    for (const raw of transactions) {
      const kind = programDataWriteOf(raw, programData);
      if (kind) found.push({ kind, deploySlot: BigInt(raw.slot), signature: raw.transaction.signatures[0]!, blockTime: raw.blockTime === null ? null : new Date(raw.blockTime * 1000) });
      cursor = { signature: raw.transaction.signatures[0]!, slot: raw.slot, blockIndex: raw.transactionIndex ?? null };
    }
    if (!more || transactions.length === 0) return found;
  }
}

/** Every deploy and upgrade of a program, oldest first: its versions. */
export async function deployHistory(source: HistorySource, programData: string): Promise<Deploy[]> {
  return (await programDataHistory(source, programData)).filter((w) => w.kind === "deploy").map(({ kind: _, ...deploy }) => deploy);
}
