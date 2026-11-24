// Pipeline's router events, read out of a transaction with Pipeline's own decoder
// (`@pipeline-sol/sdk`'s `decodeEvent`, the code behind `extractEventsFromInnerInstructions`), in
// place of the Meteora decoders Top-pad's indexer used.
//
// The router emits every event as a self-CPI: an inner instruction to the router whose data starts
// with Anchor's event tag. Only the router's event authority can sign one, so each such
// instruction in a successful transaction is a genuine event, known to this decoder or not. One it
// does not know (from a router upgrade, say) is kept, counted, and indexed again by newer code.
import { decodeEvent, EVENT_IX_TAG, PIPELINE_PROGRAM_ADDRESS, type PipelineEvent } from "@pipeline-sol/sdk";
import { getBase58Encoder, type ReadonlyUint8Array } from "@solana/kit";

/**
 * The version of the event decoder below. Raise it whenever the decoder learns an event it did not
 * know (a newer `@pipeline-sol/sdk` with a new event or layout), so `reindexUnknown` reads again
 * every transaction an older version could not fully decode.
 */
export const DECODER_VERSION = 1;

/** Turns an event instruction's data into an event, or null when it does not know it. */
export type EventDecoder = (data: ReadonlyUint8Array) => PipelineEvent | null;

/** An instruction as `json` encoding gives it: its program and accounts as indexes into the transaction's account list, its data in base58. */
export type CompiledInstruction = { programIdIndex: number; accounts?: number[]; data: string };

/** A transaction as `getTransaction` returns it with `json` encoding, with its place in its block when the source knows it. */
export type RawTransaction = {
  slot: number;
  blockTime: number | null;
  /** The transaction's position in its block; `getTransactionsForAddress` gives it, and `rpcSource` adds it from `getBlock`. */
  transactionIndex?: number;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      /** How many of the first account keys signed it. */
      header?: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      /** The top-level instructions; each account and program is an index into the full account list. */
      instructions?: CompiledInstruction[];
    };
  };
  meta: {
    err: unknown;
    innerInstructions?: { index: number; instructions: (CompiledInstruction & { stackHeight?: number | null })[] }[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
    /** The programs' log lines, which hold their `sol_log_data` events (./events). */
    logMessages?: string[] | null;
  } | null;
};

/** One router event of a transaction, at its index among the transaction's event instructions. */
export type DecodedEvent = { eventIndex: number; event: PipelineEvent };

/** An event instruction the decoder did not know, with its data in base58 as the RPC gave it. */
export type UnknownEvent = { eventIndex: number; data: string };

const base58 = getBase58Encoder();

const startsWith = (data: ReadonlyUint8Array, prefix: ReadonlyUint8Array) => data.length >= prefix.length && prefix.every((b, i) => data[i] === b);

/** The transaction's full account list: its static keys, then the writable and read-only addresses its lookup tables loaded. */
export function accountKeysOf(raw: RawTransaction): string[] {
  const loaded = raw.meta?.loadedAddresses;
  return [...raw.transaction.message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
}

/**
 * Every router event instruction of a transaction, in order. Each is numbered by its place among
 * them, known or not, so a trade keeps its event index when a newer decoder learns the event before it.
 */
export function decodeRouterEvents(raw: RawTransaction, decode: EventDecoder = decodeEvent): { events: DecodedEvent[]; unknown: UnknownEvent[] } {
  const events: DecodedEvent[] = [];
  const unknown: UnknownEvent[] = [];
  const keys = accountKeysOf(raw);
  let eventIndex = 0;
  for (const group of raw.meta?.innerInstructions ?? []) {
    for (const instruction of group.instructions) {
      if (keys[instruction.programIdIndex] !== PIPELINE_PROGRAM_ADDRESS) continue;
      const data = base58.encode(instruction.data);
      if (!startsWith(data, EVENT_IX_TAG)) continue;
      const event = decode(data);
      if (event) events.push({ eventIndex, event });
      else unknown.push({ eventIndex, data: instruction.data });
      eventIndex++;
    }
  }
  return { events, unknown };
}
