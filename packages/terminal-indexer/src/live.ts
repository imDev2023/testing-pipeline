// Adapted from Top-pad b833a7b, packages/indexer/src/live.ts (`logsSubscribeRequest`,
// `parseLogsMessage`, `webSocketUrlOf`) and apps/api/src/indexer.ts (`served`); owned here since.
//
// The live source (docs/spec/pipescope-architecture.md, Indexer, "Live source"): `logsSubscribe` on
// the watched programs says a transaction touched them, and the transaction is fetched whole to be
// decoded, with its place in its block. These are the RPC calls and messages that source is made of;
// the API's `Indexer` Durable Object holds the socket, and only while someone watches.
import type { RawTransaction } from "./decode";
import { blockPositions } from "./history";
import { rpcCall } from "./rpc";

/** The WebSocket endpoint of an HTTP RPC endpoint: the same URL, key and all, over wss. */
export const webSocketUrlOf = (rpcUrl: string) => rpcUrl.replace(/^http/, "ws");

/** A `logsSubscribe` request for transactions that mention `account`, at confirmed commitment. */
export const logsSubscribeRequest = (id: number, account: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [account] }, { commitment: "confirmed" }] });

/** What a message on the logs WebSocket says. */
export type LogsMessage =
  | { kind: "subscribed"; id: number; subscription: number }
  | { kind: "refused"; id: number; error: string }
  | { kind: "transaction"; subscription: number; slot: number; signature: string; failed: boolean }
  | { kind: "other" };

export function parseLogsMessage(data: string): LogsMessage {
  let message: {
    id?: number;
    result?: unknown;
    error?: { message?: string };
    method?: string;
    params?: { subscription: number; result: { context: { slot: number }; value: { signature: string; err: unknown } } };
  };
  try {
    message = JSON.parse(data);
  } catch {
    return { kind: "other" };
  }
  if (typeof message.id === "number" && typeof message.result === "number") return { kind: "subscribed", id: message.id, subscription: message.result };
  if (typeof message.id === "number" && message.error) return { kind: "refused", id: message.id, error: message.error.message ?? "refused" };
  if (message.method === "logsNotification" && message.params) {
    const { subscription, result } = message.params;
    return { kind: "transaction", subscription, slot: result.context.slot, signature: result.value.signature, failed: result.value.err !== null };
  }
  return { kind: "other" };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * A reported transaction, asked for every `everyMs` until the RPC serves it, for up to `waitMs` (a
 * node reports a transaction before it serves it: Helius serves a confirmed one 1.5 to 2 s after its
 * block, devnet, 2026-10-29), with its place in its block from `getBlock`. Null when it was not
 * served in time, which leaves it to reconciliation.
 */
export async function servedTransaction(
  rpcUrl: string,
  signature: string,
  { waitMs = 8_000, everyMs = 300, blockIndexOf = blockPositions(rpcUrl) }: { waitMs?: number; everyMs?: number; blockIndexOf?: (slot: number, signature: string) => Promise<number> } = {},
): Promise<RawTransaction | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const raw = await rpcCall<RawTransaction | null>(rpcUrl, "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
    if (raw) return { ...raw, transactionIndex: await blockIndexOf(raw.slot, signature) };
    if (Date.now() >= until) return null;
    await sleep(everyMs);
  }
}
