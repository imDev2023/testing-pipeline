// Strategy-program calls (docs/spec/pipescope-architecture.md, Indexer, "Strategy-program calls"):
// every instruction the indexer sees on a strategy program, stored with who signed it. Watching the
// strategy programs is what shows custom actions and bypass swaps, which the router never reports;
// Canary's `custom_instructions` result and the instruction list's callers read them (CANARY-18).
//
// "Who called it" is the transaction's signers among the instruction's accounts: a custom action's
// caller signs it, and the router passes its trader's signature on. A program that signs for its own
// PDA in a CPI is not a transaction signer and is not counted; `invokedBy` names that program.
import { getBase58Encoder } from "@solana/kit";
import { and, eq, inArray } from "drizzle-orm";
import { markets, strategyCalls, type Db } from "terminal-db";
import { accountKeysOf, type CompiledInstruction, type RawTransaction } from "./decode";
import type { TransactionHandler } from "./handler";
import { addResult, emptyResult } from "./result";

const base58 = getBase58Encoder();
const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** An instruction's first eight bytes in hex, which for an Anchor program names the instruction; null when it has fewer. */
export function discriminatorOf(data: string): string | null {
  const bytes = base58.encode(data);
  return bytes.length >= 8 ? hex(bytes.subarray(0, 8)) : null;
}

type Call = { instructionIndex: number; innerIndex: number; program: string; instruction: CompiledInstruction; invokedBy: string | null };

/**
 * Every instruction of a transaction, top-level and inner, each with the program that called it: none
 * at the top level; for an inner one, the nearest instruction before it one level up the call stack
 * (its `stackHeight`), or the top-level instruction when the RPC gives no heights.
 */
function everyInstruction(raw: RawTransaction, keys: string[]): Call[] {
  const top = raw.transaction.message.instructions ?? [];
  const inner = new Map((raw.meta?.innerInstructions ?? []).map((g) => [g.index, g.instructions]));
  const out: Call[] = [];
  top.forEach((instruction, instructionIndex) => {
    const program = keys[instruction.programIdIndex]!;
    out.push({ instructionIndex, innerIndex: -1, program, instruction, invokedBy: null });
    // The call stack of this top-level instruction: the program at each height, the top one at height 1.
    const stack: string[] = [program];
    (inner.get(instructionIndex) ?? []).forEach((ix, innerIndex) => {
      const callee = keys[ix.programIdIndex]!;
      const height = ix.stackHeight ?? 2;
      const invokedBy = stack[height - 2] ?? program;
      stack.length = height - 1;
      stack.push(callee);
      out.push({ instructionIndex, innerIndex, program: callee, instruction: ix, invokedBy });
    });
  });
  return out;
}

/**
 * The handler that stores every call on a strategy program; `isStrategy` says which programs are
 * strategies. Each call is written once, and a failed transaction, which changed nothing, has none.
 * A call whose accounts hold a market's state names that market, to be read again.
 */
export function strategyCallsHandler(isStrategy: (program: string) => boolean): TransactionHandler {
  return async (db, raw) => {
    const result = emptyResult();
    if (raw.meta === null || raw.meta.err !== null) return result;
    const keys = accountKeysOf(raw);
    const signerCount = raw.transaction.message.header?.numRequiredSignatures ?? 1;
    const calls = everyInstruction(raw, keys).filter((c) => isStrategy(c.program));
    if (!calls.length) return result;
    const signature = raw.transaction.signatures[0]!;
    const rows = calls.map((c) => {
      const accounts = c.instruction.accounts ?? [];
      return {
        signature,
        instructionIndex: c.instructionIndex,
        innerIndex: c.innerIndex,
        program: c.program,
        discriminator: discriminatorOf(c.instruction.data),
        signers: [...new Set(accounts.filter((i) => i < signerCount).map((i) => keys[i]!))],
        invokedBy: c.invokedBy,
        slot: BigInt(raw.slot),
        blockIndex: raw.transactionIndex ?? null,
        blockTime: raw.blockTime === null ? null : new Date(raw.blockTime * 1000),
      };
    });
    const written = await db.insert(strategyCalls).values(rows).onConflictDoNothing().returning({ signature: strategyCalls.signature });
    if (written.length) result.counts.strategyCalls = written.length;

    // A custom action touches a market through its state, which the strategy owns: read it again.
    for (const c of calls) {
      const accounts = [...new Set((c.instruction.accounts ?? []).map((i) => keys[i]!))];
      if (!accounts.length) continue;
      const touched = await db
        .select({ address: markets.address })
        .from(markets)
        .where(and(eq(markets.strategyProgram, c.program), inArray(markets.marketState, accounts)));
      result.markets.push(...touched.map((m) => m.address));
    }
    result.markets = [...new Set(result.markets)];
    return result;
  };
}

/** One handler that runs each of `handlers` on every transaction, in order, and adds up what they wrote. */
export function combineHandlers(...handlers: TransactionHandler[]): TransactionHandler {
  return async (db: Db, raw) => {
    const result = emptyResult();
    for (const handle of handlers) addResult(result, await handle(db, raw));
    return result;
  };
}
