import type { Metadata } from "next";
import { KeeperView } from "@/components/KeeperView";

export const metadata: Metadata = { title: "Keeper" };

/** The keeper page (PIPESCOPE-97): what the keeper runner did and spends, read-only and public. */
export default function KeeperPage() {
  return <KeeperView />;
}
