// The spec's byte offsets agree with Kamino's own account layout (its MIT SDK, generated from klend's IDL),
// and the quantities the lending AMM derives from a reserve follow klend's formulas.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

import { Reserve } from "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve.js";
import { LendingMarket } from "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/LendingMarket.js";

import {
  LENDING_MARKET_DISCRIMINATOR,
  LENDING_MARKET_SIZE,
  RESERVE_DISCRIMINATOR,
  RESERVE_SIZE,
  decodeLendingMarket,
  decodeReserve,
  freeLiquidity,
  redeemValue,
  storedRateRose,
  totalSupplySf,
  utilisationBps,
  type ReserveView,
} from "../src/layout.ts";

const ONE_SF = 1n << 60n;

function randomAccount(size: number, discriminator: Uint8Array): Buffer {
  const data = randomBytes(size);
  data.set(discriminator, 0);
  return data;
}

function bn(value: { toString(): string }): bigint {
  return BigInt(value.toString());
}

test("a reserve decoded at the spec's offsets reads the same fields as Kamino's IDL layout", () => {
  for (let round = 0; round < 20; round++) {
    const data = randomAccount(RESERVE_SIZE, RESERVE_DISCRIMINATOR);
    const idl = Reserve.decode(data);
    const ours = decodeReserve(data);

    assert.equal(ours.version, bn(idl.version));
    assert.equal(ours.lastUpdateSlot, bn(idl.lastUpdate.slot));
    assert.equal(ours.lastUpdateStale, idl.lastUpdate.stale);
    assert.equal(ours.lendingMarket, idl.lendingMarket);
    assert.equal(ours.liquidityMint, idl.liquidity.mintPubkey);
    assert.equal(ours.liquiditySupply, idl.liquidity.supplyVault);
    assert.equal(ours.feeVault, idl.liquidity.feeVault);
    assert.equal(ours.totalAvailableAmount, bn(idl.liquidity.totalAvailableAmount));
    assert.equal(ours.borrowedAmountSf, bn(idl.liquidity.borrowedAmountSf));
    assert.equal(ours.accumulatedProtocolFeesSf, bn(idl.liquidity.accumulatedProtocolFeesSf));
    assert.equal(ours.accumulatedReferrerFeesSf, bn(idl.liquidity.accumulatedReferrerFeesSf));
    assert.equal(ours.pendingReferrerFeesSf, bn(idl.liquidity.pendingReferrerFeesSf));
    assert.equal(ours.collateralMint, idl.collateral.mintPubkey);
    assert.equal(ours.collateralMintTotalSupply, bn(idl.collateral.mintTotalSupply));
    assert.equal(ours.collateralSupply, idl.collateral.supplyVault);
    assert.equal(ours.status, idl.config.status);
    assert.equal(ours.blockCtokenUsage, idl.config.blockCtokenUsage);
    assert.equal(ours.emergencyMode, idl.config.emergencyMode);
    assert.equal(ours.interestRateBasis, idl.config.interestRateBasis);
    assert.equal(ours.protocolTakeRatePct, idl.config.protocolTakeRatePct);
    assert.deepEqual(
      ours.borrowRateCurve,
      idl.config.borrowRateCurve.points.map((p) => ({
        utilizationRateBps: p.utilizationRateBps,
        borrowRateBps: p.borrowRateBps,
      })),
    );
    assert.equal(ours.depositLimit, bn(idl.config.depositLimit));
    assert.deepEqual(ours.depositWithdrawalCap, {
      capacity: bn(idl.config.depositWithdrawalCap.configCapacity),
      current: bn(idl.config.depositWithdrawalCap.currentTotal),
      intervalStart: bn(idl.config.depositWithdrawalCap.lastIntervalStartTimestamp),
      intervalLength: bn(idl.config.depositWithdrawalCap.configIntervalLengthSeconds),
    });
    assert.equal(ours.rewardsAmountPerAccrualUnit, bn(idl.config.rewardsAmountPerAccrualUnit));
    assert.equal(ours.rewardsAmountAvailable, bn(idl.liquidity.rewardsAmountAvailable));
    assert.equal(ours.queuedCollateralAmount, bn(idl.withdrawQueue.queuedCollateralAmount));
  }
});

test("a lending market decoded at the spec's offsets reads the same fields as Kamino's IDL layout", () => {
  for (let round = 0; round < 20; round++) {
    const data = randomAccount(LENDING_MARKET_SIZE, LENDING_MARKET_DISCRIMINATOR);
    const idl = LendingMarket.decode(data);
    const ours = decodeLendingMarket(data);
    assert.equal(ours.owner, idl.lendingMarketOwner);
    assert.equal(ours.emergencyMode, idl.emergencyMode);
    assert.equal(ours.borrowDisabled, idl.borrowDisabled);
  }
});

test("an account of the wrong size or discriminator is refused rather than misread", () => {
  assert.throws(() => decodeReserve(randomAccount(RESERVE_SIZE - 8, RESERVE_DISCRIMINATOR)), /size/);
  assert.throws(() => decodeReserve(randomAccount(RESERVE_SIZE, LENDING_MARKET_DISCRIMINATOR)), /discriminator/);
  assert.throws(() => decodeLendingMarket(randomAccount(LENDING_MARKET_SIZE, RESERVE_DISCRIMINATOR)), /discriminator/);
});

function reserve(fields: Partial<ReserveView>): ReserveView {
  const data = Buffer.alloc(RESERVE_SIZE);
  data.set(RESERVE_DISCRIMINATOR, 0);
  return { ...decodeReserve(data), ...fields };
}

test("total supply is available plus borrowed minus the fees owed, in 60-bit fixed point", () => {
  const r = reserve({
    totalAvailableAmount: 1_000n,
    borrowedAmountSf: 500n * ONE_SF + ONE_SF / 2n,
    accumulatedProtocolFeesSf: 10n * ONE_SF,
    accumulatedReferrerFeesSf: 2n * ONE_SF,
    pendingReferrerFeesSf: 1n * ONE_SF,
  });
  assert.equal(totalSupplySf(r), 1_487n * ONE_SF + ONE_SF / 2n);
});

test("a redeem pays floor(cTokens x total supply / the reserve's cToken supply), or 1:1 when either is zero", () => {
  const r = reserve({
    totalAvailableAmount: 100_000n,
    borrowedAmountSf: 3n * ONE_SF,
    collateralMintTotalSupply: 99_000n,
  });
  // 1,000 x 100,003 / 99,000 = 1,010.13...
  assert.equal(redeemValue(r, 1_000n), 1_010n);
  assert.equal(redeemValue(reserve({}), 1_234n), 1_234n);
});

test("free liquidity is what is available minus the value of queued withdrawal tickets", () => {
  const r = reserve({
    totalAvailableAmount: 10_000n,
    collateralMintTotalSupply: 20_000n,
    borrowedAmountSf: 10_000n * ONE_SF,
    queuedCollateralAmount: 1_000n,
  });
  assert.equal(freeLiquidity(r), 9_000n);
});

test("utilisation is borrowed over total supply, in basis points", () => {
  const r = reserve({ totalAvailableAmount: 1_500n, borrowedAmountSf: 3_500n * ONE_SF });
  assert.equal(utilisationBps(r), 7_000n);
  assert.equal(utilisationBps(reserve({})), 0n);
});

test("the stored rate rises when total supply grows faster than the cToken supply", () => {
  const before = reserve({ totalAvailableAmount: 1_000n, collateralMintTotalSupply: 1_000n });
  const same = reserve({ totalAvailableAmount: 2_000n, collateralMintTotalSupply: 2_000n });
  const higher = reserve({ totalAvailableAmount: 1_000n, borrowedAmountSf: 1n, collateralMintTotalSupply: 1_000n });
  assert.equal(storedRateRose(before, same), false);
  assert.equal(storedRateRose(before, higher), true);
});
