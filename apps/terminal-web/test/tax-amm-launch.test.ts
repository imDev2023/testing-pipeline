// The tax AMM's launch form (docs/spec/tax-amm.md, "In Aviary" and "Creating a market"; #75): what is
// typed becomes the market's creation parameters, its seed and the hash of its terms, the token first
// and SOL or USDC second, taxed in the quote mint unless the creator chooses the token; the split it
// shows, the suite share first; and what it says is missing before anything is built.
import { address, getAddressEncoder, getProgramDerivedAddress, getUtf8Encoder } from "@solana/kit";
import { MAX_TAX_BPS, TAX_AMM_PROGRAM_ADDRESS } from "tax-amm-scripts/client/index.ts";
import { termsArg, termsHash } from "tax-amm-scripts/terms.ts";
import { describe, expect, it } from "vitest";
import { TAX_LAUNCH_DEFAULTS } from "@/config";
import { launchRequest, percentBps, readLaunch, type LaunchValues } from "@/products/taxAmm/launch";

const TOKEN = address("AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx");
const WSOL = address("So11111111111111111111111111111111111111112");
const USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const WALLET = address("E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW");
const SECOND = address("9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt");
const STATE = address("Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG");
const ZERO = "11111111111111111111111111111111";

const values = (over: Partial<LaunchValues> = {}): LaunchValues => ({ ...TAX_LAUNCH_DEFAULTS, token: TOKEN, seedToken: "100000", seedQuote: "0.5", recipients: [{ wallet: WALLET, share: "100" }], ...over });
const context = { wallet: WALLET, token: { mint: TOKEN, decimals: 6 }, quotes: { sol: { mint: WSOL, decimals: 9 }, usdc: { mint: USDC, decimals: 6 } } };

describe("percentBps", () => {
  it("reads a percentage to two places as basis points", () => {
    expect(["3", "2.5", "0.01", "0", "10", " 7 "].map(percentBps)).toEqual([300, 250, 1, 0, 1000, 700]);
  });
  it("refuses what is no percentage to two places", () => {
    expect(["", "abc", "0.001", "-1", "1e2"].map(percentBps)).toEqual([null, null, null, null, null]);
  });
});

describe("readLaunch", () => {
  it("takes the token first and the quote mint second, taxed in the quote mint by default, the wallet as seeder, authority and first recipient", () => {
    const { launch, missing } = readLaunch(values(), context);
    expect(missing).toBeNull();
    expect(launch!.mints).toEqual([TOKEN, WSOL]);
    expect(launch!.params).toEqual({
      taxSide: 1,
      buyTaxBps: 300,
      sellTaxBps: 500,
      buyTaxMinBps: 0,
      buyTaxMaxBps: MAX_TAX_BPS,
      sellTaxMinBps: 0,
      sellTaxMaxBps: MAX_TAX_BPS,
      taxAuthority: WALLET,
      seeder: WALLET,
      recipients: [WALLET, ZERO, ZERO, ZERO],
      shares: [10_000, 0, 0, 0],
      burnShareBps: 0,
      virtualSide: 1,
      virtualReserve: 0n,
    });
    expect(launch!.seed).toEqual([100_000_000_000n, 500_000_000n]);
  });

  it("taxes the token when asked, pairs with USDC, names no authority, and splits between recipients and the burn", () => {
    const { launch } = readLaunch(
      values({ quote: "usdc", taxedIn: "token", authority: "none", recipients: [{ wallet: SECOND, share: "50" }, { wallet: WALLET, share: "30" }], burnShare: "20", seedQuote: "250" }),
      context,
    );
    expect(launch!.mints).toEqual([TOKEN, USDC]);
    expect(launch!.params).toMatchObject({ taxSide: 0, taxAuthority: ZERO, recipients: [SECOND, WALLET, ZERO, ZERO], shares: [5_000, 3_000, 0, 0], burnShareBps: 2_000 });
    expect(launch!.seed).toEqual([100_000_000_000n, 250_000_000n]);
    // The whole split, the suite share first, each a part of the whole tax.
    expect(launch!.split.map((p) => [p.who, p.wallet, p.ofTaxBps])).toEqual([
      ["suite", expect.any(String), 1_000],
      ["recipient", SECOND, 4_500],
      ["recipient", WALLET, 2_700],
      ["burn", null, 1_800],
    ]);
  });

  it("launches single-sided: the quote side priced by a virtual reserve, with none of it deposited", () => {
    const { launch, missing } = readLaunch(values({ virtualReserve: "10", seedQuote: "" }), context);
    expect(missing).toBeNull();
    expect(launch!.params).toMatchObject({ virtualSide: 1, virtualReserve: 10_000_000_000n });
    expect(launch!.seed).toEqual([100_000_000_000n, 0n]);
  });

  it.each([
    [{ token: "" }, "Enter the token's mint address."],
    [{ token: WSOL }, "The token must be another mint than the SOL it is paired with."],
    [{ buyTax: "12" }, "The buy tax, 12%, is outside its range of 0% to 10%."],
    [{ sellMax: "11" }, "The sell tax's highest rate can be at most 10%, the program's cap."],
    [{ buyMin: "5", buyMax: "4", buyTax: "4" }, "The buy tax's lowest rate is above its highest."],
    [{ recipients: [{ wallet: WALLET, share: "60" }] }, "The recipients' shares and the burn's add up to 60%; they must add up to 100%."],
    [{ recipients: [{ wallet: "nobody", share: "100" }] }, "Tax recipient 1 is not an address."],
    [{ recipients: [] }, "Name at least one tax recipient."],
    [{ burnShare: "10", recipients: [{ wallet: WALLET, share: "90" }] }, "SOL can't be burned, so a market taxed in SOL has no burn share."],
    [{ seedToken: "" }, "Enter how much of the token to seed the market with."],
    [{ seedQuote: "" }, "Enter how much SOL to seed the market with, or price it with a virtual reserve."],
    [{ seedToken: "1.0000001" }, "The token has 6 decimal places."],
  ] as [Partial<LaunchValues>, string][])("says what is missing or wrong: %j", (over, said) => {
    expect(readLaunch(values(over), context)).toEqual({ launch: null, missing: said });
  });

  it("says when the token's read is over without a mint: it failed, or the address is no mint", () => {
    expect(readLaunch(values(), { ...context, token: null, tokenProblem: "The token's address is no mint." }).missing).toBe("The token's address is no mint.");
  });

  it("waits for the token's mint to be read, and for a wallet", () => {
    expect(readLaunch(values(), { ...context, token: null }).missing).toBe("Waiting for the token's mint to be read.");
    expect(readLaunch(values(), { ...context, wallet: null }).missing).toBe("Connect your wallet: it creates and seeds the market.");
  });
});

describe("launchRequest", () => {
  it("is the create form's values, and the market opened with its seed and the hash of its terms, against the vaults of the new market state", async () => {
    const { launch } = readLaunch(values(), context);
    const request = await launchRequest(launch!, STATE);
    expect(request.inputs).toEqual({ mint_0: TOKEN, mint_1: WSOL });
    expect(request.args).toMatchObject({ tax_side: "1", buy_tax_bps: "300", recipient_0: WALLET, recipient_1: ZERO, share_0: "10000", virtual_reserve: "0", seeder: WALLET });
    const vault = async (mint: string) => (await getProgramDerivedAddress({ programAddress: TAX_AMM_PROGRAM_ADDRESS, seeds: [getUtf8Encoder().encode("vault"), getAddressEncoder().encode(STATE), getAddressEncoder().encode(address(mint))] }))[0];
    expect(request.then).toEqual({
      mints: [TOKEN, WSOL],
      vaults: [await vault(TOKEN), await vault(WSOL)],
      actions: [{ action: "seed", args: { amount_0: "100000000000", amount_1: "500000000", expected_terms: termsArg(termsHash([TOKEN, WSOL], launch!.params)) }, inputs: {} }],
    });
  });
});
