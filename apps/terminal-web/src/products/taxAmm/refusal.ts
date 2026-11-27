// A launch refused by the tax AMM's mint rules, in words (docs/spec/tax-amm.md, "Mint rules"; #75).
// The simulation before the signature runs the program's own rules, so the decoded failure already
// names the rule a mint breaks, in the program's words; this adds which mint breaks it and, for an
// extension, which one by Token-2022's name, from the line the program logs with the extension's
// number. The rules themselves live in the program (`programs/mint-rules`, `src/mint_levers.rs`) and
// nowhere here.
import { ExtensionType } from "@solana-program/token-2022";
import type { Failure } from "terminal-api/contract";

/** The tax AMM's errors that are mint rules: what the mints of a market may carry, and what the seed asks of their authorities. */
const MINT_RULES = new Set(["MintExtensionNotAllowed", "TransferHookNotAllowed", "MintAuthoritySet", "FreezeAuthoritySet"]);

/** An extension's Token-2022 name in words: "PermanentDelegate" as "permanent delegate". */
const words = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

const lowerFirst = (text: string) => text[0]!.toLowerCase() + text.slice(1);

/**
 * The sentence the launch form shows beneath a failed simulation the mint rules refused, or null for
 * any other failure. `tokenNamed` names a mint by its symbol when it has one.
 */
export function mintRuleRefusal(failure: Failure | null, logs: readonly string[], tokenNamed: (mint: string) => string | null): string | null {
  if (!failure?.name || !MINT_RULES.has(failure.name)) return null;
  const extension = logs.map((line) => /Mint (\S+) carries refused extension (\d+)/.exec(line)).find((m) => m !== null);
  const hooked = logs.map((line) => /Mint (\S+) has a transfer hook a market refuses/.exec(line)).find((m) => m !== null);
  const mint = extension?.[1] ?? hooked?.[1] ?? null;
  const who = (mint && tokenNamed(mint)) ?? "The token";
  const rule = failure.message ? lowerFirst(failure.message.replace(/\.$/, "")) : failure.name;
  if (extension) {
    const number = Number(extension[2]);
    const name = (ExtensionType as unknown as Record<number, string | undefined>)[number];
    return `${who} breaks the tax AMM's mint rules: it carries ${name ? `Token-2022's ${words(name)} extension` : "a Token-2022 extension"} (number ${number}), and ${rule}.`;
  }
  return `${who} breaks the tax AMM's mint rules: ${rule}.`;
}
