// Accounts for the containment hook's tests (#76): a Token-2022 mint with a transfer hook extension
// and any other extensions named, the hook's config, a tax AMM market state and the Clock sysvar, each
// laid out as the chain holds it.
import { address, getAddressEncoder, type Address } from "@solana/kit";
import { getConfigEncoder, type ConfigArgs } from "containment-hook-scripts/client/index.ts";
import { getTaxMarketEncoder, MarketStatus, type TaxMarketArgs } from "tax-amm-scripts/client/index.ts";

export const ZERO = address("11111111111111111111111111111111");
const addresses = getAddressEncoder();

/** A mint's extension: its Token-2022 type number and its value's bytes. */
export type Extension = { type: number; value: Uint8Array };

/** The transfer hook extension: its authority, then its program, each zeroes for none. */
export function transferHook(authority: Address | null, program: Address | null): Extension {
  const value = new Uint8Array(64);
  if (authority) value.set(addresses.encode(authority), 0);
  if (program) value.set(addresses.encode(program), 32);
  return { type: 14, value };
}

/** A Token-2022 mint with `supply`, 9 decimals, no mint or freeze authority, and the extensions given. */
export function token2022Mint(supply: bigint, extensions: Extension[]): Uint8Array {
  const tlv = extensions.flatMap((e) => [e.type & 0xff, e.type >> 8, e.value.length & 0xff, e.value.length >> 8, ...e.value]);
  const data = new Uint8Array(166 + tlv.length);
  new DataView(data.buffer).setBigUint64(36, supply, true);
  data[44] = 9;
  data[45] = 1;
  data[165] = 1; // the account type: a mint
  data.set(tlv, 166);
  return data;
}

/** The hook's config, at the size the program allocates whatever `unlocked_at` holds. */
export function config(over: Partial<ConfigArgs> & Pick<ConfigArgs, "mint" | "market" | "marketState" | "quoteMint">): Uint8Array {
  const encoded = getConfigEncoder().encode({
    version: 1,
    vault: ZERO,
    feeAccount: ZERO,
    unlockGoal: 100_000_000n,
    unlockDeadline: 1_800_086_400n,
    boundAt: 1_799_000_000n,
    configBump: 255,
    extraAccountMetasBump: 255,
    unlockBump: 255,
    unlockedAt: null,
    ...over,
  });
  const data = new Uint8Array(8 + 1 + 32 * 6 + 8 * 3 + 3 + 9);
  data.set(encoded, 0);
  return data;
}

/** A tax AMM market state, the token at mint 0 taxed in mint 1. */
export function taxMarket(over: Partial<TaxMarketArgs> & Pick<TaxMarketArgs, "mints">): Uint8Array {
  return new Uint8Array(
    getTaxMarketEncoder().encode({
      version: 1,
      status: MarketStatus.Open,
      taxSide: 1,
      virtualSide: 1,
      authorityBump: 255,
      taxAuthorityRenounced: false,
      vaults: [ZERO, ZERO],
      marketSigner: ZERO,
      buyTaxBps: 300,
      sellTaxBps: 500,
      buyTaxMinBps: 0,
      buyTaxMaxBps: 1000,
      sellTaxMinBps: 0,
      sellTaxMaxBps: 1000,
      taxAuthority: ZERO,
      seeder: ZERO,
      recipients: [ZERO, ZERO, ZERO, ZERO],
      shares: [0, 0, 0, 0],
      burnShareBps: 0,
      virtualReserve: 30_000_000_000n,
      reserves: [800_000_000_000_000n, 0n],
      owed: [0n, 0n, 0n, 0n, 0n, 0n],
      taxCollected: 0n,
      volume: [0n, 0n],
      swapCount: 0n,
      createdSlot: 1n,
      createdAt: 1n,
      pendingBuyTaxBps: 0,
      pendingSellTaxBps: 0,
      pendingFromSlot: 0n,
      reserved: new Uint8Array(52),
      ...over,
    }),
  );
}

/** The Clock sysvar at `slot`, its Unix time `unixTime`. */
export function clock(slot: bigint, unixTime: bigint): Uint8Array {
  const data = new Uint8Array(40);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, slot, true);
  view.setBigInt64(32, unixTime, true);
  return data;
}
