// What a wallet holds in a market's mints, read through RPC (docs/spec/pipescope-architecture.md, API:
// balances "read through RPC"), for the balance the trade box shows under the mint paid. Wrapped SOL
// is answered with the wallet's plain SOL, since a swap paying in it wraps SOL for the trader.
import { NATIVE_MINT_ADDRESS } from "@pipeline-sol/sdk";
import { findAssociatedTokenPda } from "@solana-program/token";
import { address, getBase64Encoder, type Address, type Rpc, type SolanaRpcApi } from "@solana/kit";
import type { Balances } from "../contract";

const base64 = getBase64Encoder();
const AMOUNT_OFFSET = 64;

export async function readBalances(rpc: Rpc<SolanaRpcApi>, trader: Address, mints: Address[]): Promise<Balances> {
  const [wallet, ...mintAccounts] = (await rpc.getMultipleAccounts([trader, ...mints], { encoding: "base64", commitment: "confirmed" }).send()).value;
  // Each mint's associated token account, under the token program that owns the mint.
  const atas = await Promise.all(mints.map(async (mint, i) => (mintAccounts[i] ? (await findAssociatedTokenPda({ owner: trader, mint, tokenProgram: mintAccounts[i].owner }))[0] : null)));
  const wanted = atas.filter((a): a is Address => a !== null);
  const held = wanted.length ? (await rpc.getMultipleAccounts(wanted, { encoding: "base64", commitment: "confirmed" }).send()).value : [];
  const amountOf = (ata: Address | null): bigint => {
    const account = ata ? held[wanted.indexOf(ata)] : null;
    if (!account) return 0n;
    const bytes = new Uint8Array(base64.encode(account.data[0]));
    return bytes.length >= AMOUNT_OFFSET + 8 ? new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(AMOUNT_OFFSET, true) : 0n;
  };
  return {
    trader,
    balances: mints.map((mint, i) => ({ mint, amount: String(mint === NATIVE_MINT_ADDRESS ? (wallet?.lamports ?? 0n) : amountOf(atas[i]!)) })),
  };
}

export const parseMints = (raw: string | undefined): Address[] | null => {
  const list = (raw ?? "").split(",").filter(Boolean);
  if (!list.length || list.length > 4 || !list.every((m) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m))) return null;
  return list.map((m) => address(m));
};
