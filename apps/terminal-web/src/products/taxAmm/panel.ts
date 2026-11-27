// What the tax panel reads from a tax market's state (docs/spec/tax-amm.md, "In Aviary"; #75), as
// plain figures the panel draws: the tax side; the buy tax and the sell tax with their fixed ranges,
// and a change of rates waiting for its slot; the tax authority, or that the market has none or that
// it renounced; where each tax goes, the suite share first; what each slot is owed, with the payout
// that sends it; and the real reserves and the virtual reserve beside what the vaults hold, since a
// vault also holds the tax not yet paid out.
//
// The state is decoded with the tax AMM's generated client, and its constants (the suite share, its
// treasury, the slot numbers) come from the program's IDL, so the panel restates none of them.
import { getBase64Encoder, type Address } from "@solana/kit";
import { BURN_SLOT, getTaxMarketDecoder, getTaxMarketSize, SUITE_SLOT, SUITE_TREASURY, TAX_MARKET_DISCRIMINATOR, type TaxMarket } from "tax-amm-scripts/client/index.ts";
import type { MarketKeeper } from "terminal-api/contract";
import { formatAge } from "@/format";
import { outcomeText, waitingReason } from "@/keeperText";
import { DEFAULT_ADDRESS, splitOf, type SlotWho, type SplitPart } from "./split";

/** The keeper runner's answer for the market as the panel holds it: still loading, failed, or loaded. */
export type KeeperRead = { status: "loading" } | { status: "failed" } | { status: "loaded"; data: MarketKeeper };

/** A slot that can be paid out: what it is owed, and the payout action with the inputs the metadata's action takes. */
export type PayableSlot = { slot: number; who: SlotWho; wallet: Address | null; owed: bigint; action: "distribute" | "burn"; inputs: { tax_mint: Address; recipient: Address } };

export type TaxPanelView = {
  state: TaxMarket;
  taxSide: number;
  /** The rates in force at the slot read, in basis points, with their fixed ranges. */
  rates: { buy: number; sell: number; buyRange: [number, number]; sellRange: [number, number] };
  /** A change of rates still waiting for its slot; one already due is the rates in force. */
  pending: { buy: number; sell: number; fromSlot: bigint; slotsLeft: bigint } | null;
  authority: { kind: "address"; address: Address } | { kind: "none" } | { kind: "renounced" };
  split: SplitPart[];
  collected: bigint;
  slots: PayableSlot[];
  owedTotal: bigint;
  reserves: bigint[];
  virtual: { side: number; amount: bigint } | null;
  /** What each vault holds, read at the same slot, or null when it could not be read. */
  vaults: (bigint | null)[];
};

const base64 = getBase64Encoder();

/** A token account's amount, a u64 after its mint and owner, or null for no account or one too short to be one. */
export function tokenAccountAmount(data: string | null): bigint | null {
  if (data === null) return null;
  const bytes = new Uint8Array(base64.encode(data));
  return bytes.length >= 72 ? new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(64, true) : null;
}

/** A tax market's state from its account's base64 data, or null when it is no tax market's. */
export function decodeTaxMarket(data: string | null): TaxMarket | null {
  if (data === null) return null;
  const bytes = new Uint8Array(base64.encode(data));
  if (bytes.length !== getTaxMarketSize() || !TAX_MARKET_DISCRIMINATOR.every((byte, i) => bytes[i] === byte)) return null;
  return getTaxMarketDecoder().decode(bytes);
}

/** Everything the panel shows, from the market state and its vaults read at `slot`; null for a state that is no tax market's. */
export function taxPanelView({ state: data, slot, vaults }: { state: string | null; slot: number; vaults: (string | null)[] }): TaxPanelView | null {
  const state = decodeTaxMarket(data);
  if (!state) return null;
  const taxMint = state.mints[state.taxSide]!;
  const used = state.recipients.map((wallet, slot) => ({ wallet, slot })).filter(({ wallet }) => wallet !== DEFAULT_ADDRESS);

  // A change whose slot has come is the market's rates, though no swap has written it yet ("Rates").
  const due = state.pendingFromSlot !== 0n && BigInt(slot) >= state.pendingFromSlot;
  const waiting = state.pendingFromSlot !== 0n && !due;

  const split = splitOf(state.recipients, state.shares, state.burnShareBps);

  const slots: PayableSlot[] = [
    ...used.map(({ wallet, slot }) => ({ slot, who: "recipient" as const, wallet, owed: state.owed[slot]!, action: "distribute" as const, inputs: { tax_mint: taxMint, recipient: wallet } })),
    // The burn is listed while it has a share or is owed what it earned before its share went to 0.
    ...(state.burnShareBps > 0 || state.owed[BURN_SLOT]! > 0n
      ? [{ slot: BURN_SLOT, who: "burn" as const, wallet: null, owed: state.owed[BURN_SLOT]!, action: "burn" as const, inputs: { tax_mint: taxMint, recipient: DEFAULT_ADDRESS } }]
      : []),
    { slot: SUITE_SLOT, who: "suite", wallet: SUITE_TREASURY, owed: state.owed[SUITE_SLOT]!, action: "distribute", inputs: { tax_mint: taxMint, recipient: SUITE_TREASURY } },
  ];

  return {
    state,
    taxSide: state.taxSide,
    rates: {
      buy: due ? state.pendingBuyTaxBps : state.buyTaxBps,
      sell: due ? state.pendingSellTaxBps : state.sellTaxBps,
      buyRange: [state.buyTaxMinBps, state.buyTaxMaxBps],
      sellRange: [state.sellTaxMinBps, state.sellTaxMaxBps],
    },
    pending: waiting ? { buy: state.pendingBuyTaxBps, sell: state.pendingSellTaxBps, fromSlot: state.pendingFromSlot, slotsLeft: state.pendingFromSlot - BigInt(slot) } : null,
    authority: state.taxAuthorityRenounced ? { kind: "renounced" } : state.taxAuthority === DEFAULT_ADDRESS ? { kind: "none" } : { kind: "address", address: state.taxAuthority },
    split,
    collected: state.taxCollected,
    slots,
    owedTotal: state.owed.reduce((total, owed) => total + owed, 0n),
    reserves: [...state.reserves],
    virtual: state.virtualReserve > 0n ? { side: state.virtualSide, amount: state.virtualReserve } : null,
    vaults: vaults.map(tokenAccountAmount),
  };
}

/**
 * What the keeper runner makes of a slot, from `GET /v1/markets/{market}/keeper` (PIPESCOPE-164): a slot
 * owed anything is due by the runner's own rule, with its last attempt at it and, when the runner has
 * tried and not landed it since its last payout, how long it has been due; a slot owed nothing is not.
 */
export function keeperLine(slot: PayableSlot, keeper: KeeperRead, now?: Date): string {
  if (keeper.status === "loading") return "Reading the keeper runner's records…";
  if (keeper.status === "failed") return "The keeper runner's records could not be read.";
  const due = keeper.data.due.find((d) => d.job === "distribute" && d.slot === slot.slot);
  if (!due) return slot.owed > 0n ? "The keeper runner did not count it due when it was read." : "The keeper runner has nothing to pay: it is owed nothing.";
  if (!keeper.data.records.ok) return "The keeper runner counts it due; its records could not be read.";
  const last = due.last;
  const since = due.due_since ? ` Due since ${formatAge(new Date(due.due_since), now)}.` : "";
  if (!last) return "The keeper runner counts it due and has not tried it yet.";
  const said = last.outcome === "held" || last.outcome === "parked" ? waitingReason(last) : outcomeText(last);
  return `The keeper runner: ${said}, ${formatAge(new Date(last.at), now)}.${since}`;
}
