// Adapted from Top-pad b833a7b, packages/indexer/src/live.test.ts; owned here since.
// The live source's messages (docs/spec/pipescope-architecture.md, Indexer, "Live source"): a
// `logsSubscribe` per watched program over the RPC's own URL, and what each message says; and a
// reported transaction asked for until the RPC serves it.
import { afterEach, describe, expect, it } from "vitest";
import { blockPositions, logsSubscribeRequest, parseLogsMessage, servedTransaction, webSocketUrlOf } from "../src/index";

const WAITS = { waitMs: 2_000, firstRetryMs: 100, maxRetryMs: 400 };
import { fakeRpc, type FakeRpc } from "./fakeRpc";
import { swapTransaction, WSOL, SWAP_TOKEN } from "./swaps";

let rpc: FakeRpc | null = null;
afterEach(async () => {
  await rpc?.close();
  rpc = null;
});

describe("the logs subscription", () => {
  it("runs over the RPC's own URL as a WebSocket", () => {
    expect(webSocketUrlOf("https://devnet.helius-rpc.com/?api-key=k")).toBe("wss://devnet.helius-rpc.com/?api-key=k");
    expect(JSON.parse(logsSubscribeRequest(3, "Acc"))).toEqual({ jsonrpc: "2.0", id: 3, method: "logsSubscribe", params: [{ mentions: ["Acc"] }, { commitment: "confirmed" }] });
  });

  it("tells a subscription's answer from a transaction it reports", () => {
    expect(parseLogsMessage('{"id":1,"jsonrpc":"2.0","result":7}')).toEqual({ kind: "subscribed", id: 1, subscription: 7 });
    expect(parseLogsMessage('{"id":2,"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params"}}')).toEqual({ kind: "refused", id: 2, error: "Invalid params" });
    const notification = {
      jsonrpc: "2.0",
      method: "logsNotification",
      params: { subscription: 7, result: { context: { slot: 516_000_000 }, value: { signature: "Sig", err: null as unknown, logs: [] } } },
    };
    expect(parseLogsMessage(JSON.stringify(notification))).toEqual({ kind: "transaction", subscription: 7, slot: 516_000_000, signature: "Sig", failed: false });
    notification.params.result.value.err = { InstructionError: [0, "Custom"] };
    expect(parseLogsMessage(JSON.stringify(notification))).toMatchObject({ failed: true });
    expect(parseLogsMessage("not json")).toEqual({ kind: "other" });
  });
});

describe("a reported transaction", () => {
  const raw = swapTransaction({ id: 1, slot: 300, blockIndex: 2, at: 1_795_366_800, input: WSOL, output: SWAP_TOKEN, netSent: 5n, received: 7n });

  it("is asked for until the RPC serves it, and comes with its place in its block", async () => {
    rpc = await fakeRpc([raw]);
    rpc.unserved.add(raw.transaction.signatures[0]!);
    setTimeout(() => rpc!.unserved.clear(), 400);
    const served = await servedTransaction(rpc.url, raw.transaction.signatures[0]!, { waitMs: 5_000, everyMs: 100, blockIndexOf: blockPositions(rpc.url, WAITS) });
    expect(served).toEqual(raw);
    expect(rpc.requests.filter((r) => r.method === "getTransaction").length).toBeGreaterThan(1);
  });

  it("is left to reconciliation when the RPC has not served it in time", async () => {
    rpc = await fakeRpc([raw]);
    rpc.unserved.add(raw.transaction.signatures[0]!);
    expect(await servedTransaction(rpc.url, raw.transaction.signatures[0]!, { waitMs: 300, everyMs: 100, blockIndexOf: blockPositions(rpc.url, WAITS) })).toBeNull();
  });
});
