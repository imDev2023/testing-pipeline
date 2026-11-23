// Adapted from Top-pad b833a7b, apps/api/src/rooms.ts; owned here since. Live rooms
// (docs/spec/pipescope-architecture.md, Live rooms; PIPESCOPE-31): one Durable Object per market and
// one for the feed. Browsers hold hibernatable WebSockets on a room, so a quiet room costs no
// duration; the indexer publishes its events to the rooms with a viewer, and a room sends what
// arrived in one message every LIVE_ROOM_BATCH_MS (./roomCore). A browser that reconnects resyncs
// through the API from the last trade it saw. The room tells the indexer when its first viewer
// arrives and its last one leaves, which opens and closes the indexer's socket (PIPESCOPE-27).
import { DurableObject } from "cloudflare:workers";
import type { LiveEvent } from "./contract";
import type { Bindings } from "./env";
import { ROOM_HEADER, RoomCore } from "./roomCore";

/** The one indexer, by name, as ./index reaches it. */
const indexerOf = (env: Bindings) => env.INDEXER.get(env.INDEXER.idFromName("router"));

export class LiveRoom extends DurableObject<Bindings> {
  private readonly core = new RoomCore({
    sockets: () => this.ctx.getWebSockets(),
    arrived: async () => indexerOf(this.env).arrived(await this.name()),
    left: async () => indexerOf(this.env).left(await this.name()),
  });

  /** The room's name, kept in its storage from the first browser on, since a hibernated room wakes without it. */
  private async name(): Promise<string> {
    const name = await this.ctx.storage.get<string>("name");
    if (!name) throw new Error("this live room was never named");
    return name;
  }

  /** A browser joining: the Worker hands the room its WebSocket upgrade. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("A live room speaks WebSocket.", { status: 426 });
    const name = request.headers.get(ROOM_HEADER);
    if (!name) return new Response("A live room is named by the Worker.", { status: 400 });
    if ((await this.ctx.storage.get<string>("name")) !== name) await this.ctx.storage.put("name", name);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    // The indexer opening its socket must never keep the browser waiting, nor fail its join.
    this.ctx.waitUntil(this.core.joined().catch((e: unknown) => console.error(`telling the indexer of a viewer in ${name} failed`, e)));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The indexer's new events for this room. */
  async publish(events: LiveEvent[]): Promise<void> {
    await this.core.publish(events);
  }

  /** How many browsers the room holds: the indexer's alarm asks, so a room whose browsers left unseen never keeps its socket open. */
  async viewers(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }

  /** Browsers only listen. */
  async webSocketMessage(): Promise<void> {}

  /** A browser left (the runtime answers its Close frame): when it was the last, the indexer hears of it. */
  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.core.closed(socket).catch((e: unknown) => console.error("telling the indexer the room emptied failed", e));
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.webSocketClose(socket);
  }
}
