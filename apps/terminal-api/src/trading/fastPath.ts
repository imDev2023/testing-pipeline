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

/** What the fast path says when a transaction fails, has not confirmed in time, or confirmed but is not served yet. */
export type Words = { failed: string; notYet: string; notServed: string };
const SWAP_WORDS: Words = {
  failed: "The swap failed on chain:",
  notYet: "The swap has not confirmed yet. If it lands, it joins Trades as soon as Aviary reads it.",
  notServed: "The swap confirmed, but the chain has not served it yet. It joins Trades as soon as Aviary reads it.",
};
/** The same for a custom action or a new market, which joins no list on the page. */
export const TRANSACTION_WORDS: Words = {
  failed: "It failed on chain:",
  notYet: "It has not confirmed yet. If it lands, the explorer shows it.",
  notServed: "It confirmed, but the chain has not served it yet; the explorer shows it.",
};

type Status = { slot: number; err: unknown; confirmationStatus: "processed" | "confirmed" | "finalized" | null } | null;
type RawWithLogs = RawTransaction & { meta: (RawTransaction["meta"] & { logMessages?: string[] | null }) | null };

/** A transaction the RPC serves late, asked for again for a while (devnet can answer null just after a confirmed status). */
async function readBack(rpcUrl: string, signature: string, words: Words): Promise<RawWithLogs> {
  const until = Date.now() + RPC_WAITS.transaction.waitMs;
  for (;;) {
    const raw = await rpcCall<RawWithLogs | null>(rpcUrl, "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (raw) return raw;
    if (Date.now() >= until) throw new HTTPException(504, { message: words.notServed });
    await sleep(RPC_WAITS.transaction.everyMs);
  }
}

/**
 * Waits until `signature` confirms, asking every `pollMs` for up to `waitMs`, and reads it back.
 * A transaction that failed on chain is a refusal, decoded from its error and logs; `hooks` names the
 * transfer hook programs of the mints it moved, asked only then.
 */
export async function awaitTrade(
  rpcUrl: string,
  signature: string,
  {
    pollMs = FAST_PATH_CONFIRMATION_POLL_MS,
    waitMs = FAST_PATH_WAIT_MS,
    strategy = null,
    words = SWAP_WORDS,
    hooks = async () => [],
  }: { pollMs?: number; waitMs?: number; strategy?: string | null; words?: Words; hooks?: () => Promise<readonly string[]> } = {},
): Promise<RawWithLogs> {
  const until = Date.now() + waitMs;
  for (;;) {
    const { value } = await rpcCall<{ value: Status[] }>(rpcUrl, "getSignatureStatuses", [[signature]]);
    const status = value[0] ?? null;
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      const raw = await readBack(rpcUrl, signature, words);
      if (status.err !== null || raw.meta?.err) {
        // The mints' transfer hooks are read only for a transaction that failed, so a refusal by one is named as the hook's.
        const failure = decodeFailure(status.err ?? raw.meta?.err, raw.meta?.logMessages ?? [], {
          strategy: strategy ?? "",
          hooks: await hooks().catch(() => []),
          act: words === SWAP_WORDS ? "swap" : "transaction",
        });
        throw new Refused({ ...failure, sentence: `${words.failed} ${continued(failure.sentence)}` }, raw.meta?.logMessages ?? []);
      }
      return raw;
    }
    if (Date.now() >= until) throw new HTTPException(504, { message: words.notYet });
    await sleep(pollMs);
  }
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
