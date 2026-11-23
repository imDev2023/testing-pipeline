// Reading programs' deploys (docs/spec/pipescope-architecture.md, Indexer, "ProgramData watch"):
// each program's last-deploy slot from the first 45 bytes of its ProgramData account, 100 programs
// to one `getMultipleAccounts`; a version's executable, hashed as Pipeline's SDK hashes it; and its
// deploys and upgrades, found in its ProgramData account's history.
import { createHash } from "node:crypto";
import { BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS, programDataPda } from "@pipeline-sol/sdk";
import { address, getAddressEncoder, getBase58Decoder } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deployHistory, readDeploySlots, readExecutable, type RawTransaction } from "../src/index";
import { fakeRpc, type FakeRpc } from "./fakeRpc";
import { programAddress, programDataAccount, upgradeTransaction } from "./programs";

let rpc: FakeRpc;
beforeEach(async () => {
  rpc = await fakeRpc();
});
afterEach(async () => {
  await rpc.close();
});

describe("readDeploySlots", () => {
  it("reads 100 programs' deploy slots in one request of 45 bytes an account, and 101 in two", async () => {
    const programs = await Promise.all(Array.from({ length: 101 }, (_, i) => programAddress(i)));
    for (const [i, program] of programs.entries()) rpc.accounts.set(await programDataPda(address(program)), programDataAccount(500_000_000n + BigInt(i), new Uint8Array(4096).fill(7)));

    const slots = await readDeploySlots(rpc.url, programs.slice(0, 100));
    expect(rpc.requests).toEqual([{ method: "getMultipleAccounts", params: [expect.any(Array), { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 45 } }] }]);
    expect(slots.get(programs[42]!)).toEqual({ programData: await programDataPda(address(programs[42]!)), deploySlot: 500_000_042n });

    rpc.requests.length = 0;
    await readDeploySlots(rpc.url, programs);
    expect(rpc.requests.map((r) => r.method)).toEqual(["getMultipleAccounts", "getMultipleAccounts"]);
  });

  it("gives null for a program with no ProgramData account, such as one not deployed by the upgradeable loader or closed", async () => {
    const program = await programAddress(0);
    expect((await readDeploySlots(rpc.url, [program])).get(program)).toBeNull();
  });
});

describe("readExecutable", () => {
  it("hashes the executable after the 45-byte header without its trailing zeros, as Pipeline's SDK and solana-verify do", async () => {
    const program = await programAddress(1);
    const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]);
    const padded = new Uint8Array(64);
    padded.set(elf);
    const programData = await programDataPda(address(program));
    rpc.accounts.set(programData, programDataAccount(512n, padded));
    const executable = await readExecutable(rpc.url, programData);
    expect(executable).toEqual({ deploySlot: 512n, executableSha256: createHash("sha256").update(elf).digest("hex"), code: elf });
  });

  it("gives null when the account is no ProgramData", async () => {
    const programData = await programDataPda(address(await programAddress(2)));
    rpc.accounts.set(programData, { owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS, data: new Uint8Array(45).fill(1) });
    expect(await readExecutable(rpc.url, programData)).toBeNull();
  });
});

describe("deployHistory", () => {
  it("finds each deploy and upgrade of the program in its ProgramData account's history, oldest first, and passes over failed ones, extensions, which add room and change no code, and other loader instructions", async () => {
    const program = await programAddress(3);
    const programData = await programDataPda(address(program));
    const deploy = upgradeTransaction({ kind: "deploy", program, programData, slot: 400, signature: "deploy" });
    const failed = { ...upgradeTransaction({ kind: "upgrade", program, programData, slot: 410, signature: "failed" }), meta: { err: { InstructionError: [0, "Custom"] } } } as RawTransaction;
    const authority = upgradeTransaction({ kind: "setAuthority", program, programData, slot: 420, signature: "authority" });
    const extend = upgradeTransaction({ kind: "extend", program, programData, slot: 425, signature: "extend" });
    const upgrade = upgradeTransaction({ kind: "upgrade", program, programData, slot: 430, signature: "upgrade" });
    rpc.history.push(deploy, failed, authority, extend, upgrade);
    expect(await deployHistory(rpc.url, programData)).toEqual([
      { deploySlot: 400n, signature: "deploy", blockTime: new Date(400_000) },
      { deploySlot: 430n, signature: "upgrade", blockTime: new Date(430_000) },
    ]);
  });
});

// The helpers build real loader accounts and transactions; check one against the loader's layout here.
it("builds ProgramData accounts in the loader's layout", () => {
  const account = programDataAccount(7n, Uint8Array.of(9));
  expect([...account.data.subarray(0, 13)]).toEqual([3, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0, 1]);
  expect(getBase58Decoder().decode(account.data.subarray(13, 45))).toBe(getBase58Decoder().decode(getAddressEncoder().encode(address("8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2"))));
});
