// Programs as the upgradeable loader keeps them, for the tests: ProgramData accounts and the loader's
// deploy, upgrade and set-authority transactions, in the layout `getTransaction` serves with `json`
// encoding.
import { BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { address, getAddressDecoder, getAddressEncoder, getBase58Decoder } from "@solana/kit";
import type { RawTransaction } from "../src/decode";
import { historySource } from "../src/history";
import type { ProgramReader } from "../src/versions";
import type { FakeAccount } from "./fakeRpc";

const base58 = getBase58Decoder();
const AUTHORITY = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";
const SYSTEM = "11111111111111111111111111111111";
const RENT = "SysvarRent111111111111111111111111111111111";
const CLOCK = "SysvarC1ock11111111111111111111111111111111";

/** How long the tests' history source waits for a block the RPC has not served: briefly. */
const TEST_BLOCK_WAITS = { waitMs: 2_000, firstRetryMs: 100, maxRetryMs: 400 };

/** Where the tests read versions from: the RPC at `rpcUrl`, and a history source on it. */
export const programReader = (rpcUrl: string): ProgramReader => ({ rpcUrl, source: historySource(rpcUrl, TEST_BLOCK_WAITS) });

/** A distinct, valid address for the i-th test program. */
export async function programAddress(i: number): Promise<string> {
  const bytes = new Uint8Array(32).fill(0x11);
  bytes[0] = i & 0xff;
  bytes[1] = (i >> 8) & 0xff;
  return getAddressDecoder().decode(bytes);
}

/** `UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address: Some(AUTHORITY) }`, then the executable. */
export function programDataAccount(slot: bigint, executable: Uint8Array): FakeAccount {
  const data = new Uint8Array(45 + executable.length);
  const view = new DataView(data.buffer);
  view.setUint32(0, 3, true);
  view.setBigUint64(4, slot, true);
  data[12] = 1;
  data.set(getAddressEncoder().encode(address(AUTHORITY)), 13);
  data.set(executable, 45);
  return { owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS, data };
}

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

/** A loader transaction on the program: `DeployWithMaxDataLen` (2), `Upgrade` (3), `ExtendProgram` (6) or `SetAuthority` (4), signed by the authority. */
export function upgradeTransaction({ kind, program, programData, slot, signature, blockIndex = 0 }: { kind: "deploy" | "upgrade" | "extend" | "setAuthority"; program: string; programData: string; slot: number; signature: string; blockIndex?: number }): RawTransaction {
  const buffer = "Buffer1111111111111111111111111111111111111";
  const keys =
    kind === "deploy"
      ? [AUTHORITY, programData, program, buffer, RENT, CLOCK, SYSTEM, BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS]
      : kind === "upgrade"
        ? [AUTHORITY, programData, program, buffer, RENT, CLOCK, BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS]
        : kind === "extend"
          ? [AUTHORITY, programData, program, SYSTEM, BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS]
          : [AUTHORITY, programData, BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS];
  const accounts = kind === "deploy" ? [0, 1, 2, 3, 4, 5, 6, 0] : kind === "upgrade" ? [1, 2, 3, 0, 4, 5, 0] : kind === "extend" ? [1, 2, 3, 0] : [1, 0];
  const data =
    kind === "deploy" ? Uint8Array.from([...u32(2), 0, 16, 0, 0, 0, 0, 0, 0]) : kind === "extend" ? Uint8Array.from([...u32(6), 0, 4, 0, 0]) : u32(kind === "upgrade" ? 3 : 4);
  return {
    slot,
    blockTime: slot,
    transactionIndex: blockIndex,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: keys,
        header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 3 },
        instructions: [{ programIdIndex: keys.length - 1, accounts, data: base58.decode(data) }],
      },
    },
    meta: { err: null, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] } },
  };
}
