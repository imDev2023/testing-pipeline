// Adapted from Top-pad b833a7b, apps/api/src/rooms.ts; owned here since. A live room's work
// (docs/spec/pipescope-architecture.md, Live rooms; PIPESCOPE-31), kept apart from the `LiveRoom`
// Durable Object (./liveRoom), which holds the browsers' hibernatable sockets, so it runs and is
// tested in Node: the indexer's events gathered for LIVE_ROOM_BATCH_MS and sent in one message, and
// the indexer told as viewers arrive and when the last one leaves, which opens and closes its socket
// (PIPESCOPE-27).
import { LIVE_ROOM_BATCH_MS, ROOM_ANNOUNCE_RETRY_MS } from "./config";
import type { LiveEvent, LiveMessage } from "./contract";

/** The header the Worker names the room with as it hands the room a browser's upgrade. */
export const ROOM_HEADER = "x-live-room";

/** A room's name: "feed", or "market:<address>". */
export const roomOf = { feed: "feed", market: (address: string) => `market:${address}` };

/** A browser's socket, as much of one as the room uses. */
export type RoomSocket = { send: (data: string) => void };

export type RoomDeps = {
  /** The browsers in the room now, the closing one included while it closes. */
  sockets: () => RoomSocket[];
  arrived: () => Promise<void>;
  left: () => Promise<void>;
};

export class RoomCore {
  private pending: LiveEvent[] = [];
  private flushing: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: RoomDeps) {}

  /**
   * A browser joined: the indexer hears of it each time, which costs it nothing when it already
   * counts the room, so a room it never heard of (an announcement lost in a deploy) is counted at the
   * next join; a refused announcement is tried twice more, after ROOM_ANNOUNCE_RETRY_MS and twice it.
   */
  async joined(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.arrived();
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise((done) => setTimeout(done, ROOM_ANNOUNCE_RETRY_MS * 2 ** attempt));
      }
    }
  }

  /** A browser left: when none is left, the indexer hears of it. */
  async closed(socket: RoomSocket): Promise<void> {
    if (!this.deps.sockets().some((s) => s !== socket)) await this.deps.left();
  }

  /** The indexer's new events for this room, sent on within the batching interval with whatever else arrives meanwhile. */
  async publish(events: LiveEvent[]): Promise<void> {
    this.pending.push(...events);
    this.flushing ??= setTimeout(() => this.flush(), LIVE_ROOM_BATCH_MS);
  }

  private flush() {
    this.flushing = null;
    if (!this.pending.length) return;
    const message = JSON.stringify({ events: this.pending } satisfies LiveMessage);
    this.pending = [];
    for (const socket of this.deps.sockets()) {
      try {
        socket.send(message);
      } catch {
        // A socket closing as the batch goes out; its browser resyncs through the API when it reconnects.
      }
    }
  }
}
