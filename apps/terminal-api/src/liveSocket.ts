// The indexer's live source, held only while someone watches (docs/spec/pipescope-architecture.md,
// Indexer, "Live source"; PIPESCOPE-27, PIPESCOPE-28). One `logsSubscribe` socket on the watched
// programs, open only while a live room has a viewer and closed SOCKET_CLOSE_AFTER_LAST_VIEWER_MS
// after the last one leaves, because an outbound socket cannot hibernate and keeps the Durable
// Object billed. While it is open, an alarm every SOCKET_REOPEN_ALARM_MS reopens it if it dropped
// and asks each room whether its viewers are still there; each time it opens, a reconciliation runs
// at once, so nothing between the last cron run and the socket is missed.
//
// Kept apart from the `Indexer` Durable Object (./indexer), which gives it its storage, its alarm and
// the RPC's socket, so it runs and is tested in Node.
import { SOCKET_CLOSE_AFTER_LAST_VIEWER_MS, SOCKET_REOPEN_ALARM_MS } from "./config";

/** What storage keeps, so a restarted indexer carries on, and so anyone can read when the socket last opened or closed. */
export type LiveSocketState = {
  /** The live rooms with a viewer, by name ("feed", "market:<address>"). */
  rooms: string[];
  /** When the socket closes, once no room has a viewer. */
  closesAt: number | null;
  /** Whether the socket is open, and since when, and why it last changed. */
  socket: { open: boolean; at: number; reason: string };
};

export type LiveSocketDeps = {
  now: () => number;
  load: () => Promise<LiveSocketState | undefined>;
  save: (state: LiveSocketState) => Promise<void>;
  setAlarm: (at: number) => Promise<void>;
  clearAlarm: () => Promise<void>;
  /** The programs to subscribe to. */
  accounts: () => string[];
  /** Opens a socket subscribed to `accounts`; it reports each successful transaction, and says when it drops. */
  connect: (accounts: string[], on: { transaction: (signature: string) => void; dropped: () => void }) => Promise<{ close: () => void }>;
  reconcile: () => Promise<void>;
  /** Transactions the socket reported, to be fetched and indexed. */
  transactions: (signatures: string[]) => void;
  /** How many browsers a room holds now. */
  viewersIn: (room: string) => Promise<number>;
  log: (line: string) => void;
};

/** `GET /v1/indexer`'s `live`: the socket and the rooms keeping it open. */
export type LiveStatus = { open: boolean; rooms: string[]; closesAt: number | null; changedAt: number | null; reason: string | null };

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e));
const minutes = (ms: number) => `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}`;

export class LiveSocket {
  private state: LiveSocketState | null = null;
  private socket: { close: () => void } | null = null;
  private opening: Promise<void> | null = null;

  constructor(private readonly deps: LiveSocketDeps) {}

  private async loaded(): Promise<LiveSocketState> {
    this.state ??= (await this.deps.load()) ?? { rooms: [], closesAt: null, socket: { open: false, at: 0, reason: "never opened" } };
    return this.state;
  }

  private async save() {
    await this.deps.save(this.state!);
  }

  /** The next alarm: the reopen cadence, or the close if that comes first. */
  private async schedule() {
    const { closesAt } = this.state!;
    await this.deps.setAlarm(Math.min(this.deps.now() + SOCKET_REOPEN_ALARM_MS, closesAt ?? Infinity));
  }

  /**
   * A viewer arrived in a room: the socket opens, or stays open past a pending close. A room says so
   * for each viewer, so the alarm is set only when this changes what it is for, and many viewers
   * arriving never put it off.
   */
  async arrived(room: string): Promise<void> {
    const state = await this.loaded();
    const closing = state.closesAt !== null;
    const known = state.rooms.includes(room);
    if (!known) state.rooms = [...state.rooms, room].sort();
    state.closesAt = null;
    if (!known || closing) await this.save();
    if (!this.socket) {
      await this.open(`a viewer in ${room}`);
      await this.schedule();
    } else if (closing) await this.schedule();
  }

  /** A room's last viewer left: once no room has one, the socket closes after the grace. */
  async left(room: string): Promise<void> {
    const state = await this.loaded();
    state.rooms = state.rooms.filter((r) => r !== room);
    this.countDown();
    await this.save();
    await this.schedule();
  }

  private countDown() {
    const state = this.state!;
    if (!state.rooms.length && state.closesAt === null) state.closesAt = this.deps.now() + SOCKET_CLOSE_AFTER_LAST_VIEWER_MS;
  }

  /** The alarm: drops rooms whose viewers have gone, closes the socket when its time has come, else reopens it if it dropped. */
  async alarm(): Promise<void> {
    const state = await this.loaded();
    const still = await Promise.all(state.rooms.map(async (room) => ((await this.deps.viewersIn(room).catch(() => 1)) > 0 ? room : null)));
    state.rooms = still.filter((r): r is string => r !== null);
    this.countDown();
    if (!state.rooms.length && state.closesAt !== null && this.deps.now() >= state.closesAt) {
      this.socket?.close();
      this.socket = null;
      state.closesAt = null;
      state.socket = { open: false, at: this.deps.now(), reason: `no viewer for ${minutes(SOCKET_CLOSE_AFTER_LAST_VIEWER_MS)}` };
      await this.save();
      await this.deps.clearAlarm();
      this.deps.log(`live socket closed: ${state.socket.reason}`);
      return;
    }
    await this.save();
    if (!this.socket) await this.open(state.rooms.length ? "reopened by the alarm" : "reopened by the alarm before it closes");
    await this.schedule();
  }

  private open(reason: string): Promise<void> {
    this.opening ??= this.openOnce(reason).finally(() => (this.opening = null));
    return this.opening;
  }

  private async openOnce(reason: string): Promise<void> {
    const state = this.state!;
    let socket: { close: () => void };
    try {
      socket = await this.deps.connect(this.deps.accounts(), {
        transaction: (signature) => this.deps.transactions([signature]),
        dropped: () => {
          if (this.socket !== socket) return;
          this.socket = null;
          state.socket = { open: false, at: this.deps.now(), reason: "dropped" };
          this.deps.log("live socket dropped; the alarm reopens it");
          void this.save().catch(() => {});
        },
      });
    } catch (e) {
      this.deps.log(`live socket could not open: ${describe(e)}`);
      return;
    }
    this.socket = socket;
    state.socket = { open: true, at: this.deps.now(), reason };
    await this.save();
    this.deps.log(`live socket opened: ${reason}`);
    // What landed between the last cron run and the socket.
    await this.deps.reconcile().catch((e: unknown) => this.deps.log(`the reconciliation as the socket opened failed: ${describe(e)}`));
  }

  async status(): Promise<LiveStatus> {
    const state = await this.loaded();
    return { open: this.socket !== null, rooms: state.rooms, closesAt: state.closesAt, changedAt: state.socket.at || null, reason: state.socket.reason };
  }
}
