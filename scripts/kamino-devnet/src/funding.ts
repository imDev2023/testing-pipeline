// Keeps the script's own keys funded from the devnet wallet, which itself is topped up with `devnet-airdrop`.
import type { TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";

import type { Context } from "./context.ts";

/** SOL kept for transaction fees and token account rent on top of what an action spends. */
export const FEE_RESERVE = 10_000_000n;

/**
 * Makes sure `who` holds at least `needed` lamports, sending it up to `target` from the wallet when it holds less.
 * The wallet funds itself through `devnet-airdrop`, so it is never topped up here.
 */
export async function topUp(ctx: Context, who: TransactionSigner, needed: bigint, target: bigint, name: string) {
  if (who.address === ctx.keys.wallet.address) return;
  const balance = await ctx.chain.balance(who.address);
  if (balance >= needed) return;
  const goal = target > needed ? target : needed;
  await ctx.chain.send(
    `fund the ${name}`,
    [getTransferSolInstruction({ source: ctx.keys.wallet, destination: who.address, amount: goal - balance })],
    ctx.keys.wallet,
  );
}
