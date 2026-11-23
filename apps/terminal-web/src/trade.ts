// The trade box's rules (docs/spec/pipescope-screens.md, Trade box and The amount typed), apart from
// its drawing so they are tested on their own: reading the amount typed into base units exactly,
// "Use it all", the slippage the trader accepts, and what the button says and does. Every number
// here comes from the screens' config module; every rate the box shows comes from the API.
import { MAX_SLIPPAGE_PERCENT, SOL_KEPT_BACK } from "./config";

const U64_MAX = (1n << 64n) - 1n;
const SOL_DECIMALS = 9;

export type ParsedAmount = { kind: "amount"; value: bigint } | { kind: "empty" } | { kind: "invalid"; reason: string };

/** The amount typed, in the mint's base units, read digit by digit so nothing is lost to floating point. */
export function parseAmount(text: string, decimals: number): ParsedAmount {
  const typed = text.trim();
  if (typed === "") return { kind: "empty" };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(typed);
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) return { kind: "invalid", reason: "Type an amount, such as 0.5." };
  const [whole = "", fraction = ""] = [match[1], match[2]];
  if (fraction.replace(/0+$/, "").length > decimals) return { kind: "invalid", reason: `This token has ${decimals} decimal places.` };
  const value = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt((fraction.slice(0, decimals) || "0").padEnd(decimals, "0"));
  if (value > U64_MAX) return { kind: "invalid", reason: "That is more than a token account can hold." };
  return value === 0n ? { kind: "empty" } : { kind: "amount", value };
}

/** Base units written back as the trader would type them: every digit, no grouping, no trailing zeros. */
export function writeAmount(value: bigint, decimals: number): string {
  if (decimals === 0) return String(value);
  const scale = 10n ** BigInt(decimals);
  const fraction = String(value % scale).padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${value / scale}.${fraction}` : String(value / scale);
}

/** "Use it all": the whole balance, but for SOL the configured amount kept back for network fees and rent. */
export function balanceToUse(balance: bigint, { isSol }: { isSol: boolean }): bigint {
  if (!isSol) return balance;
  const keep = BigInt(Math.round(SOL_KEPT_BACK * 10 ** SOL_DECIMALS));
  return balance > keep ? balance - keep : 0n;
}

export type ParsedSlippage = { kind: "bps"; value: number } | { kind: "invalid"; reason: string };

/** A slippage typed as a percentage, in basis points, up to the screens' highest. */
export function parseSlippage(text: string): ParsedSlippage {
  const typed = text.trim();
  if (!/^\d*(\.\d*)?$/.test(typed) || typed === "" || typed === ".") return { kind: "invalid", reason: "Type a percentage, such as 2." };
  const [whole = "", fraction = ""] = typed.split(".");
  if (fraction.replace(/0+$/, "").length > 2) return { kind: "invalid", reason: "Slippage is set to a hundredth of a percent at most." };
  const value = Number(whole || "0") * 100 + Number((fraction.slice(0, 2) || "0").padEnd(2, "0"));
  if (value > MAX_SLIPPAGE_PERCENT * 100) return { kind: "invalid", reason: `Slippage is at most ${MAX_SLIPPAGE_PERCENT}%.` };
  return { kind: "bps", value };
}

/** A rate in basis points as a percentage: "0.25%". */
export const formatBps = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`;

export type ButtonInput = {
  connected: boolean;
  amount: ParsedAmount["kind"];
  /** The quote for the amount typed: being asked, there, or none (refused, or not asked). */
  quote: "loading" | "ready" | "none";
  /** The exit-test notice is shown and its box not yet ticked. */
  noticeUnticked: boolean;
};

export type ButtonState = { label: string; action: "connect" | "review" | null; reason: string | null };

/** What the button reads and does, and why it is off when the trader can act on that. */
export function tradeButton({ connected, amount, quote, noticeUnticked }: ButtonInput): ButtonState {
  if (!connected) return { label: "Connect wallet", action: "connect", reason: null };
  if (amount === "empty") return { label: "Enter an amount", action: null, reason: null };
  if (amount === "amount" && quote === "loading") return { label: "Getting a quote", action: null, reason: null };
  if (amount !== "amount" || quote !== "ready") return { label: "Review swap", action: null, reason: "There is no quote to build a swap from." };
  if (noticeUnticked) return { label: "Review swap", action: null, reason: "Tick the box above to say you have read it." };
  return { label: "Review swap", action: "review", reason: null };
}
