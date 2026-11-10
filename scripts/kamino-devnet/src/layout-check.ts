// `layout`: reads each reserve and the lending market back from the cluster and checks that they have the size,
// the owner, the discriminator and the field offsets the lending AMM relies on. Every field the spec names is read
// twice, at the spec's offsets (src/layout.ts) and with Kamino's IDL layout, and the identity and config fields are
// compared with what the setup created and configured. `prove` adds the checks that need an action: that deposits,
// redeems, borrows and the flags move the decoded fields by exactly what the script did.
import { LendingMarket } from "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/LendingMarket.js";
import { Reserve } from "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve.js";

import type { Context } from "./context.ts";
import {
  LENDING_MARKET_DISCRIMINATOR,
  LENDING_MARKET_SIZE,
  RESERVE_DISCRIMINATOR,
  RESERVE_SIZE,
  DEPRECATED_RESERVE_VERSION,
  decodeLendingMarket,
  decodeReserve,
} from "./layout.ts";
import { KLEND_PROGRAM, RESERVES, RESERVE_KEYS, RESERVE_SEED } from "./policy.ts";

/** 2022-01-01, before Kamino Lend's first release: no last update can be older. */
const FIRST_KLEND_RELEASE = 1_640_995_200;

export interface LayoutCheck {
  account: string;
  check: string;
  ok: boolean;
  detail: string;
}

export async function checkLayout(ctx: Context): Promise<LayoutCheck[]> {
  const { book } = ctx;
  const checks: LayoutCheck[] = [];
  const add = (account: string, check: string, actual: unknown, expected: unknown) =>
    checks.push({ account, check, ok: same(actual, expected), detail: `${show(actual)}${same(actual, expected) ? "" : `, expected ${show(expected)}`}` });

  const [marketAccount, ...reserveAccounts] = await ctx.chain.accounts([
    book.lendingMarket.address,
    ...RESERVE_KEYS.map((key) => book.reserves[key].address),
  ]);
  if (!marketAccount) throw new Error("the lending market does not exist yet: run setup");
  const m = "lending market";
  add(m, "owner program", marketAccount.owner, KLEND_PROGRAM);
  add(m, "size", marketAccount.data.length, LENDING_MARKET_SIZE);
  add(m, "discriminator", hex(marketAccount.data.subarray(0, 8)), hex(LENDING_MARKET_DISCRIMINATOR));
  const market = decodeLendingMarket(marketAccount.data);
  const marketIdl = LendingMarket.decode(Buffer.from(marketAccount.data));
  add(m, "owner at 24", market.owner, book.lendingMarket.owner);
  add(m, "emergency mode at 122 matches the IDL layout", market.emergencyMode, marketIdl.emergencyMode);
  add(m, "borrow disabled at 124 matches the IDL layout", market.borrowDisabled, marketIdl.borrowDisabled);

  for (const [i, key] of RESERVE_KEYS.entries()) {
    const account = reserveAccounts[i];
    const entry = book.reserves[key];
    const name = `${RESERVES[key].label} reserve`;
    if (!account) throw new Error(`the ${name} does not exist yet: run setup`);
    add(name, "owner program", account.owner, KLEND_PROGRAM);
    add(name, "size", account.data.length, RESERVE_SIZE);
    add(name, "discriminator", hex(account.data.subarray(0, 8)), hex(RESERVE_DISCRIMINATOR));
    const r = decodeReserve(account.data);
    const idl = Reserve.decode(Buffer.from(account.data));
    const policy = RESERVES[key];

    add(name, "lending market at 32", r.lendingMarket, book.lendingMarket.address);
    add(name, "liquidity mint at 128", r.liquidityMint, entry.liquidityMint);
    add(name, "liquidity supply at 160", r.liquiditySupply, entry.liquiditySupply);
    add(name, "fee vault at 192", r.feeVault, entry.feeReceiver);
    add(name, "collateral mint at 2560", r.collateralMint, entry.collateralMint);
    add(name, "collateral supply at 2600", r.collateralSupply, entry.collateralSupply);
    add(name, "version at 8 matches the IDL layout", r.version, BigInt(idl.version.toString()));
    add(name, "version at 8 is not the deprecated marker", r.version !== DEPRECATED_RESERVE_VERSION, true);
    add(name, "deposit limit at 5016", r.depositLimit, policy.depositLimit);
    add(name, "borrow rate curve at 4920", r.borrowRateCurve, policy.borrowRateCurve);
    add(name, "withdrawal cap capacity at 5416", r.depositWithdrawalCap.capacity, policy.depositWithdrawalCap.capacity);
    add(name, "withdrawal cap interval at 5440", r.depositWithdrawalCap.intervalLength, policy.depositWithdrawalCap.intervalSeconds);
    add(name, "status at 4856 (active)", r.status, 0);
    add(name, "block cToken usage at 4862 (off)", r.blockCtokenUsage, 0);
    add(name, "emergency mode at 4864 matches the IDL layout", r.emergencyMode, idl.config.emergencyMode);
    add(name, "interest rate basis at 4865 matches the IDL layout", r.interestRateBasis, idl.config.interestRateBasis);
    add(name, "protocol take rate at 4870 matches the IDL layout", r.protocolTakeRatePct, idl.config.protocolTakeRatePct);
    add(name, "total available at 224 matches the IDL layout", r.totalAvailableAmount, BigInt(idl.liquidity.totalAvailableAmount.toString()));
    add(name, "borrowed at 232 matches the IDL layout", r.borrowedAmountSf, BigInt(idl.liquidity.borrowedAmountSf.toString()));
    add(name, "protocol fees at 344 match the IDL layout", r.accumulatedProtocolFeesSf, BigInt(idl.liquidity.accumulatedProtocolFeesSf.toString()));
    add(name, "referrer fees at 360 match the IDL layout", r.accumulatedReferrerFeesSf, BigInt(idl.liquidity.accumulatedReferrerFeesSf.toString()));
    add(name, "pending referrer fees at 376 match the IDL layout", r.pendingReferrerFeesSf, BigInt(idl.liquidity.pendingReferrerFeesSf.toString()));
    add(name, "queued collateral at 6968 (no tickets)", r.queuedCollateralAmount, 0n);
    add(name, "withdrawal cap used at 5424 matches the IDL layout", r.depositWithdrawalCap.current, BigInt(idl.config.depositWithdrawalCap.currentTotal.toString()));
    add(name, "last update slot at 16 matches the IDL layout", r.lastUpdateSlot, BigInt(idl.lastUpdate.slot.toString()));
    // klend 1.28.0 keeps the last update's Unix time in what the SDK's older layout calls padding; it must read as
    // a time between klend's first release and a minute from now, however long the reserve has been idle.
    add(name, "last update time at 28 is a Unix time", r.lastUpdateTimestamp >= FIRST_KLEND_RELEASE && r.lastUpdateTimestamp <= Date.now() / 1000 + 60, true);
    // Kamino's seed is counted in the reserve's cToken supply but never minted, so the two differ by exactly it.
    const minted = await ctx.chain.mintSupply(entry.collateralMint);
    add(name, "cToken supply at 2592 is the SPL supply plus the seed", r.collateralMintTotalSupply - minted, RESERVE_SEED);
  }
  return checks;
}

export function formatChecks(checks: LayoutCheck[]): string {
  return checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.account}: ${c.check}: ${c.detail}`).join("\n");
}

function same(a: unknown, b: unknown): boolean {
  return show(a) === show(b);
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
