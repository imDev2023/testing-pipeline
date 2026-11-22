import type { Metadata } from "next";
import { NothingThere } from "@/components/NothingThere";

export const metadata: Metadata = { title: "Nothing here" };

export default function NotFound() {
  return <NothingThere />;
}
