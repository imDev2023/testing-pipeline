// The network fee a review shows (docs/spec/pipescope-architecture.md, Trading path): the RPC's
// `getFeeForMessage`, asked again when it answers null, as a load-balanced RPC does for a blockhash
// one of its nodes has not seen yet; and when it never answers, Solana's base fee for each of the
// message's signatures, so a review never says a transaction costs nothing (#57, found recording).
import { describe, expect, it } from "vitest";
import { networkFeeOf } from "../src/trading/prepare";

/** A legacy message header: 2 required signatures, then the rest of a message that does not matter here. */
const legacy = Uint8Array.of(2, 0, 1, 0);
/** A v0 message: the version prefix, then its header with 1 required signature. */
const v0 = Uint8Array.of(0x80, 1, 0, 1, 0);

const rpcAnswering = (answers: (bigint | null)[]) => {
  const asked: number[] = [];
  return {
    asked,
    rpc: { getFeeForMessage: () => ({ send: async () => (asked.push(1), { value: answers.shift() ?? null }) }) } as never,
  };
};

describe("the network fee of a prepared transaction", () => {
  it("is the RPC's answer", async () => {
    const { rpc, asked } = rpcAnswering([5_000n]);
    expect(await networkFeeOf(rpc, legacy, { pauseMs: 0 })).toBe(5_000n);
    expect(asked).toHaveLength(1);
  });

  it("asks again when the RPC answers null, until it answers", async () => {
    const { rpc, asked } = rpcAnswering([null, null, 10_000n]);
    expect(await networkFeeOf(rpc, legacy, { pauseMs: 0 })).toBe(10_000n);
    expect(asked).toHaveLength(3);
  });

  it("is the base fee for each required signature when the RPC never answers", async () => {
    expect(await networkFeeOf(rpcAnswering([]).rpc, legacy, { pauseMs: 0 })).toBe(10_000n);
    expect(await networkFeeOf(rpcAnswering([]).rpc, v0, { pauseMs: 0 })).toBe(5_000n);
  });
});
