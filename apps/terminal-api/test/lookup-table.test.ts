// Aviary's own address lookup table (PIPESCOPE-160): the addresses every market's transactions share,
// so a transaction that would not fit otherwise does, such as a tax market's launch, which creates the
// market, its fee accounts and its seed in one transaction (docs/spec/tax-amm.md, "Creating a market").
import { readFileSync } from "node:fs";
import { configPda, eventAuthorityPda, NATIVE_MINT_ADDRESS, strategyPda, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, type MetadataInit } from "@pipeline-sol/sdk";
import { address, blockhash, getAddressEncoder, getBase64Encoder, getProgramDerivedAddress, getUtf8Encoder, type Address } from "@solana/kit";
import { actionNamed } from "strategy-actions";
import { describe, expect, it } from "vitest";
import { CLUSTER_USDC } from "../src/config";
import { createMarketTransaction } from "../src/trading/action";
import { aviaryLookupTableAddresses } from "../src/trading/lookupTable";
import { fitTransaction, TooLarge } from "../src/trading/prepare";

const TAX_METADATA = JSON.parse(readFileSync(`${import.meta.dirname}/../../../programs/tax-amm/metadata.json`, "utf8")) as Record<string, unknown>;
const TAX = address("J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t");
const TOKEN = address("AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx");
const TRADER = address("E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW");
const SECOND = address("9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt");
const STATE = address("Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG");
const ZERO = "11111111111111111111111111111111";
const LIFETIME = { blockhash: blockhash("85wnSLSYPdHaM8ad4F4MS7JpmrkaYcaSntKMVpiFAG4N"), lastValidBlockHeight: 1n };
const TABLE = address("AVLTabLE111111111111111111111111111111111111");

/** A tax market's launch as the launch form sends it: the token against SOL, taxed in SOL, two recipients, with its seed. */
async function launch(tokenProgram: Address) {
  const vaultOf = async (mint: Address) => (await getProgramDerivedAddress({ programAddress: TAX, seeds: [getUtf8Encoder().encode("vault"), getAddressEncoder().encode(STATE), getAddressEncoder().encode(mint)] }))[0];
  const args = {
    tax_side: "1",
    buy_tax_bps: "300",
    sell_tax_bps: "500",
    buy_tax_min_bps: "0",
    buy_tax_max_bps: "1000",
    sell_tax_min_bps: "0",
    sell_tax_max_bps: "1000",
    tax_authority: TRADER,
    seeder: TRADER,
    recipient_0: TRADER,
    recipient_1: SECOND,
    recipient_2: ZERO,
    recipient_3: ZERO,
    share_0: "6000",
    share_1: "4000",
    share_2: "0",
    share_3: "0",
    burn_share_bps: "0",
    virtual_side: "0",
    virtual_reserve: "0",
  };
  const built = await createMarketTransaction({
    init: TAX_METADATA.init as MetadataInit,
    strategy: TAX,
    trader: TRADER,
    marketState: STATE,
    args,
    inputs: { mint_0: TOKEN, mint_1: NATIVE_MINT_ADDRESS },
    tokenPrograms: { [TOKEN]: tokenProgram, [NATIVE_MINT_ADDRESS]: TOKEN_PROGRAM_ADDRESS },
    maxCreatorLamports: 100_000_000n,
    then: {
      mints: [TOKEN, NATIVE_MINT_ADDRESS],
      vaults: [await vaultOf(TOKEN), await vaultOf(NATIVE_MINT_ADDRESS)],
      actions: [{ action: actionNamed(TAX_METADATA, "seed"), args: { amount_0: "100000000000", amount_1: "500000000", expected_terms: ZERO }, inputs: {} }],
    },
  });
  return built.instructions;
}

describe("Aviary's lookup table", () => {
  it("holds the router's fixed accounts, the quote mints, Token-2022, the rent sysvar and each strategy's record, once each", async () => {
    const addresses = await aviaryLookupTableAddresses([TAX, SECOND, TAX]);
    expect(addresses).toEqual(
      expect.arrayContaining([await eventAuthorityPda(), await configPda(), NATIVE_MINT_ADDRESS, CLUSTER_USDC, TOKEN_2022_PROGRAM_ADDRESS, "SysvarRent111111111111111111111111111111111", await strategyPda(TAX), await strategyPda(SECOND)]),
    );
    expect(new Set(addresses).size).toBe(addresses.length);
    // One extend instruction carries at most 30 addresses; a table holds at most 256.
    expect(addresses.length).toBeLessThanOrEqual(256);
  });

  for (const [name, program] of [
    ["an SPL Token", TOKEN_PROGRAM_ADDRESS],
    ["a Token-2022", TOKEN_2022_PROGRAM_ADDRESS],
  ] as const) {
    it(`fits a tax market's launch, ${name} token against SOL with its seed, into one transaction only with it`, async () => {
      const instructions = await launch(program);
      expect(() => fitTransaction(instructions, TRADER, LIFETIME, [])).toThrow(TooLarge);
      const fitted = fitTransaction(instructions, TRADER, LIFETIME, [{ address: TABLE, addresses: await aviaryLookupTableAddresses([TAX]), whose: "aviary" }]);
      expect(fitted.version).toBe(0);
      expect(getBase64Encoder().encode(fitted.wire).length).toBeLessThanOrEqual(1232);
    });
  }
});
