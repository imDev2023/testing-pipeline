// Strategy-program events (docs/spec/pipescope-architecture.md, Indexer, "Strategy-program events";
// #88): the data a strategy program logs with `sol_log_data` (Anchor's `emit!`), read from a
// transaction's log messages and stored whole, so a product's panel can list a market's history
// (the lending AMM's liquidity added and removed, shares locked, rebalances, withdraw mode and a
// swap's redeem) from Postgres. Each `Program data:` line belongs to the program at the top of the
// call stack the `invoke` and `success` lines build, so data a strategy's inner calls log (klend's,
// under the lending AMM) is not the strategy's.
import { getAddressDecoder } from "@solana/kit";
import { strategyEvents } from "terminal-db";
import type { RawTransaction } from "./decode";
import type { TransactionHandler } from "./handler";
import { emptyResult } from "./result";

const INVOKE = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[(\d+)\]$/;
const ENDED = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed)/;
const DATA = "Program data: ";
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

export type LoggedEvent = { program: string; data: Uint8Array };

/** The data lines of `logs` written by programs `isStrategy` names, in order, each line's slices joined. */
export function eventsInLogs(logs: readonly string[], isStrategy: (program: string) => boolean): LoggedEvent[] {
  const stack: string[] = [];
  const found: LoggedEvent[] = [];
  for (const line of logs) {
    // Past a truncation the stack is unknown, so nothing after it is attributed.
    if (line === "Log truncated") break;
    const invoke = INVOKE.exec(line);
    if (invoke) {
      stack.length = Number(invoke[2]) - 1;
      stack.push(invoke[1]!);
      continue;
    }
    const ended = ENDED.exec(line);
    if (ended) {
      if (stack.at(-1) === ended[1]) stack.pop();
      continue;
    }
    if (line.startsWith(DATA)) {
      const program = stack.at(-1);
      if (!program || !isStrategy(program)) continue;
      const slices = line.slice(DATA.length).split(" ").filter(Boolean).map((slice) => Buffer.from(slice, "base64"));
      found.push({ program, data: new Uint8Array(Buffer.concat(slices)) });
    }
  }
  return found;
}

/** The handler that stores every strategy program's events of a successful transaction, once. */
export function strategyEventsHandler(isStrategy: (program: string) => boolean): TransactionHandler {
  return async (db, raw: RawTransaction) => {
    const result = emptyResult();
    if (raw.meta === null || raw.meta.err !== null) return result;
    const events = eventsInLogs(raw.meta.logMessages ?? [], isStrategy);
    if (!events.length) return result;
    const signature = raw.transaction.signatures[0]!;
    const rows = events.map((e, position) => ({
      signature,
      position,
      program: e.program,
      discriminator: e.data.length >= 8 ? hex(e.data.subarray(0, 8)) : null,
      subject: e.data.length >= 40 ? getAddressDecoder().decode(e.data.subarray(8, 40)) : null,
      data: Buffer.from(e.data).toString("base64"),
      slot: BigInt(raw.slot),
      blockIndex: raw.transactionIndex ?? null,
      blockTime: raw.blockTime === null ? null : new Date(raw.blockTime * 1000),
    }));
    const written = await db.insert(strategyEvents).values(rows).onConflictDoNothing().returning({ signature: strategyEvents.signature });
    if (written.length) result.counts.strategyEvents = written.length;
    return result;
  };
}
