// How a refused quote or a failed simulation is named (docs/spec/pipescope-screens.md, "On every
// page": an error from a strategy or the chain is shown decoded, with the raw error beneath it). Its
// classes follow Canary's (`crates/canary/src/failure.rs`, CANARY-14), worked out from the
// transaction's error and logs the same way, and add the one a trader meets most: a wallet that
// holds too little, which the review panel says in those words.
import { PIPELINE_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import type { Failure } from "../contract";

/** Anchor's "the account does not hold the type I expect" errors. */
const CANNOT_READ = new Set([3002, 3003]);

/** The token programs' errors by number (Token-2022 begins with the classic program's). */
const TOKEN_ERRORS = [
  "NotRentExempt",
  "InsufficientFunds",
  "InvalidMint",
  "MintMismatch",
  "OwnerMismatch",
  "FixedSupply",
  "AlreadyInUse",
  "InvalidNumberOfProvidedSigners",
  "InvalidNumberOfRequiredSigners",
  "UninitializedState",
  "NativeNotSupported",
  "NonNativeHasBalance",
  "InvalidInstruction",
  "InvalidState",
  "Overflow",
  "AuthorityTypeNotSupported",
  "MintCannotFreeze",
  "AccountFrozen",
  "MintDecimalsMismatch",
  "NonNativeNotSupported",
];

const TOO_LITTLE = "Your wallet holds too little for this swap.";

const between = (text: string, start: string, end: string): string | null => {
  const from = text.indexOf(start);
  if (from < 0) return null;
  const to = text.indexOf(end, from + start.length);
  return to < 0 ? null : text.slice(from + start.length, to);
};

/** A program as a sentence names it: its short address, or "A program" when no log line named it. */
const programWords = (address: string | null) => (address ? `Program ${address.slice(0, 4)}...${address.slice(-4)}` : "A program");
const quoted = (name: string, message: string | null) => (message ? `${name}, "${message}"` : name);

/** A decoded sentence continued after a colon: "The swap failed on chain: the strategy refused it: ...". */
export const continued = (sentence: string) => (/^(The|It|Your) /.test(sentence) ? sentence[0]!.toLowerCase() + sentence.slice(1) : sentence);

export function decodeFailure(error: unknown, logs: readonly string[], { strategy }: { strategy: string }): Failure {
  // Kit's RPC reads every number in an error as a bigint, which JSON has no word for.
  const raw = typeof error === "string" ? error : JSON.stringify(error, (_, v: unknown) => (typeof v === "bigint" ? Number(v) : v));
  const base = { name: null, number: null, message: null, program: null, raw };

  // Refused before any program ran: the fee payer cannot pay.
  if (raw === "InsufficientFundsForFee" || raw.includes('"InsufficientFundsForFee"')) {
    return { ...base, class: "too_little", sentence: "Your wallet holds too little for this swap: it cannot pay the network fee." };
  }
  if (raw === "AccountNotFound" || raw.includes('"AccountNotFound"')) {
    return { ...base, class: "too_little", sentence: "Your wallet holds too little for this swap: it has never held SOL, so it cannot pay the network fee." };
  }

  // The innermost program fails first; its callers then report the same failure.
  let program: string | null = null;
  let reason = "";
  for (const line of logs) {
    const match = /^Program (\S+) failed: (.*)$/.exec(line);
    if (match) {
      program = match[1]!;
      reason = match[2]!;
      break;
    }
  }
  const anchorLine = logs.find((line) => line.includes("Error Code: ") && line.includes("Error Number: "));
  const anchor = anchorLine
    ? {
        name: between(anchorLine, "Error Code: ", ". Error Number"),
        number: Number(between(anchorLine, "Error Number: ", ". Error Message")),
        message: anchorLine.split("Error Message: ")[1]?.replace(/\.$/, "") ?? null,
      }
    : null;
  const custom = /"Custom":(\d+)/.exec(raw);
  const code = custom ? Number(custom[1]) : null;
  const panic = logs.map((line) => line.slice(line.indexOf("panicked at"))).find((line) => line.startsWith("panicked at")) ?? null;
  const crashed = panic !== null || /panicked|access violation|failed to complete/i.test(reason) || raw.includes("ProgramFailedToComplete");
  const outOfCompute = raw.includes("ComputationalBudgetExceeded") || [reason, ...logs].some((l) => l.includes("exceeded CUs meter") || l.includes("Computational budget exceeded"));
  const number = anchor?.number ?? code;
  const named = { ...base, program, name: anchor?.name ?? null, number, message: anchor?.message ?? null };
  const words = named.name ? quoted(named.name, named.message) : number !== null ? `error ${number}` : reason || raw;

  if (outOfCompute) return { ...named, class: "out_of_compute", sentence: "It ran out of compute before it finished." };
  if (crashed) {
    const who = program === strategy ? "The strategy" : programWords(program);
    return { ...named, class: "crash", sentence: `${who} crashed instead of answering: ${(panic || reason || raw).replace(/\.$/, "")}.` };
  }
  if (program === strategy && number !== null && CANNOT_READ.has(number)) return { ...named, class: "cannot_read_state", sentence: `The strategy cannot read this market's state: ${words}.` };
  if (program === strategy) return { ...named, class: "strategy_refused", sentence: `The strategy refused it: ${words}.` };
  if (program === PIPELINE_PROGRAM_ADDRESS) return { ...named, class: "router_refused", sentence: `Pipeline's router refused it: ${words}.` };
  if (program === TOKEN_PROGRAM_ADDRESS || program === TOKEN_2022_PROGRAM_ADDRESS) {
    const name = code !== null ? (TOKEN_ERRORS[code] ?? null) : null;
    if (name === "InsufficientFunds") return { ...named, name, class: "too_little", sentence: TOO_LITTLE };
    return { ...named, name, class: "token_program_refused", sentence: `The token program refused it: ${name ?? words}.` };
  }
  if (program === SYSTEM_PROGRAM_ADDRESS && (code === 1 || logs.some((l) => l.includes("insufficient lamports")))) {
    return { ...named, class: "too_little", sentence: TOO_LITTLE };
  }
  return { ...named, class: "other_refused", sentence: `${programWords(program)} refused it: ${words.replace(/\.$/, "")}.` };
}
