// A custom action and a new market as the transactions Aviary prepares (docs/spec/pipescope-architecture.md,
// Trading path; #123): the strategy's instruction built from its metadata with the `strategy-actions`
// package or Pipeline's SDK, SOL wrapped before an action that takes wrapped SOL from the wallet and
// unwrapped after it in the same transaction (PIPESCOPE-141), and nothing prepared that needs a
// signature the wallet cannot give. Then what a simulation says signing would change in the wallet.
import { readFileSync } from "node:fs";
import { anchorDiscriminator, NATIVE_MINT_ADDRESS, PIPELINE_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, type MarketView, type MetadataInit } from "@pipeline-sol/sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, findAssociatedTokenPda } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { AccountRole, address, getAddressEncoder, getBase64Decoder, type Address, type Instruction } from "@solana/kit";
import { actionNamed, type AviaryAction } from "strategy-actions";
import { describe, expect, it } from "vitest";
import { actionTransaction, createMarketTransaction, measureWallet } from "../src/trading/action";
import { Refused } from "../src/trading/quote";

const TAX_METADATA = JSON.parse(readFileSync(`${import.meta.dirname}/../../../programs/tax-amm/metadata.json`, "utf8")) as Record<string, unknown>;
const TAX = address("J4sA9oSJKgJukRid3ZzuYppHtUT8gu1psW57J9xonW9t");
const TOKEN = address("AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx");
const TRADER = address("E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW");
const OTHER = address("9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt");

const market: MarketView = {
  market: address("4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c"),
  strategyProgram: TAX,
  marketState: address("7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz"),
  mints: [NATIVE_MINT_ADDRESS, TOKEN],
  vaults: [address("8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2"), address("6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp")],
  tokenPrograms: [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS],
  supportsExactOut: false,
};
const TERMS = "11111111111111111111111111111111";
const wsolAccount = async (owner: Address) => (await findAssociatedTokenPda({ owner, mint: NATIVE_MINT_ADDRESS, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
const disc = async (name: string) => Array.from(await anchorDiscriminator(name));
const programs = (instructions: readonly Instruction[]) => instructions.map((i) => i.programAddress);
const tokenPrograms = { [NATIVE_MINT_ADDRESS]: TOKEN_PROGRAM_ADDRESS, [TOKEN]: TOKEN_PROGRAM_ADDRESS };

describe("actionTransaction", () => {
  it("wraps the SOL a seed takes from the wallet before it, and unwraps what is left after it", async () => {
    const { instructions, wrapped } = await actionTransaction({ action: actionNamed(TAX_METADATA, "seed"), market, trader: TRADER, args: { amount_0: "250000000", amount_1: "1000000", expected_terms: TERMS }, inputs: {}, tokenPrograms });
    expect(wrapped).toBe(250_000_000n);
    // Create the wallet's wrapped-SOL account, move the SOL in, sync it, seed, then close the account back into the wallet.
    expect(programs(instructions)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, TAX, TOKEN_PROGRAM_ADDRESS]);
    const wsol = await wsolAccount(TRADER);
    expect(instructions[1]!.accounts!.map((a) => a.address)).toEqual([TRADER, wsol]);
    expect(Array.from(instructions[3]!.data!.slice(0, 8))).toEqual(await disc("seed"));
    expect(instructions[3]!.accounts![2]).toEqual({ address: wsol, role: AccountRole.WRITABLE });
    expect(instructions[4]!.accounts!.map((a) => a.address)).toEqual([wsol, TRADER, TRADER]);
  });

  it("closes the wallet's wrapped-SOL account after an action that pays SOL into it, wrapping nothing", async () => {
    const { instructions, wrapped } = await actionTransaction({ action: actionNamed(TAX_METADATA, "distribute"), market, trader: TRADER, args: { slot: "0" }, inputs: { tax_mint: NATIVE_MINT_ADDRESS, recipient: TRADER }, tokenPrograms });
    expect(wrapped).toBe(0n);
    expect(programs(instructions)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TAX, TOKEN_PROGRAM_ADDRESS]);
  });

  it("builds an action that touches no wrapped SOL of the wallet's as the strategy's instruction alone", async () => {
    const { instructions, action, wrapped } = await actionTransaction({ action: actionNamed(TAX_METADATA, "set_taxes"), market, trader: TRADER, args: { buy_tax_bps: "600", sell_tax_bps: "900" }, inputs: {}, tokenPrograms });
    expect(wrapped).toBe(0n);
    expect(instructions).toEqual([action]);
    expect(Array.from(action.data!)).toEqual([...(await disc("set_taxes")), 0x58, 0x02, 0x84, 0x03]);
    // Paying SOL out to someone else's wrapped-SOL account wraps and closes nothing of the wallet's.
    const payout = await actionTransaction({ action: actionNamed(TAX_METADATA, "distribute"), market, trader: TRADER, args: { slot: "1" }, inputs: { tax_mint: NATIVE_MINT_ADDRESS, recipient: OTHER }, tokenPrograms });
    expect(payout.instructions).toEqual([payout.action]);
  });

  it("refuses an action that needs a signature other than the wallet's, since the wallet alone signs", async () => {
    const action: AviaryAction = { name: "admin", label: "Admin", accounts: [{ name: "admin", source: `fixed:${OTHER}`, signer: true }] };
    const refusal = await actionTransaction({ action, market, trader: TRADER, args: {}, inputs: {}, tokenPrograms }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(Refused);
    expect((refusal as Refused).failure).toMatchObject({ class: "needs_signer", sentence: `This action needs a signature from ${OTHER}, which is not your wallet, so Aviary cannot prepare it for your wallet to sign.` });
  });

  it("refuses an argument the metadata's type does not take, naming it", async () => {
    const refusal = await actionTransaction({ action: actionNamed(TAX_METADATA, "set_taxes"), market, trader: TRADER, args: { buy_tax_bps: "70000", sell_tax_bps: "900" }, inputs: {}, tokenPrograms }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(Refused);
    expect((refusal as Refused).failure).toMatchObject({ class: "bad_input", sentence: 'The form could not be built: argument "buy_tax_bps" is out of range for u16.' });
  });
});

describe("createMarketTransaction", () => {
  const init = TAX_METADATA.init as MetadataInit;
  const args = {
    tax_side: "0",
    buy_tax_bps: "300",
    sell_tax_bps: "500",
    buy_tax_min_bps: "0",
    buy_tax_max_bps: "1000",
    sell_tax_min_bps: "0",
    sell_tax_max_bps: "1000",
    tax_authority: TRADER,
    seeder: TRADER,
    recipient_0: TRADER,
    recipient_1: TRADER,
    recipient_2: TRADER,
    recipient_3: TRADER,
    share_0: "10000",
    share_1: "0",
    share_2: "0",
    share_3: "0",
    burn_share_bps: "0",
    virtual_side: "0",
    virtual_reserve: "0",
  };

  it("builds the router's create_market from the create form, with the page's new market state signing", async () => {
    const state = address("Ewbh5n8pSFuq1ebQkLajDEFjXbX44m3ngPxznfjH1KtG");
    const built = await createMarketTransaction({ init, strategy: TAX, trader: TRADER, marketState: state, args, inputs: { mint_0: NATIVE_MINT_ADDRESS, mint_1: TOKEN }, tokenPrograms, maxCreatorLamports: 100_000_000n });
    expect(built).toMatchObject({ marketState: state, marketStateSigns: true, wrapped: 0n });
    expect(programs(built.instructions)).toEqual([PIPELINE_PROGRAM_ADDRESS]);
    const [create] = built.instructions;
    expect(create!.accounts![0]).toEqual({ address: TRADER, role: AccountRole.WRITABLE_SIGNER });
    expect(create!.accounts![3]).toEqual({ address: state, role: AccountRole.WRITABLE_SIGNER });
    expect(create!.accounts![4]!.address).toBe(built.market);
  });

  it("asks for the new market state when the create form makes one", async () => {
    const refusal = await createMarketTransaction({ init, strategy: TAX, trader: TRADER, args, inputs: { mint_0: NATIVE_MINT_ADDRESS, mint_1: TOKEN }, tokenPrograms, maxCreatorLamports: 100_000_000n }).catch((e: unknown) => e);
    expect((refusal as Refused).failure).toMatchObject({ class: "bad_input", sentence: "The form could not be built: pass the new market state keypair address as marketState." });
  });
});

describe("measureWallet", () => {
  const encoder = getAddressEncoder();
  const tokenAccount = (mint: Address, owner: Address, amount: bigint, lamports = 2_039_280n) => {
    const bytes = new Uint8Array(165);
    bytes.set(encoder.encode(mint), 0);
    bytes.set(encoder.encode(owner), 32);
    new DataView(bytes.buffer).setBigUint64(64, amount, true);
    return { lamports, owner: TOKEN_PROGRAM_ADDRESS as string, data: [getBase64Decoder().decode(bytes), "base64"] as const };
  };
  const wallet = (lamports: bigint) => ({ lamports, owner: SYSTEM_PROGRAM_ADDRESS as string, data: ["", "base64"] as const });

  it("reports the wallet's SOL and each token account it owns, before and after, and the accounts it gains", () => {
    const [kept, made, gone, others] = [address("8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2"), address("6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp"), address("7Vh9qtYfzaiu4nYwQGaBBZ4JpB1cXM4MoJakjXcpVLcz"), address("4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c")];
    const measured = measureWallet({
      trader: TRADER,
      watched: [TRADER, kept, made, gone, others],
      before: [wallet(5_000_000_000n), tokenAccount(TOKEN, TRADER, 1_000n), null, tokenAccount(NATIVE_MINT_ADDRESS, TRADER, 7n), tokenAccount(TOKEN, OTHER, 50n)],
      after: [wallet(4_000_000_000n), tokenAccount(TOKEN, TRADER, 400n), tokenAccount(NATIVE_MINT_ADDRESS, TRADER, 0n), null, tokenAccount(TOKEN, OTHER, 650n)],
    });
    expect(measured.changes).toEqual([
      { mint: null, account: TRADER, before: "5000000000", after: "4000000000" },
      { mint: TOKEN, account: kept, before: "1000", after: "400" },
      { mint: NATIVE_MINT_ADDRESS, account: made, before: "0", after: "0" },
      { mint: NATIVE_MINT_ADDRESS, account: gone, before: "7", after: "0" },
    ]);
    expect(measured.new_accounts).toEqual([{ account: made, mint: NATIVE_MINT_ADDRESS, rent: "2039280" }]);
  });
});
