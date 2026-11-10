// Emergency mode on our devnet lending market: its owner turns the WSOL reserve's emergency mode (or the whole
// market's) on and off, and a plain wallet's deposit or redeem is tried while it is on, to show Kamino refuses it.
import type { Signature, TransactionSigner } from "@solana/kit";

import type { FailedTransaction } from "./chain.ts";
import type { Context } from "./context.ts";
import { partyAccounts, plainInstruction, readReserve } from "./ctokens.ts";
import { setMarketEmergencyMode, setReserveEmergencyMode } from "./kamino.ts";
import { decodeLendingMarket, type LendingMarketView } from "./layout.ts";
import { RESERVES, type ReserveKey } from "./policy.ts";
import { createAssociatedTokenAccount, wrapSol } from "./tokens.ts";

export type EmergencyScope = "reserve" | "market";

export async function readLendingMarket(ctx: Context): Promise<LendingMarketView> {
  const account = await ctx.chain.account(ctx.book.lendingMarket.address);
  if (!account) throw new Error("the lending market does not exist yet: run setup");
  return decodeLendingMarket(account.data);
}

/**
 * Sets emergency mode on the WSOL reserve (`reserve`) or the whole lending market (`market`), signed by the market
 * owner; returns null when it was already so.
 */
export async function setEmergencyMode(
  ctx: Context,
  scope: EmergencyScope,
  on: boolean,
  key: ReserveKey = "wsol",
): Promise<Signature | null> {
  const { marketOwner, wallet } = ctx.keys;
  const flag = scope === "market" ? (await readLendingMarket(ctx)).emergencyMode : (await readReserve(ctx, key)).emergencyMode;
  if ((flag === 1) === on) return null;
  const what = scope === "market" ? "the lending market" : `the ${RESERVES[key].label} reserve`;
  return ctx.chain.send(
    `turn ${what}'s emergency mode ${on ? "on" : "off"}`,
    [
      scope === "market"
        ? setMarketEmergencyMode(marketOwner, ctx.book, on)
        : setReserveEmergencyMode(marketOwner, ctx.book, ctx.book.reserves[key].address, on),
    ],
    wallet,
  );
}

/**
 * Tries a plain deposit or redeem that Kamino is expected to refuse, and lands the refusal on chain. A deposit wraps
 * the WSOL it needs in the same transaction, so the refusal can only be Kamino's.
 */
export async function attemptPlain(
  ctx: Context,
  owner: TransactionSigner,
  key: ReserveKey,
  kind: "deposit" | "redeem",
  amount: bigint,
  scope: EmergencyScope = "reserve",
): Promise<FailedTransaction> {
  const reserve = ctx.book.reserves[key];
  const accounts = await partyAccounts(ctx, owner, key);
  const prepare = [
    await createAssociatedTokenAccount(owner, owner.address, reserve.liquidityMint),
    await createAssociatedTokenAccount(owner, owner.address, reserve.collateralMint),
  ];
  if (kind === "deposit" && key === "wsol") {
    const held = await ctx.chain.tokenBalance(accounts.liquidity);
    if (held < amount) prepare.push(...wrapSol(owner, accounts.liquidity, amount - held));
  }
  if (kind === "redeem" && (await ctx.chain.tokenBalance(accounts.ctokens)) < amount) {
    throw new Error(`a refused redeem needs ${amount} cTokens in hand, so only emergency mode can refuse it`);
  }
  return ctx.chain.sendExpectingFailure(
    `plain ${kind} on the ${RESERVES[key].label} reserve while ${scope === "market" ? "the lending market's" : "its"} emergency mode is on`,
    [...prepare, await plainInstruction(ctx, owner, key, kind, amount)],
    owner,
  );
}
