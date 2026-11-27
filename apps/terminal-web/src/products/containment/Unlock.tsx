"use client";

// The Unlock button on the containment panel (docs/spec/containment-hook.md, "Unlock" and "In
// Aviary"; #76): shown to anyone once the unlock is due, it sends the hook's `unlock` from the
// connected wallet, which pays only the network fee. Like every transaction Aviary builds it is
// prepared and simulated for that wallet first, then signed; once it lands, the panel reads the token
// again and the page's facts follow.
import { useCallback, useState } from "react";
import { PreparedUnlock } from "terminal-api/containment";
import type { Market } from "terminal-api/contract";
import { postToApi } from "@/api";
import forms from "@/components/forms/Forms.module.css";
import { TransactionReview } from "@/components/forms/TransactionReview";
import { useReview } from "@/components/forms/useReview";
import { useWallet } from "@/components/wallet/WalletProvider";
import styles from "./Containment.module.css";

/** `onReviewing` hears when a review opens and when it is left, so the panel keeps it on screen after its unlock lands. */
export function Unlock({ market, mint, onUnlocked, onReviewing }: { market: Market; mint: string; onUnlocked: () => void; onReviewing?: (open: boolean) => void }) {
  const { account, openMenu } = useWallet();
  const trader = account?.address ?? null;
  const [open, setOpen] = useState(false);
  const prepare = useCallback(() => postToApi("/v1/containment/unlock/prepare", { mint, trader }, PreparedUnlock), [mint, trader]);
  const { review, start, handlers } = useReview({ prepare, about: { market: market.address, strategy: market.strategy }, version: 0, trader, onConfirmed: onUnlocked });
  const mintOf = (address: string) => market.mints.find((m) => m.mint === address) ?? null;

  if (!open || !review) {
    return (
      <div className={styles.unlockActions}>
        {account ? (
          <button
            type="button"
            aria-label="Unlock this token"
            onClick={() => {
              setOpen(true);
              onReviewing?.(true);
              start();
            }}
          >
            Unlock
          </button>
        ) : (
          <button type="button" aria-label="Connect wallet to unlock" onClick={openMenu}>
            Connect wallet
          </button>
        )}
        <span className={forms.note}>Sent from your wallet, which pays only the network fee.</span>
      </div>
    );
  }
  return (
    <TransactionReview
      title="Review: unlock this token"
      building="Building the unlock and simulating it, exactly as it would be signed."
      review={review}
      mintOf={mintOf}
      {...handlers}
      onBack={() => {
        handlers.onBack();
        setOpen(false);
        onReviewing?.(false);
      }}
    />
  );
}
