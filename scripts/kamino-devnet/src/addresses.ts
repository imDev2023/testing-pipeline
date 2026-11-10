// The address book: one committed JSON file with every address the lending AMM program and the later devnet
// scripts need. Every address in it is derived from the market owner's and the mint authority's keys, so the
// setup computes it before creating anything and a re-run finds the same accounts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { createAddressWithSeed, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

import { lendingMarketAuthority, reserveAccounts } from "./kamino.ts";
import { ACCOUNT_SEEDS, KLEND_PROGRAM, PYTH_FEEDS, RESERVE_KEYS, TEST_USDC_DECIMALS, WSOL_MINT, type ReserveKey } from "./policy.ts";

export interface ReserveEntry {
  address: Address;
  liquidityMint: Address;
  liquiditySupply: Address;
  feeReceiver: Address;
  collateralMint: Address;
  collateralSupply: Address;
  pythPrice: Address;
}

export interface AddressBook {
  cluster: "devnet";
  klendProgram: Address;
  lendingMarket: { address: Address; authority: Address; owner: Address };
  testUsdc: { mint: Address; decimals: number; mintAuthority: Address };
  reserves: Record<ReserveKey, ReserveEntry>;
}

export async function deriveAddressBook(owner: Address, mintAuthority: Address): Promise<AddressBook> {
  const market = await createAddressWithSeed({
    baseAddress: owner,
    programAddress: KLEND_PROGRAM,
    seed: ACCOUNT_SEEDS.lendingMarket,
  });
  const testUsdcMint = await createAddressWithSeed({
    baseAddress: mintAuthority,
    programAddress: TOKEN_PROGRAM_ADDRESS,
    seed: ACCOUNT_SEEDS.testUsdcMint,
  });
  const liquidityMints: Record<ReserveKey, Address> = { wsol: WSOL_MINT, testUsdc: testUsdcMint };
  const reserves = {} as Record<ReserveKey, ReserveEntry>;
  for (const key of RESERVE_KEYS) {
    const address = await createAddressWithSeed({
      baseAddress: owner,
      programAddress: KLEND_PROGRAM,
      seed: ACCOUNT_SEEDS.reserves[key],
    });
    reserves[key] = {
      address,
      liquidityMint: liquidityMints[key],
      ...(await reserveAccounts(address)),
      pythPrice: PYTH_FEEDS[key],
    };
  }
  return {
    cluster: "devnet",
    klendProgram: KLEND_PROGRAM,
    lendingMarket: { address: market, authority: await lendingMarketAuthority(market), owner },
    testUsdc: { mint: testUsdcMint, decimals: TEST_USDC_DECIMALS, mintAuthority },
    reserves,
  };
}

export function readAddressBook(path: string): AddressBook {
  return JSON.parse(readFileSync(path, "utf8")) as AddressBook;
}

/** Writes the book only when its content changed, so a re-run leaves the committed file untouched. */
export function writeAddressBook(path: string, book: AddressBook): boolean {
  const text = `${JSON.stringify(book, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}
