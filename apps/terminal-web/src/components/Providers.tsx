"use client";

// Adapted from Top-pad b833a7b, apps/web/src/components/Providers.tsx; owned here since.
import type { ReactNode } from "react";
import { CHAIN } from "@/config";
import { WalletProvider } from "./wallet/WalletProvider";

/** Everything client-side the pages share: for now, the visitor's wallet. */
export function Providers({ children }: { children: ReactNode }) {
  return <WalletProvider chain={CHAIN}>{children}</WalletProvider>;
}
