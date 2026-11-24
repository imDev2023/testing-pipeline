// Aviary's own address lookup table (PIPESCOPE-160): one table per cluster of the addresses every
// market's transactions share and no wallet signs for, so a transaction too large as a legacy one fits
// as a version 0 one, such as a tax market's launch, which creates the market, its fee accounts and its
// seed in one transaction (docs/spec/tax-amm.md, "Creating a market"). A market's own recorded table
// (Pipeline 0.3's `record_lookup_table`) needs the market to exist, so it can never shorten the
// transaction that creates it; this one can.
//
// A program a transaction invokes must be among its own accounts, never looked up, so the table holds
// the accounts transactions pass and do not invoke: the router's event authority and config, the quote
// mints, Token-2022 (passed as a mint's token program; SPL Token is invoked to wrap SOL), the rent
// sysvar, and each registered strategy's record, which `create_market` writes. It is made once, then
// frozen, so nobody can ever change what it holds: `apps/terminal-api/scripts/lookup-table.ts` makes it,
// and `AVIARY_LOOKUP_TABLE` names it to the API.
import { configPda, eventAuthorityPda, NATIVE_MINT_ADDRESS, strategyPda, TOKEN_2022_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { address, type Address } from "@solana/kit";
import { CLUSTER_USDC } from "../config";

const RENT_SYSVAR = address("SysvarRent111111111111111111111111111111111");

/** The most addresses one lookup table holds. */
export const LOOKUP_TABLE_MAX_ADDRESSES = 256;

/** What Aviary's table holds, for the strategies registered when it is made: the fixed accounts, then each strategy's record. */
export async function aviaryLookupTableAddresses(strategies: readonly Address[]): Promise<Address[]> {
  const fixed = [await eventAuthorityPda(), await configPda(), NATIVE_MINT_ADDRESS, address(CLUSTER_USDC), TOKEN_2022_PROGRAM_ADDRESS, RENT_SYSVAR];
  const records = await Promise.all([...new Set(strategies)].map((s) => strategyPda(s)));
  const addresses = [...new Set([...fixed, ...records])];
  if (addresses.length > LOOKUP_TABLE_MAX_ADDRESSES) throw new Error(`Aviary's lookup table would hold ${addresses.length} addresses, more than the ${LOOKUP_TABLE_MAX_ADDRESSES} a table can.`);
  return addresses;
}
