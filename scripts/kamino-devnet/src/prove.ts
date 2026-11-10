// `prove`: one run that creates (or finds) our devnet Kamino lending market and proves, with real transactions,
// everything the lending AMM will ask of Kamino Lend there. Each step checks that the reserve fields decoded at the
// spec's offsets moved by exactly what the script did, and stops at the first check that fails. It ends with the
// transaction signatures and the devnet SOL spent and locked, for the ticket's closing comment.
import type { Address, Signature } from "@solana/kit";

import { borrow, borrowerPosition, repayAll, watchRate } from "./borrower.ts";
import type { Context } from "./context.ts";
import { deposit, partyAccounts, readReserve, redeem, type DepositResult, type RedeemResult } from "./ctokens.ts";
import { attemptPlain, readLendingMarket, setEmergencyMode } from "./emergency.ts";
import { CTOKEN_INSTRUCTIONS, obligationAddress, userMetadataAddress } from "./kamino.ts";
import { checkLayout, formatChecks } from "./layout-check.ts";
import { freeLiquidity, redeemValue, storedRate, storedRateRose, utilisationBps, type ReserveView } from "./layout.ts";
import { secondDepositorPosition, supplySecondDepositor, takeBack } from "./parties.ts";
import {
  CTOKEN_HOLDER,
  DEMO_TARGET_LENT_VALUE,
  KLEND_PROGRAM,
  PYTH_FEEDS,
  RATE_WATCH_SECONDS,
  RESERVES,
  RESERVE_KEYS,
  RESERVE_SEED,
  SECOND_DEPOSITOR,
  TEST_BORROWER,
  WITHDRAW_MODE_EXIT,
  WSOL_MINT,
  type ReserveKey,
} from "./policy.ts";
import { setup } from "./setup.ts";
import { statusReport, units } from "./status.ts";
import { associatedTokenAccount, tokenAmount } from "./tokens.ts";

export interface ProveOptions {
  /** How long the loan stays open before the stored rate is read again. */
  rateWatchSeconds?: number;
}

export interface ProveResult {
  created: string[];
  checks: string[];
  spentLamports: bigint;
  lockedLamports: bigint;
  summary: string;
}

const SOL_DECIMALS = 9;
const TAKE_BACK = 1_000_000_000n;

export async function prove(ctx: Context, options: ProveOptions = {}): Promise<ProveResult> {
  const checks: string[] = [];
  const expect = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`check failed: ${what}`);
    checks.push(what);
    ctx.log(`  ok: ${what}`);
  };
  const ledgerBefore = await solLedger(ctx);
  const journalStart = ctx.chain.journal.length;

  ctx.log("Setup");
  const { created } = await setup(ctx);

  ctx.log("Layout parity, as created");
  const layout = await checkLayout(ctx);
  ctx.log(formatChecks(layout));
  expect(layout.every((c) => c.ok), `all ${layout.length} layout checks pass on both reserves and the lending market`);

  ctx.log("Tidy up after an earlier run that stopped half way");
  const holder = ctx.keys.ctokenHolder;
  await setEmergencyMode(ctx, "reserve", false);
  await setEmergencyMode(ctx, "market", false);
  if ((await borrowerPosition(ctx)).debt > 0n) await repayAll(ctx);
  for (const key of RESERVE_KEYS) {
    if ((await ctx.chain.tokenBalance((await partyAccounts(ctx, holder, key)).ctokens)) > 0n) {
      const label = `plain cToken holder redeems ${RESERVES[key].label} left by an earlier run`;
      await expectRedeem(ctx, expect, key, await redeem(ctx, holder, key, "all", label));
    }
  }

  ctx.log("The plain cToken holder");
  for (const key of RESERVE_KEYS) {
    const name = RESERVES[key].label;
    const deposited = await deposit(ctx, holder, key, CTOKEN_HOLDER[key], `plain cToken holder deposits ${name}`);
    await expectDeposit(ctx, expect, key, deposited);
    const redeemed = await redeem(ctx, holder, key, deposited.ctokens, `plain cToken holder redeems ${name}`);
    await expectRedeem(ctx, expect, key, redeemed);
  }

  ctx.log("The second depositor");
  for (const key of RESERVE_KEYS) {
    const supplied = await supplySecondDepositor(ctx, key);
    if (supplied) await expectDeposit(ctx, expect, key, supplied);
    const position = await secondDepositorPosition(ctx, key);
    expect(
      position >= SECOND_DEPOSITOR[key],
      `${RESERVES[key].label}: the devnet wallet supplies ${amount(key, position)}, at least ${amount(key, SECOND_DEPOSITOR[key])}`,
    );
  }
  const wsolBefore = await readReserve(ctx, "wsol");
  expect(
    freeLiquidity(wsolBefore) >= WITHDRAW_MODE_EXIT * DEMO_TARGET_LENT_VALUE.wsol,
    `WSOL free liquidity ${amount("wsol", freeLiquidity(wsolBefore))} is above ${WITHDRAW_MODE_EXIT} x a demo market's target lent value (${amount("wsol", DEMO_TARGET_LENT_VALUE.wsol)})`,
  );

  ctx.log("The test borrower");
  const borrowed = await borrow(ctx, TEST_BORROWER.borrow);
  const position = await borrowerPosition(ctx);
  expect(position.collateralReserve === ctx.book.reserves.testUsdc.address, "the obligation's collateral is test USDC");
  expect(
    freeLiquidity(borrowed.before) - freeLiquidity(borrowed.after) === TEST_BORROWER.borrow,
    `WSOL free liquidity fell by exactly the ${amount("wsol", TEST_BORROWER.borrow)} borrowed`,
  );
  const borrowedRise = borrowed.after.borrowedAmountSf - borrowed.before.borrowedAmountSf;
  expect(
    borrowedRise >= TEST_BORROWER.borrow << 60n && borrowedRise < (TEST_BORROWER.borrow + 1n) << 60n,
    "the decoded amount borrowed rose by exactly the loan (to the lamport)",
  );
  expect(utilisationBps(borrowed.after) > 0n, `WSOL utilisation is ${units(utilisationBps(borrowed.after), 2)}%`);
  const watched = await watchRate(ctx, options.rateWatchSeconds ?? RATE_WATCH_SECONDS);
  expect(
    storedRateRose(watched.before, watched.after),
    `the stored rate rose from ${storedRate(watched.before)} to ${storedRate(watched.after)} while the loan was open (${watched.interest} lamports of interest)`,
  );
  const repaid = await repayAll(ctx);
  expect((await borrowerPosition(ctx)).debt === 0n, "the test borrower repaid in full");
  expect(repaid.after.borrowedAmountSf < 1n << 60n, "the WSOL reserve has less than a lamport borrowed after the repay");
  expect(
    freeLiquidity(repaid.after) - freeLiquidity(repaid.before) === repaid.repaid && repaid.repaid > TEST_BORROWER.borrow,
    `the repay returned ${amount("wsol", repaid.repaid)}: the loan and its interest`,
  );

  ctx.log("Emergency mode on the WSOL reserve");
  const probe = CTOKEN_HOLDER.wsol;
  await deposit(ctx, holder, "wsol", probe, "plain cToken holder deposits WSOL before emergency mode");
  await setEmergencyMode(ctx, "reserve", true);
  expect((await readReserve(ctx, "wsol")).emergencyMode === 1, "the WSOL reserve's emergency mode reads 1 at offset 4864");
  const refusedDeposit = await attemptPlain(ctx, holder, "wsol", "deposit", probe);
  expect(refusedDeposit.error === "ReserveEmergencyMode", `Kamino refused the plain deposit: ${refusedDeposit.error}`);
  const refusedRedeem = await attemptPlain(ctx, holder, "wsol", "redeem", 1n);
  expect(refusedRedeem.error === "ReserveEmergencyMode", `Kamino refused the plain redeem: ${refusedRedeem.error}`);
  await setEmergencyMode(ctx, "reserve", false);
  expect((await readReserve(ctx, "wsol")).emergencyMode === 0, "the WSOL reserve's emergency mode reads 0 again");
  await expectDeposit(ctx, expect, "wsol", await deposit(ctx, holder, "wsol", probe, "plain cToken holder deposits WSOL after emergency mode"));
  await expectRedeem(ctx, expect, "wsol", await redeem(ctx, holder, "wsol", "all", "plain cToken holder redeems WSOL after emergency mode"));

  ctx.log("Emergency mode on the whole lending market");
  await setEmergencyMode(ctx, "market", true);
  expect((await readLendingMarket(ctx)).emergencyMode === 1, "the lending market's emergency mode reads 1 at offset 122");
  const refusedMarket = await attemptPlain(ctx, holder, "wsol", "deposit", probe, "market");
  expect(refusedMarket.error === "GlobalEmergencyMode", `Kamino refused the plain deposit: ${refusedMarket.error}`);
  await setEmergencyMode(ctx, "market", false);
  expect((await readLendingMarket(ctx)).emergencyMode === 0, "the lending market's emergency mode reads 0 again");

  ctx.log("The second depositor takes some back and supplies it again");
  const taken = await takeBack(ctx, "wsol", TAKE_BACK);
  await expectRedeem(ctx, expect, "wsol", taken);
  const resupplied = await supplySecondDepositor(ctx, "wsol");
  if (resupplied) await expectDeposit(ctx, expect, "wsol", resupplied);
  expect((await secondDepositorPosition(ctx, "wsol")) >= SECOND_DEPOSITOR.wsol, "the devnet wallet's WSOL supply is back at its target");

  ctx.log("Layout parity, after the run");
  const finalLayout = await checkLayout(ctx);
  expect(finalLayout.every((c) => c.ok), `all ${finalLayout.length} layout checks still pass`);

  const status = await statusReport(ctx);
  const ledgerAfter = await solLedger(ctx);
  // Spent is what this run's transactions paid in fees, read from each one: the wallet is shared with other
  // sessions, so its balance would count their spending too. The test borrower's interest is not spent: it went to
  // the reserve's suppliers, chiefly the devnet wallet, and shows in what is locked.
  const journal = ctx.chain.journal.slice(journalStart);
  const spentLamports = await ctx.chain.fees(journal.map((entry) => entry.signature));
  const summary = [
    status.text,
    "",
    `Devnet SOL: spent ${units(spentLamports, SOL_DECIMALS)} SOL in fees on ${journal.length} transactions;`,
    `locked ${units(ledgerAfter.locked, SOL_DECIMALS)} SOL (${units(ledgerAfter.supplied, SOL_DECIMALS)} supplied by the devnet wallet, ` +
      `${units(ledgerAfter.rent, SOL_DECIMALS)} rent in the accounts created, ${units(ledgerAfter.seed, SOL_DECIMALS)} as the WSOL reserve's seed); ` +
      `this run changed what is locked by ${units(ledgerAfter.locked - ledgerBefore.locked, SOL_DECIMALS)} SOL.`,
    "",
    "| Step | Transaction | Result |",
    "| --- | --- | --- |",
    ...journal.map((e) => `| ${e.label} | [\`${short(e.signature)}\`](${explorer(ctx, e.signature)}) | ${e.ok ? "ok" : `refused: ${e.error}`} |`),
  ].join("\n");
  ctx.log("");
  ctx.log(summary);
  return { created, checks, spentLamports, lockedLamports: ledgerAfter.locked, summary };
}

type Expect = (ok: boolean, what: string) => void;

/** A cToken deposit moved the decoded fields by exactly the amount, the cTokens and the withdrawal cap. */
async function expectDeposit(ctx: Context, expect: Expect, key: ReserveKey, d: DepositResult) {
  const name = RESERVES[key].label;
  expect(
    d.after.totalAvailableAmount - d.before.totalAvailableAmount === d.amount,
    `${name}: the deposit of ${amount(key, d.amount)} raised total available by exactly that`,
  );
  expect(
    d.after.collateralMintTotalSupply - d.before.collateralMintTotalSupply === d.ctokens && d.ctokens > 0n,
    `${name}: the reserve's cToken supply rose by the ${d.ctokens} cTokens received`,
  );
  expect(capMoved(d.before, d.after, -d.amount), `${name}: the withdrawal cap's net outflow fell by the deposit`);
  await expectPlainTransaction(ctx, expect, d.signature, key, "deposit");
}

/** A cToken redeem paid at least the stored rate and moved the decoded fields by exactly what it paid. */
async function expectRedeem(ctx: Context, expect: Expect, key: ReserveKey, r: RedeemResult) {
  const name = RESERVES[key].label;
  const floor = redeemValue(r.before, r.ctokens);
  expect(
    r.received >= floor,
    `${name}: redeeming ${r.ctokens} cTokens paid ${amount(key, r.received)}, at least floor(cTokens x supply / cToken supply) = ${amount(key, floor)} at the rate stored before`,
  );
  expect(r.before.totalAvailableAmount - r.after.totalAvailableAmount === r.received, `${name}: total available fell by exactly what the redeem paid`);
  expect(r.before.collateralMintTotalSupply - r.after.collateralMintTotalSupply === r.ctokens, `${name}: the reserve's cToken supply fell by the cTokens burned`);
  expect(capMoved(r.before, r.after, r.received), `${name}: the withdrawal cap's net outflow rose by the redeem`);
  await expectPlainTransaction(ctx, expect, r.signature, key, "redeem");
}

/** The transaction's only klend instruction is the cToken deposit or redeem: no refresh and no oracle account. */
async function expectPlainTransaction(ctx: Context, expect: Expect, signature: Signature, key: ReserveKey, kind: "deposit" | "redeem") {
  const tx = await ctx.chain.transaction(signature);
  const kamino = tx.instructions.filter((ix) => ix.programId === KLEND_PROGRAM);
  const wanted = kind === "deposit" ? CTOKEN_INSTRUCTIONS.deposit_reserve_liquidity : CTOKEN_INSTRUCTIONS.redeem_reserve_collateral;
  expect(
    kamino.length === 1 && Buffer.from(kamino[0]!.discriminator).equals(Buffer.from(wanted)),
    `${RESERVES[key].label}: the ${kind} transaction holds one klend instruction and no refresh`,
  );
  expect(
    Object.values(PYTH_FEEDS).every((feed) => !tx.accounts.includes(feed)),
    `${RESERVES[key].label}: the ${kind} transaction names no oracle account`,
  );
}

/** Kamino's cap counts net outflow: deposits subtract, redeems add, and a new interval starts from 0. */
function capMoved(before: ReserveView, after: ReserveView, change: bigint): boolean {
  const restarted = after.depositWithdrawalCap.intervalStart !== before.depositWithdrawalCap.intervalStart;
  const start = restarted ? 0n : before.depositWithdrawalCap.current;
  return after.depositWithdrawalCap.current === start + change;
}

interface SolLedger {
  /** WSOL the script's keys have supplied, valued at the stored rate. */
  supplied: bigint;
  /** Rent in the accounts the script created: the market, the reserves and their vaults, the mint, the obligation, token accounts. */
  rent: bigint;
  /** Kamino's seed deposit in the WSOL reserve, which no cToken can redeem. */
  seed: bigint;
  locked: bigint;
}

async function solLedger(ctx: Context): Promise<SolLedger> {
  const keys = Object.values(ctx.keys);
  const { book } = ctx;
  const wsol = book.reserves.wsol;
  const tokenAccounts: { address: Address; mint: Address }[] = [];
  for (const key of keys) {
    for (const mint of [WSOL_MINT, book.testUsdc.mint, wsol.collateralMint, book.reserves.testUsdc.collateralMint]) {
      tokenAccounts.push({ address: await associatedTokenAccount(key.address, mint), mint });
    }
  }
  const created: Address[] = [
    book.lendingMarket.address,
    book.testUsdc.mint,
    ...RESERVE_KEYS.flatMap((k) => {
      const r = book.reserves[k];
      return [r.address, r.liquiditySupply, r.feeReceiver, r.collateralMint, r.collateralSupply];
    }),
    await obligationAddress(ctx.keys.borrower.address, book.lendingMarket.address),
    await userMetadataAddress(ctx.keys.borrower.address),
  ];
  const tokens = await ctx.chain.accounts(tokenAccounts.map((t) => t.address));
  const createdAccounts = await ctx.chain.accounts(created);
  const wsolReserve = createdAccounts[2] ? await readReserve(ctx, "wsol") : null;

  let rent = 0n;
  let supplied = 0n;
  tokens.forEach((account, i) => {
    if (!account) return;
    const amountHeld = tokenAmount(account.data);
    const mint = tokenAccounts[i]!.mint;
    if (mint === WSOL_MINT) {
      rent += account.lamports - amountHeld;
    } else {
      rent += account.lamports;
      if (mint === wsol.collateralMint && wsolReserve) supplied += redeemValue(wsolReserve, amountHeld);
    }
  });
  createdAccounts.forEach((account, i) => {
    if (!account) return;
    // The WSOL reserve's liquidity supply holds its WSOL as lamports; only the rent is ours.
    if (created[i] === wsol.liquiditySupply) {
      rent += account.lamports - tokenAmount(account.data);
    } else {
      rent += account.lamports;
    }
  });
  const seed = wsolReserve ? RESERVE_SEED : 0n;
  const locked = supplied + rent + seed;
  return { supplied, rent, seed, locked };
}

function amount(key: ReserveKey, value: bigint): string {
  return `${units(value, RESERVES[key].decimals)} ${RESERVES[key].label}`;
}

function short(signature: string): string {
  return `${signature.slice(0, 8)}...${signature.slice(-8)}`;
}

/** An explorer link: devnet's, or a local validator's by its origin (never an RPC URL, which may carry a key). */
function explorer(ctx: Context, signature: string): string {
  const url = new URL(ctx.chain.url);
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const cluster = local ? `custom&customUrl=${encodeURIComponent(url.origin)}` : "devnet";
  return `https://explorer.solana.com/tx/${signature}?cluster=${cluster}`;
}

