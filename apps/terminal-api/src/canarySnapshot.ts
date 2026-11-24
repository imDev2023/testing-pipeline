// The snapshot `CanaryRun` posts into Canary's container (docs/spec/pipescope-architecture.md,
// "Canary runner", Snapshot; CANARY-25, CANARY-30; crates/canary/src/source.rs, `Snapshot`). The
// container has no network, so everything a run reads comes in here, read through the RPC.
//
// The first round holds what `pipeline-check`'s cloner reads before any trade, layer by layer, as
// it reads them: the market, the router's config and the router; then the strategy's registry
// account, the strategy program, the market state, the mints and the vaults; then each mint's fee
// account and transfer hook with its validation account; with every upgradeable program's
// ProgramData beside it. One `getMultipleAccounts` reads each layer. What the binary still lacks
// (accounts the strategy's resolution and the trades name) it answers with, and `addMissing` reads
// them for the next round, at most CANARY-25's rounds, which the binary counts.
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS,
  PIPELINE_PROGRAM_ADDRESS,
  PROGRAMDATA_METADATA_LEN,
  configPda,
  decodeMarket,
  decodeMint,
  feeAccountPda,
  marketMints,
  strategyPda,
} from "@pipeline-sol/sdk";
import { address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { RpcError, rpcCall } from "terminal-indexer";

/**
 * An account as a snapshot carries it. The rent epoch is a u64 that a rent-exempt account holds at
 * its largest value, past what a JavaScript number keeps exactly, so it is read and written whole.
 */
export type SnapshotAccount = { lamports: number; owner: string; executable: boolean; rent_epoch: bigint; data: string };

/** The cluster's clock when the snapshot was read. */
export type SnapshotCluster = { slot: number; epoch: number; unix_timestamp: number; genesis_hash: string | null };

/** The strategy version's instructions, for `custom_instructions` (CANARY-46, PIPESCOPE-92). */
export type SnapshotInstructions = { anchor: boolean; instructions: { name: string; calls: number; signers: string[] }[] };

/** One market's snapshot, as `POST /run` takes it. */
export type Snapshot = {
  market: string;
  round: number;
  cluster: SnapshotCluster;
  /** Every account read, by address; null where the cluster has none. */
  accounts: Record<string, SnapshotAccount | null>;
  seed?: string;
  instructions?: SnapshotInstructions;
};

/** What the binary answers when the snapshot lacks accounts a trade named. */
export type MissingAnswer = { round: number; addresses: string[]; seed: string };

/** Where a snapshot's accounts come from: the RPC, counting the requests it sends. */
export type AccountReader = {
  accounts(addresses: string[], minContextSlot?: number): Promise<(SnapshotAccount | null)[]>;
  cluster(): Promise<SnapshotCluster>;
  requests(): number;
};

/** The most accounts one `getMultipleAccounts` reads. */
const ACCOUNTS_PER_CALL = 100;

type RpcAccount = { lamports: number; owner: string; executable: boolean; rentEpoch: bigint; data: [string, "base64"] } | null;

// JSON's source text access and raw JSON (V8, in Node 24 and workerd), which TypeScript's es2023 lib does not declare.
declare global {
  interface JSON {
    parse(text: string, reviver: (key: string, value: unknown, context: { source?: string }) => unknown): unknown;
    rawJSON(text: string): unknown;
  }
}

/** Reads every `rentEpoch` of an RPC answer as a bigint, from its digits. */
const keepRentEpochs = (key: string, value: unknown, context: { source?: string }) => (key === "rentEpoch" && context.source !== undefined ? BigInt(context.source) : value);

/** A snapshot as the body of `POST /run`, every rent epoch written whole. */
export const snapshotBody = (snapshot: Snapshot): string => JSON.stringify(snapshot, (_key, value: unknown) => (typeof value === "bigint" ? JSON.rawJSON(value.toString()) : value));

/** One JSON-RPC call, like terminal-indexer's `rpcCall`, whose answer keeps rent epochs whole; its errors never quote the URL, which carries the key. */
async function rpcRead<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  } catch (e) {
    throw new RpcError(method, `no answer (${e instanceof Error ? e.name : typeof e})`);
  }
  if (!response.ok) throw new RpcError(method, `HTTP ${response.status}`);
  type Answer = { result?: T; error?: { code?: number; message?: string } };
  const text = await response.text();
  let body: Answer | null;
  try {
    body = JSON.parse(text, keepRentEpochs) as Answer | null;
  } catch {
    body = null;
  }
  if (!body) throw new RpcError(method, "an answer that is not JSON");
  if (body.error) throw new RpcError(method, body.error.message ?? "refused", body.error.code ?? null);
  return body.result as T;
}

/**
 * The RPC as a snapshot's source, read at `confirmed` as `pipeline-check`'s own RPC source reads,
 * every account at or after the clock's slot. The genesis hash never changes, so it is asked once.
 */
export function rpcAccountReader(rpcUrl: string): AccountReader {
  let requests = 0;
  let genesis: string | null | undefined;
  const call = <T>(method: string, params: unknown[]) => {
    requests++;
    return rpcCall<T>(rpcUrl, method, params);
  };
  return {
    requests: () => requests,
    async accounts(addresses, minContextSlot) {
      const out: (SnapshotAccount | null)[] = [];
      for (let i = 0; i < addresses.length; i += ACCOUNTS_PER_CALL) {
        const chunk = addresses.slice(i, i + ACCOUNTS_PER_CALL);
        requests++;
        const answer = await rpcRead<{ value: RpcAccount[] }>(rpcUrl, "getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed", ...(minContextSlot ? { minContextSlot } : {}) }]);
        for (const a of answer.value) out.push(a ? { lamports: a.lamports, owner: a.owner, executable: a.executable, rent_epoch: a.rentEpoch, data: a.data[0] } : null);
      }
      return out;
    },
    async cluster() {
      const slot = await call<number>("getSlot", [{ commitment: "confirmed" }]);
      const { epoch } = await call<{ epoch: number }>("getEpochInfo", [{ commitment: "confirmed" }]);
      // A slot just confirmed may have no block time yet; pipeline-check then takes the local clock.
      const time = await call<number | null>("getBlockTime", [slot]).catch(() => null);
      if (genesis === undefined) genesis = await call<string>("getGenesisHash", []).catch(() => null);
      return { slot, epoch, unix_timestamp: time ?? Math.floor(Date.now() / 1000), genesis_hash: genesis };
    },
  };
}

const bytesOf = (account: SnapshotAccount | null | undefined) => (account ? Uint8Array.from(Buffer.from(account.data, "base64")) : null);

/** An upgradeable program's ProgramData address, from its program account (tag 2, then the address). */
function programDataOf(account: SnapshotAccount | null | undefined): string | null {
  const data = bytesOf(account);
  if (!account || !data || account.owner !== BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS || data.length < 36) return null;
  if (new DataView(data.buffer, data.byteOffset).getUint32(0, true) !== 2) return null;
  return getAddressDecoder().decode(data.subarray(4, 36));
}

/** The SHA-256 of a ProgramData account's executable, as `solana-verify` and the indexer hash it. */
async function executableSha256(account: SnapshotAccount | null | undefined): Promise<string | null> {
  const data = bytesOf(account);
  if (!data || data.length < PROGRAMDATA_METADATA_LEN) return null;
  let end = data.length;
  while (end > PROGRAMDATA_METADATA_LEN && data[end - 1] === 0) end--;
  const digest = await crypto.subtle.digest("SHA-256", data.slice(PROGRAMDATA_METADATA_LEN, end));
  return Buffer.from(digest).toString("hex");
}

/** A transfer hook's validation account (spl-transfer-hook-interface's `["extra-account-metas", mint]`). */
async function validationAddress(hook: string, mint: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({ programAddress: address(hook), seeds: [new TextEncoder().encode("extra-account-metas"), getAddressEncoder().encode(address(mint))] });
  return pda;
}

/**
 * A market's first snapshot, round 1, with its strategy program and the hash of the strategy
 * executable it holds, so the run can tell which strategy version the chain has.
 */
export async function firstSnapshot(reader: AccountReader, market: string): Promise<{ snapshot: Snapshot; strategy: string; strategyExecutableSha256: string | null }> {
  const cluster = await reader.cluster();
  const accounts: Record<string, SnapshotAccount | null> = {};
  const read = async (wanted: (string | null)[]) => {
    const fresh = [...new Set(wanted.filter((a): a is string => a !== null && !(a in accounts)))];
    if (!fresh.length) return;
    const got = await reader.accounts(fresh, cluster.slot);
    fresh.forEach((a, i) => (accounts[a] = got[i] ?? null));
  };
  // Each program read so far, with its ProgramData read in the next layer.
  const programData = (programs: string[]) => programs.map((p) => programDataOf(accounts[p]));

  await read([market, await configPda(), PIPELINE_PROGRAM_ADDRESS]);
  const record = accounts[market]?.owner === PIPELINE_PROGRAM_ADDRESS ? decodeMarket(bytesOf(accounts[market])!) : null;
  if (!record) throw new Error(`${market} is not a Pipeline market`);
  const mints = marketMints(record);
  await read([
    ...programData([PIPELINE_PROGRAM_ADDRESS]),
    await strategyPda(record.strategyProgram),
    record.strategyProgram,
    record.marketState,
    ...mints,
    ...record.vaults.slice(0, record.mintCount),
  ]);

  const hooks: string[] = [];
  const third: (string | null)[] = [...programData([record.strategyProgram])];
  for (const mint of mints) {
    const account = accounts[mint];
    if (!account) continue;
    third.push(await feeAccountPda(address(market), mint, address(account.owner)));
    const hook = decodeMint(mint, address(account.owner), bytesOf(account)!)?.extensions.transferHook?.programId ?? null;
    if (hook) {
      hooks.push(hook);
      third.push(hook, await validationAddress(hook, mint));
    }
  }
  await read(third);
  await read(programData(hooks));

  const strategyData = programDataOf(accounts[record.strategyProgram]);
  return { snapshot: { market, round: 1, cluster, accounts }, strategy: record.strategyProgram, strategyExecutableSha256: strategyData ? await executableSha256(accounts[strategyData]) : null };
}

/** The next round's snapshot: what the binary named as missing, read at the snapshot's slot, and the seed it answered with. */
export async function addMissing(reader: AccountReader, snapshot: Snapshot, missing: MissingAnswer): Promise<Snapshot> {
  const wanted = [...new Set(missing.addresses.filter((a) => !(a in snapshot.accounts)))];
  const got = wanted.length ? await reader.accounts(wanted, snapshot.cluster.slot) : [];
  const accounts = { ...snapshot.accounts };
  wanted.forEach((a, i) => (accounts[a] = got[i] ?? null));
  return { ...snapshot, round: missing.round + 1, accounts, seed: missing.seed };
}
