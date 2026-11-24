"use client";

// A slot's payout button on the tax panel (docs/spec/tax-amm.md, "Payout" and "In Aviary"; #75): it
// sends the metadata's `distribute` action for a tax recipient or the suite share, or its `burn` action
// for the burn slot, with the inputs the panel reads from the market state, the tax-side mint and the
// slot's wallet (TAX-45, TAX-48). Like every transaction Aviary builds it is prepared and simulated
// for the viewer's own wallet first, then signed; anyone may send it, and the caller pays for a
// recipient's token account when it is missing. Once it lands, the panel reads the market again.
import { useCallback, useState } from "react";
import { PreparedAction, type Market, type MarketMint } from "terminal-api/contract";
import { postToApi } from "@/api";
import forms from "@/components/forms/Forms.module.css";
import { TransactionReview } from "@/components/forms/TransactionReview";
import { useReview } from "@/components/forms/useReview";
import { useWallet } from "@/components/wallet/WalletProvider";
import type { PayableSlot } from "./panel";
import { partName } from "./SplitTable";
import styles from "./TaxAmm.module.css";

export function Payout({ market, slot, taxMint, onPaid }: { market: Market; slot: PayableSlot; taxMint: MarketMint | null; onPaid: () => void }) {
  const { account, openMenu } = useWallet();
  const trader = account?.address ?? null;
  const [open, setOpen] = useState(false);
  const prepare = useCallback(
    () => postToApi("/v1/actions/prepare", { market: market.address, action: slot.action, args: { slot: String(slot.slot) }, inputs: slot.inputs, trader }, PreparedAction),
    [market.address, slot.action, slot.slot, slot.inputs, trader],
  );
  // The slot and its inputs never change while a review is open, so a review is left only by its own Back or Done.
  const { review, start, handlers } = useReview({ prepare, about: { market: market.address, strategy: market.strategy }, version: 0, trader, onConfirmed: onPaid });
  const mintOf = (mint: string) => market.mints.find((m) => m.mint === mint) ?? null;
  const verb = slot.action === "burn" ? "Burn" : "Pay out";
  const named = `${verb} ${partName(slot).replace(/^The /, "the ").replace(/^Tax/, "tax")}`;

  if (!open || !review) {
    return (
      <div className={styles.payoutActions}>
        {account ? (
          <button
            type="button"
            disabled={slot.owed === 0n}
            aria-label={named}
            onClick={() => {
              setOpen(true);
              start();
            }}
          >
            {verb}
          </button>
        ) : (
          <button type="button" aria-label={`Connect wallet to ${named.toLowerCase()}`} onClick={openMenu}>
            Connect wallet
          </button>
        )}
        {slot.owed === 0n && <span className={forms.note}>Owed nothing now.</span>}
        {slot.owed > 0n && slot.action === "distribute" && taxMint && <span className={forms.note}>Paid to its wallet&apos;s {taxMint.symbol === "SOL" ? "wrapped-SOL" : `${taxMint.symbol ?? taxMint.token?.symbol ?? "token"}`} account, which the payout creates if it is missing.</span>}
      </div>
    );
  }
  return (
    <TransactionReview
      title={`Review: ${named.toLowerCase()}`}
      building={`Building the ${slot.action} and simulating it, exactly as it would be signed.`}
      review={review}
      mintOf={mintOf}
      {...handlers}
      onBack={() => {
        handlers.onBack();
        setOpen(false);
      }}
    />
  );
}
