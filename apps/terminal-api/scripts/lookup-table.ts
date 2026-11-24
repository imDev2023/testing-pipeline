// Makes Aviary's own address lookup table on a cluster (PIPESCOPE-160): creates it, extends it with
// what `aviaryLookupTableAddresses` lists for every strategy registered with Pipeline's router now,
// then freezes it, so nobody, its maker included, can ever change what it holds. The API reads it
// through `AVIARY_LOOKUP_TABLE` (wrangler.jsonc's var for devnet; `--var` for a local validator's).
//
//   node apps/terminal-api/scripts/lookup-table.ts [--url <rpc>] [--key wallet]
//
// The key, which pays and is the table's authority until the freeze, is
// ~/.config/testing-pipeline/devnet/<key>.json; the RPC is --url, or RPC_URL from the project's .env.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { fetchStrategies } from "@pipeline-sol/sdk";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { aviaryLookupTableAddresses } from "../src/trading/lookupTable.ts";

const LOOKUP_TABLE_PROGRAM = address("AddressLookupTab1e1111111111111111111111111");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
/** The most addresses one extend instruction carries and still fits a transaction. */
const PER_EXTEND = 20;

const u32 = (n: number) => new Uint8Array(new Uint32Array([n]).buffer);
const u64 = (n: bigint) => new Uint8Array(new BigUint64Array([n]).buffer);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((total, p) => total + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** The address lookup table program's instructions, as its `ProgramInstruction` enum encodes them (a u32 tag, then the fields). */
const tableInstructions = (authority: Address, payer: Address, table: Address) => ({
  create: (recentSlot: bigint, bump: number): Instruction => ({
    programAddress: LOOKUP_TABLE_PROGRAM,
    accounts: [
      { address: table, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: concat(u32(0), u64(recentSlot), new Uint8Array([bump])),
  }),
  extend: (addresses: readonly Address[]): Instruction => ({
    programAddress: LOOKUP_TABLE_PROGRAM,
    accounts: [
      { address: table, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
    ],
    data: concat(u32(2), u64(BigInt(addresses.length)), ...addresses.map((a) => new Uint8Array(getAddressEncoder().encode(a)))),
  }),
  freeze: (): Instruction => ({
    programAddress: LOOKUP_TABLE_PROGRAM,
    accounts: [
      { address: table, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
    ],
    data: u32(1),
  }),
});

async function send(rpc: ReturnType<typeof createSolanaRpc>, signer: KeyPairSigner, instructions: Instruction[], what: string): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  const signature = getSignatureFromTransaction(signed);
  await rpc.sendTransaction(getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed" }).send();
  for (let attempt = 0; ; attempt++) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    if (value[0]?.err) throw new Error(`${what} failed (${signature}): ${JSON.stringify(value[0].err, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v))}`);
    if (value[0]?.confirmationStatus === "confirmed" || value[0]?.confirmationStatus === "finalized") break;
    if (attempt > 60) throw new Error(`${what} did not confirm (${signature})`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
  console.log(`${what}: ${signature}`);
  return signature;
}

async function main() {
  const { values } = parseArgs({ options: { url: { type: "string" }, key: { type: "string", default: "wallet" } } });
  if (!/^[a-z0-9-]+$/.test(values.key)) throw new Error("--key names a key file in ~/.config/testing-pipeline/devnet/, such as wallet");
  const rpcUrl = values.url ?? process.env.RPC_URL;
  if (!rpcUrl) throw new Error("Pass --url, or run with the project's .env loaded for RPC_URL.");
  const rpc = createSolanaRpc(rpcUrl);
  const signer = await createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(`${homedir()}/.config/testing-pipeline/devnet/${values.key}.json`, "utf8")) as number[]));

  const strategies = (await fetchStrategies(rpc)).map((s) => s.account.programId);
  const addresses = await aviaryLookupTableAddresses(strategies);
  console.log(`${addresses.length} addresses: the fixed accounts and ${strategies.length} strategies' records`);

  const recentSlot = await rpc.getSlot({ commitment: "finalized" }).send();
  const [table, bump] = await getProgramDerivedAddress({ programAddress: LOOKUP_TABLE_PROGRAM, seeds: [getAddressEncoder().encode(signer.address), u64(recentSlot)] });
  const make = tableInstructions(signer.address, signer.address, table);
  await send(rpc, signer, [make.create(recentSlot, bump)], `created ${table}`);
  for (let i = 0; i < addresses.length; i += PER_EXTEND) await send(rpc, signer, [make.extend(addresses.slice(i, i + PER_EXTEND))], `extended with addresses ${i + 1} to ${Math.min(i + PER_EXTEND, addresses.length)}`);
  await send(rpc, signer, [make.freeze()], "frozen: nobody can change it again");

  // A table's addresses follow its 56-byte header, 32 bytes each.
  const { value: account } = await rpc.getAccountInfo(table, { encoding: "base64", commitment: "confirmed" }).send();
  const bytes = account ? Buffer.from(account.data[0], "base64") : Buffer.alloc(0);
  const held = Array.from({ length: Math.floor((bytes.length - 56) / 32) }, (_, i) => getAddressDecoder().decode(bytes.subarray(56 + 32 * i, 88 + 32 * i)));
  if (held.join() !== addresses.join()) throw new Error(`${table} does not hold what was sent`);
  console.log(`AVIARY_LOOKUP_TABLE=${table}`);
}

await main();
