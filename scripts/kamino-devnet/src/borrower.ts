// The test borrower: an obligation with test USDC as collateral that borrows WSOL, so the WSOL reserve has
// utilisation, interest raises its stored rate, and the devnet demo can bring a lending AMM market into withdraw
// mode and out again. Borrowing reads the reserves' Pyth prices, which the cToken path never does.
import { Obligation } from "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Obligation.js";
import type { Address, Instruction, Signature } from "@solana/kit";

import type { Context } from "./context.ts";
import { mintTestUsdc, readReserve } from "./ctokens.ts";
import { FEE_RESERVE, topUp } from "./funding.ts";
import {
  DEFAULT_ADDRESS,
  borrowObligationLiquidity,
  depositObligationCollateral,
  initObligation,
  initUserMetadata,
  obligationAddress,
  refreshObligation,
  refreshReserve,
  repayAllObligationLiquidity,
  userMetadataAddress,
} from "./kamino.ts";
import { ceilSf, redeemValue, totalSupplySf, type ReserveView } from "./layout.ts";
import { TEST_BORROWER } from "./policy.ts";
import { associatedTokenAccount, createAssociatedTokenAccount, unwrapSol, wrapSol } from "./tokens.ts";

/**
 * WSOL wrapped on top of the debt read right after a refresh, for the interest of the seconds until the repay lands;
 * 0.01 SOL covers hours even at the curve's top rate.
 */
const REPAY_MARGIN = 10_000_000n;

export interface BorrowerPosition {
  obligation: Address;
  exists: boolean;
  collateralReserve: Address | null;
  /** cTokens of the test USDC reserve the obligation holds as collateral. */
  collateralCtokens: bigint;
  /** WSOL owed, rounded up, as of the obligation's last refresh. */
  debt: bigint;
  /** The obligation's reserves in klend's order (deposits, then borrows), for `refresh_obligation`. */
  reserves: Address[];
}

export interface BorrowResult {
  signature: Signature;
  amount: bigint;
  before: ReserveView;
  after: ReserveView;
}

export interface RateWatch {
  signature: Signature;
  before: ReserveView;
  after: ReserveView;
  /** How much the WSOL reserve's total supply grew, in lamports. */
  interest: bigint;
}

export interface RepayResult {
  signature: Signature;
  /** Principal and interest paid back, as the WSOL reserve's free liquidity measured it. */
  repaid: bigint;
  before: ReserveView;
  after: ReserveView;
}

export async function borrowerPosition(ctx: Context): Promise<BorrowerPosition> {
  const obligation = await obligationAddress(ctx.keys.borrower.address, ctx.book.lendingMarket.address);
  const account = await ctx.chain.account(obligation);
  if (!account) return { obligation, exists: false, collateralReserve: null, collateralCtokens: 0n, debt: 0n, reserves: [] };
  const decoded = Obligation.decode(Buffer.from(account.data));
  const deposits = decoded.deposits.filter((d) => d.depositReserve !== DEFAULT_ADDRESS);
  const borrows = decoded.borrows.filter((b) => b.borrowReserve !== DEFAULT_ADDRESS);
  const wsolBorrow = borrows.find((b) => b.borrowReserve === ctx.book.reserves.wsol.address);
  const debtSf = wsolBorrow ? BigInt(wsolBorrow.borrowedAmountSf.toString()) : 0n;
  return {
    obligation,
    exists: true,
    collateralReserve: deposits[0]?.depositReserve ?? null,
    collateralCtokens: deposits
      .filter((d) => d.depositReserve === ctx.book.reserves.testUsdc.address)
      .reduce((sum, d) => sum + BigInt(d.depositedAmount.toString()), 0n),
    debt: ceilSf(debtSf),
    reserves: [...deposits.map((d) => d.depositReserve), ...borrows.map((b) => b.borrowReserve)],
  };
}

/** Refreshes each reserve the obligation uses, then the obligation, as klend requires right before an action. */
async function refreshes(ctx: Context, position: BorrowerPosition, alsoReserves: Address[]): Promise<Instruction[]> {
  const order = [...new Set([...position.reserves, ...alsoReserves])];
  const entries = Object.values(ctx.book.reserves);
  // The reserve the action uses must be refreshed last, right before the obligation (klend's check_refresh).
  const last = alsoReserves.at(-1);
  const sorted = last ? [...order.filter((r) => r !== last), last] : order;
  return [
    ...sorted.map((address) => refreshReserve(ctx.book, entries.find((e) => e.address === address)!)),
    refreshObligation(ctx.book, position.obligation, position.reserves),
  ];
}

/** Opens the obligation (with its user metadata) if needed, and tops its test USDC collateral up to the policy. */
export async function ensureCollateral(ctx: Context): Promise<BorrowerPosition> {
  const { borrower } = ctx.keys;
  const usdc = ctx.book.reserves.testUsdc;
  await topUp(ctx, borrower, FEE_RESERVE * 3n, TEST_BORROWER.funding, "test borrower");
  let position = await borrowerPosition(ctx);
  if (!position.exists) {
    const metadata = await userMetadataAddress(borrower.address);
    const opening: Instruction[] = [];
    if (!(await ctx.chain.account(metadata))) opening.push(initUserMetadata(borrower, metadata));
    opening.push(initObligation(borrower, ctx.book, position.obligation, metadata));
    await ctx.chain.send("test borrower opens an obligation", opening, borrower);
    position = await borrowerPosition(ctx);
  }
  const posted = redeemValue(await readReserve(ctx, "testUsdc"), position.collateralCtokens);
  // Within 1% of the policy is enough: a top-up of a few base units is not worth a transaction.
  if (posted * 100n >= TEST_BORROWER.collateral * 99n) return position;
  const source = await associatedTokenAccount(borrower.address, usdc.liquidityMint);
  const amount = TEST_BORROWER.collateral - posted;
  const held = await ctx.chain.tokenBalance(source);
  if (held < amount) await mintTestUsdc(ctx, borrower, amount - held);
  await ctx.chain.send(
    "test borrower posts test USDC collateral",
    [...(await refreshes(ctx, position, [usdc.address])), depositObligationCollateral(borrower, ctx.book, position.obligation, usdc, source, amount)],
    borrower,
  );
  return borrowerPosition(ctx);
}

/** Borrows `amount` lamports of WSOL against the test USDC collateral, into the borrower's WSOL account. */
export async function borrow(ctx: Context, amount: bigint): Promise<BorrowResult> {
  const { borrower } = ctx.keys;
  const wsol = ctx.book.reserves.wsol;
  const position = await ensureCollateral(ctx);
  const destination = await associatedTokenAccount(borrower.address, wsol.liquidityMint);
  const before = await readReserve(ctx, "wsol");
  const signature = await ctx.chain.send(
    "test borrower borrows WSOL",
    [
      await createAssociatedTokenAccount(borrower, borrower.address, wsol.liquidityMint),
      ...(await refreshes(ctx, position, [wsol.address])),
      borrowObligationLiquidity(borrower, ctx.book, position.obligation, wsol, destination, amount),
    ],
    borrower,
  );
  return { signature, amount, before, after: await readReserve(ctx, "wsol") };
}

/** Waits, then refreshes the WSOL reserve, which accrues the interest owed since its last update into its rate. */
export async function watchRate(ctx: Context, seconds: number): Promise<RateWatch> {
  const before = await readReserve(ctx, "wsol");
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const signature = await ctx.chain.send("refresh the WSOL reserve", [refreshReserve(ctx.book, ctx.book.reserves.wsol)], ctx.keys.wallet);
  const after = await readReserve(ctx, "wsol");
  return { signature, before, after, interest: (totalSupplySf(after) - totalSupplySf(before)) >> 60n };
}

/**
 * Repays the whole WSOL debt and unwraps what is left. The obligation is refreshed first, so the debt read is current
 * however long the loan was open, and the borrower wraps that much SOL plus a margin for the seconds until the repay.
 */
export async function repayAll(ctx: Context): Promise<RepayResult> {
  const { borrower } = ctx.keys;
  const wsol = ctx.book.reserves.wsol;
  const stale = await borrowerPosition(ctx);
  if (stale.debt === 0n) throw new Error("the test borrower owes nothing");
  await ctx.chain.send("refresh the test borrower's obligation", await refreshes(ctx, stale, [wsol.address]), ctx.keys.wallet);
  const position = await borrowerPosition(ctx);
  const source = await associatedTokenAccount(borrower.address, wsol.liquidityMint);
  const held = await ctx.chain.tokenBalance(source);
  const wrapping = position.debt + REPAY_MARGIN > held ? position.debt + REPAY_MARGIN - held : 0n;
  await topUp(ctx, borrower, wrapping + FEE_RESERVE, wrapping + TEST_BORROWER.funding, "test borrower");
  const before = await readReserve(ctx, "wsol");
  const signature = await ctx.chain.send(
    "test borrower repays in full",
    [
      await createAssociatedTokenAccount(borrower, borrower.address, wsol.liquidityMint),
      ...(wrapping > 0n ? wrapSol(borrower, source, wrapping) : []),
      ...(await refreshes(ctx, position, [wsol.address])),
      repayAllObligationLiquidity(borrower, ctx.book, position.obligation, wsol, source),
      unwrapSol(borrower, source),
    ],
    borrower,
  );
  const after = await readReserve(ctx, "wsol");
  return { signature, repaid: after.totalAvailableAmount - before.totalAvailableAmount, before, after };
}
