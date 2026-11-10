// The cToken path the lending AMM uses: a plain wallet deposits liquidity for cTokens with `deposit_reserve_liquidity`
// and redeems them with `redeem_reserve_collateral`, with no oracle account and no refresh instruction. The plain
// cToken holder and the second depositor (the devnet wallet) both go through here; each pays its own fees.
import type { Instruction, Signature, TransactionSigner } from "@solana/kit";
import { getMintToInstruction } from "@solana-program/token";

import type { Context } from "./context.ts";
import { depositReserveLiquidity, redeemReserveCollateral } from "./kamino.ts";
import { FEE_RESERVE, topUp } from "./funding.ts";
import { decodeReserve, type ReserveView } from "./layout.ts";
import { CTOKEN_HOLDER, RESERVES, type ReserveKey } from "./policy.ts";
import { associatedTokenAccount, createAssociatedTokenAccount, wrapSol } from "./tokens.ts";

export interface DepositResult {
  signature: Signature;
  amount: bigint;
  /** cTokens the depositor received. */
  ctokens: bigint;
  before: ReserveView;
  after: ReserveView;
}

export interface RedeemResult {
  signature: Signature;
  ctokens: bigint;
  /** Liquidity the redeemer received. */
  received: bigint;
  before: ReserveView;
  after: ReserveView;
}

export async function readReserve(ctx: Context, key: ReserveKey): Promise<ReserveView> {
  const account = await ctx.chain.account(ctx.book.reserves[key].address);
  if (!account) throw new Error(`the ${RESERVES[key].label} reserve does not exist yet: run setup`);
  return decodeReserve(account.data);
}

/** The owner's token accounts for the reserve's liquidity mint and its cToken mint. */
export async function partyAccounts(ctx: Context, owner: TransactionSigner, key: ReserveKey) {
  const reserve = ctx.book.reserves[key];
  return {
    liquidity: await associatedTokenAccount(owner.address, reserve.liquidityMint),
    ctokens: await associatedTokenAccount(owner.address, reserve.collateralMint),
  };
}

/**
 * Deposits `amount` of the reserve's liquidity for cTokens. WSOL is wrapped from the owner's SOL in the same
 * transaction; test USDC is minted to the owner first by the mint authority when the owner holds too little.
 */
export async function deposit(
  ctx: Context,
  owner: TransactionSigner,
  key: ReserveKey,
  amount: bigint,
  label = `deposit into the ${RESERVES[key].label} reserve`,
): Promise<DepositResult> {
  const reserve = ctx.book.reserves[key];
  const accounts = await partyAccounts(ctx, owner, key);
  const held = await ctx.chain.tokenBalance(accounts.liquidity);
  const instructions: Instruction[] = [await createAssociatedTokenAccount(owner, owner.address, reserve.liquidityMint)];
  const wrapping = key === "wsol" && held < amount ? amount - held : 0n;
  await topUp(ctx, owner, wrapping + FEE_RESERVE, wrapping + CTOKEN_HOLDER.funding, partyName(ctx, owner));
  if (held < amount) {
    if (key === "wsol") {
      instructions.push(...wrapSol(owner, accounts.liquidity, amount - held));
    } else {
      await mintTestUsdc(ctx, owner, amount - held);
    }
  }
  instructions.push(
    await createAssociatedTokenAccount(owner, owner.address, reserve.collateralMint),
    depositReserveLiquidity(owner, ctx.book, reserve, accounts.liquidity, accounts.ctokens, amount),
  );
  const before = await readReserve(ctx, key);
  const ctokensBefore = await ctx.chain.tokenBalance(accounts.ctokens);
  const signature = await ctx.chain.send(label, instructions, owner);
  const after = await readReserve(ctx, key);
  const ctokens = (await ctx.chain.tokenBalance(accounts.ctokens)) - ctokensBefore;
  return { signature, amount, ctokens, before, after };
}

/** Redeems `ctokens` (or every cToken the owner holds) for liquidity, paid into the owner's token account. */
export async function redeem(
  ctx: Context,
  owner: TransactionSigner,
  key: ReserveKey,
  ctokens: bigint | "all",
  label = `redeem from the ${RESERVES[key].label} reserve`,
): Promise<RedeemResult> {
  const reserve = ctx.book.reserves[key];
  const accounts = await partyAccounts(ctx, owner, key);
  const held = await ctx.chain.tokenBalance(accounts.ctokens);
  const amount = ctokens === "all" ? held : ctokens;
  if (amount <= 0n || amount > held) throw new Error(`${label}: holds ${held} cTokens, asked to redeem ${amount}`);
  await topUp(ctx, owner, FEE_RESERVE, CTOKEN_HOLDER.funding, partyName(ctx, owner));
  const before = await readReserve(ctx, key);
  const liquidityBefore = await ctx.chain.tokenBalance(accounts.liquidity);
  const signature = await ctx.chain.send(
    label,
    [
      await createAssociatedTokenAccount(owner, owner.address, reserve.liquidityMint),
      redeemReserveCollateral(owner, ctx.book, reserve, accounts.ctokens, accounts.liquidity, amount),
    ],
    owner,
  );
  const after = await readReserve(ctx, key);
  const received = (await ctx.chain.tokenBalance(accounts.liquidity)) - liquidityBefore;
  return { signature, ctokens: amount, received, before, after };
}

/** Builds a deposit or redeem without sending it, for transactions Kamino is expected to refuse. */
export async function plainInstruction(
  ctx: Context,
  owner: TransactionSigner,
  key: ReserveKey,
  kind: "deposit" | "redeem",
  amount: bigint,
): Promise<Instruction> {
  const reserve = ctx.book.reserves[key];
  const accounts = await partyAccounts(ctx, owner, key);
  return kind === "deposit"
    ? depositReserveLiquidity(owner, ctx.book, reserve, accounts.liquidity, accounts.ctokens, amount)
    : redeemReserveCollateral(owner, ctx.book, reserve, accounts.ctokens, accounts.liquidity, amount);
}

/** Mints test USDC to `owner`'s token account; the script holds the mint authority, so test USDC is free. */
export async function mintTestUsdc(ctx: Context, owner: TransactionSigner, amount: bigint): Promise<Signature> {
  const { wallet, testUsdcMintAuthority } = ctx.keys;
  const mint = ctx.book.testUsdc.mint;
  return ctx.chain.send(
    "mint test USDC",
    [
      await createAssociatedTokenAccount(wallet, owner.address, mint),
      getMintToInstruction({
        mint,
        token: await associatedTokenAccount(owner.address, mint),
        mintAuthority: testUsdcMintAuthority,
        amount,
      }),
    ],
    wallet,
  );
}

/** How the script's output names a key. */
export function partyName(ctx: Context, owner: TransactionSigner): string {
  const names: Record<string, string> = {
    [ctx.keys.wallet.address]: "devnet wallet",
    [ctx.keys.ctokenHolder.address]: "plain cToken holder",
    [ctx.keys.borrower.address]: "test borrower",
    [ctx.keys.marketOwner.address]: "market owner",
  };
  return names[owner.address] ?? owner.address;
}
