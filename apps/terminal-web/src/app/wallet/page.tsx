import type { Metadata } from "next";
import { WalletView } from "@/components/wallet/WalletView";

export const metadata: Metadata = { title: "Wallet" };

/** The wallet page (docs/spec/pipescope-screens.md, Wallet page): the connected wallet's holdings and swaps, drawn in the browser, since only the browser knows the wallet. */
export default function WalletPage() {
  return <WalletView />;
}
