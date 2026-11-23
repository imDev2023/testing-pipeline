// A live room (docs/spec/pipescope-architecture.md, Live rooms; PIPESCOPE-31): the indexer's events
// for it are gathered for LIVE_ROOM_BATCH_MS and sent to every browser in one message, and the room
// tells the indexer when its first viewer arrives and its last one leaves.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_ROOM_BATCH_MS } from "../src/config";
import { LiveMessage, type LiveEvent } from "../src/contract";
import { RoomCore, type RoomSocket } from "../src/roomCore";

const event = (n: number): LiveEvent => ({
  type: "trade",
  trade: {
    signature: `sig-${n}`,
    event_index: 0,
    slot: 100 + n,
    block_index: 0,
    block_time: "2026-11-23T12:00:00.000Z",
    market: "C5bB3UT6vFGWCqaguWnnhCR9cqn75XYM2PfQqRGR7X3w",
    trader: "9rYtQM57An5FRiVMkE5aZVRMtq5i1uwN3iiAEjRoywCt",
    input_mint: "So11111111111111111111111111111111111111112",
    output_mint: "4gqiCkoxxD72nbXGc7XtxQx4UjBHD3KiJyXpMvEZ6u8c",
    mode: "exact_in",
    net_sent: "1000000",
    received: "241072692",
    pipeline_fee: "2500",
    fee_mint: "So11111111111111111111111111111111111111112",
    integrator: null,
    integrator_fee: "0",
    quote_mint: "So11111111111111111111111111111111111111112",
    base_mint: "4gqiCkoxxD72nbXGc7XtxQx4UjBHD3KiJyXpMvEZ6u8c",
    side: "buy",
  },
});

function room() {
  const sockets: (RoomSocket & { received: unknown[] })[] = [];
  const told: string[] = [];
  const core = new RoomCore({
    sockets: () => sockets,
    arrived: async () => void told.push("arrived"),
    left: async () => void told.push("left"),
  });
  const connect = async () => {
    const socket = { received: [] as unknown[], send: (data: string) => void socket.received.push(JSON.parse(data)) };
    sockets.push(socket);
    await core.joined();
    return socket;
  };
  const disconnect = async (socket: RoomSocket) => {
    await core.closed(socket);
    sockets.splice(sockets.indexOf(socket as (typeof sockets)[number]), 1);
  };
  return { core, connect, disconnect, told };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a live room", () => {
  it("sends what arrives within the batching interval to every browser as one message", async () => {
    const { core, connect } = room();
    const [a, b] = [await connect(), await connect()];
    await core.publish([event(1)]);
    await core.publish([event(2), event(3)]);
    expect(a.received).toEqual([]);
    await vi.advanceTimersByTimeAsync(LIVE_ROOM_BATCH_MS);
    for (const socket of [a, b]) expect(socket.received).toEqual([LiveMessage.parse({ events: [event(1), event(2), event(3)] })]);
    await core.publish([event(4)]);
    await vi.advanceTimersByTimeAsync(LIVE_ROOM_BATCH_MS);
    expect(a.received).toHaveLength(2);
  });

  it("tells the indexer when its first viewer arrives and when its last one leaves, and not between", async () => {
    const { connect, disconnect, told } = room();
    const a = await connect();
    const b = await connect();
    await disconnect(a);
    expect(told).toEqual(["arrived"]);
    await disconnect(b);
    expect(told).toEqual(["arrived", "left"]);
    await connect();
    expect(told).toEqual(["arrived", "left", "arrived"]);
  });

  it("keeps sending to the others when one browser's socket fails as the batch goes out", async () => {
    const { core, connect } = room();
    const broken = await connect();
    broken.send = () => {
      throw new Error("closing");
    };
    const fine = await connect();
    await core.publish([event(1)]);
    await vi.advanceTimersByTimeAsync(LIVE_ROOM_BATCH_MS);
    expect(fine.received).toHaveLength(1);
  });
});
