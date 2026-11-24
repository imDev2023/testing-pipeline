// A form's fields as the pages read them (docs/spec/pipescope.md, Custom-action and create-market
// forms; #123), apart from their drawing so they are tested on their own: what is typed into a field
// becomes the argument the API builds the instruction with. An amount whose mint the metadata names
// (`decimals_of`) is typed in that mint's decimals, as the trade box's amounts are, and sent in base
// units; every other value is sent as typed and checked again by the API with Pipeline's SDK.
import { isAddress } from "@solana/kit";
import type { AccountSource, FormArg, MarketMint } from "terminal-api/contract";
import { parseAmount } from "./trade";

/** A mint as a form names it and reads its decimals: the market's, or one the user entered, once read. */
export type MintInfo = Pick<MarketMint, "mint" | "symbol" | "token" | "decimals">;

/** The mints a form can refer to: the market's own in its order (none on the create page), and each entered mint by its input's name, once read. */
export type MintContext = { market: readonly MintInfo[]; inputs: Readonly<Record<string, MintInfo | null>> };

export type FieldValue = string | boolean;

export type ArgReading = { kind: "ok"; value: FieldValue } | { kind: "empty" } | { kind: "invalid"; reason: string };

const RANGES: Partial<Record<FormArg["type"], readonly [bigint, bigint]>> = {
  u8: [0n, 0xffn],
  u16: [0n, 0xffffn],
  u32: [0n, 0xffff_ffffn],
  u64: [0n, (1n << 64n) - 1n],
  i64: [-(1n << 63n), (1n << 63n) - 1n],
};
const grouped = (n: bigint) => n.toLocaleString("en-US");

/** The mint a source names, from the market or an entered input, or null when it is neither or not read yet. */
export function mintOf(source: AccountSource | null, context: MintContext): MintInfo | null {
  if (!source) return null;
  if (source.kind === "mint") return context.market[source.index] ?? null;
  if (source.kind === "input") return context.inputs[source.name] ?? null;
  return null;
}

/** The decimals an amount argument is typed in: those of the mint its `decimals_of` names, when known. */
export const decimalsOf = (source: AccountSource | null, context: MintContext): number | null => mintOf(source, context)?.decimals ?? null;

/** What a field holds, as the argument the API takes, or why it cannot be used yet. */
export function argValue(arg: FormArg, typed: FieldValue | undefined, decimals: number | null): ArgReading {
  if (arg.type === "bool") return { kind: "ok", value: typed === true };
  const text = typeof typed === "string" ? typed : "";
  if (arg.type === "string") return { kind: "ok", value: text };
  if (text.trim() === "") return { kind: "empty" };
  const value = text.trim();
  const range = RANGES[arg.type];
  if (range) {
    const outOfRange = { kind: "invalid", reason: `A ${arg.type} is a whole number from ${grouped(range[0])} to ${grouped(range[1])}.` } as const;
    let n: bigint;
    if (decimals !== null && range[0] === 0n) {
      if (/^0*(\.0*)?$/.test(value)) return { kind: "ok", value: "0" };
      const amount = parseAmount(value, decimals);
      if (amount.kind === "invalid") return amount.reason.includes("decimal places") ? amount : outOfRange;
      if (amount.kind === "empty") return { kind: "ok", value: "0" };
      n = amount.value;
    } else {
      if (!/^-?\d+$/.test(value)) return outOfRange;
      n = BigInt(value);
    }
    return n < range[0] || n > range[1] ? outOfRange : { kind: "ok", value: String(n) };
  }
  if (arg.type === "pubkey") return isAddress(value) ? { kind: "ok", value } : { kind: "invalid", reason: "Type an address: 32 to 44 characters of base58." };
  // bytes
  return /^(0x)?([0-9a-fA-F]{2})*$/.test(value) ? { kind: "ok", value } : { kind: "invalid", reason: "Type bytes in hex, two digits each, such as 0a1b." };
}
