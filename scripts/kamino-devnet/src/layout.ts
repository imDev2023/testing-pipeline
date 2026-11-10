// Kamino Lend's Reserve and LendingMarket accounts, decoded at the byte offsets the lending AMM relies on.
// Offsets include the 8-byte Anchor discriminator. They come from `docs/spec/lending-pool.md` ("Checking the
// reserve before reading it") and the Kamino facts, section 4, at klend 1.28.0 (`686913e`); the identity fields
// (version, lending market, mints, vaults) are from the same `#[repr(C)]` layout. Nothing here comes from klend's
// code: the bytes are read by hand, as the program will read them.
import { createHash } from "node:crypto";

import { getAddressDecoder, type Address } from "@solana/kit";

export const RESERVE_SIZE = 8624;
export const LENDING_MARKET_SIZE = 4664;
export const RESERVE_DISCRIMINATOR = anchorAccountDiscriminator("Reserve");
export const LENDING_MARKET_DISCRIMINATOR = anchorAccountDiscriminator("LendingMarket");

/** A reserve version of `u64::MAX` means Kamino deprecated it after a total write-off; redeems stop for good. */
export const DEPRECATED_RESERVE_VERSION = 0xffff_ffff_ffff_ffffn;

export const RESERVE_OFFSETS = {
  version: 8,
  lastUpdateSlot: 16,
  lastUpdateStale: 24,
  lastUpdateTimestamp: 28,
  lendingMarket: 32,
  liquidityMint: 128,
  liquiditySupply: 160,
  feeVault: 192,
  totalAvailableAmount: 224,
  borrowedAmountSf: 232,
  accumulatedProtocolFeesSf: 344,
  accumulatedReferrerFeesSf: 360,
  pendingReferrerFeesSf: 376,
  rewardsAmountAvailable: 440,
  collateralMint: 2560,
  collateralMintTotalSupply: 2592,
  collateralSupply: 2600,
  status: 4856,
  blockCtokenUsage: 4862,
  emergencyMode: 4864,
  interestRateBasis: 4865,
  protocolTakeRatePct: 4870,
  borrowRateCurve: 4920,
  depositLimit: 5016,
  depositWithdrawalCap: 5416,
  rewardsAmountPerAccrualUnit: 5792,
  queuedCollateralAmount: 6968,
} as const;

export const LENDING_MARKET_OFFSETS = {
  owner: 24,
  emergencyMode: 122,
  borrowDisabled: 124,
} as const;

const BORROW_RATE_CURVE_POINTS = 11;

export interface CurvePoint {
  utilizationRateBps: number;
  borrowRateBps: number;
}

export interface WithdrawalCap {
  capacity: bigint;
  current: bigint;
  intervalStart: bigint;
  intervalLength: bigint;
}

export interface ReserveView {
  version: bigint;
  lastUpdateSlot: bigint;
  lastUpdateStale: number;
  lastUpdateTimestamp: number;
  lendingMarket: Address;
  liquidityMint: Address;
  liquiditySupply: Address;
  feeVault: Address;
  totalAvailableAmount: bigint;
  borrowedAmountSf: bigint;
  accumulatedProtocolFeesSf: bigint;
  accumulatedReferrerFeesSf: bigint;
  pendingReferrerFeesSf: bigint;
  rewardsAmountAvailable: bigint;
  collateralMint: Address;
  collateralMintTotalSupply: bigint;
  collateralSupply: Address;
  status: number;
  blockCtokenUsage: number;
  emergencyMode: number;
  interestRateBasis: number;
  protocolTakeRatePct: number;
  borrowRateCurve: CurvePoint[];
  depositLimit: bigint;
  depositWithdrawalCap: WithdrawalCap;
  rewardsAmountPerAccrualUnit: bigint;
  queuedCollateralAmount: bigint;
}

export interface LendingMarketView {
  owner: Address;
  emergencyMode: number;
  borrowDisabled: number;
}

export function decodeReserve(data: Uint8Array): ReserveView {
  const view = checked(data, "Reserve", RESERVE_SIZE, RESERVE_DISCRIMINATOR);
  const o = RESERVE_OFFSETS;
  const cap = o.depositWithdrawalCap;
  return {
    version: view.u64(o.version),
    lastUpdateSlot: view.u64(o.lastUpdateSlot),
    lastUpdateStale: view.u8(o.lastUpdateStale),
    lastUpdateTimestamp: view.u32(o.lastUpdateTimestamp),
    lendingMarket: view.address(o.lendingMarket),
    liquidityMint: view.address(o.liquidityMint),
    liquiditySupply: view.address(o.liquiditySupply),
    feeVault: view.address(o.feeVault),
    totalAvailableAmount: view.u64(o.totalAvailableAmount),
    borrowedAmountSf: view.u128(o.borrowedAmountSf),
    accumulatedProtocolFeesSf: view.u128(o.accumulatedProtocolFeesSf),
    accumulatedReferrerFeesSf: view.u128(o.accumulatedReferrerFeesSf),
    pendingReferrerFeesSf: view.u128(o.pendingReferrerFeesSf),
    rewardsAmountAvailable: view.u64(o.rewardsAmountAvailable),
    collateralMint: view.address(o.collateralMint),
    collateralMintTotalSupply: view.u64(o.collateralMintTotalSupply),
    collateralSupply: view.address(o.collateralSupply),
    status: view.u8(o.status),
    blockCtokenUsage: view.u8(o.blockCtokenUsage),
    emergencyMode: view.u8(o.emergencyMode),
    interestRateBasis: view.u8(o.interestRateBasis),
    protocolTakeRatePct: view.u8(o.protocolTakeRatePct),
    borrowRateCurve: Array.from({ length: BORROW_RATE_CURVE_POINTS }, (_, i) => ({
      utilizationRateBps: view.u32(o.borrowRateCurve + 8 * i),
      borrowRateBps: view.u32(o.borrowRateCurve + 8 * i + 4),
    })),
    depositLimit: view.u64(o.depositLimit),
    depositWithdrawalCap: {
      capacity: view.i64(cap),
      current: view.i64(cap + 8),
      intervalStart: view.u64(cap + 16),
      intervalLength: view.u64(cap + 24),
    },
    rewardsAmountPerAccrualUnit: view.u64(o.rewardsAmountPerAccrualUnit),
    queuedCollateralAmount: view.u64(o.queuedCollateralAmount),
  };
}

export function decodeLendingMarket(data: Uint8Array): LendingMarketView {
  const view = checked(data, "LendingMarket", LENDING_MARKET_SIZE, LENDING_MARKET_DISCRIMINATOR);
  const o = LENDING_MARKET_OFFSETS;
  return {
    owner: view.address(o.owner),
    emergencyMode: view.u8(o.emergencyMode),
    borrowDisabled: view.u8(o.borrowDisabled),
  };
}

/** One in klend's fixed point, which has 60 fractional bits (fields ending in `_sf`). */
export const ONE_SF = 1n << 60n;

/** A fixed-point amount rounded up to whole base units, as klend rounds a debt. */
export function ceilSf(valueSf: bigint): bigint {
  return (valueSf + ONE_SF - 1n) >> 60n;
}

/** cTokens worth at most `liquidity` at the stored rate: floor(liquidity x cToken supply / total supply), or 1:1. */
export function liquidityToCtokens(r: ReserveView, liquidity: bigint): bigint {
  const supplySf = totalSupplySf(r);
  if (supplySf === 0n || r.collateralMintTotalSupply === 0n) return liquidity;
  return (liquidity * r.collateralMintTotalSupply * ONE_SF) / supplySf;
}

/** The reserve's total supply in 60-bit fixed point: available + borrowed - fees owed to the protocol and referrers. */
export function totalSupplySf(r: ReserveView): bigint {
  return (
    (r.totalAvailableAmount << 60n) +
    r.borrowedAmountSf -
    r.accumulatedProtocolFeesSf -
    r.accumulatedReferrerFeesSf -
    r.pendingReferrerFeesSf
  );
}

/** What redeeming `ctokens` pays at the stored rate: floor(cTokens x total supply / the reserve's cToken supply). */
export function redeemValue(r: ReserveView, ctokens: bigint): bigint {
  const supplySf = totalSupplySf(r);
  if (supplySf === 0n || r.collateralMintTotalSupply === 0n) return ctokens;
  return (ctokens * supplySf) / (r.collateralMintTotalSupply * ONE_SF);
}

/** Liquidity a plain redeem can take now: what is available minus the value of queued withdrawal tickets. */
export function freeLiquidity(r: ReserveView): bigint {
  const queued = redeemValue(r, r.queuedCollateralAmount);
  return r.totalAvailableAmount > queued ? r.totalAvailableAmount - queued : 0n;
}

/** Borrowed over total supply, in basis points, rounded down. */
export function utilisationBps(r: ReserveView): bigint {
  const supplySf = totalSupplySf(r);
  return supplySf === 0n ? 0n : (r.borrowedAmountSf * 10_000n) / supplySf;
}

/** Whether the stored rate (total supply per cToken) of `after` is above that of `before`. */
export function storedRateRose(before: ReserveView, after: ReserveView): boolean {
  return totalSupplySf(after) * before.collateralMintTotalSupply > totalSupplySf(before) * after.collateralMintTotalSupply;
}

/** The stored rate as a decimal string with `digits` places, for display only. */
export function storedRate(r: ReserveView, digits = 12): string {
  const supplySf = totalSupplySf(r);
  if (supplySf === 0n || r.collateralMintTotalSupply === 0n) return `1.${"0".repeat(digits)}`;
  const scaled = (supplySf * 10n ** BigInt(digits)) / (r.collateralMintTotalSupply * ONE_SF);
  const text = scaled.toString().padStart(digits + 1, "0");
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

function anchorAccountDiscriminator(name: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`account:${name}`).digest().subarray(0, 8));
}

function checked(data: Uint8Array, name: string, size: number, discriminator: Uint8Array) {
  if (data.length !== size) throw new Error(`${name}: size ${data.length}, expected ${size}`);
  if (!discriminator.every((byte, i) => data[i] === byte)) throw new Error(`${name}: wrong discriminator`);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const addresses = getAddressDecoder();
  return {
    u8: (at: number) => view.getUint8(at),
    u32: (at: number) => view.getUint32(at, true),
    u64: (at: number) => view.getBigUint64(at, true),
    i64: (at: number) => view.getBigInt64(at, true),
    u128: (at: number) => view.getBigUint64(at, true) | (view.getBigUint64(at + 8, true) << 64n),
    address: (at: number) => addresses.decode(data.subarray(at, at + 32)),
  };
}
