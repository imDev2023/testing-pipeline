// Where every tax goes, as a table (docs/spec/tax-amm.md, "Where the tax goes"): the suite share first,
// then each tax recipient and the burn, each as a part of the creator's part and of the whole tax. The
// launch form shows it before signing, and the tax panel shows a market's.
import { Table } from "@/components/Table";
import { ShortAddress } from "@/components/ShortAddress";
import type { SplitPart } from "./split";

const percent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** A part's name as the split says it. */
export function partName(part: Pick<SplitPart, "who" | "slot">): string {
  if (part.who === "suite") return "The suite share";
  if (part.who === "burn") return "The burn";
  return `Tax recipient ${part.slot + 1}`;
}

export function SplitTable({ split, caption }: { split: SplitPart[]; caption: string }) {
  return (
    <Table
      caption={caption}
      columns={[
        { key: "part", label: "Part" },
        { key: "wallet", label: "Paid to" },
        { key: "creator", label: "Of the creator's part" },
        { key: "tax", label: "Of every tax" },
      ]}
      rows={split.map((part) => ({
        key: `${part.who}-${part.slot}`,
        cells: {
          part: partName(part),
          // One element a cell: at narrow widths a cell is a grid, which would set each loose part on a line of its own.
          wallet: part.who === "burn" ? "Burned, so nobody" : part.who === "suite" ? <span>The suite&apos;s treasury, <ShortAddress address={part.wallet!} /></span> : <ShortAddress address={part.wallet!} />,
          creator: part.ofCreatorBps === null ? "Taken first" : percent(part.ofCreatorBps),
          tax: percent(part.ofTaxBps),
        },
      }))}
    />
  );
}
