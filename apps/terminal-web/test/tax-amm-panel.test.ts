// The tax panel's reading of a tax market's state (docs/spec/tax-amm.md, "In Aviary"; #75): the tax
// side, both taxes with their fixed ranges and any pending change, the tax authority or that there is
// none or that it renounced, where each tax goes with the suite share first, what each slot is owed
// with the payout that sends it, and the real reserves beside what the vaults hold.
import { address, getAddressEncoder, getBase64Decoder } from "@solana/kit";
import { getTaxMarketEncoder, MarketStatus, SUITE_TREASURY, type TaxMarketArgs } from "tax-amm-scripts/client/index.ts";
import { describe, expect, it } from "vitest";
import { taxPanelView, tokenAccountAmount } from "@/products/taxAmm/panel";

const TOKEN = address("AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx");
const WSOL = address("So11111111111111111111111111111111111111112");
const AUTHORITY = address("E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW");
const SECOND = address("9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt");
const ZERO = address("11111111111111111111111111111111");
const VAULTS = [address("8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2"), address("6efYq3Jt7k2bQxW9pLm4nR8sV1uZcA5dHgE2oTiwdnYp")];

const state = (over: Partial<TaxMarketArgs> = {}): TaxMarketArgs => ({
  version: 1,
  status: MarketStatus.Open,
  taxSide: 1,
  virtualSide: 0,
  authorityBump: 255,
  taxAuthorityRenounced: false,
  mints: [TOKEN, WSOL],
  vaults: VAULTS,
  marketSigner: address("4oPAw2WtnusKZxW8aprTc1Ldk3MyhiQdBeRFmfGhFJ9c"),
  buyTaxBps: 300,
  sellTaxBps: 500,
  buyTaxMinBps: 100,
  buyTaxMaxBps: 800,
  sellTaxMinBps: 0,
  sellTaxMaxBps: 900,
  taxAuthority: AUTHORITY,
  seeder: AUTHORITY,
  recipients: [AUTHORITY, SECOND, ZERO, ZERO],
  shares: [6_000, 4_000, 0, 0],
  burnShareBps: 0,
  virtualReserve: 0n,
  reserves: [99_000_000_000n, 548_000_000n],
  owed: [1_620_000n, 1_080_000n, 0n, 0n, 0n, 300_000n],
  taxCollected: 3_000_000n,
  volume: [1_000_000_000n, 50_000_000n],
  swapCount: 2n,
  createdSlot: 525_000_000n,
  createdAt: 1_795_000_000n,
  pendingBuyTaxBps: 0,
  pendingSellTaxBps: 0,
  pendingFromSlot: 0n,
  reserved: new Uint8Array(52),
  ...over,
});
const base64 = (bytes: Uint8Array) => getBase64Decoder().decode(bytes);
const encoded = (over: Partial<TaxMarketArgs> = {}) => base64(new Uint8Array(getTaxMarketEncoder().encode(state(over))));
const tokenAccount = (amount: bigint) => {
  const bytes = new Uint8Array(165);
  bytes.set(getAddressEncoder().encode(WSOL), 0);
  new DataView(bytes.buffer).setBigUint64(64, amount, true);
  return base64(bytes);
};

describe("taxPanelView", () => {
  it("reads the tax side, both taxes with their ranges, the authority, and the real reserves beside the vaults", () => {
    const view = taxPanelView({ state: encoded(), slot: 525_100_000, vaults: [tokenAccount(99_000_000_000n), tokenAccount(551_000_000n)] });
    expect(view).not.toBeNull();
    expect(view!.taxSide).toBe(1);
    expect(view!.rates).toEqual({ buy: 300, sell: 500, buyRange: [100, 800], sellRange: [0, 900] });
    expect(view!.pending).toBeNull();
    expect(view!.authority).toEqual({ kind: "address", address: AUTHORITY });
    expect(view!.reserves).toEqual([99_000_000_000n, 548_000_000n]);
    expect(view!.virtual).toBeNull();
    // The SOL vault holds the 0.003 SOL owed besides the reserve.
    expect(view!.vaults).toEqual([99_000_000_000n, 551_000_000n]);
    expect(view!.owedTotal).toBe(3_000_000n);
    expect(view!.collected).toBe(3_000_000n);
  });

  it("splits every tax with the suite share first, then each recipient's and the burn's part, as parts of the whole tax", () => {
    const view = taxPanelView({ state: encoded({ shares: [5_000, 3_000, 0, 0], burnShareBps: 2_000, taxSide: 0 }), slot: 1, vaults: [null, null] })!;
    expect(view.split).toEqual([
      { slot: 5, who: "suite", wallet: SUITE_TREASURY, ofCreatorBps: null, ofTaxBps: 1_000 },
      { slot: 0, who: "recipient", wallet: AUTHORITY, ofCreatorBps: 5_000, ofTaxBps: 4_500 },
      { slot: 1, who: "recipient", wallet: SECOND, ofCreatorBps: 3_000, ofTaxBps: 2_700 },
      { slot: 4, who: "burn", wallet: null, ofCreatorBps: 2_000, ofTaxBps: 1_800 },
    ]);
  });

  it("lists each slot that can be paid with what it is owed and the payout that sends it: distribute for a wallet, burn for the burn", () => {
    const view = taxPanelView({ state: encoded({ owed: [1n, 0n, 0n, 0n, 7n, 2n], burnShareBps: 0 }), slot: 1, vaults: [null, null] })!;
    expect(view.slots).toEqual([
      { slot: 0, who: "recipient", wallet: AUTHORITY, owed: 1n, action: "distribute", inputs: { tax_mint: WSOL, recipient: AUTHORITY } },
      { slot: 1, who: "recipient", wallet: SECOND, owed: 0n, action: "distribute", inputs: { tax_mint: WSOL, recipient: SECOND } },
      // A burn share cut to 0 can leave the burn owed what it earned before; it is still burned.
      { slot: 4, who: "burn", wallet: null, owed: 7n, action: "burn", inputs: { tax_mint: WSOL, recipient: ZERO } },
      { slot: 5, who: "suite", wallet: SUITE_TREASURY, owed: 2n, action: "distribute", inputs: { tax_mint: WSOL, recipient: SUITE_TREASURY } },
    ]);
  });

  it("says when the market has no tax authority, and when it renounced", () => {
    expect(taxPanelView({ state: encoded({ taxAuthority: ZERO }), slot: 1, vaults: [null, null] })!.authority).toEqual({ kind: "none" });
    expect(taxPanelView({ state: encoded({ taxAuthority: ZERO, taxAuthorityRenounced: true }), slot: 1, vaults: [null, null] })!.authority).toEqual({ kind: "renounced" });
  });

  it("shows a pending change of rates with the slot it applies from and how many slots are left, and one that is due as the rates in force", () => {
    const pending = { pendingBuyTaxBps: 600, pendingSellTaxBps: 700, pendingFromSlot: 525_000_300n };
    const waiting = taxPanelView({ state: encoded(pending), slot: 525_000_100, vaults: [null, null] })!;
    expect(waiting.pending).toEqual({ buy: 600, sell: 700, fromSlot: 525_000_300n, slotsLeft: 200n });
    expect(waiting.rates).toMatchObject({ buy: 300, sell: 500 });
    // Due but not yet applied by a swap: those are the rates in force (docs/spec/tax-amm.md, "Rates").
    const due = taxPanelView({ state: encoded(pending), slot: 525_000_300, vaults: [null, null] })!;
    expect(due.pending).toBeNull();
    expect(due.rates).toMatchObject({ buy: 600, sell: 700 });
  });

  it("shows the virtual reserve on its side", () => {
    expect(taxPanelView({ state: encoded({ virtualReserve: 5_000_000_000n, virtualSide: 1 }), slot: 1, vaults: [null, null] })!.virtual).toEqual({ side: 1, amount: 5_000_000_000n });
  });

  it("reads nothing from a state that is no tax market's", () => {
    expect(taxPanelView({ state: base64(Uint8Array.from([1, 2, 3])), slot: 1, vaults: [null, null] })).toBeNull();
    expect(taxPanelView({ state: null, slot: 1, vaults: [null, null] })).toBeNull();
  });

  it("reads a token account's amount, and nothing from an account too short to be one", () => {
    expect(tokenAccountAmount(tokenAccount(42n))).toBe(42n);
    expect(tokenAccountAmount(base64(new Uint8Array(10)))).toBeNull();
    expect(tokenAccountAmount(null)).toBeNull();
  });
});
