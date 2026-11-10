// Kamino Lend's addresses and instructions, built with the generated builders of Kamino's MIT-licensed TypeScript
// SDK (`@kamino-finance/klend-sdk`, generated from klend's IDL). This devnet script may use the SDK; the lending
// AMM program never compiles klend's BSL-licensed crate (docs/spec/lending-pool.md, "Building it").
import BN from "bn.js";

import * as ix from "@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/index.js";
import { DISCRIMINATOR as DEPOSIT_DISCRIMINATOR } from "@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/depositReserveLiquidity.js";
import { DISCRIMINATOR as REDEEM_DISCRIMINATOR } from "@kamino-finance/klend-sdk/dist/@codegen/klend/instructions/redeemReserveCollateral.js";
import * as types from "@kamino-finance/klend-sdk/dist/@codegen/klend/types/index.js";
import type { Reserve } from "@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/Reserve.js";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  none,
  some,
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  type TransactionSigner,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import type { AddressBook, ReserveEntry } from "./addresses.ts";
import { KLEND_GLOBAL_CONFIG, KLEND_PROGRAM, QUOTE_CURRENCY, type ReservePolicy } from "./policy.ts";

const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");
const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");
/** The all-zero address, which klend uses for an empty slot or an unused seed. */
export const DEFAULT_ADDRESS = address("11111111111111111111111111111111");
const addressBytes = getAddressEncoder();

async function pda(seeds: (string | ReadonlyUint8Array)[]): Promise<Address> {
  const [found] = await getProgramDerivedAddress({ programAddress: KLEND_PROGRAM, seeds });
  return found;
}

export async function lendingMarketAuthority(market: Address): Promise<Address> {
  return pda(["lma", addressBytes.encode(market)]);
}

export async function reserveAccounts(reserve: Address) {
  const key = addressBytes.encode(reserve);
  return {
    liquiditySupply: await pda(["reserve_liq_supply", key]),
    feeReceiver: await pda(["fee_receiver", key]),
    collateralMint: await pda(["reserve_coll_mint", key]),
    collateralSupply: await pda(["reserve_coll_supply", key]),
  };
}

export async function userMetadataAddress(owner: Address): Promise<Address> {
  return pda(["user_meta", addressBytes.encode(owner)]);
}

/** A vanilla obligation (tag 0, id 0), whose two extra seeds are the default address. */
export async function obligationAddress(owner: Address, market: Address): Promise<Address> {
  const empty = addressBytes.encode(DEFAULT_ADDRESS);
  return pda([new Uint8Array([0]), new Uint8Array([0]), addressBytes.encode(owner), addressBytes.encode(market), empty, empty]);
}

export function initLendingMarket(owner: TransactionSigner, book: AddressBook): Instruction {
  const quoteCurrency = new Array<number>(32).fill(0);
  Buffer.from(QUOTE_CURRENCY).forEach((byte, i) => (quoteCurrency[i] = byte));
  return ix.initLendingMarket(
    { quoteCurrency },
    {
      lendingMarketOwner: owner,
      lendingMarket: book.lendingMarket.address,
      lendingMarketAuthority: book.lendingMarket.authority,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      rent: RENT_SYSVAR,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
    },
  );
}

/** `init_reserve`, which moves the market's minimum initial deposit from `seedSource` into the reserve as its seed. */
export function initReserve(
  owner: TransactionSigner,
  book: AddressBook,
  reserve: ReserveEntry,
  seedSource: Address,
): Instruction {
  return ix.initReserve({
    signer: owner,
    lendingMarket: book.lendingMarket.address,
    lendingMarketAuthority: book.lendingMarket.authority,
    reserve: reserve.address,
    reserveLiquidityMint: reserve.liquidityMint,
    reserveLiquiditySupply: reserve.liquiditySupply,
    feeReceiver: reserve.feeReceiver,
    reserveCollateralMint: reserve.collateralMint,
    reserveCollateralSupply: reserve.collateralSupply,
    initialLiquiditySource: seedSource,
    rent: RENT_SYSVAR,
    liquidityTokenProgram: TOKEN_PROGRAM_ADDRESS,
    collateralTokenProgram: TOKEN_PROGRAM_ADDRESS,
    systemProgram: SYSTEM_PROGRAM_ADDRESS,
    instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
  });
}

/** One `update_reserve_config` change: the mode, the Borsh value, and how to read the current value back. */
export interface ConfigItem {
  label: string;
  mode: types.UpdateConfigModeKind;
  value: Uint8Array;
  current(reserve: Reserve): Uint8Array;
  /**
   * Opening items run Kamino's full config validation. The others are set while the reserve holds only its seed,
   * when Kamino lets the owner skip validation, as the spec's Devnet steps do.
   */
  opens: boolean;
}

export function reserveConfigItems(policy: ReservePolicy, pythPrice: Address): ConfigItem[] {
  const M = types.UpdateConfigMode;
  const item = (
    label: string,
    mode: types.UpdateConfigModeKind,
    value: Uint8Array,
    current: (r: Reserve) => Uint8Array,
    opens = false,
  ): ConfigItem => ({ label, mode, value, current, opens });
  return [
    item("name", new M.UpdateTokenInfoName(), name32(policy.name), (r) => Uint8Array.from(r.config.tokenInfo.name)),
    item("Pyth price", new M.UpdatePythPrice(), addressBytes.encode(pythPrice) as Uint8Array, (r) =>
      addressBytes.encode(r.config.tokenInfo.pythConfiguration.price) as Uint8Array,
    ),
    item("price max age", new M.UpdateTokenInfoPriceMaxAge(), u64(policy.maxPriceAgeSeconds), (r) =>
      u64(bn(r.config.tokenInfo.maxAgePriceSeconds)),
    ),
    item("borrow rate curve", new M.UpdateBorrowRateCurve(), curve(policy.borrowRateCurve), (r) =>
      curve(r.config.borrowRateCurve.points),
    ),
    item("borrow factor", new M.UpdateBorrowFactor(), u64(100n), (r) => u64(bn(r.config.borrowFactorPct))),
    item("loan to value", new M.UpdateLoanToValuePct(), u8(policy.loanToValuePct), (r) => u8(r.config.loanToValuePct)),
    item("liquidation threshold", new M.UpdateLiquidationThresholdPct(), u8(policy.liquidationThresholdPct), (r) =>
      u8(r.config.liquidationThresholdPct),
    ),
    item(
      "deposit withdrawal cap",
      new M.UpdateDepositWithdrawalCap(),
      concat(i64(policy.depositWithdrawalCap.capacity), u64(policy.depositWithdrawalCap.intervalSeconds)),
      (r) =>
        concat(
          i64(bn(r.config.depositWithdrawalCap.configCapacity)),
          u64(bn(r.config.depositWithdrawalCap.configIntervalLengthSeconds)),
        ),
    ),
    // u64::MAX switches off the separate limit on borrowing outside an elevation group (klend's rule).
    item("borrow limit outside elevation groups", new M.UpdateBorrowLimitOutsideElevationGroup(), u64(U64_MAX), (r) =>
      u64(bn(r.config.borrowLimitOutsideElevationGroup)),
    ),
    item("status active", new M.UpdateReserveStatus(), u8(types.ReserveStatus.Active.discriminator), (r) =>
      u8(r.config.status),
    ),
    item("deposit limit", new M.UpdateDepositLimit(), u64(policy.depositLimit), (r) => u64(bn(r.config.depositLimit)), true),
    item("borrow limit", new M.UpdateBorrowLimit(), u64(policy.borrowLimit), (r) => u64(bn(r.config.borrowLimit)), true),
  ];
}

export function updateReserveConfig(
  owner: TransactionSigner,
  book: AddressBook,
  reserve: Address,
  mode: types.UpdateConfigModeKind,
  value: Uint8Array,
  skipValidation: boolean,
): Instruction {
  return ix.updateReserveConfig(
    { mode, value, skipConfigIntegrityValidation: skipValidation },
    {
      signer: owner,
      globalConfig: KLEND_GLOBAL_CONFIG,
      lendingMarket: book.lendingMarket.address,
      reserve,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
    },
  );
}

export function setReserveEmergencyMode(owner: TransactionSigner, book: AddressBook, reserve: Address, on: boolean) {
  return updateReserveConfig(owner, book, reserve, new types.UpdateConfigMode.UpdateReserveEmergencyMode(), u8(on ? 1 : 0), false);
}

export function setMarketEmergencyMode(owner: TransactionSigner, book: AddressBook, on: boolean): Instruction {
  const value = new Array<number>(72).fill(0);
  value[0] = on ? 1 : 0;
  return ix.updateLendingMarket(
    { mode: new BN(types.UpdateLendingMarketMode.UpdateEmergencyMode.discriminator), value },
    { signer: owner, lendingMarket: book.lendingMarket.address, instructionSysvarAccount: INSTRUCTIONS_SYSVAR },
  );
}

/** `deposit_reserve_liquidity`: liquidity in, cTokens out, with no oracle account and no refresh. */
export function depositReserveLiquidity(
  owner: TransactionSigner,
  book: AddressBook,
  reserve: ReserveEntry,
  source: Address,
  destination: Address,
  amount: bigint,
): Instruction {
  return ix.depositReserveLiquidity(
    { liquidityAmount: new BN(amount.toString()) },
    {
      owner,
      reserve: reserve.address,
      lendingMarket: book.lendingMarket.address,
      lendingMarketAuthority: book.lendingMarket.authority,
      reserveLiquidityMint: reserve.liquidityMint,
      reserveLiquiditySupply: reserve.liquiditySupply,
      reserveCollateralMint: reserve.collateralMint,
      userSourceLiquidity: source,
      userDestinationCollateral: destination,
      collateralTokenProgram: TOKEN_PROGRAM_ADDRESS,
      liquidityTokenProgram: TOKEN_PROGRAM_ADDRESS,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
    },
  );
}

/** `redeem_reserve_collateral`: cTokens in, liquidity out at the reserve's rate, with no oracle and no refresh. */
export function redeemReserveCollateral(
  owner: TransactionSigner,
  book: AddressBook,
  reserve: ReserveEntry,
  source: Address,
  destination: Address,
  ctokens: bigint,
): Instruction {
  return ix.redeemReserveCollateral(
    { collateralAmount: new BN(ctokens.toString()) },
    {
      owner,
      lendingMarket: book.lendingMarket.address,
      reserve: reserve.address,
      lendingMarketAuthority: book.lendingMarket.authority,
      reserveLiquidityMint: reserve.liquidityMint,
      reserveCollateralMint: reserve.collateralMint,
      reserveLiquiditySupply: reserve.liquiditySupply,
      userSourceCollateral: source,
      userDestinationLiquidity: destination,
      collateralTokenProgram: TOKEN_PROGRAM_ADDRESS,
      liquidityTokenProgram: TOKEN_PROGRAM_ADDRESS,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
    },
  );
}

export function refreshReserve(book: AddressBook, reserve: ReserveEntry): Instruction {
  return ix.refreshReserve({
    reserve: reserve.address,
    lendingMarket: book.lendingMarket.address,
    pythOracle: some(reserve.pythPrice),
    switchboardPriceOracle: none(),
    switchboardTwapOracle: none(),
    scopePrices: none(),
  });
}

export function initUserMetadata(owner: TransactionSigner, userMetadata: Address): Instruction {
  return ix.initUserMetadata(
    { userLookupTable: DEFAULT_ADDRESS },
    {
      owner,
      feePayer: owner,
      userMetadata,
      referrerUserMetadata: none(),
      rent: RENT_SYSVAR,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
    },
  );
}

export function initObligation(
  owner: TransactionSigner,
  book: AddressBook,
  obligation: Address,
  userMetadata: Address,
): Instruction {
  return ix.initObligation(
    { args: { tag: 0, id: 0 } },
    {
      obligationOwner: owner,
      feePayer: owner,
      obligation,
      lendingMarket: book.lendingMarket.address,
      seed1Account: DEFAULT_ADDRESS,
      seed2Account: DEFAULT_ADDRESS,
      ownerUserMetadata: userMetadata,
      rent: RENT_SYSVAR,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
    },
  );
}

/** `refresh_obligation`, passed the obligation's deposit reserves and then its borrow reserves, in its own order. */
export function refreshObligation(book: AddressBook, obligation: Address, reserves: Address[]): Instruction {
  return ix.refreshObligation(
    { lendingMarket: book.lendingMarket.address, obligation },
    reserves.map((reserve) => ({ address: reserve, role: 0 as const })),
  );
}

export function depositObligationCollateral(
  owner: TransactionSigner,
  book: AddressBook,
  obligation: Address,
  reserve: ReserveEntry,
  source: Address,
  amount: bigint,
): Instruction {
  return ix.depositReserveLiquidityAndObligationCollateral(
    { liquidityAmount: new BN(amount.toString()) },
    {
      owner,
      obligation,
      lendingMarket: book.lendingMarket.address,
      lendingMarketAuthority: book.lendingMarket.authority,
      reserve: reserve.address,
      reserveLiquidityMint: reserve.liquidityMint,
      reserveLiquiditySupply: reserve.liquiditySupply,
      reserveCollateralMint: reserve.collateralMint,
      reserveDestinationDepositCollateral: reserve.collateralSupply,
      userSourceLiquidity: source,
      placeholderUserDestinationCollateral: none(),
      collateralTokenProgram: TOKEN_PROGRAM_ADDRESS,
      liquidityTokenProgram: TOKEN_PROGRAM_ADDRESS,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
    },
  );
}

export function borrowObligationLiquidity(
  owner: TransactionSigner,
  book: AddressBook,
  obligation: Address,
  reserve: ReserveEntry,
  destination: Address,
  amount: bigint,
): Instruction {
  return ix.borrowObligationLiquidity(
    { liquidityAmount: new BN(amount.toString()) },
    {
      owner,
      obligation,
      lendingMarket: book.lendingMarket.address,
      lendingMarketAuthority: book.lendingMarket.authority,
      borrowReserve: reserve.address,
      borrowReserveLiquidityMint: reserve.liquidityMint,
      reserveSourceLiquidity: reserve.liquiditySupply,
      borrowReserveLiquidityFeeReceiver: reserve.feeReceiver,
      userDestinationLiquidity: destination,
      referrerTokenState: none(),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
    },
  );
}

/** `repay_obligation_liquidity` of `u64::MAX`, which klend reads as the whole debt. */
export function repayAllObligationLiquidity(
  owner: TransactionSigner,
  book: AddressBook,
  obligation: Address,
  reserve: ReserveEntry,
  source: Address,
): Instruction {
  return ix.repayObligationLiquidity(
    { liquidityAmount: new BN(U64_MAX.toString()) },
    {
      owner,
      obligation,
      lendingMarket: book.lendingMarket.address,
      repayReserve: reserve.address,
      reserveLiquidityMint: reserve.liquidityMint,
      reserveDestinationLiquidity: reserve.liquiditySupply,
      userSourceLiquidity: source,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      instructionSysvarAccount: INSTRUCTIONS_SYSVAR,
    },
  );
}

/** The only klend instructions a plain cToken holder's transactions may hold: no refresh, no oracle. */
export const CTOKEN_INSTRUCTIONS = {
  deposit_reserve_liquidity: new Uint8Array(DEPOSIT_DISCRIMINATOR),
  redeem_reserve_collateral: new Uint8Array(REDEEM_DISCRIMINATOR),
};

export const U64_MAX = 0xffff_ffff_ffff_ffffn;

function bn(value: BN): bigint {
  return BigInt(value.toString());
}

function u8(value: number): Uint8Array {
  return Uint8Array.of(value);
}

function u64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function i64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value, true);
  return out;
}

function name32(text: string): Uint8Array {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > 32) throw new Error(`reserve name ${text} is longer than 32 bytes`);
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
}

function curve(points: readonly { utilizationRateBps: number; borrowRateBps: number }[]): Uint8Array {
  if (points.length !== 11) throw new Error("a borrow rate curve has 11 points");
  const out = new Uint8Array(88);
  const view = new DataView(out.buffer);
  points.forEach((p, i) => {
    view.setUint32(8 * i, p.utilizationRateBps, true);
    view.setUint32(8 * i + 4, p.borrowRateBps, true);
  });
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return Uint8Array.from(parts.flatMap((part) => Array.from(part)));
}
