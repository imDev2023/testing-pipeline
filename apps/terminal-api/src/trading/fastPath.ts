// The trade fast path (docs/spec/pipescope-architecture.md, Trading path, step 5; PIPESCOPE-33): the
// page posts the signature its wallet sent, the API asks every 300 ms whether it has confirmed, reads
// it back and answers with its swaps at once, each under a provisional order key (its slot and event,
// with no place in its block yet), and hands the signature to the indexer, which writes the trade
// with its place in the block and sends it to the market's live room, where the page replaces the
// provisional row in place.
import { HTTPException } from "hono/http-exception";
import { decodeRouterEvents, rpcCall, type RawTransaction } from "terminal-indexer";
import type { trades } from "terminal-db";
import { FAST_PATH_CONFIRMATION_POLL_MS, FAST_PATH_WAIT_MS, RPC_WAITS } from "../config";
import { continued, decodeFailure } from "./failure";
import { Refused } from "./quote";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Status = { slot: number; err: unknown; confirmationStatus: "processed" | "confirmed" | "finalized" | null } | null;
type RawWithLogs = RawTransaction & { meta: (RawTransaction["meta"] & { logMessages?: string[] | null }) | null };

/** A transaction the RPC serves late, asked for again for a while (devnet can answer null just after a confirmed status). */
async function readBack(rpcUrl: string, signature: string): Promise<RawWithLogs> {
  const until = Date.now() + RPC_WAITS.transaction.waitMs;
  for (;;) {
    const raw = await rpcCall<RawWithLogs | null>(rpcUrl, "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (raw) return raw;
    if (Date.now() >= until) throw new HTTPException(504, { message: "The swap confirmed, but the chain has not served it yet. It joins Trades as soon as Aviary reads it." });
    await sleep(RPC_WAITS.transaction.everyMs);
  }
}

/** The signature's status once it has confirmed, asking every `pollMs` for up to `waitMs`; null when it has not by then. */
async function confirmedStatus(rpcUrl: string, signature: string, pollMs: number, waitMs: number): Promise<NonNullable<Status> | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const { value } = await rpcCall<{ value: Status[] }>(rpcUrl, "getSignatureStatuses", [[signature]]);
    const status = value[0] ?? null;
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) return status;
    if (Date.now() >= until) return null;
    await sleep(pollMs);
  }
}

/** A transaction that failed on chain, decoded from its error and logs, as a refusal whose sentence starts `prefix`. */
function failedOnChain(err: unknown, raw: RawWithLogs, prefix: string, context: Parameters<typeof decodeFailure>[2]): Refused {
  const logs = raw.meta?.logMessages ?? [];
  const failure = decodeFailure(err, logs, context);
  return new Refused({ ...failure, sentence: `${prefix} ${continued(failure.sentence)}` }, logs);
}

/**
 * Waits until `signature` confirms, asking every `pollMs` for up to `waitMs`, and reads it back.
 * A transaction that failed on chain is a refusal, decoded from its error and logs.
 */
export async function awaitTrade(
  rpcUrl: string,
  signature: string,
  { pollMs = FAST_PATH_CONFIRMATION_POLL_MS, waitMs = FAST_PATH_WAIT_MS, strategy = null }: { pollMs?: number; waitMs?: number; strategy?: string | null } = {},
): Promise<RawWithLogs> {
  const status = await confirmedStatus(rpcUrl, signature, pollMs, waitMs);
  if (!status) throw new HTTPException(504, { message: "The swap has not confirmed yet. If it lands, it joins Trades as soon as Aviary reads it." });
  const raw = await readBack(rpcUrl, signature);
  if (status.err !== null || raw.meta?.err) throw failedOnChain(status.err ?? raw.meta?.err, raw, "The swap failed on chain:", { strategy: strategy ?? "" });
  return raw;
}

/**
 * Waits as the fast path does until a transaction the page's wallet sent (an unwrap, and later a
 * custom action) confirms, and answers its slot; one that failed on chain is a refusal, decoded.
 */
export async function awaitConfirmation(
  rpcUrl: string,
  signature: string,
  { pollMs = FAST_PATH_CONFIRMATION_POLL_MS, waitMs = FAST_PATH_WAIT_MS }: { pollMs?: number; waitMs?: number } = {},
): Promise<{ signature: string; slot: number }> {
  const status = await confirmedStatus(rpcUrl, signature, pollMs, waitMs);
  if (!status) throw new HTTPException(504, { message: "It has not confirmed yet. If it lands, this page shows it once reloaded." });
  if (status.err !== null) throw failedOnChain(status.err, await readBack(rpcUrl, signature), "It failed on chain:", { strategy: "", act: "transaction" });
  return { signature, slot: status.slot };
}

type TradeRow = typeof trades.$inferSelect;

/** The swaps of a confirmed transaction, as trade rows with no place in their block yet: the provisional order key. */
export function provisionalTrades(raw: RawTransaction): TradeRow[] {
  const signature = raw.transaction.signatures[0]!;
  return decodeRouterEvents(raw).events.flatMap(({ eventIndex, event }) => {
    if (event.type !== "Swap") return [];
    const s = event.data;
    return [
      {
        signature,
        eventIndex,
        slot: BigInt(raw.slot),
        blockIndex: null,
        blockTime: raw.blockTime === null ? null : new Date(raw.blockTime * 1000),
        market: s.market,
        strategy: s.strategy,
        trader: s.trader,
        inputMint: s.inputMint,
        outputMint: s.outputMint,
        mode: s.mode,
        netSent: String(s.netSent),
        received: String(s.received),
        pipelineFee: String(s.pipelineFee),
        feeMint: s.feeMint,
        integrator: s.integrator,
        integratorFee: String(s.integratorFee),
        unixTimestamp: s.unixTimestamp,
      },
    ];
  });
}
