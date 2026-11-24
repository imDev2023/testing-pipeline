// Accounts for the lending AMM's panel tests, byte for byte as the chain holds them: a market state
// through the program's generated encoder, and klend's Reserve and LendingMarket at the offsets of the
// Kamino facts, section 4 (klend 1.28.0), the same offsets the keeper's decoder reads.
import { getAddressEncoder, type Address } from "@solana/kit";
import { getLendingAmmMarketEncoder, type LendingAmmMarketArgs } from "lending-amm-scripts/client/index.ts";
import { LENDING_MARKET_DISCRIMINATOR, LENDING_MARKET_SIZE, RESERVE_DISCRIMINATOR, RESERVE_SIZE } from "lending-amm-scripts/kamino.ts";

export const LENDING_PROGRAM = "Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG" as Address;
export const WSOL = "So11111111111111111111111111111111111111112" as Address;
export const TOKEN = "AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx" as Address;
export const RESERVE = "5vJJ1sQi972Qcf6oUy3gHEx6prijjSj31CWo5He85Hjw" as Address;
export const LENDING_MARKET = "DCKrWS5G3YEcrRP1Ayu8S8nBR4QfgFsSaRzRdPrjqzj3" as Address;
export const COLLATERAL_MINT = "8gdtrmgc9QmintdEgJbZhRaqh286ti4wUHMUZw54pLr8" as Address;
export const LIQUIDITY_SUPPLY = "GEEjB2HWqjXXTPzceyjzhk3wwD1rwLjAPfiEoBAd9Tzv" as Address;
export const MARKET_STATE = "AMJ4eVWMgqc9hZMmKDipbvwU6EQkmAvhUf4F42dNSDuu" as Address;
const SOME = "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt" as Address;
const DEFAULT = "11111111111111111111111111111111" as Address;
const SF = 1n << 60n;

export type StateFields = Partial<Omit<LendingAmmMarketArgs, "discriminator" | "reserved">>;

/** A WSOL-lent market state: mint 0 the token, mint 1 WSOL, lent_index 1. */
export function marketState(fields: StateFields = {}): Uint8Array {
  return new Uint8Array(
    getLendingAmmMarketEncoder().encode({
      version: 1,
      bump: 255,
      authorityBump: 254,
      lentIndex: 1,
      lpFeeBps: 30,
      withdrawMode: false,
      mints: [TOKEN, WSOL],
      vaults: [SOME, SOME],
      marketSigner: SOME,
      lpMint: SOME,
      ctokenAccount: SOME,
      reserve: RESERVE,
      collateralMint: COLLATERAL_MINT,
      seeder: DEFAULT,
      reserves: [1_000_000_000_000n, 1_000_000_000n],
      ctokens: 0n,
      deposited: 0n,
      redeemed: 0n,
      createdSlot: 1n,
      createdAt: 1n,
      exitSeenSlot: 0n,
      reserved: new Uint8Array(248),
      ...fields,
    }),
  );
}

export type ReserveFields = {
  version?: bigint;
  lastUpdateSlot?: bigint;
  /** Liquidity the reserve holds, in base units. */
  available?: bigint;
  /** Borrowed, in base units (stored with 60 fractional bits). */
  borrowed?: bigint;
  /** cTokens in circulation, the reserve's own `collateral.mint_total_supply`. */
  mintTotalSupply?: bigint;
  blockCtokenUsage?: boolean;
  emergencyMode?: boolean;
  protocolTakeRatePct?: number;
  curve?: [number, number][];
  withdrawalCap?: { capacity: bigint; current: bigint; intervalStart: bigint; intervalLength: bigint };
  queuedCollateral?: bigint;
};

/** Our devnet WSOL reserve's account, with the fields the panel reads set. */
export function reserve(fields: ReserveFields = {}): Uint8Array {
  const data = new Uint8Array(RESERVE_SIZE);
  const view = new DataView(data.buffer);
  data.set(RESERVE_DISCRIMINATOR, 0);
  const key = (offset: number, value: Address) => data.set(getAddressEncoder().encode(value), offset);
  const u64 = (offset: number, value: bigint) => view.setBigUint64(offset, value, true);
  const u128 = (offset: number, value: bigint) => {
    u64(offset, value & ((1n << 64n) - 1n));
    u64(offset + 8, value >> 64n);
  };
  u64(8, fields.version ?? 1n);
  u64(16, fields.lastUpdateSlot ?? 1_000n);
  key(32, LENDING_MARKET);
  key(128, WSOL);
  key(160, LIQUIDITY_SUPPLY);
  u64(224, fields.available ?? 100_000_000_000n);
  u128(232, (fields.borrowed ?? 0n) * SF);
  key(2560, COLLATERAL_MINT);
  u64(2592, fields.mintTotalSupply ?? 100_000_000_000n);
  data[4862] = fields.blockCtokenUsage ? 1 : 0;
  data[4864] = fields.emergencyMode ? 1 : 0;
  data[4870] = fields.protocolTakeRatePct ?? 0;
  (fields.curve ?? [[0, 0], [10_000, 0]]).forEach(([u, r], i) => {
    view.setUint32(4920 + i * 8, u, true);
    view.setUint32(4920 + i * 8 + 4, r, true);
  });
  const cap = fields.withdrawalCap ?? { capacity: 0n, current: 0n, intervalStart: 0n, intervalLength: 0n };
  view.setBigInt64(5416, cap.capacity, true);
  view.setBigInt64(5424, cap.current, true);
  u64(5432, cap.intervalStart);
  u64(5440, cap.intervalLength);
  u64(6968, fields.queuedCollateral ?? 0n);
  return data;
}

export function lendingMarket({ emergencyMode = false }: { emergencyMode?: boolean } = {}): Uint8Array {
  const data = new Uint8Array(LENDING_MARKET_SIZE);
  data.set(LENDING_MARKET_DISCRIMINATOR, 0);
  data[122] = emergencyMode ? 1 : 0;
  return data;
}

/** The clock sysvar at `slot` and Unix time `unixTime`. */
export function clock(slot: bigint, unixTime = 1_800_000_000n): Uint8Array {
  const data = new Uint8Array(40);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, slot, true);
  view.setBigInt64(32, unixTime, true);
  return data;
}

/** An SPL mint with `supply` and 9 decimals. */
export function mint(supply: bigint): Uint8Array {
  const data = new Uint8Array(82);
  new DataView(data.buffer).setBigUint64(36, supply, true);
  data[44] = 9;
  data[45] = 1;
  return data;
}

/** An SPL token account holding `amount`. */
export function tokenAccount(amount: bigint, owner: Address = SOME, ofMint: Address = SOME): Uint8Array {
  const data = new Uint8Array(165);
  data.set(getAddressEncoder().encode(ofMint), 0);
  data.set(getAddressEncoder().encode(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1;
  return data;
}
