// The indexer's live socket, only while someone watches (docs/spec/pipescope-architecture.md,
// Indexer, "Live source"; PIPESCOPE-27): opened when a browser joins a live room, with a
// reconciliation the moment it opens; reopened by its 15-second alarm if it drops; closed 3 minutes
// after the last viewer leaves, which its storage and its log record.
import { beforeEach, describe, expect, it } from "vitest";
import { SOCKET_CLOSE_AFTER_LAST_VIEWER_MS, SOCKET_HOURS_PER_DAY, SOCKET_REOPEN_ALARM_MS, SOCKET_REOPEN_BACKOFF_MAX_MS } from "../src/config";
import { LiveSocket, type LiveSocketDeps, type LiveSocketState } from "../src/liveSocket";

type FakeSocket = {
  accounts: string[];
  closed: boolean;
  report: (signature: string) => void;
  drop: () => void;
  /** The RPC confirms every subscription, or refuses one, as its first answer on the socket. */
  subscribed: () => void;
  refuse: (error: string) => void;
};

function harness(saved?: LiveSocketState) {
  const world = {
    now: 1_000_000,
    stored: saved as LiveSocketState | undefined,
    alarm: null as number | null,
    sockets: [] as FakeSocket[],
    reconciled: 0,
    reported: [] as string[],
    viewers: new Map<string, number>(),
    log: [] as string[],
    refuse: false,
  };
  const deps: LiveSocketDeps = {
    now: () => world.now,
    load: async () => world.stored,
    save: async (state) => void (world.stored = structuredClone(state)),
    setAlarm: async (at) => void (world.alarm = at),
    clearAlarm: async () => void (world.alarm = null),
    accounts: () => ["PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34"],
    connect: async (accounts, on) => {
      if (world.refuse) throw new Error("the RPC answered 429 to a WebSocket upgrade");
      const socket: FakeSocket = {
        accounts,
        closed: false,
        report: (s) => on.transaction(s),
        drop: () => {
          socket.closed = true;
          on.dropped();
        },
        subscribed: () => on.subscribed(),
        refuse: (error) => {
          socket.closed = true;
          on.refused(error);
        },
      };
      world.sockets.push(socket);
      return { close: () => void (socket.closed = true) };
    },
    reconcile: async () => void world.reconciled++,
    transactions: (signatures) => void world.reported.push(...signatures),
    viewersIn: async (room) => world.viewers.get(room) ?? 0,
    log: (line) => void world.log.push(line),
  };
  const open = () => world.sockets.filter((s) => !s.closed);
  return { world, deps, open, live: new LiveSocket(deps) };
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});

/** A browser joins a room: the room counts it, then tells the indexer. */
async function join(room: string) {
  h.world.viewers.set(room, (h.world.viewers.get(room) ?? 0) + 1);
  await h.live.arrived(room);
}
async function leave(room: string) {
  const left = (h.world.viewers.get(room) ?? 1) - 1;
  h.world.viewers.set(room, left);
  if (left === 0) await h.live.left(room);
}
/** Time passes to the alarm, which then fires. */
async function alarm() {
  expect(h.world.alarm).not.toBeNull();
  h.world.now = h.world.alarm!;
  await h.live.alarm();
}

describe("with no viewer", () => {
  it("holds no socket and sets no alarm", async () => {
    expect(await h.live.status()).toMatchObject({ open: false, rooms: [], closesAt: null });
    expect(h.world.alarm).toBeNull();
    expect(h.world.sockets).toEqual([]);
  });
});

describe("when a viewer arrives", () => {
  it("opens the socket on the watched programs, reconciles at once and sets the 15-second alarm", async () => {
    await join("market:A");
    expect(h.open().map((s) => s.accounts)).toEqual([["PiPEf4fFBpYXCtgfiWgVWzZNXnq2wZ7bnXidJCTwf34"]]);
    expect(h.world.reconciled).toBe(1);
    expect(h.world.alarm).toBe(h.world.now + SOCKET_REOPEN_ALARM_MS);
    expect(await h.live.status()).toMatchObject({ open: true, rooms: ["market:A"] });
    expect(h.world.stored).toMatchObject({ socket: { open: true, at: h.world.now } });
    expect(h.world.log).toEqual(["live socket opened: a viewer in market:A"]);
  });

  it("keeps one socket however many rooms have viewers", async () => {
    await join("market:A");
    await join("feed");
    await join("market:A");
    expect(h.world.sockets).toHaveLength(1);
    expect((await h.live.status()).rooms).toEqual(["feed", "market:A"]);
  });

  it("hands every transaction the socket reports to the indexer", async () => {
    await join("feed");
    h.open()[0]!.report("sig-1");
    h.open()[0]!.report("sig-2");
    expect(h.world.reported).toEqual(["sig-1", "sig-2"]);
  });
});

describe("when the last viewer leaves", () => {
  it("keeps the socket 3 minutes, then closes it, clears the alarm and records it in storage and the log", async () => {
    await join("market:A");
    const leftAt = h.world.now + 40_000;
    h.world.now = leftAt;
    await leave("market:A");
    expect(await h.live.status()).toMatchObject({ open: true, rooms: [], closesAt: leftAt + SOCKET_CLOSE_AFTER_LAST_VIEWER_MS });
    while (h.world.alarm !== null && h.world.alarm < leftAt + SOCKET_CLOSE_AFTER_LAST_VIEWER_MS) {
      await alarm();
      expect(h.open()).toHaveLength(1);
    }
    await alarm();
    expect(h.open()).toEqual([]);
    expect(h.world.alarm).toBeNull();
    expect(h.world.now).toBe(leftAt + SOCKET_CLOSE_AFTER_LAST_VIEWER_MS);
    expect(h.world.stored).toMatchObject({ rooms: [], closesAt: null, socket: { open: false, at: leftAt + SOCKET_CLOSE_AFTER_LAST_VIEWER_MS } });
    expect(h.world.log.at(-1)).toBe("live socket closed: no viewer for 3 minutes");
  });

  it("stays open when a viewer comes back within the 3 minutes", async () => {
    await join("market:A");
    await leave("market:A");
    h.world.now += 60_000;
    await join("feed");
    h.world.now += SOCKET_CLOSE_AFTER_LAST_VIEWER_MS;
    await h.live.alarm();
    expect(h.open()).toHaveLength(1);
    expect(h.world.sockets).toHaveLength(1);
  });

  it("is not reopened when it drops in those 3 minutes: it stays closed, with no reconciliation, until a viewer comes (#214)", async () => {
    await join("market:A");
    await leave("market:A");
    h.world.now += 20_000;
    h.open()[0]!.drop();
    await alarm();
    expect(h.world.sockets).toHaveLength(1);
    expect(h.world.reconciled).toBe(1);
    expect(h.world.alarm).toBeNull();
    expect(await h.live.status()).toMatchObject({ open: false, rooms: [], closesAt: null });
    expect(h.world.stored).toMatchObject({ closesAt: null, socket: { open: false, reason: "dropped with no viewer" } });
    expect(h.world.log.at(-1)).toBe("live socket closed: dropped with no viewer");
    await join("feed");
    expect(h.open()).toHaveLength(1);
    expect(h.world.reconciled).toBe(2);
  });

  it("is noticed by the alarm when a room's viewers went without saying so", async () => {
    await join("market:A");
    h.world.viewers.set("market:A", 0);
    await alarm();
    expect(await h.live.status()).toMatchObject({ rooms: [], closesAt: h.world.now + SOCKET_CLOSE_AFTER_LAST_VIEWER_MS });
  });
});

describe("the 15-second alarm", () => {
  it("is never put off by viewers arriving, so a dropped socket is reopened on time however often pages join", async () => {
    await join("market:A");
    const due = h.world.alarm;
    for (let i = 0; i < 5; i++) {
      h.world.now += 5_000;
      await join(`market:${i}`);
      expect(h.world.alarm).toBe(due);
    }
  });


  it("reopens a dropped socket and reconciles the moment it opens", async () => {
    await join("market:A");
    h.open()[0]!.drop();
    expect(await h.live.status()).toMatchObject({ open: false });
    await alarm();
    expect(h.open()).toHaveLength(1);
    expect(h.world.sockets).toHaveLength(2);
    expect(h.world.reconciled).toBe(2);
  });

  it("tries again on the next alarm when the socket cannot be opened, and says why", async () => {
    h.world.refuse = true;
    await join("market:A");
    expect(h.open()).toEqual([]);
    expect(h.world.log.at(-1)).toBe("live socket could not open: the RPC answered 429 to a WebSocket upgrade");
    h.world.refuse = false;
    await alarm();
    expect(h.open()).toHaveLength(1);
  });

  it("waits twice as long before each new try while the RPC refuses the subscription, up to SOCKET_REOPEN_BACKOFF_MAX_MS, reconciling only as it tries (#214)", async () => {
    await join("market:A");
    const waits: number[] = [];
    for (let tries = 1; tries <= 7; tries++) {
      h.open()[0]!.refuse("logsSubscribe is not available on this plan");
      expect(await h.live.status()).toMatchObject({ open: false });
      // A viewer arriving meanwhile never tries ahead of the wait.
      await join("feed");
      expect(h.world.sockets).toHaveLength(tries);
      const before = h.world.now;
      await alarm();
      waits.push(h.world.now - before);
      expect(h.world.sockets).toHaveLength(tries + 1);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16, 32, 64].map((x) => Math.min(x * SOCKET_REOPEN_ALARM_MS, SOCKET_REOPEN_BACKOFF_MAX_MS)));
    expect(h.world.reconciled).toBe(8);
    expect(h.world.stored).toMatchObject({ socket: { open: true } });
    expect(h.world.log).toContain("live socket refused: logsSubscribe is not available on this plan; the alarm tries again in 30 s");

    // Once the RPC confirms the subscription, a drop is tried again on the next 15-second alarm.
    h.open()[0]!.subscribed();
    h.open()[0]!.drop();
    const before = h.world.now;
    await alarm();
    expect(h.world.now - before).toBe(SOCKET_REOPEN_ALARM_MS);
    expect(h.open()).toHaveLength(1);
  });

  it("keeps its waits across a restart, as the object is evicted while it waits with no socket open", async () => {
    await join("market:A");
    h.open()[0]!.refuse("logsSubscribe is not available on this plan");
    await alarm();
    h.open()[0]!.refuse("logsSubscribe is not available on this plan");
    // Evicted while it waits: a new instance, from storage alone, waits out the 30 s and doubles the next wait.
    const restarted = harness(h.world.stored);
    restarted.world.viewers.set("market:A", 1);
    restarted.world.now = h.world.now + 20_000;
    restarted.world.alarm = restarted.world.now;
    await restarted.live.alarm();
    expect(restarted.world.sockets).toHaveLength(0);
    expect(restarted.world.alarm).toBe(h.world.now + 2 * SOCKET_REOPEN_ALARM_MS);
    restarted.world.now = restarted.world.alarm!;
    await restarted.live.alarm();
    restarted.open()[0]!.refuse("logsSubscribe is not available on this plan");
    expect(restarted.world.alarm).toBe(restarted.world.now + 4 * SOCKET_REOPEN_ALARM_MS);
  });

  it("carries on after a restart from what storage holds, opening the socket again", async () => {
    await join("market:A");
    const restarted = harness(h.world.stored);
    restarted.world.viewers.set("market:A", 1);
    restarted.world.now = h.world.now + SOCKET_REOPEN_ALARM_MS;
    restarted.world.alarm = restarted.world.now;
    await restarted.live.alarm();
    expect(restarted.open()).toHaveLength(1);
    expect(await restarted.live.status()).toMatchObject({ open: true, rooms: ["market:A"] });
  });
});

// The socket's daily cap (PIPESCOPE-169): an open socket keeps the indexer's Durable Object billed,
// so it is held at most SOCKET_HOURS_PER_DAY hours in a UTC day, whoever watches; past them the
// pages update from the every-minute reconciliation until the next day.
describe("the daily cap", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const CAP = SOCKET_HOURS_PER_DAY * HOUR;

  /** Alarms fire, as the clock moves to each, until `until`. */
  async function alarmsUntil(until: number) {
    while (h.world.alarm !== null && h.world.alarm <= until) await alarm();
  }

  it("closes the socket once it has been open SOCKET_HOURS_PER_DAY hours in a day, with viewers still there, and says why", async () => {
    await join("market:A");
    h.open()[0]!.subscribed();
    const opened = h.world.now;
    await alarmsUntil(opened + CAP - 1);
    expect(h.open()).toHaveLength(1);
    await alarmsUntil(opened + CAP + SOCKET_REOPEN_ALARM_MS);
    expect(h.open()).toHaveLength(0);
    expect(await h.live.status()).toMatchObject({ open: false, rooms: ["market:A"], reason: `used its ${SOCKET_HOURS_PER_DAY} hours for the day` });
    expect(h.world.log.at(-1)).toBe(`live socket closed: used its ${SOCKET_HOURS_PER_DAY} hours for the day`);
  });

  it("opens no socket for a viewer arriving once the day's hours are used, and opens it at the next UTC day for the viewers still there", async () => {
    await join("market:A");
    h.open()[0]!.subscribed();
    await alarmsUntil(h.world.now + CAP + SOCKET_REOPEN_ALARM_MS);
    await join("feed");
    expect(h.world.sockets).toHaveLength(1);
    expect(h.open()).toHaveLength(0);
    const tomorrow = (Math.floor(h.world.now / DAY) + 1) * DAY;
    expect(h.world.alarm).toBe(tomorrow);
    await alarm();
    expect(h.open()).toHaveLength(1);
    expect(await h.live.status()).toMatchObject({ open: true, rooms: ["feed", "market:A"], reason: "reopened by the alarm" });
  });

  it("counts every opening of the day together, across a restart of the object", async () => {
    await join("market:A");
    h.open()[0]!.subscribed();
    await alarmsUntil(h.world.now + CAP - HOUR);
    await leave("market:A");
    await alarmsUntil(h.world.now + SOCKET_CLOSE_AFTER_LAST_VIEWER_MS);
    expect(h.open()).toHaveLength(0);
    // Evicted while closed: a new instance reads the day's count from storage.
    const restarted = harness(h.world.stored);
    h = restarted;
    h.world.now += 10 * 60_000;
    await join("market:A");
    h.open()[0]!.subscribed();
    const reopened = h.world.now;
    await alarmsUntil(reopened + HOUR - SOCKET_CLOSE_AFTER_LAST_VIEWER_MS - 2 * SOCKET_REOPEN_ALARM_MS);
    expect(h.open()).toHaveLength(1);
    await alarmsUntil(reopened + HOUR);
    expect(h.open()).toHaveLength(0);
    expect((await h.live.status()).openTodayMs).toBeGreaterThanOrEqual(CAP);
  });
});
