"use client";

// Adapted from Top-pad b833a7b, apps/web/src/components/WalletButton.tsx; owned here since.
// The header's wallet button (docs/spec/pipescope-screens.md, "On every page"): "Connect wallet",
// or the connected wallet's short address with a way out.
import { useEffect, useRef, useState } from "react";
import { shortAddress } from "@/format";
import styles from "./WalletButton.module.css";
import { useWallet } from "./WalletProvider";

export function WalletButton() {
  const { wallets, wallet, account, connecting, connect, disconnect, menuRequests } = useWallet();
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  // The trade box's "Connect wallet" opens this menu.
  const asked = useRef(menuRequests);
  useEffect(() => {
    if (menuRequests === asked.current) return;
    asked.current = menuRequests;
    setProblem(null);
    setOpen(true);
    root.current?.scrollIntoView({ block: "nearest" });
  }, [menuRequests]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  if (account) {
    return (
      <div className={styles.wrap} ref={root}>
        <button type="button" className={styles.button} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu" title={wallet ? `Connected with ${wallet.name}` : undefined}>
          {/* A wallet's own icon is its author's picture, drawn at a fixed size; it is a data URI the wallet registers, so there is nothing to optimise. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {wallet?.icon && <img src={wallet.icon} alt="" width={18} height={18} className={styles.icon} />}
          <code>{shortAddress(account.address)}</code>
        </button>
        {open && (
          <div className={styles.menu} role="menu" aria-label={wallet ? `Connected with ${wallet.name}` : "Wallet"}>
            <p className={styles.note}>
              Connected with {wallet?.name} <code>{shortAddress(account.address)}</code>
            </p>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void disconnect();
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.wrap} ref={root}>
      <button
        type="button"
        className={styles.button}
        onClick={() => {
          setProblem(null);
          setOpen((o) => !o);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={connecting !== null}
      >
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
      {open && (
        <div className={styles.menu} role="menu" aria-label="Choose a wallet">
          {wallets.length === 0 ? (
            <p className={styles.note}>
              No Solana wallet that signs on devnet was found in this browser. Install Phantom, Solflare or Backpack, point it at devnet, then reload.
            </p>
          ) : (
            wallets.map((w) => (
              <button
                key={w.name}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  connect(w).catch((e: Error) => {
                    if (!/reject|declin|cancel/i.test(e.message)) setProblem(`${w.name} did not connect: ${e.message}`);
                  });
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URI the wallet registers */}
                <img src={w.icon} alt="" width={20} height={20} className={styles.icon} />
                {w.name}
              </button>
            ))
          )}
        </div>
      )}
      {problem && (
        <p className={styles.problem} role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}
